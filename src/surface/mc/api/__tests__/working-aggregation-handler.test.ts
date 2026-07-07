/**
 * CK-4b (cortex#1295) — GET /api/working-aggregation handler tests.
 *
 * Pins that the local daemon endpoint projects CK-4a's `listWorkingAggregation`
 * read model onto the wire as `{ aggregation: WorkingStackAggregate[] }`, and
 * that the wire payload stays METADATA-ONLY (ADR-0005): a federated PEER origin
 * yields the same counts-only rollup as a local origin — never a session id or
 * interior. Provider-retry (local-only back-pressure) is populated here.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../../db/init";
import { handleListWorkingAggregation } from "../handlers";
import type { ListWorkingAggregationResponse } from "../types";

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
  opts: { id: string; assignmentId: string; originStackId?: string | null; parentSessionId?: string | null }
): void {
  db.query(
    `INSERT INTO sessions
       (id, assignment_id, endpoint_kind, started_at, ended_at, parent_session_id, origin_stack_id)
     VALUES (?, ?, 'local.process.controlled', datetime('now'), NULL, ?, ?)`
  ).run(opts.id, opts.assignmentId, opts.parentSessionId ?? null, opts.originStackId ?? null);
}

async function body(db: Database): Promise<ListWorkingAggregationResponse> {
  const res = handleListWorkingAggregation(db);
  expect(res.status).toBe(200);
  return (await res.json()) as ListWorkingAggregationResponse;
}

describe("GET /api/working-aggregation", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-ck4b-handler-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty aggregation array on a fresh DB", async () => {
    const b = await body(db);
    expect(b.aggregation).toEqual([]);
  });

  it("projects per-origin active + sub-agent counts across stacks", async () => {
    seedAgent(db, "ag-1");
    seedTask(db, "t-1");
    // Own/local origin (null): a root session + a sub-agent (child) session.
    // Each session owns its OWN assignment — the sessions table enforces one
    // active session per assignment (partial unique index on assignment_id), so
    // a root and its sub-agent are distinct assignments linked by
    // parent_session_id (mirrors the canonical CK-4a read-model test).
    seedAssignment(db, { id: "a-local-root", agentId: "ag-1", taskId: "t-1", state: "running" });
    seedAssignment(db, { id: "a-local-child", agentId: "ag-1", taskId: "t-1", state: "running" });
    seedSession(db, { id: "s-root", assignmentId: "a-local-root", originStackId: null });
    seedSession(db, { id: "s-child", assignmentId: "a-local-child", originStackId: null, parentSessionId: "s-root" });
    // A federated peer origin: one working session, metadata-only.
    seedAssignment(db, { id: "a-peer", agentId: "ag-1", taskId: "t-1", state: "running" });
    seedSession(db, { id: "s-peer", assignmentId: "a-peer", originStackId: "jc/home" });

    const b = await body(db);
    // null (own/local) first, then origin id ASC.
    expect(b.aggregation.map((r) => r.originStackId)).toEqual([null, "jc/home"]);
    const local = b.aggregation[0]!;
    expect(local.activeSessionCount).toBe(2);
    expect(local.subAgentCount).toBe(1);
    const peer = b.aggregation[1]!;
    expect(peer.originStackId).toBe("jc/home");
    expect(peer.activeSessionCount).toBe(1);
    expect(peer.subAgentCount).toBe(0);
  });

  it("folds provider-retry (not_now/retry_after_ms) — pre-spawn, session-less", async () => {
    seedAgent(db, "ag-1");
    seedTask(db, "t-1");
    // A queued assignment with a retry hint but NO session yet (pure pre-spawn).
    seedAssignment(db, { id: "a-q", agentId: "ag-1", taskId: "t-1", state: "queued", retryAfterMs: 4000 });

    const b = await body(db);
    // Attributes to the null/own bucket (session-less pre-spawn).
    const own = b.aggregation.find((r) => r.originStackId === null);
    expect(own?.providerRetry).toEqual({ state: "not_now", retryAfterMs: 4000 });
  });

  it("wire payload is METADATA-ONLY — no session id / interior leaks across the boundary", async () => {
    seedAgent(db, "ag-1");
    seedTask(db, "t-1");
    seedAssignment(db, { id: "a-peer", agentId: "ag-1", taskId: "t-1", state: "running" });
    seedSession(db, { id: "s-secret", assignmentId: "a-peer", originStackId: "jc/home" });

    const res = handleListWorkingAggregation(db);
    const raw = await res.text();
    // The peer's session id must never appear on the cross-stack feed.
    expect(raw).not.toContain("s-secret");
    const parsed = JSON.parse(raw) as ListWorkingAggregationResponse;
    for (const r of parsed.aggregation) {
      expect(Object.keys(r).sort()).toEqual(
        ["activeSessionCount", "originStackId", "providerRetry", "subAgentCount"].sort()
      );
    }
  });
});
