import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { WsClientRegistry } from "../ws/client-registry";
import type { WsData } from "../ws/types";

// Mirror `DASHBOARD_DIST` from ../server.ts. Server resolves it as
// `<server.ts dir>/../../dist/dashboard-v2`; from this test file that's
// three levels up (out of `__tests__/`, `mc/`, `surface/`) plus the same
// `dist/dashboard-v2` tail. Kept in lockstep with server.ts by hand —
// if the server path ever moves, this needs to move with it.
const DASHBOARD_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
  "dashboard-v2"
);
const DASHBOARD_INDEX = join(DASHBOARD_DIST, "index.html");
const dashboardBuilt = existsSync(DASHBOARD_INDEX);
if (!dashboardBuilt) {
  // One-line discoverable log so a developer who DOES build the dashboard
  // (or who wonders why the count says "1 skip") knows exactly how to
  // enable the skipped case. Matches cortex#89's "self-skip with a clear
  // log" requirement.
  console.log(
    `[mc-server-test] dashboard SPA test skipped — missing ${DASHBOARD_INDEX}. ` +
      `Run \`bun build src/dashboard/index.html --outdir=dist/dashboard-v2\` to enable.`
  );
}

describe("mission-control server", () => {
  let db: Database;
  let server: Server<WsData>;
  let wsRegistry: WsClientRegistry;
  const tmpDir = join(tmpdir(), `mc-server-test-${Date.now()}`);
  const testPort = 18767; // avoid conflict with real instance

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: testPort },
      db
    );
    server = ctx.server;
    wsRegistry = ctx.wsRegistry;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("responds 200 on GET /health", async () => {
    const res = await fetch(`http://localhost:${testPort}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.wsClients).toBe("number");
  });

  it("responds 404 on unknown routes", async () => {
    const res = await fetch(`http://localhost:${testPort}/nonexistent`);
    expect(res.status).toBe(404);
  });

  // cortex#89 — this case depends on the bundled dashboard artifact at
  // `dist/dashboard-v2/index.html`. The build is not part of `bun test`
  // (option 2 from cortex#89: self-skip rather than bloat every run with
  // a 10-30s build step). On a fresh checkout `dashboardBuilt` is false
  // and the case skips with a discoverable log line; once a developer
  // runs `bun build src/dashboard/index.html --outdir=dist/dashboard-v2`
  // the case becomes active.
  const dashboardIt = dashboardBuilt ? it : it.skip;
  dashboardIt("serves the React dashboard shell on GET /", async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Post-MIG-6 cutover: server returns the bundled React shell, not
    // the legacy monolith. The shell is small — we anchor on the React
    // mount point + page title rather than route strings (which now
    // live inside the bundled JS, not the HTML).
    expect(body).toContain('<div id="root">');
    expect(body).toContain("Grove · Mission Control");
  });

  // Spec NFR: "On port already in use: exit with clear error message naming the port".
  // The first server is bound by beforeAll on testPort — a second startServer on
  // the same port must throw, and the error must mention the port number so the
  // principal knows what to override.
  it("throws when starting on a port already in use, with the port in the message", () => {
    let err: unknown;
    try {
      startServer({ ...DEFAULT_CONFIG, port: testPort }, db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toContain(String(testPort));
  });
});
