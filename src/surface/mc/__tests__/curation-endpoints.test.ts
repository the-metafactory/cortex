import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { Database } from "bun:sqlite";

import { startMcTestServer, stopMcTestServer } from "./__fixtures__/mc-test-server";
import type { McTestServer } from "./__fixtures__/mc-test-server";
import type { SpawnFn } from "../session/endpoint-resolver";
import { createSession } from "../db/sessions";
import { generateId } from "../db/events";

const neverExitingCatSpawn: SpawnFn = () =>
  Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

const realFetch = globalThis.fetch;
function installLoopbackPrincipalIdentityOnEveryRequest(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Cf-Access-Authenticated-User-Email")) {
      headers.set("Cf-Access-Authenticated-User-Email", "principal@example.com");
    }
    return realFetch(input, { ...init, headers });
  }) as unknown as typeof globalThis.fetch;
}
beforeAll(installLoopbackPrincipalIdentityOnEveryRequest);
afterAll(() => {
  globalThis.fetch = realFetch;
});

type TestContext = McTestServer;

async function setup(): Promise<TestContext> {
  return startMcTestServer("mc-f12", { spawn: neverExitingCatSpawn });
}

const teardown = stopMcTestServer;

const PERMISSION_BLOCK_REASON = JSON.stringify({
  kind: "permission.request",
  payload: { requested_action: "tool.edit" },
});

function postAssignmentVerb(
  t: TestContext,
  assignmentId: string,
  verb: "requeue" | "abandon" | "handoff",
  body?: unknown
): Promise<Response> {
  return fetch(
    `${t.baseUrl}/api/assignments/${assignmentId}/${verb}`,
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  );
}

function curationEvents(db: Database, sessionId: string): { payload: string }[] {
  return db
    .query(
      "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
    )
    .all(sessionId) as { payload: string }[];
}

function readAssignmentState(db: Database, assignmentId: string): { state: string } {
  return db
    .query("SELECT state FROM agent_task_assignment WHERE id = ?")
    .get(assignmentId) as { state: string };
}

function readTaskStatus(db: Database, taskId: string): { status: string } {
  return db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
    status: string;
  };
}

function endSessionToFreeUniqueActiveSessionSlot(db: Database, sessionId: string): void {
  db.query(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run(
    sessionId
  );
}

function seedAssignment(
  db: Database,
  state: string,
  opts: { agentId?: string; taskId?: string; blockReason?: string | null } = {}
): { assignmentId: string; sessionId: string; agentId: string; taskId: string } {
  const agentId = opts.agentId ?? `a-${generateId()}`;
  const taskId = opts.taskId ?? `t-${generateId()}`;
  const assignmentId = `ata-${generateId()}`;

  db.query(
    `INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`
  ).run(agentId, "Test agent");
  db.query(
    `INSERT OR IGNORE INTO tasks (id, title, priority, principal_id, source_system)
     VALUES (?, ?, 1, 'op', 'internal')`
  ).run(taskId, "Test task");
  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason)
     VALUES (?, ?, ?, ?, ?)`
  ).run(assignmentId, agentId, taskId, state, opts.blockReason ?? null);

  const session = createSession(db, {
    assignmentId,
    endpointKind: "local.observed",
  });

  endSessionToFreeUniqueActiveSessionSlot(db, session.id);

  return { assignmentId, sessionId: session.id, agentId, taskId };
}

describe("POST /api/assignments/:id/requeue", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("requeues from blocked → queued and inserts principal.curation kind=requeue", async () => {
    const blockReason = PERMISSION_BLOCK_REASON;
    const { assignmentId, sessionId } = seedAssignment(t.db, "blocked", {
      blockReason,
    });

    const res = await postAssignmentVerb(t, assignmentId, "requeue");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.from).toBe("blocked");
    expect(body.to).toBe("queued");
    expect(typeof body.eventId).toBe("string");

    const row = t.db
      .query(
        "SELECT state, block_reason FROM agent_task_assignment WHERE id = ?"
      )
      .get(assignmentId) as { state: string; block_reason: string | null };
    expect(row.state).toBe("queued");
    expect(row.block_reason).toBeNull();

    const events = curationEvents(t.db, sessionId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("requeue");
  });

  it("requeues from failed → queued", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await postAssignmentVerb(t, assignmentId, "requeue");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBe("failed");
    expect(body.to).toBe("queued");
  });

  it("captures optional reason in the curation event payload", async () => {
    const { assignmentId, sessionId } = seedAssignment(t.db, "failed");
    const res = await postAssignmentVerb(t, assignmentId, "requeue", { reason: "external dep recovered" });
    expect(res.status).toBe(200);
    const events = curationEvents(t.db, sessionId);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).reason).toBe("external dep recovered");
  });

  it("returns 409 from running (Decision 3 — disabled)", async () => {
    const { assignmentId } = seedAssignment(t.db, "running");
    const res = await postAssignmentVerb(t, assignmentId, "requeue");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Invalid transition");
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await postAssignmentVerb(t, "does-not-exist", "requeue");
    expect(res.status).toBe(404);
  });

  it("returns 405 on GET", async () => {
    const { assignmentId } = seedAssignment(t.db, "blocked", {
      blockReason: PERMISSION_BLOCK_REASON,
    });
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`
    );
    expect(res.status).toBe(405);
  });

  it("returns 400 on non-string reason", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await postAssignmentVerb(t, assignmentId, "requeue", { reason: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects unknown body keys (400)", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await postAssignmentVerb(t, assignmentId, "requeue", { reason: "ok", bogus: 1 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("bogus");
  });
});

describe("POST /api/assignments/:id/abandon", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("Decision 5: cancels assignment when state is non-terminal (default scope)", async () => {
    const { assignmentId, sessionId, taskId } = seedAssignment(t.db, "queued");
    const res = await postAssignmentVerb(t, assignmentId, "abandon");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("assignment");
    expect(body.from).toBe("queued");
    expect(body.to).toBe("cancelled");

    const ataRow = readAssignmentState(t.db, assignmentId);
    expect(ataRow.state).toBe("cancelled");
    const taskRow = readTaskStatus(t.db, taskId);
    expect(taskRow.status).toBe("open");

    const events = curationEvents(t.db, sessionId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("abandon");
    expect(payload.targetKind).toBe("assignment");
  });

  it("Decision 5: cancels task when state is terminal (default scope)", async () => {
    const { assignmentId, sessionId, taskId } = seedAssignment(t.db, "completed");
    const res = await postAssignmentVerb(t, assignmentId, "abandon");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("task");
    expect(body.from).toBeUndefined();

    const taskRow = readTaskStatus(t.db, taskId);
    expect(taskRow.status).toBe("cancelled");
    const ataRow = readAssignmentState(t.db, assignmentId);
    expect(ataRow.state).toBe("completed");

    const events = curationEvents(t.db, sessionId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.targetKind).toBe("task");
  });

  it("Decision 5: from blocked, cancels assignment AND clears block_reason", async () => {
    const { assignmentId } = seedAssignment(t.db, "blocked", {
      blockReason: PERMISSION_BLOCK_REASON,
    });
    const res = await postAssignmentVerb(t, assignmentId, "abandon");
    expect(res.status).toBe(200);
    const row = t.db
      .query(
        "SELECT state, block_reason FROM agent_task_assignment WHERE id = ?"
      )
      .get(assignmentId) as { state: string; block_reason: string | null };
    expect(row.state).toBe("cancelled");
    expect(row.block_reason).toBeNull();
  });

  it("rejects scope=task on non-terminal assignment (409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "running");
    const res = await postAssignmentVerb(t, assignmentId, "abandon", { scope: "task" });
    expect(res.status).toBe(409);
  });

  it("rejects scope=assignment on terminal assignment (409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "completed");
    const res = await postAssignmentVerb(t, assignmentId, "abandon", { scope: "assignment" });
    expect(res.status).toBe(409);
  });

  it("rejects when task is already cancelled (409)", async () => {
    const { assignmentId, taskId } = seedAssignment(t.db, "completed");
    t.db
      .query(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`)
      .run(taskId);
    const res = await postAssignmentVerb(t, assignmentId, "abandon");
    expect(res.status).toBe(409);
  });

  it("rejects unknown scope (400)", async () => {
    const { assignmentId } = seedAssignment(t.db, "queued");
    const res = await postAssignmentVerb(t, assignmentId, "abandon", { scope: "everything" });
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await postAssignmentVerb(t, "does-not-exist", "abandon");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/assignments/:id/handoff", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  async function spawnControlledRunningSession(): Promise<{
    assignmentId: string;
    sessionId: string;
  }> {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "for-handoff" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return { assignmentId: body.assignmentId, sessionId: body.sessionId };
  }

  function ensureAgent(id: string, name = "Other agent"): void {
    t.db
      .query(
        `INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`
      )
      .run(id, name);
  }

  it("Decision 6: in-flight hand-off cancels the source assignment and spawns a new one", async () => {
    const { assignmentId: oldId, sessionId: oldSessionId } =
      await spawnControlledRunningSession();
    ensureAgent("agent-b");

    const res = await postAssignmentVerb(t, oldId, "handoff", { newAgentId: "agent-b", reason: "swap to head" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.newAssignmentId).toBe("string");
    expect(typeof body.newSessionId).toBe("string");
    expect(body.from).toBe("running");
    expect(body.to).toBe("cancelled");

    const oldRow = readAssignmentState(t.db, oldId);
    expect(oldRow.state).toBe("cancelled");

    const newRow = t.db
      .query("SELECT state, agent_id FROM agent_task_assignment WHERE id = ?")
      .get(body.newAssignmentId) as { state: string; agent_id: string };
    expect(newRow.state).toBe("running");
    expect(newRow.agent_id).toBe("agent-b");

    const events = curationEvents(t.db, body.newSessionId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("handoff");
    expect(payload.toAgentId).toBe("agent-b");
    expect(payload.newAssignmentId).toBe(body.newAssignmentId);
    expect(payload.reason).toBe("swap to head");

    const cancelEvents = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'state.transition'"
      )
      .all(oldSessionId) as { payload: string }[];
    const cancelHit = cancelEvents.find(
      (e) => JSON.parse(e.payload).action === "cancel"
    );
    expect(cancelHit).toBeDefined();
  });

  it("Decision 6: from `failed`, hand-off creates new assignment without a cancel", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    ensureAgent("agent-c");

    const res = await postAssignmentVerb(t, assignmentId, "handoff", { newAgentId: "agent-c" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBeUndefined();
    expect(body.to).toBeUndefined();

    const oldRow = readAssignmentState(t.db, assignmentId);
    expect(oldRow.state).toBe("failed");
  });

  it("rejects from `completed` (Decision 3 — disabled, 409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "completed");
    ensureAgent("agent-d");
    const res = await postAssignmentVerb(t, assignmentId, "handoff", { newAgentId: "agent-d" });
    expect(res.status).toBe(409);
  });

  it("rejects from `cancelled` (409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "cancelled");
    ensureAgent("agent-e");
    const res = await postAssignmentVerb(t, assignmentId, "handoff", { newAgentId: "agent-e" });
    expect(res.status).toBe(409);
  });

  it("returns 400 when newAgentId is missing", async () => {
    const { assignmentId } = await spawnControlledRunningSession();
    const res = await postAssignmentVerb(t, assignmentId, "handoff", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 when newAgentId references an unknown agent", async () => {
    const { assignmentId } = await spawnControlledRunningSession();
    const res = await postAssignmentVerb(t, assignmentId, "handoff", { newAgentId: "no-such-agent" });
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await postAssignmentVerb(t, "does-not-exist", "handoff", { newAgentId: "anyone" });
    expect(res.status).toBe(404);
  });

  it("rejects self-handoff (new agent == current agent, 400)", async () => {
    const { assignmentId } = await spawnControlledRunningSession();
    const { agent_id: defaultAgentId } = t.db
      .query("SELECT agent_id FROM agent_task_assignment WHERE id = ?")
      .get(assignmentId) as { agent_id: string };
    const res = await postAssignmentVerb(t, assignmentId, "handoff", { newAgentId: defaultAgentId });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("same agent");
  });

  it("rejects unknown body keys (400)", async () => {
    const { assignmentId } = await spawnControlledRunningSession();
    ensureAgent("agent-strict");
    const res = await postAssignmentVerb(t, assignmentId, "handoff", {
    newAgentId: "agent-strict",
    reason: "ok",
    nefarious: true,
  });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nefarious");
  });
});
