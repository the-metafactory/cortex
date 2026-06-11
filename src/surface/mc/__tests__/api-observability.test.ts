/**
 * P-14 U0.1 — server-route integration for `/api/observability/*`.
 *
 * Boots the real MC server (with a real loopback "fake sideband" Bun.serve) and
 * verifies the proxy route: happy-path passthrough, structured error mapping,
 * and the "no sideband configured" not-available path. The proxy internals are
 * unit-tested in `src/common/sideband/__tests__/proxy.test.ts`; this asserts the
 * server wiring (route prefix, dep threading, suffix/query forwarding).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";

interface Ctx {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  baseUrl: string;
  tmpDir: string;
  sideband: { url: string; stop: () => void; lastPath: () => string | null };
}

/** A loopback fake sideband: records the requested path, returns canned bodies. */
function startFakeSideband(): { url: string; stop: () => void; lastPath: () => string | null } {
  let lastPath: string | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      lastPath = u.pathname + u.search;
      if (u.pathname === "/traces") {
        // Simulate a backend-down SidebandError for a sentinel id so the proxy's
        // verbatim relay (status + body + deep_link) is exercised.
        if (u.searchParams.get("correlation_id") === "down") {
          return Response.json(
            { code: "backend_unavailable", message: "down", deep_link: "https://grafana/x" },
            { status: 503 },
          );
        }
        return Response.json({ correlation_id: "abc", backend: "victoria", spans: [] });
      }
      if (u.pathname.endsWith("/timeline")) {
        return Response.json({ correlation_id: "abc", backend: "victoria", entries: [] });
      }
      if (u.pathname === "/healthz") {
        return Response.json({ status: "ok", backend: "victoria" });
      }
      return Response.json({ code: "internal_error", message: "unknown" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    lastPath: () => lastPath,
  };
}

async function setup(withSideband: boolean): Promise<Ctx> {
  const tmpDir = join(tmpdir(), `mc-obs-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const fake = startFakeSideband();
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port: 0 },
    db,
    {
      processManager: pm,
      ...(withSideband ? { sidebandUrl: fake.url } : {}),
    },
  );
  const port = ctx.server.port;
  if (port === undefined) throw new Error("server.port unresolved");
  return {
    db,
    ctx,
    pm,
    baseUrl: `http://localhost:${port}`,
    tmpDir,
    sideband: { url: fake.url, stop: fake.stop, lastPath: fake.lastPath },
  };
}

async function teardown(t: Ctx): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  t.sideband.stop();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

describe("GET /api/observability/* — proxy wired", () => {
  let t: Ctx;
  beforeEach(async () => {
    t = await setup(true);
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("proxies /traces and forwards the query string", async () => {
    const res = await fetch(`${t.baseUrl}/api/observability/traces?correlation_id=abcd`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("victoria");
    expect(t.sideband.lastPath()).toBe("/traces?correlation_id=abcd");
  });

  it("proxies /traces/{id}/timeline", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const res = await fetch(`${t.baseUrl}/api/observability/traces/${id}/timeline`);
    expect(res.status).toBe(200);
    expect(t.sideband.lastPath()).toBe(`/traces/${id}/timeline`);
  });

  it("proxies /healthz", async () => {
    const res = await fetch(`${t.baseUrl}/api/observability/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("relays a sideband SidebandError + deep_link verbatim", async () => {
    const res = await fetch(`${t.baseUrl}/api/observability/traces?correlation_id=down`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(body.deep_link).toBe("https://grafana/x");
  });

  it("refuses an unknown endpoint with a structured 404 (never reaches upstream)", async () => {
    const res = await fetch(`${t.baseUrl}/api/observability/admin/secrets`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("internal_error");
  });
});

describe("GET /api/observability/* — no sideband configured", () => {
  let t: Ctx;
  beforeEach(async () => {
    t = await setup(false);
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns a structured not-available error (not a 500 splat)", async () => {
    const res = await fetch(`${t.baseUrl}/api/observability/traces?correlation_id=x`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(body.message).toContain("interior capture not available");
  });
});
