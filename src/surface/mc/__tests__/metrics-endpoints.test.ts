/**
 * F-18 — REST endpoint tests for metrics handlers.
 *
 * Boots the full server (matches the iteration-import-endpoints pattern) and
 * exercises the two new GET routes against a freshly-seeded in-memory DB.
 * The metrics computation itself has unit coverage in `metrics.test.ts`;
 * these tests assert the wire contract — status codes, JSON envelope,
 * query-param validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, mkdtempSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";

interface TestCtx {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  baseUrl: string;
  tmpDir: string;
}

let nextPort = 18_900;
function makePort(): number {
  nextPort += 1;
  return nextPort;
}

async function setup(): Promise<TestCtx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "grove-metrics-"));
  const dbPath = join(tmpDir, "mc.sqlite");
  const db = initDatabase(dbPath);
  const pm = new ProcessManager();
  const port = makePort();
  const ctx = startServer({ ...DEFAULT_CONFIG, port }, db, {
    processManager: pm,
  });
  return { db, ctx, pm, baseUrl: `http://localhost:${port}`, tmpDir };
}

async function teardown(t: TestCtx): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

function isoOffset(baseMs: number, addMs: number): string {
  return new Date(baseMs + addMs).toISOString();
}

/** Same minimal seeder as the metrics unit tests — copied so the two suites
 *  stay independently readable. */
function seedAssignment(
  db: Database,
  opts: {
    assignmentId: string;
    agentId: string;
    agentName: string;
    taskId: string;
    createdAt: string;
    transitions: {
      timestamp: string;
      from: string;
      to: string;
      blockReason?: { kind: string; payload: Record<string, unknown> };
    }[];
  }
): void {
  db.exec(
    `INSERT OR IGNORE INTO tasks (id, title, priority, operator_id, source_system) VALUES ('${opts.taskId}', 'Task', 0, 'op', 'internal')`
  );
  db.exec(
    `INSERT OR IGNORE INTO agents (id, name, type, persistent) VALUES ('${opts.agentId}', '${opts.agentName}', 'head', 1)`
  );
  const finalState =
    opts.transitions.length > 0
      ? opts.transitions[opts.transitions.length - 1]!.to
      : "queued";
  const finalBlockReason =
    finalState === "blocked"
      ? opts.transitions[opts.transitions.length - 1]!.blockReason
      : null;
  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.assignmentId,
    opts.agentId,
    opts.taskId,
    finalState,
    finalBlockReason ? JSON.stringify(finalBlockReason) : null,
    opts.createdAt,
    opts.transitions.length > 0
      ? opts.transitions[opts.transitions.length - 1]!.timestamp
      : opts.createdAt
  );
  const sessionId = `${opts.assignmentId}-sess`;
  db.query(
    `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES (?, ?, 'local.process.controlled', ?)`
  ).run(sessionId, opts.assignmentId, opts.createdAt);
  let counter = 0;
  for (const t of opts.transitions) {
    counter += 1;
    const payload: Record<string, unknown> = {
      from: t.from,
      to: t.to,
      action: "test",
    };
    if (t.blockReason) payload.blockReason = t.blockReason;
    db.query(
      `INSERT INTO events (id, session_id, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(
      `EVT-${opts.assignmentId}-${counter.toString().padStart(20, "0")}`,
      sessionId,
      "state.transition",
      JSON.stringify(payload),
      t.timestamp
    );
  }
}

describe("GET /api/metrics/assignment/:id", () => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns 404 for unknown assignment", async () => {
    const res = await fetch(`${t.baseUrl}/api/metrics/assignment/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("returns 200 + computed metrics for a known assignment", async () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seedAssignment(t.db, {
      assignmentId: "ata-x",
      agentId: "luna",
      agentName: "Luna",
      taskId: "t-x",
      createdAt: isoOffset(base, 0),
      transitions: [
        { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
        { timestamp: isoOffset(base, 5_000), from: "running", to: "completed" },
      ],
    });
    const res = await fetch(`${t.baseUrl}/api/metrics/assignment/ata-x`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: { totalCycleMs: number; byState: Record<string, number> };
    };
    expect(body.metrics.totalCycleMs).toBe(5_000);
    expect(body.metrics.byState.queued).toBe(1_000);
    expect(body.metrics.byState.running).toBe(4_000);
  });
});

describe("GET /api/metrics/fleet", () => {
  let t: TestCtx;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  it("returns 400 when window is missing", async () => {
    const res = await fetch(`${t.baseUrl}/api/metrics/fleet`);
    expect(res.status).toBe(400);
  });

  it("returns 400 when window is not in the allowlist", async () => {
    const res = await fetch(`${t.baseUrl}/api/metrics/fleet?window=6h`);
    expect(res.status).toBe(400);
  });

  it("returns 200 + zero-state body for an empty fleet", async () => {
    const res = await fetch(`${t.baseUrl}/api/metrics/fleet?window=24h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: {
        count: number;
        completedCount: number;
        p50CycleMs: number | null;
        perAgent: unknown[];
      };
    };
    expect(body.metrics.count).toBe(0);
    expect(body.metrics.completedCount).toBe(0);
    expect(body.metrics.p50CycleMs).toBeNull();
    expect(body.metrics.perAgent).toEqual([]);
  });

  it("returns 200 + populated body when there's data in the window", async () => {
    // Seed within the last 24h so the window catches it.
    const base = Date.now() - 60_000;
    seedAssignment(t.db, {
      assignmentId: "ata-luna",
      agentId: "luna",
      agentName: "Luna",
      taskId: "t-l",
      createdAt: isoOffset(base, 0),
      transitions: [
        { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
        { timestamp: isoOffset(base, 5_000), from: "running", to: "completed" },
      ],
    });
    const res = await fetch(`${t.baseUrl}/api/metrics/fleet?window=24h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: {
        count: number;
        completedCount: number;
        p50CycleMs: number;
        perAgent: { agentId: string; completed: number }[];
      };
    };
    expect(body.metrics.count).toBe(1);
    expect(body.metrics.completedCount).toBe(1);
    expect(body.metrics.p50CycleMs).toBe(5_000);
    expect(body.metrics.perAgent.length).toBe(1);
    expect(body.metrics.perAgent[0]?.agentId).toBe("luna");
    expect(body.metrics.perAgent[0]?.completed).toBe(1);
  });

  it("filters by agent when ?agent= provided", async () => {
    const base = Date.now() - 60_000;
    seedAssignment(t.db, {
      assignmentId: "ata-luna",
      agentId: "luna",
      agentName: "Luna",
      taskId: "t-l",
      createdAt: isoOffset(base, 0),
      transitions: [
        { timestamp: isoOffset(base, 1_000), from: "queued", to: "completed" },
      ],
    });
    seedAssignment(t.db, {
      assignmentId: "ata-forge",
      agentId: "forge",
      agentName: "Forge",
      taskId: "t-f",
      createdAt: isoOffset(base, 0),
      transitions: [
        { timestamp: isoOffset(base, 1_000), from: "queued", to: "completed" },
      ],
    });

    const res = await fetch(
      `${t.baseUrl}/api/metrics/fleet?window=24h&agent=luna`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: { count: number; perAgent: { agentId: string }[] };
    };
    expect(body.metrics.count).toBe(1);
    expect(body.metrics.perAgent.length).toBe(1);
    expect(body.metrics.perAgent[0]?.agentId).toBe("luna");
  });
});
