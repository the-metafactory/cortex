/**
 * Grove Mission Control v2 — F-12 task curation endpoints.
 *
 * Exercises the three new endpoints (requeue/abandon/handoff) and pins:
 *   - per-state enablement matrix (Decision 3) on the wire side: legal verbs
 *     return 200; illegal verbs return 409 with the state-machine's error
 *     string (or the handler's friendlier 409 for the abandon-scope branches).
 *   - 404 on unknown assignment id, 400 on malformed body.
 *   - Decision 5 abandon-scope branching: active assignment → cancel
 *     assignment; terminal assignment → cancel task.
 *   - Decision 6 hand-off semantics: in-flight cancels-then-spawns; failed
 *     spawns only.
 *   - Decision 9 principal.curation events are inserted with the correct
 *     `kind` discriminator and broadcast via the WS surface.
 *   - Decision 11 observer side effects (process-kill on cancelled / requeue
 *     from blocked) are exercised with a fake `cat` spawn.
 */

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
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer } from "../server";
import type { ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import { createSession } from "../db/sessions";
import { generateId } from "../db/events";

/** `cat` stands in for `claude` — reads stdin, never exits on its own. */
const fakeCatSpawn: SpawnFn = () =>
  Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

// FND-6: the curation mutations (requeue/abandon/handoff) now require a
// CF-Access identity on the loopback bind (mutation-guard identity gate). These
// tests exercise HANDLER behavior, not the gate — the gate has its own coverage
// in mutation-guard-rebinding.test.ts — so inject the loopback principal header
// on every test-server call here.
const _realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Cf-Access-Authenticated-User-Email")) {
      headers.set("Cf-Access-Authenticated-User-Email", "principal@example.com");
    }
    return _realFetch(input, { ...init, headers });
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = _realFetch;
});

interface TestContext {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

function makePort(): number {
  return 21000 + Math.floor(Math.random() * 1000);
}

async function setup(): Promise<TestContext> {
  const tmpDir = join(tmpdir(), `mc-f12-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const port = makePort();
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port },
    db,
    { processManager: pm, spawn: fakeCatSpawn }
  );
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

/**
 * Seed a self-contained assignment + session in `state`. Returns ids for
 * subsequent endpoint calls. Avoids POST /api/sessions because we want
 * direct control over the assignment state — the spawn loop forces
 * queued→dispatched→running, which is the wrong starting state for several
 * matrix entries.
 */
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

  // Mark observed sessions (the seed helper) ended_at so the spawn-controlled
  // path can run without colliding on the unique-active-session index.
  db.query(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run(
    session.id
  );

  return { assignmentId, sessionId: session.id, agentId, taskId };
}

// ============================================================================
// POST /api/assignments/:id/requeue
// ============================================================================

describe("POST /api/assignments/:id/requeue", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("requeues from blocked → queued and inserts principal.curation kind=requeue", async () => {
    const blockReason = JSON.stringify({
      kind: "permission.request",
      payload: { requested_action: "tool.edit" },
    });
    const { assignmentId, sessionId } = seedAssignment(t.db, "blocked", {
      blockReason,
    });

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.from).toBe("blocked");
    expect(body.to).toBe("queued");
    expect(typeof body.eventId).toBe("string");

    // DB: state moved to queued, block_reason cleared.
    const row = t.db
      .query(
        "SELECT state, block_reason FROM agent_task_assignment WHERE id = ?"
      )
      .get(assignmentId) as { state: string; block_reason: string | null };
    expect(row.state).toBe("queued");
    expect(row.block_reason).toBeNull();

    // principal.curation event present with kind=requeue.
    const events = t.db
      .query(
        "SELECT type, payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(sessionId) as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("requeue");
  });

  it("requeues from failed → queued", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBe("failed");
    expect(body.to).toBe("queued");
  });

  it("captures optional reason in the curation event payload", async () => {
    const { assignmentId, sessionId } = seedAssignment(t.db, "failed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "external dep recovered" }),
      }
    );
    expect(res.status).toBe(200);
    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(sessionId) as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).reason).toBe("external dep recovered");
  });

  it("returns 409 from running (Decision 3 — disabled)", async () => {
    const { assignmentId } = seedAssignment(t.db, "running");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Invalid transition");
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await fetch(
      `${t.baseUrl}/api/assignments/does-not-exist/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 405 on GET", async () => {
    const { assignmentId } = seedAssignment(t.db, "blocked", {
      blockReason: JSON.stringify({
        kind: "permission.request",
        payload: { requested_action: "tool.edit" },
      }),
    });
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`
    );
    expect(res.status).toBe(405);
  });

  it("returns 400 on non-string reason", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: 42 }),
      }
    );
    expect(res.status).toBe(400);
  });

  // PR #30 S3 — strict shape validation. Unknown keys must be rejected
  // (the RequeueRequest type only defines `reason`).
  it("rejects unknown body keys (400)", async () => {
    const { assignmentId } = seedAssignment(t.db, "failed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "ok", bogus: 1 }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("bogus");
  });
});

// ============================================================================
// POST /api/assignments/:id/abandon
// ============================================================================

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
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("assignment");
    expect(body.from).toBe("queued");
    expect(body.to).toBe("cancelled");

    // Assignment cancelled, task UNTOUCHED.
    const ataRow = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(assignmentId) as { state: string };
    expect(ataRow.state).toBe("cancelled");
    const taskRow = t.db
      .query("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string };
    expect(taskRow.status).toBe("open");

    // Curation event with kind=abandon, targetKind=assignment.
    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(sessionId) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("abandon");
    expect(payload.targetKind).toBe("assignment");
  });

  it("Decision 5: cancels task when state is terminal (default scope)", async () => {
    const { assignmentId, sessionId, taskId } = seedAssignment(t.db, "completed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("task");
    expect(body.from).toBeUndefined();

    // Task moved to cancelled; assignment row UNTOUCHED.
    const taskRow = t.db
      .query("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string };
    expect(taskRow.status).toBe("cancelled");
    const ataRow = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(assignmentId) as { state: string };
    expect(ataRow.state).toBe("completed");

    // Curation event landed on the latest (terminal) session.
    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(sessionId) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.targetKind).toBe("task");
  });

  it("Decision 5: from blocked, cancels assignment AND clears block_reason", async () => {
    const { assignmentId } = seedAssignment(t.db, "blocked", {
      blockReason: JSON.stringify({
        kind: "permission.request",
        payload: { requested_action: "tool.edit" },
      }),
    });
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
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
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "task" }),
      }
    );
    expect(res.status).toBe(409);
  });

  it("rejects scope=assignment on terminal assignment (409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "completed");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "assignment" }),
      }
    );
    expect(res.status).toBe(409);
  });

  it("rejects when task is already cancelled (409)", async () => {
    const { assignmentId, taskId } = seedAssignment(t.db, "completed");
    t.db
      .query(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`)
      .run(taskId);
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(409);
  });

  it("rejects unknown scope (400)", async () => {
    const { assignmentId } = seedAssignment(t.db, "queued");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "everything" }),
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await fetch(
      `${t.baseUrl}/api/assignments/does-not-exist/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/assignments/:id/handoff
// ============================================================================

describe("POST /api/assignments/:id/handoff", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  /**
   * Hand-off needs a controlled session in flight to exercise step 1's
   * cancel — so we POST /api/sessions to spawn one rather than seeding
   * with `local.observed`.
   */
  async function spawnRunning(): Promise<{
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
      await spawnRunning();
    ensureAgent("agent-b");

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${oldId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-b", reason: "swap to head" }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.newAssignmentId).toBe("string");
    expect(typeof body.newSessionId).toBe("string");
    expect(body.from).toBe("running");
    expect(body.to).toBe("cancelled");

    // OLD assignment cancelled.
    const oldRow = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(oldId) as { state: string };
    expect(oldRow.state).toBe("cancelled");

    // NEW assignment exists, in `running`, owned by `agent-b`.
    const newRow = t.db
      .query("SELECT state, agent_id FROM agent_task_assignment WHERE id = ?")
      .get(body.newAssignmentId) as { state: string; agent_id: string };
    expect(newRow.state).toBe("running");
    expect(newRow.agent_id).toBe("agent-b");

    // Curation event on the NEW session with kind=handoff.
    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(body.newSessionId) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("handoff");
    expect(payload.toAgentId).toBe("agent-b");
    expect(payload.newAssignmentId).toBe(body.newAssignmentId);
    expect(payload.reason).toBe("swap to head");

    // OLD session has the cancel state.transition event.
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

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-c" }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // No cancel happened — `from`/`to` are absent on the response.
    expect(body.from).toBeUndefined();
    expect(body.to).toBeUndefined();

    // Source assignment row still `failed`.
    const oldRow = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(assignmentId) as { state: string };
    expect(oldRow.state).toBe("failed");
  });

  it("rejects from `completed` (Decision 3 — disabled, 409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "completed");
    ensureAgent("agent-d");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-d" }),
      }
    );
    expect(res.status).toBe(409);
  });

  it("rejects from `cancelled` (409)", async () => {
    const { assignmentId } = seedAssignment(t.db, "cancelled");
    ensureAgent("agent-e");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-e" }),
      }
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when newAgentId is missing", async () => {
    const { assignmentId } = await spawnRunning();
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when newAgentId references an unknown agent", async () => {
    const { assignmentId } = await spawnRunning();
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "no-such-agent" }),
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown assignment id", async () => {
    const res = await fetch(
      `${t.baseUrl}/api/assignments/does-not-exist/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "anyone" }),
      }
    );
    expect(res.status).toBe(404);
  });

  // PR #30 W3 — self-handoff rejection. Without this guard the endpoint
  // cancel-and-respawns to the same agent and emits a misleading `handoff`
  // audit event. Return 400 with a clear message instead.
  it("rejects self-handoff (new agent == current agent, 400)", async () => {
    const { assignmentId } = await spawnRunning();
    // The POST /api/sessions path assigns the well-known default agent.
    const row = t.db
      .query("SELECT agent_id FROM agent_task_assignment WHERE id = ?")
      .get(assignmentId) as { agent_id: string };
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: row.agent_id }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("same agent");
  });

  // PR #30 S2 — strict shape validation. Unknown keys must be rejected
  // rather than silently ignored (the loose `as HandoffRequest` cast used
  // to accept arbitrary payloads).
  it("rejects unknown body keys (400)", async () => {
    const { assignmentId } = await spawnRunning();
    ensureAgent("agent-strict");
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAgentId: "agent-strict",
          reason: "ok",
          nefarious: true,
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nefarious");
  });
});
