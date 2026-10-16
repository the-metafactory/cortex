import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";

import { startMcTestServer, stopMcTestServer } from "./__fixtures__/mc-test-server";
import type { McTestServer } from "./__fixtures__/mc-test-server";
import type { GhSpawnFn } from "../adapters/github";
import { getRepository, getBranch, getCommit, getPullRequest } from "../db/git-objects";
import { SHADOW_AGENT_ID } from "../db/sessions";

interface CannedResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

interface TestContext extends McTestServer {
  gh: FakeGh;
}

async function setup(): Promise<TestContext> {
  const gh = new FakeGh();
  return { ...startMcTestServer("mc-f12b", { ghSpawn: gh.spawn }), gh };
}

const teardown = stopMcTestServer;

const HAPPY_ISSUE_BODY = JSON.stringify({
  title: "fix webhook HMAC verification bypass",
  state: "open",
  body:
    "The HMAC signature comparison uses === which allows timing-attacks " +
    "against the signature header.\n\nSwitching to crypto.timingSafeEqual " +
    "closes the window.",
  html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
  labels: [{ name: "bug" }, { name: "security" }],
});

const HAPPY_PR_BODY = JSON.stringify({
  title: "Refactor session manager",
  state: "open",
  body: "Lifts session bookkeeping out of grove-bot.",
  html_url: "https://github.com/the-metafactory/grove-v2/pull/45",
  labels: [],
  pull_request: { url: "https://api.github.com/repos/.../pulls/45" },
});

const HAPPY_PR_PULLS_BODY = JSON.stringify({
  state: "open",
  merged: false,
  draft: false,
  title: "Refactor session manager",
  html_url: "https://github.com/the-metafactory/grove-v2/pull/45",
  number: 45,
  head: { ref: "feat/session-mgr", sha: "abc1234def", repo: { full_name: "the-metafactory/grove-v2" } },
  base: { ref: "main" },
});

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

  it("returns 409 conflict + deeplink shape without calling gh when an existing task tracks the same ref", async () => {
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

    const task = t.db
      .query(
        "SELECT title, priority, status, source_system, source_external_id, source_url FROM tasks WHERE id = ?"
      )
      .get(body.taskId) as Record<string, unknown> | null;
    expect(task).not.toBeNull();
    expect(task!.source_system).toBe("github");
    expect(task!.priority).toBe(1);
    expect(task!.status).toBe("open");

    const ata = t.db
      .query(
        "SELECT agent_id, state FROM agent_task_assignment WHERE id = ?"
      )
      .get(body.shadowAssignmentId) as { agent_id: string; state: string };
    expect(ata.agent_id).toBe(SHADOW_AGENT_ID);
    expect(ata.state).toBe("cancelled");

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

  it("G-1113.C.5 — a PR-ref create populates the software-mode Git model (repo+PR+branches+commit)", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_PR_BODY, stderr: "" });
    t.gh.push({ exitCode: 0, stdout: HAPPY_PR_PULLS_BODY, stderr: "" });

    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#45", priority: 2 }),
    });
    expect(res.status).toBe(201);

    const rid = "github:the-metafactory/grove-v2";
    expect(getRepository(t.db, rid)).not.toBeNull();
    const pr = getPullRequest(t.db, `${rid}#45`);
    expect(pr).toMatchObject({
      repositoryId: rid,
      numberOrKey: "45",
      sourceBranch: "feat/session-mgr",
      targetBranch: "main",
      state: "open",
      providerNativeType: "pull_request",
    });
    expect(getBranch(t.db, `${rid}@feat/session-mgr`)).toMatchObject({ headSha: "abc1234def" });
    expect(getBranch(t.db, `${rid}@main`)).not.toBeNull();
    expect(getCommit(t.db, `${rid}@abc1234def`)).toMatchObject({ sha: "abc1234def" });
  });

  it("uses titleOverride when provided", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
        titleOverride: "principal override",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("principal override");
  });

  it("returns 409 conflict when racing the dedup window after preview", async () => {
    t.db.exec(`
      INSERT INTO tasks (id, title, priority, principal_id, source_system,
                         source_url, source_external_id, status)
      VALUES ('T-prev', 'prev', 2, 'op', 'github',
              'https://github.com/x/y/issues/3', 'x/y#3', 'open');
    `);

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

describe("POST /api/tasks/:taskId/abandon", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

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

    const curationEventsNewestFirst = t.db
      .query(
        "SELECT payload FROM events WHERE session_id = ? AND type = 'principal.curation' ORDER BY id DESC"
      )
      .all(shadowSessionId) as { payload: string }[];
    const abandonPayload = JSON.parse(curationEventsNewestFirst[0]!.payload);
    expect(abandonPayload.kind).toBe("abandon");
    expect(abandonPayload.targetKind).toBe("task");
  });

  it("404s on unknown taskId", async () => {
    const res = await fetch(`${t.baseUrl}/api/tasks/nonexistent/abandon`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("409s when the task is already cancelled", async () => {
    const { taskId } = await createImportedTask();
    const firstAbandon = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(firstAbandon.status).toBe(200);
    const repeatAbandon = await fetch(`${t.baseUrl}/api/tasks/${taskId}/abandon`, {
      method: "POST",
    });
    expect(repeatAbandon.status).toBe(409);
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

describe("F-9 working-agent filter", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("does not surface mc-shadow-agent in GET /api/working-agents even when its assignment is running", async () => {
    t.gh.push({ exitCode: 0, stdout: HAPPY_ISSUE_BODY, stderr: "" });
    await fetch(`${t.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "the-metafactory/grove-v2#42",
        priority: 2,
      }),
    });

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
    expect(row!.assignments.length).toBe(0);
    expect(row!.aggregate_state).toBeNull();
  });

  it("shadow_assignment_id is null for internal-source tasks", async () => {
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
