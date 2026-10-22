import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer } from "../server";
import type { ServerContext } from "../server";
import type { StartServerOptions } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import { createSession } from "../db/sessions";
import { insertEvent, EVENTS_LIST_MAX_LIMIT } from "../db/events";
import { _resetDispatchDebounceForTests } from "../api/handlers";
import * as shouldNotifyModule from "../notifications/should-notify";
import { ingestLedgerEnvelope } from "../../../vigil/ingest";
import { ledgerEnvelope, ENDED_AT } from "../../../vigil/__tests__/fixtures";

const catStandInForClaude: SpawnFn = () =>
  Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

const _realFetch = globalThis.fetch;
const LOOPBACK_PRINCIPAL_EMAIL = "principal@example.com";
function fetchAsLoopbackPrincipalPassingTheMutationGuard(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cf-Access-Authenticated-User-Email")) {
    headers.set("Cf-Access-Authenticated-User-Email", LOOPBACK_PRINCIPAL_EMAIL);
  }
  return _realFetch(input, { ...init, headers });
}
beforeAll(() => {
  globalThis.fetch =
    fetchAsLoopbackPrincipalPassingTheMutationGuard as unknown as typeof globalThis.fetch;
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

const PORT_BIND_ANY = 0;

async function setup(options: StartServerOptions = {}): Promise<TestContext> {
  const tmpDir = join(tmpdir(), `mc-api-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port: PORT_BIND_ANY },
    db,
    { processManager: pm, spawn: catStandInForClaude, ...options }
  );
  const port = ctx.port;
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

function reopenDatabaseForTeardown(t: TestContext): void {
  t.db = initDatabase(join(t.tmpDir, "test.db"));
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

describe("GET /api/vigil/subjects", () => {
  let t: TestContext;
  afterEach(async () => { await teardown(t); });

  it("returns only local subjects with request-time wording and configured cadence", async () => {
    const key = "run:job:default:harness-gate";
    t = await setup({ vigil: {
      enabled: true, resolveGoalWording: () => "Example goal", cadence: { [key]: 3_600_000 },
    } });
    ingestLedgerEnvelope(t.db, ledgerEnvelope({
      ran: { kind: "job", ref: "harness-gate" }, serves: { goal: "G1" },
    }), ENDED_AT);
    const before = t.db.query("SELECT total_changes() AS changes").get();
    const response = await fetch(`${t.baseUrl}/api/vigil/subjects`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subjects: [expect.objectContaining({
      subjectKey: key, goalId: "G1", goalWording: "Example goal", expectedBy: ENDED_AT + 3_600_000,
    })] });
    expect(t.db.query("SELECT total_changes() AS changes").get()).toEqual(before);
  });

  it.each([undefined, { enabled: false }])("returns a disabled empty response when Vigil is not enabled (%j)", async (vigil) => {
    t = await setup({ vigil });
    ingestLedgerEnvelope(t.db, ledgerEnvelope(), ENDED_AT);
    const response = await fetch(`${t.baseUrl}/api/vigil/subjects`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subjects: [], enabled: false });
  });

  it("does not read sibling subjects when local aggregation is enabled", async () => {
    const resolved: string[] = [];
    t = await setup({
      vigil: { enabled: true, resolveGoalWording: (id) => { resolved.push(id); return "Example goal"; } },
      localAggregation: () => ({
        siblings: [{ stack: "work", principal: "example", url: "nats://127.0.0.1:4222", credential: { kind: "noauth" } }],
        resolve: { configRoot: t.tmpDir, homeShareDir: join(t.tmpDir, "share") },
      }),
    });
    const siblingDb = initDatabase(join(t.tmpDir, "share", "work", "mission-control.db"));
    try {
      ingestLedgerEnvelope(siblingDb, ledgerEnvelope({ serves: { goal: "G2" } }), ENDED_AT);
    } finally {
      siblingDb.close();
    }
    ingestLedgerEnvelope(t.db, ledgerEnvelope({ serves: { goal: "G1" } }), ENDED_AT);
    const response = await fetch(`${t.baseUrl}/api/vigil/subjects`);
    expect(response.status).toBe(200);
    expect((await response.json()).subjects).toHaveLength(1);
    expect(resolved).toEqual(["G1"]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("returns methodNotAllowed for %s", async (method) => {
    t = await setup();
    const response = await fetch(`${t.baseUrl}/api/vigil/subjects`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("GET /api/assignments", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns an empty list when the DB has no assignments", async () => {
    const res = await fetch(`${t.baseUrl}/api/assignments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ assignments: [] });
  });

  it("lists assignments with joined task and most-recent session", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-1', 'Do a thing', 1, 'op', 'internal')`
    );
    t.db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    t.db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'a-1', 't-1', 'running')`
    );
    createSession(t.db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });

    const res = await fetch(`${t.baseUrl}/api/assignments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    const item = body.assignments[0];
    expect(item.id).toBe("ata-1");
    expect(item.state).toBe("running");
    expect(item.task.title).toBe("Do a thing");
    expect(item.session.endpoint_kind).toBe("local.observed");
    expect(item.session.ended_at).toBeNull();
  });

  it("returns 405 on POST /api/assignments", async () => {
    const res = await fetch(`${t.baseUrl}/api/assignments`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/focus-area", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seed(
    id: string,
    state: string,
    priority: number,
    updatedSecondsAgo: number,
    blockReasonJson: string | null = null
  ): void {
    t.db.query(
      `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`
    ).run();
    t.db
      .query(
        `INSERT INTO tasks (id, title, priority, principal_id, source_system)
         VALUES (?, ?, ?, 'op', 'internal')`
      )
      .run(`task-${id}`, `Task ${id}`, priority);
    t.db
      .query(
        `INSERT INTO agent_task_assignment
           (id, agent_id, task_id, state, block_reason, updated_at)
         VALUES (?, 'a-1', ?, ?, ?, datetime('now', ? || ' seconds'))`
      )
      .run(id, `task-${id}`, state, blockReasonJson, -updatedSecondsAgo);
  }

  it("returns an empty list when nothing is blocked, with the running assignment as mostActiveAgent", async () => {
    seed("ata-running", "running", 0, 0);
    const res = await fetch(`${t.baseUrl}/api/focus-area`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.mostActiveAgent).not.toBeNull();
    expect(body.mostActiveAgent.assignmentId).toBe("ata-running");
    expect(body.mostActiveAgent.taskTitle).toBe("Task ata-running");
  });

  it("returns mostActiveAgent: null when no assignment is running", async () => {
    const permissionReason = JSON.stringify({
      kind: "permission.request",
      payload: { requested_action: "tool.edit" },
    });
    seed("only-blocked", "blocked", 0, 10, permissionReason);
    const res = await fetch(`${t.baseUrl}/api/focus-area`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.mostActiveAgent).toBeNull();
  });

  it("returns only blocked assignments, ordered by priority ASC then updated_at ASC", async () => {
    const permissionReason = JSON.stringify({
      kind: "permission.request",
      payload: { requested_action: "tool.edit" },
    });
    seed("p2-newer", "blocked", 2, 10, permissionReason);
    seed("p0-newer", "blocked", 0, 10, permissionReason);
    seed("p0-older", "blocked", 0, 100, permissionReason);
    seed("p1-only", "blocked", 1, 30, permissionReason);
    seed("running", "running", 0, 0);
    seed("completed", "completed", 0, 0);

    const res = await fetch(`${t.baseUrl}/api/focus-area`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(["p0-older", "p0-newer", "p1-only", "p2-newer"]);
    for (const item of body.items) {
      expect(item.state).toBe("blocked");
      expect(item.block_reason).not.toBeNull();
      expect(item.block_reason.kind).toBe("permission.request");
    }
  });

  it("returns 405 on POST /api/focus-area", async () => {
    const res = await fetch(`${t.baseUrl}/api/focus-area`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("POST /api/sessions", () => {
  let t: TestContext;
  beforeEach(async () => {
    _resetDispatchDebounceForTests();
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("creates task + assignment + controlled session and returns ids", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.assignmentId).toBe("string");
    expect(typeof body.sessionId).toBe("string");

    const row = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(body.assignmentId) as { state: string } | null;
    expect(row?.state).toBe("running");

    const sess = t.db
      .query("SELECT endpoint_kind FROM sessions WHERE id = ?")
      .get(body.sessionId) as { endpoint_kind: string } | null;
    expect(sess?.endpoint_kind).toBe("local.process.controlled");

    expect(t.pm.size).toBe(1);
  });

  it("writes the initial prompt as a principal.input event", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "With prompt", prompt: "hello there" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const events = t.db
      .query("SELECT type, payload FROM events WHERE session_id = ? ORDER BY timestamp")
      .all(body.sessionId) as { type: string; payload: string }[];
    const principalInputs = events.filter((e) => e.type === "principal.input");
    expect(principalInputs).toHaveLength(1);
    const first = principalInputs[0]!;
    expect(JSON.parse(first.payload).text).toBe("hello there");
  });

  it("returns 405 on GET /api/sessions", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`);
    expect(res.status).toBe(405);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("emits a principal.curation event with kind=dispatch on successful create", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "audit-trail" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(body.sessionId) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("dispatch");
    expect(typeof payload.agentId).toBe("string");
    expect(payload.newAssignmentId).toBe(body.assignmentId);
  });

  it("debounces a same-taskId dispatch within 2 seconds (409)", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-debounce', 'task', 1, 'op', 'internal')`
    );

    const first = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "t-debounce" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(typeof firstBody.assignmentId).toBe("string");

    const second = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "t-debounce" }),
    });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error).toContain(firstBody.assignmentId);

    const rows = t.db
      .query(
        "SELECT id FROM agent_task_assignment WHERE task_id = 't-debounce'"
      )
      .all() as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("does NOT debounce when body.taskId is omitted (each call mints a fresh task)", async () => {
    const first = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no-debounce-1" }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no-debounce-2" }),
    });
    expect(second.status).toBe(201);
  });

  it("concurrent same-taskId dispatches: exactly one 201, the other 409", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-race', 'task', 1, 'op', 'internal')`
    );
    const [a, b] = await Promise.all([
      fetch(`${t.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "t-race" }),
      }),
      fetch(`${t.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "t-race" }),
      }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);

    const rows = t.db
      .query(`SELECT id FROM agent_task_assignment WHERE task_id = 't-race'`)
      .all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(t.pm.size).toBe(1);
  });

  it("kind=local.observed registers a session without spawning", async () => {
    const ccUuid = "11111111-2222-3333-4444-555555555555";
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "observed-test",
        kind: "local.observed",
        ccSessionId: ccUuid,
        agentId: "andreas",
        agentName: "Andreas",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.assignmentId).toBe("string");
    expect(typeof body.sessionId).toBe("string");

    expect(t.pm.size).toBe(0);

    const sess = t.db
      .query(
        "SELECT endpoint_kind, cc_session_id FROM sessions WHERE id = ?"
      )
      .get(body.sessionId) as {
      endpoint_kind: string;
      cc_session_id: string;
    } | null;
    expect(sess?.endpoint_kind).toBe("local.observed");
    expect(sess?.cc_session_id).toBe(ccUuid);

    const ata = t.db
      .query("SELECT state FROM agent_task_assignment WHERE id = ?")
      .get(body.assignmentId) as { state: string } | null;
    expect(ata?.state).toBe("dispatched");

    const agent = t.db
      .query("SELECT name FROM agents WHERE id = 'andreas'")
      .get() as { name: string } | null;
    expect(agent?.name).toBe("Andreas");
  });

  it("kind=local.observed without ccSessionId returns 400", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local.observed" }),
    });
    expect(res.status).toBe(400);
  });

  it("kind=local.observed with non-UUID ccSessionId returns 400", async () => {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "local.observed",
        ccSessionId: "not-a-uuid",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("kind=local.observed with duplicate ccSessionId returns 409 + rolls back the orphan rows", async () => {
    const ccUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const a = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local.observed", ccSessionId: ccUuid }),
    });
    expect(a.status).toBe(201);
    const aBody = await a.json();

    const taskCountBefore = (
      t.db.query("SELECT count(*) AS n FROM tasks").get() as { n: number }
    ).n;
    const ataCountBefore = (
      t.db
        .query("SELECT count(*) AS n FROM agent_task_assignment")
        .get() as { n: number }
    ).n;

    const b = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local.observed", ccSessionId: ccUuid }),
    });
    expect(b.status).toBe(409);

    const taskCountAfter = (
      t.db.query("SELECT count(*) AS n FROM tasks").get() as { n: number }
    ).n;
    const ataCountAfter = (
      t.db
        .query("SELECT count(*) AS n FROM agent_task_assignment")
        .get() as { n: number }
    ).n;
    expect(taskCountAfter).toBe(taskCountBefore);
    expect(ataCountAfter).toBe(ataCountBefore);

    const stillThere = t.db
      .query("SELECT id FROM agent_task_assignment WHERE id = ?")
      .get(aBody.assignmentId);
    expect(stillThere).not.toBeNull();
  });

  it("ensureNamedAgent: re-POST with a different agentName does NOT update the existing row", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    const a = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "local.observed",
        ccSessionId: u1,
        agentId: "andreas",
        agentName: "First Name",
      }),
    });
    expect(a.status).toBe(201);
    const b = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "local.observed",
        ccSessionId: u2,
        agentId: "andreas",
        agentName: "Second Name",
      }),
    });
    expect(b.status).toBe(201);
    const row = t.db
      .query("SELECT name FROM agents WHERE id = 'andreas'")
      .get() as { name: string };
    expect(row.name).toBe("First Name");
  });
});

describe("POST /api/sessions — F-11 Discord notification hook", () => {
  let t: TestContext;
  let calls: { from: string; to: string }[];

  beforeEach(async () => {
    const tmpDir = join(tmpdir(), `mc-api-f11-${Date.now()}-${Math.random()}`);
    const db = initDatabase(join(tmpDir, "test.db"));
    const pm = new ProcessManager();
    calls = [];

    const countingNotifier = {
      async sendDM(_userId: string, _text: string) {
        calls.push({ from: "<sendDM>", to: "<DM>" });
      },
      async sendChannelMessage(_channelId: string, _text: string) {
        calls.push({ from: "<sendChannel>", to: "<channel>" });
      },
    };

    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: PORT_BIND_ANY },
      db,
      {
        processManager: pm,
        spawn: catStandInForClaude,
        notify: {
          config: {
            enabled: true,
            baseUrl: "http://localhost:8766",
            operatorDiscordId: "OP_DISCORD_ID",
            fallbackChannelId: "CHANNEL_FALLBACK",
          },
          notifier: countingNotifier,
        },
      }
    );
    const port = ctx.port;
    t = { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("create-session loop runs the notify policy once per transition yet sends no Discord traffic (queued→dispatched + dispatched→running are silent)", async () => {
    const shouldNotifySpy = spyOn(shouldNotifyModule, "shouldNotify");
    shouldNotifySpy.mockClear();
    try {
      const res = await fetch(`${t.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Quiet spawn" }),
      });
      expect(res.status).toBe(201);
      expect(calls).toHaveLength(0);
      expect(shouldNotifySpy).toHaveBeenCalledTimes(2);
    } finally {
      shouldNotifySpy.mockRestore();
    }
  });
});

describe("POST /api/assignments/:id/input", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("writes input to an active controlled session", async () => {
    const create = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "For input" }),
    });
    expect(create.status).toBe(201);
    const { assignmentId, sessionId } = await create.json();

    const send = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second turn" }),
      }
    );
    expect(send.status).toBe(200);
    const body = await send.json();
    expect(body.ok).toBe(true);
    expect(typeof body.eventId).toBe("string");

    const events = t.db
      .query("SELECT type, payload FROM events WHERE session_id = ? AND type = 'principal.input'")
      .all(sessionId) as { payload: string }[];
    const texts = events.map((e) => JSON.parse(e.payload).text as string);
    expect(texts).toContain("second turn");
  });

  it("returns 404 when the assignment has no active session", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-x', 'Orphan', 2, 'op', 'internal')`
    );
    t.db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-x', 'X', 'hands')`);
    t.db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-x', 'a-x', 't-x', 'queued')`
    );

    const res = await fetch(`${t.baseUrl}/api/assignments/ata-x/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the session is observed (not controllable)", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-obs', 'Observed', 2, 'op', 'internal')`
    );
    t.db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-obs', 'Obs', 'hands')`);
    t.db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-obs', 'a-obs', 't-obs', 'running')`
    );
    createSession(t.db, {
      assignmentId: "ata-obs",
      endpointKind: "local.observed",
    });

    const res = await fetch(`${t.baseUrl}/api/assignments/ata-obs/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "nope" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 when body is missing text", async () => {
    const create = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { assignmentId } = await create.json();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(400);
  });

  it("accepts text exactly at the 50 KB byte cap", async () => {
    const create = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "At cap" }),
    });
    const { assignmentId } = await create.json();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(51200) }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 413 when text exceeds the 50 KB byte cap by one byte", async () => {
    const create = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Over cap" }),
    });
    const { assignmentId } = await create.json();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(51201) }),
      }
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Principal input exceeds the 50 KB limit.");
  });

  it("returns 413 for multi-byte text whose UTF-8 byte length exceeds the cap", async () => {
    const create = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Multi-byte over cap" }),
    });
    const { assignmentId } = await create.json();
    const threeByteEuroSignsOverCapInBytesUnderCapInChars = "€".repeat(20000);

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: threeByteEuroSignsOverCapInBytesUnderCapInChars }),
      }
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Principal input exceeds the 50 KB limit.");
  });

  it("returns 413 from the upstream body cap on /api/sessions raw bodies larger than the default 128 KB JSON-body limit", async () => {
    const overDefault128KbBodyCap = JSON.stringify({ title: "a".repeat(200 * 1024) });
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: overDefault128KbBodyCap,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Request body exceeds the size limit.");
  });

  const ONE_PIXEL_TRANSPARENT_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  async function createAssignment(): Promise<string> {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "img" }),
    });
    const { assignmentId } = await res.json();
    return assignmentId;
  }

  it("accepts text + one valid image (200)", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "look at this",
        images: [{ media_type: "image/png", data: ONE_PIXEL_TRANSPARENT_PNG_B64 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("accepts image-only body (text absent) and stores images on principal.input", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [{ media_type: "image/png", data: ONE_PIXEL_TRANSPARENT_PNG_B64 }],
      }),
    });
    expect(res.status).toBe(200);
    const stored = t.db
      .query(
        "SELECT payload FROM events WHERE type = 'principal.input' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload: string };
    const parsed = JSON.parse(stored.payload) as {
      text?: string;
      images?: { media_type: string; data: string }[];
    };
    expect(parsed.text).toBeUndefined();
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images![0]!.media_type).toBe("image/png");
  });

  it("rejects body with neither text nor images (400)", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects disallowed media_type (400)", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [{ media_type: "image/svg+xml", data: "AAAA" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });

  it("rejects malformed base64 (400)", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [{ media_type: "image/png", data: "not!!!valid" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not valid base64");
  });

  it("rejects more than 8 images (413)", async () => {
    const id = await createAssignment();
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: Array.from({ length: 9 }, () => ({
          media_type: "image/png",
          data: ONE_PIXEL_TRANSPARENT_PNG_B64,
        })),
      }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("8 images");
  });

  it("rejects a single image over 5 MB decoded (413) with the per-image message", async () => {
    const id = await createAssignment();
    const overFiveMbDecodedUnderEndpointCap = "A".repeat(7 * 1024 * 1024);
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [{ media_type: "image/png", data: overFiveMbDecodedUnderEndpointCap }],
      }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("5 MB per-image limit");
  });

  it("accepts a ~10 MB image-only body on the per-endpoint 25 MB cap (200)", async () => {
    const id = await createAssignment();
    const underFiveMbDecodedOverDefault128KbBodyCap = "A".repeat(Math.floor(3.5 * 1024 * 1024 * 4 / 3));
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [{ media_type: "image/png", data: underFiveMbDecodedOverDefault128KbBodyCap }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a 40 MB body with the upstream cap message, not the handler's attachment copy (413)", async () => {
    const id = await createAssignment();
    const overTwentyFiveMbEndpointCap = "A".repeat(40 * 1024 * 1024);
    const res = await fetch(`${t.baseUrl}/api/assignments/${id}/input`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(40 * 1024 * 1024 + 128),
      },
      body: JSON.stringify({
        images: [{ media_type: "image/png", data: overTwentyFiveMbEndpointCap }],
      }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Request body exceeds the size limit.");
  });

  it("returns 409 on an observed session even with valid images", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-obs', 'Observed', 2, 'op', 'internal')`
    );
    t.db.exec(
      `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag-obs', 'Obs', 'hands')`
    );
    t.db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-obs-img', 'ag-obs', 't-obs', 'running')`
    );
    const { createSession } = await import("../db/sessions");
    createSession(t.db, {
      assignmentId: "ata-obs-img",
      endpointKind: "local.observed",
    });
    const res = await fetch(
      `${t.baseUrl}/api/assignments/ata-obs-img/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          images: [{ media_type: "image/png", data: ONE_PIXEL_TRANSPARENT_PNG_B64 }],
        }),
      }
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /api/assignments/:id/events", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedEvents(eventCount: number): {
    assignmentId: string;
    sessionId: string;
    eventIds: string[];
  } {
    t.db.run(
      `INSERT INTO agents (id, name, type, persistent) VALUES ('agent-evt', 'Evt', 'hands', 1)`
    );
    t.db.run(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('task-evt', 'Events task', 2, 'op', 'internal')`
    );
    const assignmentId = "ata-evt";
    t.db.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES (?, 'agent-evt', 'task-evt', 'running')`,
      [assignmentId]
    );
    const session = createSession(t.db, {
      assignmentId,
      endpointKind: "local.process.controlled",
    });

    const eventIds: string[] = [];
    for (let i = 0; i < eventCount; i += 1) {
      const ev = insertEvent(t.db, {
        sessionId: session.id,
        type: i % 2 === 0 ? "stream-json.assistant" : "stream-json.user",
        payload: { idx: i },
      });
      eventIds.push(ev.id);
    }
    return { assignmentId, sessionId: session.id, eventIds };
  }

  it("404s for unknown assignment", async () => {
    const res = await fetch(
      `${t.baseUrl}/api/assignments/does-not-exist/events`
    );
    expect(res.status).toBe(404);
  });

  it("returns empty + null sessionId when assignment has no session", async () => {
    t.db.run(
      `INSERT INTO agents (id, name, type, persistent) VALUES ('a-ns', 'Ns', 'hands', 1)`
    );
    t.db.run(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-ns', 'No session', 2, 'op', 'internal')`
    );
    t.db.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-ns', 'a-ns', 't-ns', 'queued')`
    );
    const res = await fetch(`${t.baseUrl}/api/assignments/ata-ns/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      hasMore: boolean;
      sessionId: string | null;
    };
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.sessionId).toBeNull();
  });

  it("returns the newest page ascending by id with hasMore flag", async () => {
    const { assignmentId, sessionId, eventIds } = seedEvents(5);
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?limit=3`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { id: string }[];
      hasMore: boolean;
      sessionId: string;
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.hasMore).toBe(true);
    expect(body.events.map((e) => e.id)).toEqual(eventIds.slice(2, 5));
  });

  it("paginates backwards via the `before` cursor", async () => {
    const { assignmentId, eventIds } = seedEvents(5);
    const page1 = (await (await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?limit=2`
    )).json()) as { events: { id: string }[]; hasMore: boolean };
    expect(page1.events.map((e) => e.id)).toEqual(eventIds.slice(3, 5));
    expect(page1.hasMore).toBe(true);

    const firstId = page1.events[0]!.id;
    const page2 = (await (await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?limit=2&before=${firstId}`
    )).json()) as { events: { id: string }[]; hasMore: boolean };
    expect(page2.events.map((e) => e.id)).toEqual(eventIds.slice(1, 3));
    expect(page2.hasMore).toBe(true);

    const page3 = (await (await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?limit=2&before=${page2.events[0]!.id}`
    )).json()) as { events: { id: string }[]; hasMore: boolean };
    expect(page3.events.map((e) => e.id)).toEqual([eventIds[0]!]);
    expect(page3.hasMore).toBe(false);
  });

  it("clamps limit at EVENTS_LIST_MAX_LIMIT and sets hasMore=true", async () => {
    const extra = 5;
    const { assignmentId } = seedEvents(EVENTS_LIST_MAX_LIMIT + extra);
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?limit=99999`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      hasMore: boolean;
    };
    expect(body.events.length).toBe(EVENTS_LIST_MAX_LIMIT);
    expect(body.hasMore).toBe(true);
  });

  it("rejects `before` values longer than 64 chars with 400", async () => {
    const { assignmentId } = seedEvents(1);
    const longId = "A".repeat(65);
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events?before=${longId}`
    );
    expect(res.status).toBe(400);
  });

  it("does not echo the assignment id in the 404 error body", async () => {
    const res = await fetch(
      `${t.baseUrl}/api/assignments/attacker-payload-xyz/events`
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("attacker-payload-xyz");
  });

  it("405s on non-GET", async () => {
    const { assignmentId } = seedEvents(1);
    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/events`,
      { method: "POST" }
    );
    expect(res.status).toBe(405);
  });
});

describe("REST unavailable without ProcessManager", () => {
  it("returns 503 on POST /api/sessions", async () => {
    const tmpDir = join(tmpdir(), `mc-api-test-noop-${Date.now()}`);
    const db = initDatabase(join(tmpDir, "test.db"));
    const ctx = startServer({ ...DEFAULT_CONFIG, port: PORT_BIND_ANY }, db);
    const port = ctx.port;
    try {
      const res = await fetch(`http://localhost:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
    } finally {
      ctx.stop(true);
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/tasks", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedTask(
    id: string,
    opts: {
      title?: string;
      priority?: number;
      status?: string;
      createdOffsetSec?: number;
      updatedOffsetSec?: number;
      sourceSystem?: "github" | "internal";
      sourceExternalId?: string | null;
      sourceUrl?: string | null;
      assignments?: { id: string; agentId: string; state: string }[];
    } = {}
  ): void {
    const title = opts.title ?? `Task ${id}`;
    const priority = opts.priority ?? 2;
    const status = opts.status ?? "open";
    const createdOffset = opts.createdOffsetSec ?? 0;
    const updatedOffset = opts.updatedOffsetSec ?? 0;
    const sourceSystem = opts.sourceSystem ?? "internal";
    const sourceExternalId = opts.sourceExternalId ?? null;
    const sourceUrl = opts.sourceUrl ?? null;
    t.db
      .query(
        `INSERT INTO tasks
           (id, title, priority, principal_id, source_system, source_url,
            source_external_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'op', ?, ?, ?, ?,
                 unixepoch() - ?, unixepoch() - ?)`
      )
      .run(
        id,
        title,
        priority,
        sourceSystem,
        sourceUrl,
        sourceExternalId,
        status,
        createdOffset,
        updatedOffset
      );
    for (const a of opts.assignments ?? []) {
      t.db
        .query(
          `INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`
        )
        .run(a.agentId, `Agent ${a.agentId}`);
      const blockReason =
        a.state === "blocked"
          ? JSON.stringify({
              kind: "permission.request",
              payload: { requested_action: "tool.edit" },
            })
          : null;
      t.db
        .query(
          `INSERT INTO agent_task_assignment
             (id, agent_id, task_id, state, block_reason)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(a.id, a.agentId, id, a.state, blockReason);
    }
  }

  it("returns empty list when there are no tasks", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toEqual([]);
  });

  it("excludes done/cancelled by default", async () => {
    seedTask("t-open", { status: "open" });
    seedTask("t-done", { status: "done" });
    seedTask("t-cancelled", { status: "cancelled" });
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks.map((x: { id: string }) => x.id)).toEqual(["t-open"]);
  });

  it("includes closed tasks when includeClosed=true and sinks them to the bottom", async () => {
    seedTask("t-open-p2", { priority: 2, status: "open" });
    seedTask("t-done-p0", { priority: 0, status: "done" });
    const res = await fetch(`${t.baseUrl}/api/tasks?includeClosed=true`);
    const body = await res.json();
    expect(body.tasks.map((x: { id: string }) => x.id)).toEqual([
      "t-open-p2",
      "t-done-p0",
    ]);
  });

  it("computes aggregate_state as the worst-case rank", async () => {
    seedTask("t-mixed", {
      assignments: [
        { id: "a-run", agentId: "ag-1", state: "running" },
        { id: "a-block", agentId: "ag-2", state: "blocked" },
      ],
    });
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].aggregate_state).toBe("blocked");
    expect(body.tasks[0].assignments).toHaveLength(2);
  });

  it("returns aggregate_state=null for a task with no assignments", async () => {
    seedTask("t-orphan", {});
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].aggregate_state).toBeNull();
    expect(body.tasks[0].assignments).toEqual([]);
  });

  it("hydrates INTEGER-epoch task timestamps as ISO-8601 UTC", async () => {
    seedTask("t-iso");
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    const row = body.tasks[0];
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
  });

  it("surfaces source_url and constructs source_ref from external id", async () => {
    seedTask("t-src", {
      sourceSystem: "github",
      sourceExternalId: "42",
      sourceUrl: "https://example.invalid/issues/42",
    });
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].source_ref).toBe("github:42");
    expect(body.tasks[0].source_url).toBe(
      "https://example.invalid/issues/42"
    );
  });

  it("defaults sort to priority ASC then updated_at DESC", async () => {
    seedTask("t-p2-newer", { priority: 2, updatedOffsetSec: 10 });
    seedTask("t-p0", { priority: 0, updatedOffsetSec: 5 });
    seedTask("t-p2-older", { priority: 2, updatedOffsetSec: 200 });
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks.map((x: { id: string }) => x.id)).toEqual([
      "t-p0",
      "t-p2-newer",
      "t-p2-older",
    ]);
  });

  it("405s on PUT (GET and POST are the only routed methods)", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks`, { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("surfaces in_progress tasks in the default open-only list", async () => {
    seedTask("t-open", { status: "open" });
    seedTask("t-in-progress", { status: "in_progress" });
    seedTask("t-done", { status: "done" });
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    const ids = body.tasks.map((x: { id: string }) => x.id).sort();
    expect(ids).toEqual(["t-in-progress", "t-open"]);
    const statuses = Object.fromEntries(
      body.tasks.map((x: { id: string; status: string }) => [x.id, x.status])
    );
    expect(statuses["t-in-progress"]).toBe("in_progress");
  });

  it("caps the response at TASKS_QUERY_LIMIT and returns the priority-ordered top window", async () => {
    const TOTAL = 501;
    t.db.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        const roundRobinPriority = i % 3;
        t.db
          .query(
            `INSERT INTO tasks
               (id, title, priority, principal_id, source_system, status,
                created_at, updated_at)
             VALUES (?, ?, ?, 'op', 'internal', 'open',
                     unixepoch(), unixepoch() - ?)`
          )
          .run(`t-${i.toString().padStart(4, "0")}`, `Task ${i}`, roundRobinPriority, i);
      }
    })();
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks.length).toBe(500);
    for (let i = 1; i < body.tasks.length; i++) {
      expect(body.tasks[i].priority).toBeGreaterThanOrEqual(
        body.tasks[i - 1].priority
      );
    }
    expect(body.tasks[0].priority).toBe(0);
    expect(body.tasks[499].priority).toBeLessThanOrEqual(2);
  });

  it("returns a 500 JSON error when the underlying query fails", async () => {
    t.db.close();
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/Failed to list tasks/);
    reopenDatabaseForTeardown(t);
  });
});

describe("GET /api/working-agents", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedAgent(id: string, name = `Agent ${id}`): void {
    t.db
      .query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`)
      .run(id, name);
  }
  function seedTask(id: string, priority = 2): void {
    t.db
      .query(
        `INSERT OR IGNORE INTO tasks (id, title, priority, principal_id, source_system)
         VALUES (?, ?, ?, 'op', 'internal')`
      )
      .run(id, `Task ${id}`, priority);
  }
  function seedAssignment(
    agentId: string,
    id: string,
    taskId: string,
    state: string,
    updatedOffsetSec = 0
  ): void {
    const br =
      state === "blocked"
        ? JSON.stringify({
            kind: "permission.request",
            payload: { requested_action: "tool.edit" },
          })
        : null;
    t.db
      .query(
        `INSERT INTO agent_task_assignment
           (id, agent_id, task_id, state, block_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', ? || ' seconds'))`
      )
      .run(id, agentId, taskId, state, br, -updatedOffsetSec);
  }

  it("returns an empty list when no agents are working", async () => {
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([]);
  });

  it("excludes agents whose only assignments are blocked", async () => {
    seedAgent("ag-b");
    seedTask("t-1");
    seedAssignment("ag-b", "a-1", "t-1", "blocked");
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    const body = await res.json();
    expect(body.agents).toEqual([]);
  });

  it("lists working agents sorted by rank then updated_at DESC", async () => {
    seedAgent("ag-run-newer");
    seedAgent("ag-run-older");
    seedAgent("ag-disp");
    seedAgent("ag-queue");
    for (const t_ of ["t-1", "t-2", "t-3", "t-4"]) seedTask(t_);
    seedAssignment("ag-disp", "a-d", "t-1", "dispatched", 0);
    seedAssignment("ag-queue", "a-q", "t-2", "queued", 0);
    seedAssignment("ag-run-older", "a-ro", "t-3", "running", 300);
    seedAssignment("ag-run-newer", "a-rn", "t-4", "running", 10);
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    const body = await res.json();
    expect(body.agents.map((x: { agent_id: string }) => x.agent_id)).toEqual([
      "ag-run-newer",
      "ag-run-older",
      "ag-disp",
      "ag-queue",
    ]);
  });

  it("includes agent_name, agent_type, and primary_assignment details", async () => {
    seedAgent("ag-1", "Luna");
    seedTask("t-7", 0);
    seedAssignment("ag-1", "a-1", "t-7", "running");
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    const body = await res.json();
    const row = body.agents[0];
    expect(row.agent_name).toBe("Luna");
    expect(row.agent_type).toBe("hands");
    expect(row.primary_state).toBe("running");
    expect(row.primary_state_rank).toBe(1);
    expect(row.primary_assignment.task_title).toBe("Task t-7");
    expect(row.primary_assignment.task_priority).toBe(0);
  });

  it("reports additional_active_count excluding blocked + terminal", async () => {
    seedAgent("ag-busy");
    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) seedTask(id);
    seedAssignment("ag-busy", "a-r", "t-1", "running");
    seedAssignment("ag-busy", "a-q", "t-2", "queued");
    seedAssignment("ag-busy", "a-d", "t-3", "dispatched");
    seedAssignment("ag-busy", "a-blk", "t-4", "blocked");
    seedAssignment("ag-busy", "a-cpl", "t-5", "completed");
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].additional_active_count).toBe(2);
  });

  function seedSession(
    sessionId: string,
    assignmentId: string,
    parentSessionId: string | null = null
  ): void {
    t.db
      .query(
        `INSERT INTO sessions
           (id, assignment_id, cc_session_id, endpoint_kind, started_at,
            parent_session_id, substrate)
         VALUES (?, ?, NULL, 'local.observed', datetime('now'), ?, 'claude-code')`
      )
      .run(sessionId, assignmentId, parentSessionId);
  }

  it("ST-P4: returns a nested session tree on each tile (additive `sessions`)", async () => {
    seedAgent("ag-tree", "Luna");
    seedTask("t-1");
    seedAssignment("ag-tree", "a-root", "t-1", "running");
    seedAssignment("ag-tree", "a-child", "t-1", "running");
    seedSession("s-root", "a-root");
    seedSession("s-child", "a-child", "s-root");

    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const tile = body.agents.find((x: { agent_id: string }) => x.agent_id === "ag-tree");
    expect(tile).toBeDefined();
    expect(tile.sessions).toHaveLength(1);
    expect(tile.sessions[0].session_id).toBe("s-root");
    expect(tile.sessions[0].children.map((c: { session_id: string }) => c.session_id)).toEqual([
      "s-child",
    ]);
  });

  it("ST-P4: existing DTO fields are unchanged byte-for-byte (additivity)", async () => {
    seedAgent("ag-add", "Echo");
    seedTask("t-add", 1);
    seedAssignment("ag-add", "a-add", "t-add", "running");
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    const body = await res.json();
    const tile = body.agents.find((x: { agent_id: string }) => x.agent_id === "ag-add");
    expect(tile.agent_id).toBe("ag-add");
    expect(tile.agent_name).toBe("Echo");
    expect(tile.agent_type).toBe("hands");
    expect(tile.primary_state).toBe("running");
    expect(tile.primary_state_rank).toBe(1);
    expect(tile.primary_assignment.id).toBe("a-add");
    expect(tile.primary_assignment.task_id).toBe("t-add");
    expect(tile.primary_assignment.task_title).toBe("Task t-add");
    expect(tile.primary_assignment.task_priority).toBe(1);
    expect(tile.additional_active_count).toBe(0);
    expect(tile.sessions).toEqual([]);
  });

  it("405s on POST", async () => {
    const res = await fetch(`${t.baseUrl}/api/working-agents`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });

  it("returns a 500 JSON error when the underlying query fails", async () => {
    t.db.close();
    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to list working agents/);
    reopenDatabaseForTeardown(t);
  });
});

describe("GET /api/iterations", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns an empty list when there are no iterations", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ iterations: [] });
  });

  it("returns inserted iterations with hydrated timestamps + task_count", async () => {
    t.db.exec(
      `INSERT INTO iterations (id, title, state, priority) VALUES ('it-1', 'First', 'designing', 1)`
    );
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES ('t-1', 'A', 2, 'op', 'github', 'it-1')`
    );
    const res = await fetch(`${t.baseUrl}/api/iterations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iterations).toHaveLength(1);
    const row = body.iterations[0];
    expect(row.id).toBe("it-1");
    expect(row.state).toBe("designing");
    expect(row.task_count).toBe(1);
    expect(row.created_at).toMatch(/T.*Z$/);
    expect(row.updated_at).toMatch(/T.*Z$/);
  });

  it("?state=designing filters to a single column", async () => {
    t.db.exec(
      `INSERT INTO iterations (id, title, state) VALUES ('a', 'A', 'inbox'), ('b', 'B', 'designing')`
    );
    const res = await fetch(`${t.baseUrl}/api/iterations?state=designing`);
    const body = await res.json();
    expect(body.iterations.map((r: { id: string }) => r.id)).toEqual(["b"]);
  });

  it("?state=garbage returns 400 with the allowed list", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations?state=banana`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid 'state' filter/);
  });

  it("405s on PUT (only GET + POST are wired)", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, { method: "PUT" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/inbox", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns upstream-imported tasks not attached to any iteration", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, source_external_id, iteration_id)
       VALUES ('t-gh', 'GH issue', 2, 'op', 'github', 'github:x/y#1', NULL),
              ('t-int', 'Internal', 2, 'op', 'internal', NULL, NULL)`
    );
    const res = await fetch(`${t.baseUrl}/api/inbox`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("t-gh");
    expect(body.items[0].source_system).toBe("github");
  });

  it("?source=github filters to a single source", async () => {
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-gh', 'GH', 2, 'op', 'github')`
    );
    const res = await fetch(`${t.baseUrl}/api/inbox?source=github`);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });

  it("?limit=5 caps the result count", async () => {
    for (let i = 0; i < 12; i++) {
      t.db.exec(
        `INSERT INTO tasks (id, title, priority, principal_id, source_system)
         VALUES ('t-${i}', 'X', 2, 'op', 'github')`
      );
    }
    const res = await fetch(`${t.baseUrl}/api/inbox?limit=5`);
    const body = await res.json();
    expect(body.items).toHaveLength(5);
  });

  it("?limit=0 returns 400", async () => {
    const res = await fetch(`${t.baseUrl}/api/inbox?limit=0`);
    expect(res.status).toBe(400);
  });

  it("?limit=garbage returns 400", async () => {
    const res = await fetch(`${t.baseUrl}/api/inbox?limit=banana`);
    expect(res.status).toBe(400);
  });

  it("?source=banana returns 400 with the allowlist (symmetric with ?state= validation)", async () => {
    const res = await fetch(`${t.baseUrl}/api/inbox?source=banana`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("github");
  });

  it("?source=internal returns 400 — silently always-empty otherwise", async () => {
    const res = await fetch(`${t.baseUrl}/api/inbox?source=internal`);
    expect(res.status).toBe(400);
  });

  it("405s on POST", async () => {
    const res = await fetch(`${t.baseUrl}/api/inbox`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/iterations/:id", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns the detail (header + tasks) for a known iteration", async () => {
    t.db.exec(
      `INSERT INTO iterations (id, title, body, state, priority) VALUES ('it-1', 'Iter one', 'design notes', 'designing', 1)`
    );
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES ('task-a', 'Task A', 0, 'op', 'github', 'it-1'),
              ('task-b', 'Task B', 2, 'op', 'github', 'it-1')`
    );
    const res = await fetch(`${t.baseUrl}/api/iterations/it-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.id).toBe("it-1");
    expect(body.iteration.body).toBe("design notes");
    expect(body.iteration.tasks).toHaveLength(2);
    expect(body.iteration.tasks[0].id).toBe("task-a");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/missing`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/iterations", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("creates an iteration with defaults (state=inbox, priority=2) and returns 201", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New iter" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.iteration.title).toBe("New iter");
    expect(body.iteration.state).toBe("inbox");
    expect(body.iteration.priority).toBe(2);
    expect(typeof body.iteration.id).toBe("string");
    expect(body.iteration.tasks).toEqual([]);
  });

  it("accepts overrides for state/priority/source_*", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Designed",
        priority: 0,
        state: "designing",
        source_system: "github",
        source_url: "https://github.com/x/y/issues/9",
        source_parent_ref: "github:x/y#9",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.iteration.state).toBe("designing");
    expect(body.iteration.priority).toBe(0);
    expect(body.iteration.source_system).toBe("github");
  });

  it("returns 400 when 'title' is missing", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when 'title' is empty/whitespace", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on out-of-vocabulary 'state'", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", state: "banana" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on unexpected fields (strict-shape)", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", surprise: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/iterations/:id", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedIter(id: string, state = "inbox"): void {
    t.db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, ?, 2)`
    ).run(id, `Iter ${id}`, state);
  }

  it("patches title + body + priority", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "renamed", body: "new notes", priority: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.title).toBe("renamed");
    expect(body.iteration.body).toBe("new notes");
    expect(body.iteration.priority).toBe(0);
  });

  it("moves state through canTransitionServer (inbox → designing legal)", async () => {
    seedIter("i-1", "inbox");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "designing" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.state).toBe("designing");
  });

  it("rejects an illegal state transition (inbox → in_flight) with 400 + allowed list", async () => {
    seedIter("i-1", "inbox");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "in_flight" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/allowed next states/);
    expect(String(body.error)).toMatch(/designing/);
  });

  it("rejects designing → done with the principal-friendly D10 Q1 message", async () => {
    seedIter("i-1", "designing");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "done" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/iteration must reach in_flight/);
    expect(String(body.error)).toMatch(/cancel it instead/);
  });

  it("returns 404 for an unknown iteration id", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on unexpected body fields", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", surprise: true }),
    });
    expect(res.status).toBe(400);
  });

  it("empty body is a 200 no-op", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/iterations/:id/tasks (attach existing OR create+attach)", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedIter(id: string): void {
    t.db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, 'designing', 2)`
    ).run(id, `Iter ${id}`);
  }
  function seedTask(id: string, iterationId: string | null = null): void {
    t.db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES (?, ?, 2, 'op', 'github', ?)`
    ).run(id, `T ${id}`, iterationId);
  }

  it("attaches an existing unattached task and returns the iteration", async () => {
    seedIter("i-1");
    seedTask("t-a");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "t-a" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.tasks.map((r: { id: string }) => r.id)).toEqual(["t-a"]);
  });

  it("creates a new internal-only task and attaches it", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create: { title: "Quick chore", priority: 1 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.tasks).toHaveLength(1);
    expect(body.iteration.tasks[0].title).toBe("Quick chore");
    expect(body.iteration.tasks[0].priority).toBe(1);
    const row = t.db
      .query(`SELECT source_system FROM tasks WHERE id = ?`)
      .get(body.iteration.tasks[0].id) as { source_system: string };
    expect(row.source_system).toBe("internal");
  });

  it("returns 404 for an unknown iteration id", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/missing/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "doesnt-matter" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when attaching an unknown task id", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "missing-task" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the task is already attached to a DIFFERENT iteration", async () => {
    seedIter("i-1");
    seedIter("i-2");
    seedTask("t-a", "i-2");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "t-a" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toMatch(/i-2/);
  });

  it("is idempotent — attaching a task to its current iteration returns 200", async () => {
    seedIter("i-1");
    seedTask("t-a", "i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "t-a" }),
    });
    expect(res.status).toBe(200);
  });

  it("Major 2 — concurrent attaches of the same task to two iterations resolve to 1× success + 1× 409", async () => {
    seedIter("i-1");
    seedIter("i-2");
    seedTask("t-a");
    const [r1, r2] = await Promise.all([
      fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: "t-a" }),
      }),
      fetch(`${t.baseUrl}/api/iterations/i-2/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: "t-a" }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const link = t.db
      .query(`SELECT iteration_id FROM tasks WHERE id = ?`)
      .get("t-a") as { iteration_id: string };
    expect([link.iteration_id]).toContain(link.iteration_id);
    expect(["i-1", "i-2"]).toContain(link.iteration_id);
    const winnerCount = t.db
      .query(`SELECT COUNT(*) AS c FROM tasks WHERE iteration_id = ?`)
      .get(link.iteration_id) as { c: number };
    expect(winnerCount.c).toBe(1);
    const loserId = link.iteration_id === "i-1" ? "i-2" : "i-1";
    const loserCount = t.db
      .query(`SELECT COUNT(*) AS c FROM tasks WHERE iteration_id = ?`)
      .get(loserId) as { c: number };
    expect(loserCount.c).toBe(0);
  });

  it("returns 400 when both 'task_id' and 'create' are sent", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "x", create: { title: "y" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither 'task_id' nor 'create' is sent", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when 'create.title' is empty", async () => {
    seedIter("i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create: { title: "  " } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/iterations/:id/tasks/:taskId", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedIter(id: string): void {
    t.db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, 'designing', 2)`
    ).run(id, `Iter ${id}`);
  }
  function seedTask(id: string, iterationId: string | null = null): void {
    t.db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES (?, ?, 2, 'op', 'github', ?)`
    ).run(id, `T ${id}`, iterationId);
  }

  it("detaches an attached task (unlink, not delete) and returns the iteration without it", async () => {
    seedIter("i-1");
    seedTask("t-a", "i-1");
    const res = await fetch(`${t.baseUrl}/api/iterations/i-1/tasks/t-a`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.iteration.tasks).toEqual([]);
    const row = t.db.query(`SELECT id FROM tasks WHERE id = ?`).get("t-a") as { id: string };
    expect(row.id).toBe("t-a");
  });

  it("returns 404 for an unknown iteration id", async () => {
    seedTask("t-a");
    const res = await fetch(
      `${t.baseUrl}/api/iterations/missing/tasks/t-a`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown task id", async () => {
    seedIter("i-1");
    const res = await fetch(
      `${t.baseUrl}/api/iterations/i-1/tasks/missing`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the task is unattached", async () => {
    seedIter("i-1");
    seedTask("t-a", null);
    const res = await fetch(
      `${t.baseUrl}/api/iterations/i-1/tasks/t-a`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 when the task is attached to a DIFFERENT iteration", async () => {
    seedIter("i-1");
    seedIter("i-2");
    seedTask("t-a", "i-2");
    const res = await fetch(
      `${t.baseUrl}/api/iterations/i-1/tasks/t-a`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toMatch(/i-2/);
  });
});

describe("F-16 — GET /api/tasks `iteration` denormalisation", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedIteration(
    id: string,
    title: string,
    state = "designing"
  ): void {
    t.db.exec(
      `INSERT INTO iterations (id, title, state, priority) VALUES ('${id}', '${title}', '${state}', 1)`
    );
  }
  function seedTaskWithIter(id: string, iterationId: string | null): void {
    t.db
      .query(
        `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
         VALUES (?, ?, 2, 'op', 'internal', ?)`
      )
      .run(id, `Task ${id}`, iterationId);
  }

  it("returns iteration: { id, title, state } for an attached task", async () => {
    seedIteration("it-1", "F-16 design", "designing");
    seedTaskWithIter("t-attached", "it-1");
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].iteration).toEqual({
      id: "it-1",
      title: "F-16 design",
      state: "designing",
    });
  });

  it("returns iteration: null for an ungrouped task", async () => {
    seedTaskWithIter("t-ungrouped", null);
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].iteration).toBeNull();
  });

  it("mixes attached + ungrouped tasks in one round-trip (no N+1)", async () => {
    seedIteration("it-1", "Sprint Alpha");
    seedTaskWithIter("t-1", "it-1");
    seedTaskWithIter("t-2", null);
    seedTaskWithIter("t-3", "it-1");
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    const byId = Object.fromEntries(
      body.tasks.map((x: { id: string; iteration: unknown }) => [
        x.id,
        x.iteration,
      ])
    );
    expect(byId["t-1"]).toEqual({
      id: "it-1",
      title: "Sprint Alpha",
      state: "designing",
    });
    expect(byId["t-2"]).toBeNull();
    expect(byId["t-3"]).toEqual({
      id: "it-1",
      title: "Sprint Alpha",
      state: "designing",
    });
  });

  it("reflects the iteration's CURRENT state, not a snapshot at attach time", async () => {
    seedIteration("it-1", "Iter one", "designing");
    seedTaskWithIter("t-a", "it-1");
    t.db.exec(`UPDATE iterations SET state = 'queued' WHERE id = 'it-1'`);
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].iteration.state).toBe("queued");
  });

  it("renames flow through to the next fetch (title is JOIN-derived)", async () => {
    seedIteration("it-1", "Original title");
    seedTaskWithIter("t-a", "it-1");
    t.db.exec(`UPDATE iterations SET title = 'Renamed' WHERE id = 'it-1'`);
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(body.tasks[0].iteration.title).toBe("Renamed");
  });

  it("survives an iteration with body / source columns set (only id+title+state hit the wire)", async () => {
    t.db.exec(
      `INSERT INTO iterations
         (id, title, body, state, priority, source_system, source_url)
       VALUES ('it-1', 'Title', 'long body', 'designing', 1, 'github', 'https://example.invalid')`
    );
    seedTaskWithIter("t-a", "it-1");
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    expect(Object.keys(body.tasks[0].iteration).sort()).toEqual([
      "id",
      "state",
      "title",
    ]);
  });
});

describe("F-16 — GET /api/assignments `iteration` denormalisation", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  function seedAssignmentWithIter(
    iterationId: string | null,
    iterTitle: string | null
  ): void {
    if (iterationId && iterTitle) {
      t.db
        .query(
          `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, 'designing', 1)`
        )
        .run(iterationId, iterTitle);
    }
    t.db
      .query(
        `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
         VALUES ('t-1', 'task', 1, 'op', 'internal', ?)`
      )
      .run(iterationId);
    t.db.exec(
      `INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`
    );
    t.db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'a-1', 't-1', 'running')`
    );
  }

  it("carries iteration: { id, title, state } when the task is attached", async () => {
    seedAssignmentWithIter("it-1", "Drill chip iteration");
    const res = await fetch(`${t.baseUrl}/api/assignments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].iteration).toEqual({
      id: "it-1",
      title: "Drill chip iteration",
      state: "designing",
    });
  });

  it("carries iteration: null when the task is ungrouped", async () => {
    seedAssignmentWithIter(null, null);
    const res = await fetch(`${t.baseUrl}/api/assignments`);
    const body = await res.json();
    expect(body.assignments[0].iteration).toBeNull();
  });

  it("propagates iteration state changes without a re-attach", async () => {
    seedAssignmentWithIter("it-1", "T");
    t.db.exec(`UPDATE iterations SET state = 'in_flight' WHERE id = 'it-1'`);
    const res = await fetch(`${t.baseUrl}/api/assignments`);
    const body = await res.json();
    expect(body.assignments[0].iteration.state).toBe("in_flight");
  });
});

describe("F-16 — GET /api/focus-area `iteration` denormalisation", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("blocked assignment carries the iteration tag through to the focus row", async () => {
    t.db.exec(
      `INSERT INTO iterations (id, title, state, priority) VALUES ('it-1', 'Block iter', 'in_flight', 1)`
    );
    t.db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES ('t-1', 'blocked task', 0, 'op', 'internal', 'it-1')`
    );
    t.db.exec(
      `INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`
    );
    const blockReason = JSON.stringify({
      kind: "permission.request",
      payload: { requested_action: "tool.edit" },
    });
    t.db
      .query(
        `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason)
         VALUES ('ata-1', 'a-1', 't-1', 'blocked', ?)`
      )
      .run(blockReason);
    const res = await fetch(`${t.baseUrl}/api/focus-area`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].iteration).toEqual({
      id: "it-1",
      title: "Block iter",
      state: "in_flight",
    });
  });
});
