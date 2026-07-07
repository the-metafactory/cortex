/**
 * FND-6 — end-to-end coverage for the daemon mutation-surface hardening
 * (docs/plan-mc-future-state.md §4.0), booting the REAL Bun.serve stack.
 *
 * The headline threat is **DNS rebinding**: attacker JS rebinds a hostname it
 * controls to 127.0.0.1, becoming same-origin to the loopback daemon, and
 * drives principal-credentialed mutations (`POST /api/sessions` spawns a CC
 * session). `fetch` cannot forge the `Host` header (it is derived from the URL
 * authority), so these cases use a **raw TCP socket** to send a hand-crafted
 * HTTP/1.1 request with a spoofed `Host` / `Origin` — the exact shape a rebind
 * produces — and assert the guard rejects it (403) before any handler runs.
 *
 * Also locks: unauthenticated `/api/sessions` is 401; the `mc.governance.
 * principals` authorization binding (allowed → through; not-listed → 403); and
 * the CK-6a attention lifecycle route rides the same gate.
 */

import { describe, it, expect, afterEach } from "bun:test";
import net from "node:net";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import type { Config } from "../types";
import { upsertAttentionItem } from "../db/attention";
import type { Database } from "bun:sqlite";

const PRINCIPAL = "principal@example.com";
const AUTH_HEADER = { "Cf-Access-Authenticated-User-Email": PRINCIPAL };

const fakeCatSpawn: SpawnFn = () =>
  Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

interface Ctx {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

function start(governance?: string[]): Ctx {
  const tmpDir = join(tmpdir(), `mc-fnd6-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const config: Config = {
    ...DEFAULT_CONFIG,
    port: 0, // ephemeral — bound port read back from ctx.server.port
    ...(governance ? { governance: { principals: governance } } : {}),
  };
  const ctx = startServer(config, db, { processManager: pm, spawn: fakeCatSpawn });
  const port = ctx.server.port;
  if (port === undefined) throw new Error("server.port unresolved after start");
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

async function teardown(c: Ctx): Promise<void> {
  await c.pm.closeAll();
  c.ctx.stop(true);
  c.db.close();
  rmSync(c.tmpDir, { recursive: true, force: true });
}

/**
 * Send a hand-crafted HTTP/1.1 request over a raw TCP socket so the `Host` /
 * `Origin` headers are exactly what we write — the rebinding shape `fetch`
 * refuses to produce. Returns the parsed status code.
 */
function rawHttp(
  port: number,
  opts: {
    method?: string;
    path: string;
    host: string;
    origin?: string;
    email?: string;
    body?: string;
  },
): Promise<number> {
  const { method = "POST", path, host, origin, email, body = "" } = opts;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`];
  if (origin !== undefined) lines.push(`Origin: ${origin}`);
  if (email !== undefined) lines.push(`Cf-Access-Authenticated-User-Email: ${email}`);
  lines.push("Content-Type: application/json");
  lines.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
  lines.push("Connection: close");
  lines.push("", body);
  const payload = lines.join("\r\n");

  return new Promise<number>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(payload);
    });
    let data = "";
    sock.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    sock.on("end", () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on("error", reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error("raw http request timed out"));
    });
  });
}

const SESSION_BODY = JSON.stringify({ title: "Hello" });

describe("FND-6 — Host-header allowlist (anti-DNS-rebinding)", () => {
  let c: Ctx;
  afterEach(() => teardown(c));

  it("REJECTS a mutating request with a foreign Host (the rebinding tell) — 403", async () => {
    c = start();
    // Rebind shape: connected to 127.0.0.1 but Host carries the attacker origin,
    // AND a forged CF-Access identity header. The Host allowlist trips first.
    const status = await rawHttp(c.port, {
      path: "/api/sessions",
      host: "evil.attacker.example",
      email: PRINCIPAL,
      body: SESSION_BODY,
    });
    expect(status).toBe(403);
    // The spawn must NOT have run — no controlled process was created.
    expect(c.pm.size).toBe(0);
  });

  it("ACCEPTS a legitimate loopback Host on the bound port", async () => {
    c = start();
    const status = await rawHttp(c.port, {
      path: "/api/sessions",
      host: `127.0.0.1:${c.port}`,
      email: PRINCIPAL,
      body: SESSION_BODY,
    });
    expect(status).toBe(201);
  });

  it("REJECTS a loopback host on the WRONG port — 403", async () => {
    c = start();
    const status = await rawHttp(c.port, {
      path: "/api/sessions",
      host: "127.0.0.1:1",
      email: PRINCIPAL,
      body: SESSION_BODY,
    });
    expect(status).toBe(403);
  });
});

describe("FND-6 — foreign-Origin rejection", () => {
  let c: Ctx;
  afterEach(() => teardown(c));

  it("REJECTS a mutating request bearing a foreign Origin — 403", async () => {
    c = start();
    const status = await rawHttp(c.port, {
      path: "/api/sessions",
      host: `127.0.0.1:${c.port}`,
      origin: "https://evil.attacker.example",
      email: PRINCIPAL,
      body: SESSION_BODY,
    });
    expect(status).toBe(403);
    expect(c.pm.size).toBe(0);
  });

  it("ACCEPTS a same-origin loopback Origin", async () => {
    c = start();
    const status = await rawHttp(c.port, {
      path: "/api/sessions",
      host: `127.0.0.1:${c.port}`,
      origin: `http://127.0.0.1:${c.port}`,
      email: PRINCIPAL,
      body: SESSION_BODY,
    });
    expect(status).toBe(201);
  });
});

describe("FND-6 — identity gate on the session-control routes", () => {
  let c: Ctx;
  afterEach(() => teardown(c));

  it("REJECTS unauthenticated POST /api/sessions — 401 (no unauthenticated mutation tier)", async () => {
    c = start();
    // fetch → Host is the valid loopback authority; NO CF-Access identity header.
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
    expect(c.pm.size).toBe(0);
  });

  it("ALLOWS an authenticated POST /api/sessions on loopback (unset allowlist) — 201", async () => {
    c = start();
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADER },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(201);
  });

  it("REJECTS unauthenticated POST /api/assignments/:id/requeue — 401", async () => {
    c = start();
    const res = await fetch(`${c.baseUrl}/api/assignments/does-not-matter/requeue`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

describe("FND-6 — authorization binding (mc.governance.principals)", () => {
  let c: Ctx;
  afterEach(() => teardown(c));

  it("ALLOWS a listed principal — 201", async () => {
    c = start([PRINCIPAL]);
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADER },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(201);
  });

  it("REJECTS an authenticated-but-unlisted principal — 403", async () => {
    c = start(["someone@else.example"]);
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADER },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_authorized");
    expect(c.pm.size).toBe(0);
  });
});

describe("FND-6 — CK-6a attention lifecycle rides the same gate", () => {
  let c: Ctx;
  afterEach(() => teardown(c));

  function seedAttention(db: Database, id: string): void {
    upsertAttentionItem(db, {
      id,
      stackId: "test-stack",
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "normal",
      status: "open",
    });
  }

  it("REJECTS unauthenticated resolve — 401", async () => {
    c = start();
    seedAttention(c.db, "att-1");
    const res = await fetch(`${c.baseUrl}/api/attention/att-1/resolve`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("ALLOWS an authenticated resolve — 200 and flips db status", async () => {
    c = start();
    seedAttention(c.db, "att-2");
    const res = await fetch(`${c.baseUrl}/api/attention/att-2/resolve`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("resolved");
    const row = c.db
      .query("SELECT status FROM attention_items WHERE id = ?")
      .get("att-2") as { status: string } | null;
    expect(row?.status).toBe("resolved");
  });

  it("REJECTS a foreign Host on the attention route — 403", async () => {
    c = start();
    seedAttention(c.db, "att-3");
    const status = await rawHttp(c.port, {
      path: "/api/attention/att-3/dismiss",
      host: "evil.attacker.example",
      email: PRINCIPAL,
    });
    expect(status).toBe(403);
  });
});
