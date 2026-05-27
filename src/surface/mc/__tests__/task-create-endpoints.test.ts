/**
 * Grove Mission Control v2 — F-12b add-to-queue endpoint coverage.
 *
 * Exercises the three new endpoints (preview / create / abandon-task)
 * against a real Bun.serve instance with a fake `gh` CLI. The fake spawn
 * returns a canned JSON response so tests don't depend on the operator's
 * `gh auth` state or network.
 *
 * Decisions referenced inline:
 *   D4 — URL parser (covered standalone in github-ref-parser.test.ts)
 *   D5 — application-level dedup at preview, 409 + deeplink shape
 *   D6 — endpoint shapes (status codes + body keys)
 *   D8 — shadow assignment + session created in the same transaction
 *   D10 — principal.curation event with kind: "task.imported"
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
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
import type { GhSpawnFn } from "../api/github-fetch";
import { SHADOW_AGENT_ID } from "../db/sessions";

interface CannedResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Fake `gh` spawn — returns the test-controlled response without shelling
 * out. Each test pushes responses onto the queue; the spawn pops the next
 * one. A single "default OK" can be set for tests that don't care about
 * specific shape.
 */
class FakeGh {
  queue: CannedResponse[] = [];
  default: CannedResponse | null = null;
  calls: string[][] = [];

  push(r: CannedResponse): this {
    this.queue.push(r);
    return this;
  }

  setDefault(r: CannedResponse): this {
    this.default = r;
    return this;
  }

  spawn: GhSpawnFn = (args: string[]) => {
    this.calls.push(args.slice());
    const resp = this.queue.shift() ?? this.default;
    if (!resp) {
      throw new Error("FakeGh: no canned response queued");
    }
    return makeFakeProc(resp);
  };
}

function makeFakeProc(r: CannedResponse) {
  // ReadableStream from bytes — same shape Bun.spawn returns. Use
  // ReadableStream directly so the existing `new Response(stream).text()`
  // drains it without binding to a real subprocess.
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(r.stdout));
      c.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(r.stderr));
      c.close();
    },
  });
  return {
    stdout,
    stderr,
    exited: Promise.resolve(r.exitCode),
    kill: () => {},
  };
}

interface TestContext {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
  gh: FakeGh;
}

function makePort(): number {
  return 22000 + Math.floor(Math.random() * 1000);
}

async function setup(): Promise<TestContext> {
  const tmpDir = join(tmpdir(), `mc-f12b-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const port = makePort();
  const gh = new FakeGh();
  const ctx = startServer({ ...DEFAULT_CONFIG, port }, db, {
    processManager: pm,
    ghSpawn: gh.spawn,
  });
  return {
    db,
    ctx,
    pm,
    port,
    baseUrl: `http://localhost:${port}`,
    tmpDir,
    gh,
  };
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

const HAPPY_ISSUE_BODY = JSON.stringify({
  title: "fix webhook HMAC verification bypass",
  state: "open",
  body:
    "The HMAC signature comparison uses === which allows timing-attacks " +
    "against the signature header.\n\nSwitching to crypto.timingSafeEqual " +
    "closes the window.",
  html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
  labels: [{ name: "bug" }, { name: "security" }],
  // No `pull_request` field → kind=issue.
});

const HAPPY_PR_BODY = JSON.stringify({
  title: "Refactor session manager",
  state: "open",
  body: "Lifts session bookkeeping out of grove-bot.",
  html_url: "https://github.com/the-metafactory/grove-v2/pull/45",
  labels: [],
  pull_request: { url: "https://api.github.com/repos/.../pulls/45" },
});

// ============================================================================
// POST /api/tasks/preview
// ============================================================================

describe("POST /api/tasks/preview", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns 200 with metadata on the happy path", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "https://github.com/the-metafactory/grove-v2/issues/42",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("preview");
    expect(body.ref).toBe("the-metafactory/grove-v2#42");
    expect(body.type).toBe("issue");
    expect(body.title).toBe("fix webhook HMAC verification bypass");
    expect(body.labels).toEqual(["bug", "security"]);
    expect(body.body_excerpt.length).toBeGreaterThan(20);
    expect(body.body_excerpt).not.toContain("\n");
    expect(typeof body.fetched_at).toBe("string");
  });

  it("disambiguates issue vs PR via the pull_request field", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_PR_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#45",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("pr");
  });

  it("returns 409 conflict + deeplink shape when an existing task tracks the same ref", async () => {
    // Seed an existing GitHub-source task with the canonical ref.
    t.db.exec(`
      INSERT INTO tasks (id, title, priority, principal_id, source_system,
                         source_url, source_external_id, status)
      VALUES ('T-existing', 'old title', 2, 'op-1', 'github',
              'https://github.com/the-metafactory/grove-v2/issues/42',
              'the-metafactory/grove-v2#42', 'open');
    `);

    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("conflict");
    expect(body.existingTaskId).toBe("T-existing");
    expect(body.existingTitle).toBe("old title");
    expect(body.existingStatus).toBe("open");
    expect(body.message).toMatch(/T-existing/);
    // Crucially, the gh CLI was NOT called — dedup short-circuits before fetch.
    expect(t.gh.calls.length).toBe(0);
  });

  it("returns 400 on parse error", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "not-a-valid-input" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(t.gh.calls.length).toBe(0);
  });

  it("maps gh 404 → 404", async () => {
    t.gh.push({
      exitCode: 1,
      stdout: "",
      stderr: "gh: HTTP 404: Not Found (https://api.github.com/...)",
    });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#999" }),
    });
    expect(res.status).toBe(404);
  });

  it("maps gh auth failure → 401", async () => {
    t.gh.push({
      exitCode: 4,
      stdout: "",
      stderr:
        "gh: HTTP 401: Bad credentials. Run `gh auth login` to authenticate.",
    });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1" }),
    });
    expect(res.status).toBe(401);
  });

  it("maps gh rate limit → 429", async () => {
    t.gh.push({
      exitCode: 1,
      stdout: "",
      stderr:
        "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1" }),
    });
    expect(res.status).toBe(429);
  });

  it("maps an unexpected upstream error → 502", async () => {
    t.gh.push({
      exitCode: 1,
      stdout: "",
      stderr: "gh: HTTP 500: Server error",
    });
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1" }),
    });
    expect(res.status).toBe(502);
  });

  it("400s when 'ref' is missing", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on unexpected fields", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", evil: true }),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /api/tasks
// ============================================================================

describe("POST /api/tasks", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("creates a task + shadow assignment + shadow session + curation event in one go", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.taskId).toBe("string");
    expect(typeof body.shadowAssignmentId).toBe("string");
    expect(typeof body.shadowSessionId).toBe("string");
    expect(body.title).toBe("fix webhook HMAC verification bypass");
    expect(body.source_external_id).toBe("the-metafactory/grove-v2#42");
    expect(body.source_url).toBe(
      "https://github.com/the-metafactory/grove-v2/issues/42"
    );
    expect(body.priority).toBe(1);

    // Task row: source_system='github', priority=1, status='open'.
    const task = t.db
      .query(
        "SELECT title, priority, status, source_system, source_external_id, source_url FROM tasks WHERE id = ?"
      )
      .get(body.taskId) as Record<string, unknown> | null;
    expect(task).not.toBeNull();
    expect(task!.source_system).toBe("github");
    expect(task!.priority).toBe(1);
    expect(task!.status).toBe("open");

    // Shadow assignment: agent_id=mc-shadow-agent, state='cancelled'.
    const ata = t.db
      .query(
        "SELECT agent_id, state FROM agent_task_assignment WHERE id = ?"
      )
      .get(body.shadowAssignmentId) as { agent_id: string; state: string };
    expect(ata.agent_id).toBe(SHADOW_AGENT_ID);
    expect(ata.state).toBe("cancelled");

    // Shadow session: endpoint_kind='local.observed', ended_at non-null.
    const sess = t.db
      .query(
        "SELECT endpoint_kind, ended_at FROM sessions WHERE id = ?"
      )
      .get(body.shadowSessionId) as {
      endpoint_kind: string;
      ended_at: string | null;
    };
    expect(sess.endpoint_kind).toBe("local.observed");
    expect(sess.ended_at).not.toBeNull();

    // principal.curation event with kind='task.imported' on the shadow session.
    const events = t.db
      .query(
        "SELECT type, payload FROM events WHERE session_id = ? AND type = 'principal.curation'"
      )
      .all(body.shadowSessionId) as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.kind).toBe("task.imported");
    expect(payload.source).toBe("github");
    expect(payload.ref).toBe("the-metafactory/grove-v2#42");
    expect(payload.url).toBe(
      "https://github.com/the-metafactory/grove-v2/issues/42"
    );
    expect(payload.type).toBe("issue");
  });

  it("uses titleOverride when provided", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
        titleOverride: "operator override",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("operator override");
  });

  it("returns 409 conflict when racing the dedup window after preview", async () => {
    // Seed dedup target.
    t.db.exec(`
      INSERT INTO tasks (id, title, priority, principal_id, source_system,
                         source_url, source_external_id, status)
      VALUES ('T-prev', 'prev', 2, 'op', 'github',
              'https://github.com/x/y/issues/3', 'x/y#3', 'open');
    `);

    // No gh canned response queued — the dedup short-circuit means we
    // never call gh.
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#3", priority: 2 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("conflict");
    expect(body.existingTaskId).toBe("T-prev");
  });

  it("400s on out-of-range priority", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", priority: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when priority is a string", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", priority: "P2" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on unknown body keys", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "x/y#1",
        priority: 2,
        nasty: "extra",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /api/tasks/:taskId/abandon
// ============================================================================

describe("POST /api/tasks/:taskId/abandon", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  /** Helper: create a real F-12b task via POST /api/tasks. */
  async function createImportedTask(): Promise<{
    taskId: string;
    shadowSessionId: string;
  }> {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return {
      taskId: body.taskId,
      shadowSessionId: body.shadowSessionId,
    };
  }

  it("transitions tasks.status to 'cancelled' and inserts an abandon curation event", async () => {
    const { taskId, shadowSessionId } = await createImportedTask();

    const res = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(taskId);
    expect(body.status).toBe("cancelled");
    expect(typeof body.eventId).toBe("string");

    const row = t.db
      .query("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string };
    expect(row.status).toBe("cancelled");

    // Curation event lands on the shadow session.
    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation' ORDER BY id DESC"
      )
      .all(shadowSessionId) as { payload: string }[];
    // First event was task.imported (from create); this is the abandon.
    const lastPayload = JSON.parse(events[0]!.payload);
    expect(lastPayload.kind).toBe("abandon");
    expect(lastPayload.targetKind).toBe("task");
  });

  it("404s on unknown taskId", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks/nonexistent/abandon`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("409s when the task is already cancelled", async () => {
    const { taskId } = await createImportedTask();
    // First call succeeds.
    const r1 = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(r1.status).toBe(200);
    // Second call hits the already-cancelled guard.
    const r2 = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(r2.status).toBe(409);
  });

  it("captures optional reason in the curation event payload", async () => {
    const { taskId, shadowSessionId } = await createImportedTask();
    const res = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no longer relevant" }),
    });
    expect(res.status).toBe(200);

    const events = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation' ORDER BY id DESC"
      )
      .all(shadowSessionId) as { payload: string }[];
    const last = JSON.parse(events[0]!.payload);
    expect(last.reason).toBe("no longer relevant");
  });

  it("409s when a non-shadow non-terminal assignment exists on the task", async () => {
    const { taskId } = await createImportedTask();
    // Add a real assignment in 'running' state — F-12b should refuse.
    t.db.exec(`
      INSERT OR IGNORE INTO agents (id, name, type) VALUES ('a-real', 'real', 'hands');
    `);
    t.db
      .query(
        `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
         VALUES (?, 'a-real', ?, 'running')`
      )
      .run("ata-real-1", taskId);
    const res = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/non-terminal|assignment/);
  });

  it("400s on unknown body keys", async () => {
    const { taskId } = await createImportedTask();
    const res = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x", nasty: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// Shadow filter on listWorkingAgents
// ============================================================================

describe("F-9 working-agent filter", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("does not surface mc-shadow-agent in GET /api/working-agents", async () => {
    // Create an F-12b task; this seeds the shadow agent + assignment.
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
      }),
    });

    // Defensive: even if a future bug flipped the shadow assignment to
    // 'running', the agent-id filter still excludes it.
    t.db
      .query(
        "UPDATE agent_task_assignment SET state = 'running' WHERE agent_id = ?"
      )
      .run(SHADOW_AGENT_ID);

    const res = await fetch(`${t.baseUrl}/api/working-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.agents as { agent_id: string }[]).map(
      (a) => a.agent_id
    );
    expect(ids).not.toContain(SHADOW_AGENT_ID);
  });
});

// ============================================================================
// Task projection — shadow_assignment_id surface
// ============================================================================

describe("GET /api/tasks projection", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("populates shadow_assignment_id for F-12b-imported tasks", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const cr = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
      }),
    });
    const created = await cr.json();

    const res = await fetch(`${t.baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = (body.tasks as {
      id: string;
      shadow_assignment_id: string | null;
      assignments: unknown[];
      aggregate_state: string | null;
    }[]).find((tt) => tt.id === created.taskId);
    expect(row).toBeTruthy();
    expect(row!.shadow_assignment_id).toBe(created.shadowAssignmentId);
    // The assignments roll-up does NOT include the shadow row.
    expect(row!.assignments.length).toBe(0);
    // aggregate_state = null when the only assignment is the shadow.
    expect(row!.aggregate_state).toBeNull();
  });

  it("shadow_assignment_id is null for internal-source tasks", async () => {
    // Insert a task with no shadow assignment.
    t.db.exec(`
      INSERT INTO tasks (id, title, priority, principal_id, source_system, status)
      VALUES ('T-internal', 'plain', 2, 'op', 'internal', 'open');
    `);
    const res = await fetch(`${t.baseUrl}/api/tasks`);
    const body = await res.json();
    const row = (body.tasks as {
      id: string;
      shadow_assignment_id: string | null;
    }[]).find((tt) => tt.id === "T-internal");
    expect(row).toBeTruthy();
    expect(row!.shadow_assignment_id).toBeNull();
  });
});
