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

import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach } from "bun:test";
import net from "node:net";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import type { CfAccessConfig, Config } from "../types";
import { upsertAttentionItem } from "../db/attention";
import type { Database } from "bun:sqlite";
import { cfAccessCertsUrl, cfAccessIssuer, resetCfAccessJwksCache } from "../../../common/auth/cf-access-jwt";
import { createCfAccessSigningKeys, jwksFetch, mintCfAccessJwt, type CfAccessSigningKeys } from "../api/__tests__/cf-access-fixture";

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

function start(principals?: string[], localPrincipal?: string, cfAccess?: CfAccessConfig): Ctx {
  const tmpDir = join(tmpdir(), `mc-fnd6-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const config: Config = {
    ...DEFAULT_CONFIG,
    port: 0, // ephemeral — bound port read back from ctx.server.port
    ...(principals || localPrincipal
      ? {
          governance: {
            principals: principals ?? [],
            ...(localPrincipal ? { localPrincipal } : {}),
          },
        }
      : {}),
    ...(cfAccess ? { cfAccess } : {}),
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
    jwt?: string;
    body?: string;
  },
): Promise<number> {
  const { method = "POST", path, host, origin, email, jwt, body = "" } = opts;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`];
  if (origin !== undefined) lines.push(`Origin: ${origin}`);
  if (email !== undefined) lines.push(`Cf-Access-Authenticated-User-Email: ${email}`);
  if (jwt !== undefined) lines.push(`Cf-Access-Jwt-Assertion: ${jwt}`);
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

describe("FND-6 posture A — legitimate loopback dashboard requests succeed (headerless, same-origin)", () => {
  // The regression FND-6 shipped: the dashboard calls the daemon over loopback
  // with a same-origin Origin, the correct Host, and NO CF-Access header (there
  // is no CF Access in front of a bare loopback daemon). On main every mutating
  // route 401s. Posture A resolves the headerless loopback caller to the local
  // principal so these succeed — the Host+Origin allowlist is the real boundary.
  let c: Ctx;
  afterEach(() => teardown(c));

  it("ALLOWS a headerless, same-origin POST /api/sessions on loopback — 201 (was 401 on main)", async () => {
    c = start();
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: c.baseUrl },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(201); // NOT 401 — the regression is fixed.
  });

  it("ALLOWS a headerless attention resolve on loopback — 200 (auth-pass, not 401)", async () => {
    c = start();
    upsertAttentionItem(c.db, {
      id: "dash-att",
      stackId: "s",
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "normal",
      status: "open",
    });
    const res = await fetch(`${c.baseUrl}/api/attention/dash-att/resolve`, {
      method: "POST",
      headers: { origin: c.baseUrl },
    });
    expect(res.status).toBe(200);
  });

  it("does NOT 401 a headerless requeue/abandon/input on loopback (auth-pass; handler-level status only)", async () => {
    c = start();
    // Send-input (`/input`) is a dashboard control too — cover it here so the
    // "every mutating control" claim is real (finding #2).
    for (const route of ["requeue", "abandon", "input"] as const) {
      const res = await fetch(
        `${c.baseUrl}/api/assignments/nonexistent/${route}`,
        { method: "POST", headers: { "content-type": "application/json", origin: c.baseUrl }, body: "{}" },
      );
      // Auth passed → the handler runs; it may 4xx on the unknown assignment,
      // but it must NOT be the 401 the pre-posture-A gate produced.
      expect(res.status).not.toBe(401);
    }
  });

  it("ALLOWS a headerless attention DISMISS on loopback — 200 (auth-pass, not 401)", async () => {
    c = start();
    upsertAttentionItem(c.db, {
      id: "dash-att-dismiss",
      stackId: "s",
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "normal",
      status: "open",
    });
    const res = await fetch(`${c.baseUrl}/api/attention/dash-att-dismiss/dismiss`, {
      method: "POST",
      headers: { origin: c.baseUrl },
    });
    expect(res.status).toBe(200);
  });

  it("uses the header for audit attribution when present (still 201)", async () => {
    c = start();
    const res = await fetch(`${c.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: c.baseUrl, ...AUTH_HEADER },
      body: SESSION_BODY,
    });
    expect(res.status).toBe(201);
  });
});

describe("FND-6 — the tasks/iterations family is now identity-gated (cortex#1640, invariant 3)", () => {
  // These reach their handlers on main (400/404, not 401) — unauthenticated.
  // `POST /api/tasks` enqueues work the runner spawns as a principal-credentialed
  // CC session; `/api/iterations/from-github` shells out to `gh`. Posture A keeps
  // the headerless local dashboard working (unset allowlist ⇒ permissive on
  // loopback), while the authorization binding below proves the gate is real.
  let c: Ctx;
  afterEach(() => teardown(c));

  it("403s a headerless POST /api/tasks when the local-principal fallback is unlisted", async () => {
    // Allowlist set + local_principal deliberately NOT in it → the headerless
    // fallback identity is refused. This is the gate the family lacked entirely.
    c = start(["allowed@principal.test"], "unlisted@local.box");
    const res = await fetch(`${c.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: c.baseUrl },
      body: JSON.stringify({ source: "x" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_authorized");
  });

  it("403s a headerless POST /api/iterations/from-github when the fallback is unlisted", async () => {
    c = start(["allowed@principal.test"], "unlisted@local.box");
    const res = await fetch(`${c.baseUrl}/api/iterations/from-github`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: c.baseUrl },
      body: JSON.stringify({ url: "https://github.com/x/y/issues/1" }),
    });
    expect(res.status).toBe(403);
  });

  it("REJECTS a foreign Host on POST /api/tasks — 403 (rebind guard still applies)", async () => {
    c = start();
    const status = await rawHttp(c.port, {
      path: "/api/tasks",
      host: "evil.attacker.example",
      email: PRINCIPAL,
      body: JSON.stringify({ source: "x" }),
    });
    expect(status).toBe(403);
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

  it("resolves the headerless loopback caller to the local principal — 200 (posture A), not 401", async () => {
    c = start();
    seedAttention(c.db, "att-1");
    const res = await fetch(`${c.baseUrl}/api/attention/att-1/resolve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
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

describe("cfAccess.hostnames — a request under an Access hostname must carry a verified Access JWT", () => {
  const TEAM = "test-team";
  const AUD = "test-access-aud";
  const ACCESS_HOST = "desk.example.com";
  const ACCESS_ORIGIN = `https://${ACCESS_HOST}`;
  const CF_ACCESS: CfAccessConfig = { aud: AUD, teamDomain: TEAM, hostnames: [ACCESS_HOST] };
  const realFetch = globalThis.fetch;
  let keys: CfAccessSigningKeys;
  let c: Ctx;

  function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return { aud: AUD, iss: cfAccessIssuer(TEAM), email: PRINCIPAL, iat: now - 30, exp: now + 3600, ...over };
  }

  beforeAll(async () => {
    keys = await createCfAccessSigningKeys();
    const serveJwks = jwksFetch(keys.jwk);
    const urlOf = (input: RequestInfo | URL): string =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input) === cfAccessCertsUrl(TEAM) ? serveJwks(input, init) : realFetch(input, init)) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    resetCfAccessJwksCache();
    c = start([PRINCIPAL], PRINCIPAL, CF_ACCESS);
  });
  afterEach(() => teardown(c));

  it("ALLOWS a mutation with a verified JWT for a listed principal — 201", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims());
    const status = await rawHttp(c.port, { path: "/api/sessions", host: ACCESS_HOST, origin: ACCESS_ORIGIN, jwt, body: SESSION_BODY });
    expect(status).toBe(201);
  });

  it("ALLOWS a read with a verified JWT — 200", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims());
    expect(await rawHttp(c.port, { method: "GET", path: "/health", host: ACCESS_HOST, jwt })).toBe(200);
  });

  it("REJECTS a read without a JWT — 401, the edge is not the only gate", async () => {
    expect(await rawHttp(c.port, { method: "GET", path: "/health", host: ACCESS_HOST })).toBe(401);
  });

  it("REJECTS a self-asserted email header without a JWT — 401, no loopback trust under an Access hostname", async () => {
    const status = await rawHttp(c.port, { path: "/api/sessions", host: ACCESS_HOST, origin: ACCESS_ORIGIN, email: PRINCIPAL, body: SESSION_BODY });
    expect(status).toBe(401);
    expect(c.pm.size).toBe(0);
  });

  it("REJECTS a JWT signed by a key outside the team JWKS — 401", async () => {
    const jwt = await mintCfAccessJwt(keys.wrongKey, claims());
    expect(await rawHttp(c.port, { method: "GET", path: "/health", host: ACCESS_HOST, jwt })).toBe(401);
  });

  it("REJECTS a JWT minted for another Access application — 401", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims({ aud: "another-app" }));
    expect(await rawHttp(c.port, { method: "GET", path: "/health", host: ACCESS_HOST, jwt })).toBe(401);
  });

  it("REJECTS a verified JWT for a principal outside mc.governance.principals — 403", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims({ email: "someone-else@example.com" }));
    expect(await rawHttp(c.port, { method: "GET", path: "/health", host: ACCESS_HOST, jwt })).toBe(403);
  });

  it("keeps result files loopback-only even with a verified JWT — 404", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims());
    expect(await rawHttp(c.port, { method: "GET", path: "/results/anything", host: ACCESS_HOST, jwt })).toBe(404);
  });

  it("leaves the loopback path unchanged — headerless same-origin mutation still 201", async () => {
    const status = await rawHttp(c.port, { path: "/api/sessions", host: `127.0.0.1:${c.port}`, origin: `http://127.0.0.1:${c.port}`, body: SESSION_BODY });
    expect(status).toBe(201);
  });

  it("still REJECTS a foreign Host — 403", async () => {
    const jwt = await mintCfAccessJwt(keys.signKey, claims());
    expect(await rawHttp(c.port, { path: "/api/sessions", host: "evil.attacker.example", jwt, body: SESSION_BODY })).toBe(403);
  });
});
