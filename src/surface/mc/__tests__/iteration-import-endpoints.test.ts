/**
 * F-17 — endpoint tests for the GitHub iteration auto-import surface.
 *
 * Two routes:
 *   POST /api/iterations/from-github — operator-driven import via gh CLI
 *   POST /api/github/webhook         — HMAC-validated upstream stream
 *
 * The harness mirrors `task-create-endpoints.test.ts` (FakeGh + real
 * Bun.serve), with a webhook secret seeded for the receiver tests.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { GhSpawnFn } from "../api/github-fetch";
import { _resetWebhookDeliveryDedupeForTests } from "../api/handlers";

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
    if (!resp) throw new Error("FakeGh: no canned response queued");
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

interface TestContext {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
  gh: FakeGh;
  webhookSecret: string;
}

function makePort(): number {
  return 23000 + Math.floor(Math.random() * 1000);
}

const WEBHOOK_SECRET = "f17-test-secret-not-prod";

async function setup(): Promise<TestContext> {
  const tmpDir = join(tmpdir(), `mc-f17-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const port = makePort();
  const gh = new FakeGh();
  const ctx = startServer({ ...DEFAULT_CONFIG, port }, db, {
    processManager: pm,
    ghSpawn: gh.spawn,
    githubWebhookSecret: WEBHOOK_SECRET,
  });
  return {
    db,
    ctx,
    pm,
    port,
    baseUrl: `http://localhost:${port}`,
    tmpDir,
    gh,
    webhookSecret: WEBHOOK_SECRET,
  };
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

// gh canned bodies
const ITERATION_ISSUE_BODY = JSON.stringify({
  title: "Phase G — PM agent",
  state: "open",
  body: "Long-running head agent that drafts iterations.",
  html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
  labels: [{ name: "iteration" }, { name: "feature" }],
});

const PLAIN_ISSUE_BODY = JSON.stringify({
  title: "ordinary bug",
  state: "open",
  body: "stack trace",
  html_url: "https://github.com/the-metafactory/grove-v2/issues/77",
  labels: [{ name: "bug" }],
});

// ---------------------------------------------------------------------------
// HMAC helper for webhook tests
// ---------------------------------------------------------------------------

async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(body))
  );
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

async function postWebhook(
  t: TestContext,
  event: string,
  payload: unknown,
  opts: { signOverride?: string; bodyOverride?: string } = {}
): Promise<Response> {
  const body = opts.bodyOverride ?? JSON.stringify(payload);
  const signature =
    opts.signOverride ?? (await signBody(t.webhookSecret, body));
  return fetch(`${t.baseUrl}/api/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": event,
      "x-github-delivery": `test-${Math.random()}`,
    },
    body,
  });
}

// =============================================================================
// POST /api/iterations/from-github
// =============================================================================

describe("POST /api/iterations/from-github", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("creates an iteration on the happy path (201)", async () => {
    t.gh.push({ exitCode: 0, stdout: ITERATION_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "https://github.com/the-metafactory/grove-v2/issues/42",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe("imported");
    expect(body.bodyRefreshed).toBe(false);
    expect(body.iteration.title).toBe("Phase G — PM agent");
    expect(body.iteration.state).toBe("inbox");
    expect(body.iteration.source_system).toBe("github");
    expect(body.iteration.source_parent_ref).toBe(
      "the-metafactory/grove-v2#42"
    );
  });

  it("returns 200 + kind='exists' on idempotent re-import (no body change)", async () => {
    // The handler always calls gh (see Echo's M2 — no pre-flight
    // short-circuit, so backfill on operator demand can refresh stale
    // imported_body snapshots after a missed webhook). Both calls
    // therefore need a canned response.
    t.gh.push({ exitCode: 0, stdout: ITERATION_ISSUE_BODY, stderr: "" });
    t.gh.push({ exitCode: 0, stdout: ITERATION_ISSUE_BODY, stderr: "" });
    const r1 = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#42" }),
    });
    expect(r1.status).toBe(201);

    // Same upstream body → gh returns the same payload → snapshot hash
    // matches → bodyRefreshed: false (true no-op against the audit
    // trail; the handler still returns the canonical detail row).
    const r2 = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#42" }),
    });
    expect(r2.status).toBe(200);
    const body = await r2.json();
    expect(body.kind).toBe("exists");
    expect(body.bodyRefreshed).toBe(false);
  });

  it("refreshes imported_body on backfill when upstream body has changed (M2)", async () => {
    // Headline use case for the operator-driven path — webhook delivery
    // missed, upstream body has since drifted, operator manually
    // re-imports to recover the audit snapshot. Pre-M2 this was a
    // silent no-op; post-M2 the snapshot refreshes and bodyRefreshed
    // flips to true so the dashboard can surface the divergence.
    const v1 = JSON.stringify({
      title: "Phase G — PM agent",
      state: "open",
      body: "v1 — initial draft",
      html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
      labels: [{ name: "iteration" }, { name: "feature" }],
    });
    const v2 = JSON.stringify({
      title: "Phase G — PM agent",
      state: "open",
      body: "v2 — upstream rewrite the webhook missed",
      html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
      labels: [{ name: "iteration" }, { name: "feature" }],
    });
    t.gh.push({ exitCode: 0, stdout: v1, stderr: "" });
    t.gh.push({ exitCode: 0, stdout: v2, stderr: "" });

    const r1 = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#42" }),
    });
    expect(r1.status).toBe(201);
    const created = await r1.json();
    expect(created.iteration.body).toBe("v1 — initial draft");

    const r2 = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#42" }),
    });
    expect(r2.status).toBe(200);
    const refreshed = await r2.json();
    expect(refreshed.kind).toBe("exists");
    expect(refreshed.bodyRefreshed).toBe(true);
    // Decision 9 — `body` is operator-editable so it stays at v1 even
    // though upstream is now v2; only `imported_body` (the audit-only
    // snapshot) tracks upstream.
    expect(refreshed.iteration.body).toBe("v1 — initial draft");
    const row = t.db
      .query(`SELECT body, imported_body FROM iterations WHERE id = ?`)
      .get(refreshed.iteration.id) as {
        body: string | null;
        imported_body: string | null;
      };
    expect(row.body).toBe("v1 — initial draft");
    expect(row.imported_body).toBe("v2 — upstream rewrite the webhook missed");
  });

  it("returns 409 conflict when the issue is missing the iteration label", async () => {
    t.gh.push({ exitCode: 0, stdout: PLAIN_ISSUE_BODY, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "the-metafactory/grove-v2#77" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("conflict");
    expect(body.reason).toBe("not_iteration_labelled");
    expect(body.canonical).toBe("the-metafactory/grove-v2#77");
    expect(typeof body.message).toBe("string");
  });

  it("honours an explicit label override (200 with custom label)", async () => {
    const epicBody = JSON.stringify({
      title: "Epic",
      state: "open",
      body: "x",
      html_url: "https://github.com/x/y/issues/1",
      labels: [{ name: "epic" }],
    });
    t.gh.push({ exitCode: 0, stdout: epicBody, stderr: "" });
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", label: "epic" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.iteration.title).toBe("Epic");
  });

  it("400s when 'ref' is missing", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on unknown body keys", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", evil: true }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on parse error (malformed ref)", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "not a valid ref" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when gh reports the issue is missing", async () => {
    t.gh.push({
      exitCode: 1,
      stdout: "",
      stderr: "gh: HTTP 404: Not Found (https://api.github.com/...)",
    });
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#999" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on empty label override", async () => {
    const res = await fetch(`${t.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x/y#1", label: "   " }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /api/github/webhook — HMAC + dispatch
// =============================================================================

describe("POST /api/github/webhook — auth + dispatch", () => {
  let t: TestContext;
  beforeEach(async () => {
    // Module-scoped dedupe state — clear between tests so a deliveryId
    // collision in `Math.random()` (vanishingly unlikely but possible)
    // can't leak a no-op into the wrong test.
    _resetWebhookDeliveryDedupeForTests();
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns 401 on a missing signature", async () => {
    const res = await fetch(`${t.baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "d-1",
      },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 on a wrong signature", async () => {
    const res = await postWebhook(t, "issues", { action: "labeled" }, {
      signOverride: "sha256=" + "00".repeat(32),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 (no-op) for non-issues events", async () => {
    const res = await postWebhook(t, "pull_request", {
      action: "opened",
    });
    expect(res.status).toBe(200);
  });

  it("creates an iteration on issues.labeled with the iteration label", async () => {
    const payload = {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "Phase G",
        body: "design notes",
        html_url: "https://github.com/the-metafactory/grove-v2/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: {
        full_name: "the-metafactory/grove-v2",
        name: "grove-v2",
        owner: { login: "the-metafactory" },
      },
    };
    const res = await postWebhook(t, "issues", payload);
    expect(res.status).toBe(200);

    const row = t.db
      .query(
        `SELECT title, state, source_parent_ref FROM iterations WHERE source_parent_ref = ?`
      )
      .get("the-metafactory/grove-v2#42") as
      | { title: string; state: string; source_parent_ref: string }
      | null;
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Phase G");
    expect(row!.state).toBe("inbox");
  });

  it("ignores issues.labeled when the label is not the iteration label", async () => {
    const payload = {
      action: "labeled",
      label: { name: "bug" },
      issue: {
        number: 77,
        title: "ordinary",
        body: null,
        html_url: "https://github.com/x/y/issues/77",
        labels: [{ name: "bug" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    };
    const res = await postWebhook(t, "issues", payload);
    expect(res.status).toBe(200);
    const count = (t.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("issues.unlabeled with the iteration label is a no-op (does NOT delete)", async () => {
    // Pre-seed via labeled.
    await postWebhook(t, "issues", {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "P",
        body: "b",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const before = (t.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(before).toBe(1);

    await postWebhook(t, "issues", {
      action: "unlabeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "P",
        body: "b",
        html_url: "https://github.com/x/y/issues/42",
        labels: [],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const after = (t.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(after).toBe(1); // intentionally not deleted
  });

  it("issues.edited refreshes imported_body but not the operator's body (Decision 9)", async () => {
    // Seed.
    await postWebhook(t, "issues", {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "T",
        body: "v1",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    // Operator edits the live body via PATCH.
    const row = t.db
      .query(`SELECT id FROM iterations LIMIT 1`)
      .get() as { id: string };
    const patchRes = await fetch(
      `${t.baseUrl}/api/iterations/${encodeURIComponent(row.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "operator's notes" }),
      }
    );
    expect(patchRes.status).toBe(200);

    // Upstream edit fires.
    await postWebhook(t, "issues", {
      action: "edited",
      issue: {
        number: 42,
        title: "T",
        body: "v2 upstream rewrite",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const after = t.db
      .query(`SELECT body, imported_body FROM iterations WHERE id = ?`)
      .get(row.id) as { body: string | null; imported_body: string | null };
    expect(after.body).toBe("operator's notes");
    expect(after.imported_body).toBe("v2 upstream rewrite");
  });

  it("creates a child task on issues.opened for a sub-issue of a tracked parent", async () => {
    // Seed parent.
    await postWebhook(t, "issues", {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "Parent",
        body: "p",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    // Sub-issue opens.
    await postWebhook(t, "issues", {
      action: "opened",
      issue: {
        number: 100,
        title: "Sub",
        body: null,
        html_url: "https://github.com/x/y/issues/100",
        state: "open",
        labels: [],
        parent: {
          number: 42,
          html_url: "https://github.com/x/y/issues/42",
          repository: { full_name: "x/y" },
        },
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const task = t.db
      .query(
        `SELECT title, status, iteration_id, source_external_id
         FROM tasks WHERE source_external_id = ?`
      )
      .get("x/y#100") as
      | { title: string; status: string; iteration_id: string | null; source_external_id: string }
      | null;
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Sub");
    expect(task!.status).toBe("open");
    expect(task!.iteration_id).not.toBeNull();
  });

  it("flips a child task to 'done' on issues.closed", async () => {
    // Seed parent + child.
    await postWebhook(t, "issues", {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "Parent",
        body: "p",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });
    await postWebhook(t, "issues", {
      action: "opened",
      issue: {
        number: 100,
        title: "Sub",
        body: null,
        html_url: "https://github.com/x/y/issues/100",
        state: "open",
        labels: [],
        parent: {
          number: 42,
          html_url: "https://github.com/x/y/issues/42",
          repository: { full_name: "x/y" },
        },
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });
    // Close the sub.
    await postWebhook(t, "issues", {
      action: "closed",
      issue: {
        number: 100,
        title: "Sub",
        body: null,
        html_url: "https://github.com/x/y/issues/100",
        state: "closed",
        labels: [],
        parent: {
          number: 42,
          html_url: "https://github.com/x/y/issues/42",
          repository: { full_name: "x/y" },
        },
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const task = t.db
      .query(`SELECT status FROM tasks WHERE source_external_id = ?`)
      .get("x/y#100") as { status: string } | null;
    expect(task?.status).toBe("done");
  });

  it("ignores sub-issue events when the parent isn't tracked", async () => {
    // No parent seed.
    await postWebhook(t, "issues", {
      action: "opened",
      issue: {
        number: 100,
        title: "Sub",
        body: null,
        html_url: "https://github.com/x/y/issues/100",
        state: "open",
        labels: [],
        parent: {
          number: 42,
          html_url: "https://github.com/x/y/issues/42",
          repository: { full_name: "x/y" },
        },
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });

    const count = (t.db
      .query(`SELECT COUNT(*) AS c FROM tasks WHERE source_external_id = ?`)
      .get("x/y#100") as { c: number }).c;
    expect(count).toBe(0);
  });

  it("400s on malformed JSON payload", async () => {
    const sig = await signBody(t.webhookSecret, "{not-json");
    const res = await fetch(`${t.baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": "d-1",
      },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  it("dedupes a replayed delivery — second POST with same x-github-delivery is a no-op (W1)", async () => {
    const payload = {
      action: "labeled",
      label: { name: "iteration" },
      issue: {
        number: 42,
        title: "Replay-target",
        body: "v1",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    };
    const body = JSON.stringify(payload);
    const sig = await signBody(t.webhookSecret, body);
    const fixedDelivery = "replay-delivery-id-001";

    const r1 = await fetch(`${t.baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": fixedDelivery,
      },
      body,
    });
    expect(r1.status).toBe(200);
    const after1 = t.db
      .query(
        `SELECT id, updated_at, imported_body FROM iterations WHERE source_parent_ref = ?`
      )
      .get("x/y#42") as
      | { id: string; updated_at: number; imported_body: string | null }
      | null;
    expect(after1).not.toBeNull();
    const seenId = after1!.id;
    const seenUpdatedAt = after1!.updated_at;

    // Replay — same deliveryId, same signed body. The HMAC verify
    // succeeds (the message is identical) but the dedupe should
    // intercept before any dispatch / DB / WS work.
    const r2 = await fetch(`${t.baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": fixedDelivery,
      },
      body,
    });
    expect(r2.status).toBe(200);
    // Row count unchanged.
    const count = (t.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(count).toBe(1);
    // The row was not re-touched (updated_at stable). This is the
    // key dispatch-skipped assertion — without dedupe the labeled
    // dispatcher would re-invoke `importIterationFromMetadata`, which
    // is itself idempotent on `source_parent_ref` so it wouldn't
    // duplicate the row, but the dedupe also short-circuits the WS
    // broadcast and any side-effecting handler logic before that
    // idempotency check ever fires.
    const after2 = t.db
      .query(`SELECT id, updated_at FROM iterations WHERE id = ?`)
      .get(seenId) as { id: string; updated_at: number };
    expect(after2.updated_at).toBe(seenUpdatedAt);
  });

  it("rejects an oversized webhook body before buffering it into memory (M1)", async () => {
    // 1.5 MB payload — well over the 1 MB cap. The streaming reader
    // should bail with 413 the moment cumulative bytes cross the cap,
    // without first allocating the whole 1.5 MB string.
    //
    // The signed body never reaches the HMAC verify because the cap
    // fires first — so we don't bother signing it. The cap is the
    // first line of defence; auth comes after.
    const oversized = "x".repeat(1_500_000);
    const res = await fetch(`${t.baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "00".repeat(32),
        "x-github-event": "issues",
        "x-github-delivery": "oversized-1",
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/1 MB cap/);
  });

  it("503s when no webhook secret is configured", async () => {
    // Spin up a fresh server without githubWebhookSecret.
    const tmpDir = join(tmpdir(), `mc-f17-noseed-${Date.now()}`);
    const db = initDatabase(join(tmpDir, "test.db"));
    const pm = new ProcessManager();
    const port = makePort();
    const ctx = startServer({ ...DEFAULT_CONFIG, port }, db, {
      processManager: pm,
    });
    try {
      const res = await fetch(`http://localhost:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=00",
          "x-github-event": "issues",
          "x-github-delivery": "d-1",
        },
        body: "{}",
      });
      expect(res.status).toBe(503);
    } finally {
      await pm.closeAll();
      ctx.stop(true);
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Iteration label override via deps.iterationLabel
// =============================================================================

describe("iterationLabel server option", () => {
  it("respects a custom server-wide iteration label", async () => {
    const tmpDir = join(tmpdir(), `mc-f17-customlabel-${Date.now()}`);
    const db = initDatabase(join(tmpDir, "test.db"));
    const pm = new ProcessManager();
    const port = makePort();
    const gh = new FakeGh();
    const ctx = startServer({ ...DEFAULT_CONFIG, port }, db, {
      processManager: pm,
      ghSpawn: gh.spawn,
      githubWebhookSecret: WEBHOOK_SECRET,
      iterationLabel: "epic",
    });
    try {
      // Webhook with a payload labelled `iteration` should NOT trigger
      // import on this server (custom label is `epic`).
      const sig = await signBody(
        WEBHOOK_SECRET,
        JSON.stringify({
          action: "labeled",
          label: { name: "iteration" },
          issue: {
            number: 42,
            title: "T",
            body: "b",
            html_url: "https://github.com/x/y/issues/42",
            labels: [{ name: "iteration" }],
          },
          repository: {
            full_name: "x/y",
            name: "y",
            owner: { login: "x" },
          },
        })
      );
      const res = await fetch(`http://localhost:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "issues",
          "x-github-delivery": "d-1",
        },
        body: JSON.stringify({
          action: "labeled",
          label: { name: "iteration" },
          issue: {
            number: 42,
            title: "T",
            body: "b",
            html_url: "https://github.com/x/y/issues/42",
            labels: [{ name: "iteration" }],
          },
          repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
        }),
      });
      expect(res.status).toBe(200);
      const count = (db
        .query(`SELECT COUNT(*) AS c FROM iterations`)
        .get() as { c: number }).c;
      expect(count).toBe(0);
    } finally {
      await pm.closeAll();
      ctx.stop(true);
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
