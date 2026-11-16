import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { DESK_API_ROUTES } from "../../../desk-api/routes";
import type { Database } from "bun:sqlite";
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

const withFixtureIds = (path: string): string => path.replace(/\{(\w+)\}/g, (_match, key: string) => FIXTURE_IDS[key] ?? "fixture");

describe("pinned Desk API routes", () => {
  let db: Database;
  let server: Server<WsData>;
  const tmpDir = join(tmpdir(), `desk-api-routes-test-${Date.now()}`);
  const port = 18768;

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    server = startServer({ ...DEFAULT_CONFIG, port }, db, { flowSurfaces: () => unreadableFlows }).server;
  });

  afterAll(() => {
    server.stop(true);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves every pinned method and path without a 404 or 405", async () => {
    const unserved: string[] = [];
    for (const { method, path } of DESK_API_ROUTES) {
      const hasBody = method !== "GET" && method !== "DELETE";
      const res = await fetch(`http://localhost:${port}${withFixtureIds(path)}`, {
        method,
        ...(hasBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
      });
      if (res.status === 404 || res.status === 405) unserved.push(`${method} ${path} answered ${res.status}`);
    }
    expect(unserved).toEqual([]);
  });

  it("lists no route twice and none outside the pinned scope", () => {
    const keys = DESK_API_ROUTES.map(({ method, path }) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const excluded = ["/api/conversations/discord/check", "/api/attention", "/health", "/ws", "/api/desk/adapters"];
    expect(DESK_API_ROUTES.filter(({ path }) => excluded.some((base) => path === base || path.startsWith(`${base}/`)))).toEqual([]);
  });
});
