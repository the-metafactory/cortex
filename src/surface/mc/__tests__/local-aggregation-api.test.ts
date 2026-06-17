/**
 * #1008 — `/api/working-agents` + `/api/agents` DB-read aggregation, end-to-end.
 *
 * Drives the real Bun.serve HTTP stack with a `localAggregation` getter that
 * points at fixture sibling MC dbs. Asserts both feeds return the origin-tagged
 * UNION across the local db + the sibling dbs, and that omitting the getter
 * yields the byte-identical single-db feed (no regression).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import type { Database } from "bun:sqlite";
import type { SiblingStackDescriptor } from "../local-aggregation/sibling-discovery";
import type { LocalAggregationContext } from "../local-aggregation/sibling-db-reader";
import type {
  AgentPresenceSnapshotRecord,
  AgentPresenceView,
} from "../api/agents";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function boundPort(ctx: ServerContext): number {
  const port = ctx.server.port;
  if (port === undefined) throw new Error("server.port unresolved");
  return port;
}

function seedWorking(
  db: Database,
  opts: { agentId: string; agentName: string },
): void {
  db.run(`INSERT INTO agents (id,name,type,persistent) VALUES (?,?,'head',1)`, [
    opts.agentId,
    opts.agentName,
  ]);
  db.run(
    `INSERT INTO tasks (id,title,priority,principal_id,source_system) VALUES ('t','task',2,'andreas','internal')`,
  );
  db.run(
    `INSERT INTO agent_task_assignment (id,agent_id,task_id,state) VALUES ('asg',?,'t','running')`,
    [opts.agentId],
  );
  db.run(
    `INSERT INTO sessions (id,assignment_id,endpoint_kind,started_at,substrate,agent_id,agent_name,principal_id,status)
     VALUES ('s','asg','local.observed','2026-06-12T00:00:00.000Z','claude-code',?,?,'andreas','running')`,
    [opts.agentId, opts.agentName],
  );
}

function sibling(stack: string): SiblingStackDescriptor {
  return {
    stack,
    principal: "andreas",
    url: "nats://127.0.0.1:4222",
    credential: { kind: "noauth" },
  };
}

interface Harness {
  ctx: ServerContext;
  baseUrl: string;
  db: Database;
  cleanup: () => void;
}

function start(opts: {
  agentPresence?: () => AgentPresenceView | null;
  localAggregation?: () => LocalAggregationContext | null;
}): Harness {
  const root = mkdtempSync(join(tmpdir(), "mc-la-root-"));
  const db = initDatabase(join(root, "local", "mission-control.db"));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, {
    ...(opts.agentPresence ? { agentPresence: opts.agentPresence } : {}),
    ...(opts.localAggregation ? { localAggregation: opts.localAggregation } : {}),
  });
  const cleanup = () => {
    ctx.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { ctx, baseUrl: `http://localhost:${boundPort(ctx)}`, db, cleanup, root } as Harness & {
    root: string;
  };
}

describe("#1008 /api/working-agents aggregation", () => {
  it("returns the origin-tagged union across local + sibling dbs", async () => {
    const share = mkdtempSync(join(tmpdir(), "mc-la-share-"));
    cleanups.push(() => rmSync(share, { recursive: true, force: true }));
    const workDb = initDatabase(join(share, "work", "mission-control.db"));
    seedWorking(workDb, { agentId: "luna", agentName: "Luna" });
    workDb.close();

    const root = mkdtempSync(join(tmpdir(), "mc-la-cfg-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const h = start({
      localAggregation: (): LocalAggregationContext => ({
        siblings: [sibling("work")],
        resolve: { configRoot: root, homeShareDir: share },
      }),
    });
    seedWorking(h.db, { agentId: "echo", agentName: "Echo" });

    const res = await fetch(`${h.baseUrl}/api/working-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const echo = body.agents.find((a: { agent_id: string }) => a.agent_id === "echo");
    expect(echo.origin).toBe("local");
    const luna = body.agents.find((a: { agent_id: string }) => a.agent_id === "luna");
    expect(luna.origin).toEqual({ principal: "andreas", stack: "work" });
  });

  it("omitting localAggregation yields the single-db feed (no origin field)", async () => {
    const h = start({});
    seedWorking(h.db, { agentId: "echo", agentName: "Echo" });
    const res = await fetch(`${h.baseUrl}/api/working-agents`);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].origin).toBeUndefined();
  });
});

describe("#1008 /api/agents aggregation", () => {
  it("unions the local registry view with sibling-db agent tiles", async () => {
    const share = mkdtempSync(join(tmpdir(), "mc-la-share2-"));
    cleanups.push(() => rmSync(share, { recursive: true, force: true }));
    const workDb = initDatabase(join(share, "work", "mission-control.db"));
    seedWorking(workDb, { agentId: "luna", agentName: "Luna" });
    workDb.close();

    const root = mkdtempSync(join(tmpdir(), "mc-la-cfg2-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const view: AgentPresenceView = {
      getAgents: (): AgentPresenceSnapshotRecord[] => [
        {
          key: "andreas/meta-factory/echo",
          origin: "local",
          agentId: "echo",
          nkeyPublicKey: "NECHO",
          assistantName: "Echo",
          principal: "andreas",
          stack: "meta-factory",
          capabilities: [],
          state: "online",
          lastSeenAt: 1,
        },
      ],
    };

    const h = start({
      agentPresence: () => view,
      localAggregation: (): LocalAggregationContext => ({
        siblings: [sibling("work")],
        resolve: { configRoot: root, homeShareDir: share },
      }),
    });

    const res = await fetch(`${h.baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const echo = body.agents.find((a: { agent_id: string }) => a.agent_id === "echo");
    expect(echo.origin).toBe("local");
    const luna = body.agents.find((a: { agent_id: string }) => a.agent_id === "luna");
    expect(luna.origin).toEqual({ principal: "andreas", stack: "work" });
    expect(luna.state).toBe("online");
  });
});
