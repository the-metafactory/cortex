import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { WsClientRegistry } from "../ws/client-registry";
import type { WsData } from "../ws/types";

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

  it("serves the React dashboard shell on GET /", async () => {
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
  // operator knows what to override.
  it("throws when starting on a port already in use, with the port in the message", () => {
    let err: unknown;
    try {
      startServer({ ...DEFAULT_CONFIG, port: testPort }, db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String((err as Error).message)).toContain(String(testPort));
  });
});
