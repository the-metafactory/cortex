/**
 * CK-4a / #1295 — unit tests for the cross-stack WORKING aggregation read model
 * (db/working-aggregation.ts) + the origin_stack_id / retry_after_ms migration +
 * the origin backfill.
 *
 * Pins:
 *   - the migration applies cleanly (both new columns present; idempotent re-init);
 *   - per-origin active + sub-agent counts (from parent_session_id), null/own-origin
 *     first, then origin id ASC;
 *   - provider-retry folded from agent_task_assignment.retry_after_ms (MIN per
 *     origin; session-less pending retry attributes to the null/own bucket);
 *   - the NO-INTERIORS shape guard: a rollup carries ONLY metadata keys — a
 *     federated PEER origin yields the same metadata-only aggregate, never a
 *     session id / interior (the local mirror of the DashboardSnapshot guard);
 *   - backfillOriginStackId stamps NULL rows only (idempotent, never overwrites).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import { backfillOriginStackId } from "../db/sessions";
import {
  listWorkingAggregation,
  type WorkingStackAggregate,
} from "../db/working-aggregation";

// Every key any rollup (or its providerRetry) may carry. The no-interiors
// allow-list — the local mirror of the worker dashboard-snapshot-contract guard.
const ROLLUP_KEYS = new Set([
  "originStackId",
  "activeSessionCount",
  "subAgentCount",
  "providerRetry",
]);
const PROVIDER_RETRY_KEYS = new Set(["state", "retryAfterMs"]);

function seedAgent(db: Database, id: string): void {
  db.query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`).run(id, `Agent ${id}`);
}

function seedTask(db: Database, id: string): void {
  db.query(
    `INSERT OR IGNORE INTO tasks (id, title, priority, principal_id, source_system)
     VALUES (?, ?, 2, 'andreas', 'internal')`
  ).run(id, `Task ${id}`);
}

function seedAssignment(
  db: Database,
  opts: { id: string; agentId: string; taskId: string; state: string; retryAfterMs?: number | null }
): void {
  // The schema CHECK requires block_reason iff state = 'blocked'.
  const blockReason =
    opts.state === "blocked"
      ? JSON.stringify({ kind: "permission.request", payload: { requested_action: "tool.edit" } })
      : null;
  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason, retry_after_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(opts.id, opts.agentId, opts.taskId, opts.state, blockReason, opts.retryAfterMs ?? null);
}

function seedSession(
  db: Database,
  opts: {
    id: string;
    assignmentId: string;
    originStackId?: string | null;
    parentSessionId?: string | null;
    endedAt?: string | null;
  }
): void {
  db.query(
    `INSERT INTO sessions
       (id, assignment_id, endpoint_kind, started_at, ended_at, parent_session_id, origin_stack_id)
     VALUES (?, ?, 'local.process.controlled', datetime('now'), ?, ?, ?)`
  ).run(
    opts.id,
    opts.assignmentId,
    opts.endedAt ?? null,
    opts.parentSessionId ?? null,
    opts.originStackId ?? null
  );
}

/** Assert every rollup (and providerRetry) carries ONLY metadata keys. */
function assertNoInteriors(rollups: WorkingStackAggregate[]): void {
  for (const r of rollups) {
    const unexpected = Object.keys(r).filter((k) => !ROLLUP_KEYS.has(k));
    expect(unexpected).toEqual([]);
    if (r.providerRetry) {
      const pu = Object.keys(r.providerRetry).filter((k) => !PROVIDER_RETRY_KEYS.has(k));
      expect(pu).toEqual([]);
    }
  }
}

describe("CK-4a origin_stack_id / retry_after_ms migration", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-ck4a-mig-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds origin_stack_id to sessions and retry_after_ms to agent_task_assignment", () => {
    const sessionCols = (db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name);
    const ataCols = (db.query(`PRAGMA table_info(agent_task_assignment)`).all() as { name: string }[]).map((c) => c.name);
    expect(sessionCols).toContain("origin_stack_id");
    expect(ataCols).toContain("retry_after_ms");
  });

  it("creates the origin-stack lookup index", () => {
    const idx = (db.query(`PRAGMA index_list(sessions)`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain("idx_sessions_origin_stack_id");
  });

  it("is idempotent — re-initialising the same DB path does not throw", () => {
    const path = join(tmpDir, "test.db");
    db.close();
    // Re-open: SCHEMA_SQL is IF NOT EXISTS and COLUMN_ADD_MIGRATIONS is
    // pragma-gated, so the ALTERs skip the now-present columns without error.
    db = initDatabase(path);
    const sessionCols = (db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(sessionCols).toContain("origin_stack_id");
  });
});

describe("listWorkingAggregation", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-ck4a-agg-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when there are no sessions", () => {
    expect(listWorkingAggregation(db)).toEqual([]);
  });

  it("counts active sessions and sub-agents per origin, own-origin first", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    // own/local origin (null): a root + its sub-agent (both active)
    seedAssignment(db, { id: "a-local-root", agentId: "ag", taskId: "t", state: "running" });
    seedAssignment(db, { id: "a-local-child", agentId: "ag", taskId: "t", state: "running" });
    seedSession(db, { id: "s-local-root", assignmentId: "a-local-root", originStackId: null });
    seedSession(db, { id: "s-local-child", assignmentId: "a-local-child", originStackId: null, parentSessionId: "s-local-root" });
    // a federated PEER stack: one active root session
    seedAssignment(db, { id: "a-peer", agentId: "ag", taskId: "t", state: "dispatched" });
    seedSession(db, { id: "s-peer", assignmentId: "a-peer", originStackId: "andreas/peer-b" });
    // a terminal (ended) session must be excluded from active counts
    seedAssignment(db, { id: "a-done", agentId: "ag", taskId: "t", state: "running" });
    seedSession(db, { id: "s-done", assignmentId: "a-done", originStackId: null, endedAt: "2026-07-01T00:00:00Z" });

    const rollups = listWorkingAggregation(db);
    expect(rollups.map((r) => r.originStackId)).toEqual([null, "andreas/peer-b"]);

    const local = rollups[0]!;
    expect(local.activeSessionCount).toBe(2);
    expect(local.subAgentCount).toBe(1);
    expect(local.providerRetry).toBeNull();

    const peer = rollups[1]!;
    expect(peer.activeSessionCount).toBe(1);
    expect(peer.subAgentCount).toBe(0);
  });

  it("excludes sessions whose owning assignment is not in a working state", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    seedAssignment(db, { id: "a-blocked", agentId: "ag", taskId: "t", state: "blocked" });
    seedSession(db, { id: "s-blocked", assignmentId: "a-blocked", originStackId: null });
    expect(listWorkingAggregation(db)).toEqual([]);
  });

  it("folds provider-retry (MIN retry_after_ms) per origin from assignment rows", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    // two queued assignments awaiting retry, WITH sessions on the same origin
    seedAssignment(db, { id: "a-r1", agentId: "ag", taskId: "t", state: "queued", retryAfterMs: 5000 });
    seedAssignment(db, { id: "a-r2", agentId: "ag", taskId: "t", state: "queued", retryAfterMs: 1500 });
    seedSession(db, { id: "s-r1", assignmentId: "a-r1", originStackId: null });
    seedSession(db, { id: "s-r2", assignmentId: "a-r2", originStackId: null });

    const rollups = listWorkingAggregation(db);
    const local = rollups.find((r) => r.originStackId === null)!;
    expect(local.providerRetry).toEqual({ state: "not_now", retryAfterMs: 1500 });
  });

  it("attributes a session-less pending retry to the own/local (null) origin", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    // queued assignment awaiting retry, NOT yet spawned (no session row)
    seedAssignment(db, { id: "a-pending", agentId: "ag", taskId: "t", state: "queued", retryAfterMs: 3000 });

    const rollups = listWorkingAggregation(db);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.originStackId).toBeNull();
    expect(rollups[0]!.activeSessionCount).toBe(0);
    expect(rollups[0]!.providerRetry).toEqual({ state: "not_now", retryAfterMs: 3000 });
  });

  it("a federated peer origin yields metadata-only — no interiors (guard)", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    seedAssignment(db, { id: "a-peer", agentId: "ag", taskId: "t", state: "running" });
    seedSession(db, { id: "s-peer-secret", assignmentId: "a-peer", originStackId: "andreas/peer-b" });

    const rollups = listWorkingAggregation(db);
    assertNoInteriors(rollups);
    // The peer's session id / interior must NOT leak anywhere in the output.
    expect(JSON.stringify(rollups)).not.toContain("s-peer-secret");
    expect(JSON.stringify(rollups)).not.toContain("assignment");
  });
});

describe("backfillOriginStackId", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-ck4a-bf-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps NULL-origin rows with the daemon's own stack id, idempotently", () => {
    seedAgent(db, "ag");
    seedTask(db, "t");
    seedAssignment(db, { id: "a-1", agentId: "ag", taskId: "t", state: "running" });
    seedAssignment(db, { id: "a-2", agentId: "ag", taskId: "t", state: "running" });
    seedSession(db, { id: "s-null", assignmentId: "a-1", originStackId: null });
    seedSession(db, { id: "s-attributed", assignmentId: "a-2", originStackId: "andreas/peer-b" });

    const stamped = backfillOriginStackId(db, "andreas/local");
    expect(stamped).toBe(1); // only the NULL row

    const rows = db.query(`SELECT id, origin_stack_id FROM sessions ORDER BY id`).all() as {
      id: string;
      origin_stack_id: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r.origin_stack_id]));
    expect(byId.get("s-null")).toBe("andreas/local");
    // a pre-attributed peer row is NEVER overwritten
    expect(byId.get("s-attributed")).toBe("andreas/peer-b");

    // second run is a no-op (idempotent)
    expect(backfillOriginStackId(db, "andreas/local")).toBe(0);
  });
});
