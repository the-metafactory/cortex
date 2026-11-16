import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { DESK_API_ROUTES } from "../../../desk-api/routes";
import type { Database } from "bun:sqlite";
import type { ConversationHost } from "../../../conversations/host";
import type { ConnectionSetupService } from "../../../conversations/connection-setup";
import type { FlowSurfaceReader } from "../desk/flow-surfaces";
import type { Server } from "bun";
import type { WsData } from "../ws/types";

const UUID = "00000000-0000-4000-8000-000000000000";
const FIXTURE_IDS: Record<string, string> = {
  id: UUID,
  proposalId: UUID,
  grantId: `grant-${"0".repeat(32)}`,
  entryId: "1",
  inputId: "input-1",
  name: "fixture-flow",
  ref: "fixture-ref",
};

const unreadableFlows: FlowSurfaceReader = {
  list: () => Promise.reject(new Error("fixture")),
  definition: () => Promise.reject(new Error("fixture")),
  card: () => Promise.reject(new Error("fixture")),
};

const failingService = (): object => new Proxy({}, { get: (_target, name) => (name === "then" ? undefined : name === "attachSources" ? () => Promise.resolve() : () => Promise.reject(new Error("fixture"))) });
const readyConversations = Object.assign(() => ({ state: "ready" as const, host: failingService() as ConversationHost, tookOver: null, resumed: [], reconciled: [] }), { discord: () => null });
const connectionService = failingService() as ConnectionSetupService;

const withFixtureIds = (path: string): string => path.replace(/\{(\w+)\}/g, (_match, key: string) => FIXTURE_IDS[key] ?? "fixture");

describe("pinned Desk API routes", () => {
  let db: Database;
  let server: Server<WsData>;
  const tmpDir = join(tmpdir(), `desk-api-routes-test-${Date.now()}`);
  const port = 18768;

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    server = startServer({ ...DEFAULT_CONFIG, port }, db, { flowSurfaces: () => unreadableFlows, conversations: readyConversations, connectionSetup: () => connectionService }).server;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const probe = async (method: string, path: string): Promise<number> => {
    const hasBody = method !== "GET" && method !== "DELETE";
    const abort = new AbortController();
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      signal: abort.signal,
      ...(hasBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    abort.abort();
    return res.status;
  };
  const unserved = async (routes: readonly { method: string; path: string }[]): Promise<string[]> => {
    const found: string[] = [];
    for (const { method, path } of routes) {
      const status = await probe(method, withFixtureIds(path));
      if (status === 404 || status === 405) found.push(`${method} ${path} answered ${status}`);
    }
    return found;
  };

  it("serves every pinned method and path without a 404 or 405", async () => {
    expect(await unserved(DESK_API_ROUTES)).toEqual([]);
  });

  it("names a path or method the router does not serve", async () => {
    const missing = await unserved([
      { method: "GET", path: "/api/conversations/{id}/not-a-part" },
      { method: "DELETE", path: "/api/conversations/{id}/stream" },
      { method: "GET", path: "/api/desk/connections/{id}/not-an-action" },
      { method: "PUT", path: "/api/desk/connections" },
    ]);
    expect(missing).toHaveLength(4);
  });

  it("lists no route twice and none outside the pinned scope", () => {
    const keys = DESK_API_ROUTES.map(({ method, path }) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const excluded = ["/api/conversations/discord/check", "/api/attention", "/health", "/ws", "/api/desk/adapters"];
    expect(DESK_API_ROUTES.filter(({ path }) => excluded.some((base) => path === base || path.startsWith(`${base}/`)))).toEqual([]);
  });
});
