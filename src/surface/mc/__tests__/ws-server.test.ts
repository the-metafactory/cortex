import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import type { Database } from "bun:sqlite";
import type { WsClientRegistry } from "../ws/client-registry";

/**
 * Poll until predicate returns true, or throw after timeout. Deterministic
 * replacement for fixed setTimeout waits — lets the event loop settle between
 * checks without burning a fixed budget.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Close a WebSocket and resolve when the `close` event fires on the client.
 * Does NOT guarantee the server has finished its own close handler — pair
 * with `waitUntil(() => wsRegistry.size === expected)` for that.
 */
function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close();
  });
}

/**
 * Connect a WebSocket and collect all messages into an array.
 * Returns the ws, the messages array, and a helper to wait for N messages.
 */
function createClient(port: number): Promise<{
  ws: WebSocket;
  messages: any[];
  waitFor: (n: number) => Promise<any[]>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: any[] = [];
    let waitResolve: ((msgs: any[]) => void) | null = null;
    let waitCount = 0;

    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string));
      if (waitResolve && messages.length >= waitCount) {
        waitResolve(messages.slice());
        waitResolve = null;
      }
    };

    ws.onopen = () => {
      resolve({
        ws,
        messages,
        waitFor(n: number) {
          if (messages.length >= n) return Promise.resolve(messages.slice());
          waitCount = n;
          return new Promise((res, rej) => {
            waitResolve = res;
            setTimeout(() => rej(new Error(`WS timeout waiting for ${n} messages, got ${messages.length}`)), 3000);
          });
        },
      });
    };

    ws.onerror = () => reject(new Error("WS connect error"));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
}

describe("WebSocket server", () => {
  let db: Database;
  let serverCtx: ServerContext;
  let wsRegistry: WsClientRegistry;
  const tmpDir = join(tmpdir(), `mc-ws-test-${Date.now()}`);
  const testPort = 18768;

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    serverCtx = startServer({ ...DEFAULT_CONFIG, port: testPort }, db);
    wsRegistry = serverCtx.wsRegistry;
  });

  afterAll(() => {
    // Use serverCtx.stop() — not server.stop() — to also clear the ping
    // setInterval. Without this, the test runner hangs on the leaked timer.
    serverCtx.stop(true);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends connected message on WebSocket open", async () => {
    const client = await createClient(testPort);
    const msgs = await client.waitFor(1);

    expect(msgs[0].type).toBe("connected");
    expect(typeof msgs[0].clientId).toBe("string");
    expect(msgs[0].clientId.length).toBe(26);
    expect(msgs[0].serverVersion).toBe("0.1.0");
    expect(msgs[0].protocolVersion).toBe(1);

    await closeAndWait(client.ws);
    await waitUntil(() => wsRegistry.size === 0);
  });

  it("tracks connected clients in registry", async () => {
    await waitUntil(() => wsRegistry.size === 0);
    const before = wsRegistry.size;

    const client = await createClient(testPort);
    await client.waitFor(1); // connected
    await waitUntil(() => wsRegistry.size === before + 1);

    await closeAndWait(client.ws);
    await waitUntil(() => wsRegistry.size === before);
  });

  it("responds to ping with pong", async () => {
    const client = await createClient(testPort);
    await client.waitFor(1); // connected

    client.ws.send(JSON.stringify({ type: "ping" }));
    const msgs = await client.waitFor(2); // connected + pong

    expect(msgs[1].type).toBe("pong");
    await closeAndWait(client.ws);
  });

  it("responds with error for invalid JSON", async () => {
    const client = await createClient(testPort);
    await client.waitFor(1); // connected

    client.ws.send("NOT JSON");
    const msgs = await client.waitFor(2);

    expect(msgs[1].type).toBe("error");
    expect(msgs[1].message).toContain("Invalid JSON");
    await closeAndWait(client.ws);
  });

  it("responds with error for unknown message type", async () => {
    const client = await createClient(testPort);
    await client.waitFor(1); // connected

    client.ws.send(JSON.stringify({ type: "unknown_type" }));
    const msgs = await client.waitFor(2);

    expect(msgs[1].type).toBe("error");
    expect(msgs[1].message).toContain("unknown_type");
    await closeAndWait(client.ws);
  });

  it("broadcast reaches all connected clients", async () => {
    const c1 = await createClient(testPort);
    const c2 = await createClient(testPort);
    await c1.waitFor(1); // connected
    await c2.waitFor(1); // connected

    wsRegistry.broadcast({
      type: "state.transition",
      assignmentId: "ata-1",
      from: "running",
      to: "blocked",
    });

    const msgs1 = await c1.waitFor(2); // connected + broadcast
    const msgs2 = await c2.waitFor(2);

    expect(msgs1[1].type).toBe("state.transition");
    expect(msgs1[1].assignmentId).toBe("ata-1");
    expect(msgs2[1].type).toBe("state.transition");

    await Promise.all([closeAndWait(c1.ws), closeAndWait(c2.ws)]);
  });

  it("health endpoint reports wsClients count", async () => {
    const client = await createClient(testPort);
    await client.waitFor(1); // connected

    const res = await fetch(`http://localhost:${testPort}/health`);
    const body = await res.json();
    expect(body.wsClients).toBeGreaterThanOrEqual(1);

    await closeAndWait(client.ws);
  });
});
