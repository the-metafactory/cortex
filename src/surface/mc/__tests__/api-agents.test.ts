import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer } from "../server";
import type { ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import type {
  AgentPresenceSnapshotRecord,
  AgentPresenceView,
} from "../api/agents";
import type { Database } from "bun:sqlite";

const PORT_BIND_ANY = 0;

function rec(
  over: Partial<AgentPresenceSnapshotRecord> & { agentId: string }
): AgentPresenceSnapshotRecord {
  const { agentId } = over;
  return {
    key: `andreas/research/${agentId}`,
    origin: "local",
    nkeyPublicKey: `N${agentId.toUpperCase()}`,
    assistantName: null,
    principal: "andreas",
    stack: "research",
    capabilities: [],
    state: "online",
    lastSeenAt: 1000,
    ...over,
  };
}

interface Ctx {
  db: Database;
  ctx: ServerContext;
  baseUrl: string;
  tmpDir: string;
}

function startWith(
  agentPresence?: () => AgentPresenceView | null
): Ctx {
  const tmpDir = join(tmpdir(), `mc-agents-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port: PORT_BIND_ANY },
    db,
    agentPresence ? { agentPresence } : {}
  );
  return { db, ctx, baseUrl: `http://localhost:${ctx.port}`, tmpDir };
}

function teardown(c: Ctx): void {
  c.ctx.stop(true);
  c.db.close();
  rmSync(c.tmpDir, { recursive: true, force: true });
}

describe("GET /api/agents", () => {
  let c: Ctx;
  afterEach(() => {
    teardown(c);
  });

  it("returns an empty list when no presence registry is wired (gating mismatch)", async () => {
    c = startWith();
    const res = await fetch(`${c.baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agents: [] });
  });

  it("returns an empty list when the getter resolves to null", async () => {
    c = startWith(() => null);
    const res = await fetch(`${c.baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toEqual([]);
  });

  it("projects the registry snapshot into the snake_case DTO", async () => {
    const view: AgentPresenceView = {
      getAgents: () => [
        rec({
          agentId: "luna",
          assistantName: "Luna",
          capabilities: ["review.code", "review.design"],
          state: "online",
          startedAt: "2026-06-10T00:00:00.000Z",
          lastHeartbeatAt: 5000,
          lastSeenAt: 5000,
        }),
        rec({
          agentId: "echo",
          assistantName: "Echo",
          state: "offline",
          offlineReason: "graceful-shutdown",
          lastSeenAt: 4000,
        }),
      ],
    };
    c = startWith(() => view);
    const res = await fetch(`${c.baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(2);

    const luna = body.agents[0];
    expect(luna.key).toBe("andreas/research/luna");
    expect(luna.agent_id).toBe("luna");
    expect(luna.assistant_name).toBe("Luna");
    expect(luna.nkey_public_key).toBe("NLUNA");
    expect(luna.principal).toBe("andreas");
    expect(luna.stack).toBe("research");
    expect(luna.capabilities).toEqual(["review.code", "review.design"]);
    expect(luna.state).toBe("online");
    expect(luna.offline_reason).toBeNull();
    expect(luna.started_at).toBe("2026-06-10T00:00:00.000Z");
    expect(luna.last_heartbeat_at).toBe(5000);
    expect(luna.last_seen_at).toBe(5000);

    const echo = body.agents[1];
    expect(echo.agent_id).toBe("echo");
    expect(echo.state).toBe("offline");
    expect(echo.offline_reason).toBe("graceful-shutdown");
    expect(echo.last_heartbeat_at).toBeNull();
    expect(echo.started_at).toBeNull();
  });

  it("exposes origin: a local agent as \"local\", a foreign agent as {principal,stack} (G-1114.E.4)", async () => {
    const view: AgentPresenceView = {
      getAgents: () => [
        rec({ agentId: "luna", origin: "local" }),
        rec({
          agentId: "sage",
          key: "jc/research/sage",
          principal: "jc",
          stack: "research",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
        }),
      ],
    };
    c = startWith(() => view);
    const body = await (await fetch(`${c.baseUrl}/api/agents`)).json();

    const luna = body.agents.find((a: { agent_id: string }) => a.agent_id === "luna");
    expect(luna.origin).toBe("local");

    const sage = body.agents.find((a: { agent_id: string }) => a.agent_id === "sage");
    expect(sage.origin).toEqual({ principal: "jc", stack: "research" });
  });

  it("surfaces offline_reason for the inferred TTL lapse, and null while online (G-1114.C.4)", async () => {
    const view: AgentPresenceView = {
      getAgents: () => [
        rec({ agentId: "luna", state: "online", lastHeartbeatAt: 9000, lastSeenAt: 9000 }),
        rec({
          agentId: "sage",
          state: "offline",
          offlineReason: "ttl_lapse",
          lastHeartbeatAt: 1000,
          lastSeenAt: 1000,
        }),
      ],
    };
    c = startWith(() => view);
    const body = await (await fetch(`${c.baseUrl}/api/agents`)).json();

    const luna = body.agents.find((a: { agent_id: string }) => a.agent_id === "luna");
    expect(luna.state).toBe("online");
    expect(luna.offline_reason).toBeNull();

    const sage = body.agents.find((a: { agent_id: string }) => a.agent_id === "sage");
    expect(sage.state).toBe("offline");
    expect(sage.offline_reason).toBe("ttl_lapse");
  });

  it("resolves the getter lazily per request (registry attaches after boot)", async () => {
    let live: AgentPresenceView | null = null;
    c = startWith(() => live);

    const before = await fetch(`${c.baseUrl}/api/agents`);
    expect((await before.json()).agents).toEqual([]);

    live = { getAgents: () => [rec({ agentId: "luna", assistantName: "Luna" })] };
    const after = await fetch(`${c.baseUrl}/api/agents`);
    const body = await after.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_id).toBe("luna");
  });

  it("405s on POST", async () => {
    c = startWith(() => ({ getAgents: () => [] }));
    const res = await fetch(`${c.baseUrl}/api/agents`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns a 500 JSON error when the registry view throws", async () => {
    c = startWith(() => ({
      getAgents: () => {
        throw new Error("registry exploded");
      },
    }));
    const res = await fetch(`${c.baseUrl}/api/agents`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("registry exploded");
  });
});
