/**
 * G-1113.E.2 — attention reconciler: derive open items from DB state, upsert,
 * and auto-resolve cleared conditions.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { getAttentionItem, listOpenAttention } from "../db/attention";
import { reconcileAttention } from "../db/attention-sources";
import type { AttentionKind, AttentionSeverity, BlockReason } from "../types";

const NOW = 1_900_000_000; // fixed epoch seconds for deterministic staleness
const DAY = 24 * 60 * 60;

describe("reconcileAttention (E.2)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `attsrc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  /**
   * Insert a blocked assignment carrying `reason`; a session is created unless
   * `withSession` is false (to exercise the no-deep-link skip). The shared
   * agent/task are seeded idempotently (INSERT OR IGNORE) so this is safe to
   * call repeatedly on a DB; each assignment + session is suffixed by `suffix`.
   */
  function seedBlocked(
    db: ReturnType<typeof initDatabase>,
    reason: BlockReason,
    suffix = "1",
    withSession = true
  ) {
    db.query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag-1', 'Echo', 'head')`).run();
    db.query(
      `INSERT OR IGNORE INTO tasks (id, title, principal_id, source_system, status) VALUES ('tk-1', 'T', 'andreas', 'github', 'in_progress')`
    ).run();
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason) VALUES (?, 'ag-1', 'tk-1', 'blocked', ?)`
    ).run(`asg-${suffix}`, JSON.stringify(reason));
    if (withSession) {
      db.query(
        `INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES (?, ?, 'local.observed')`
      ).run(`sess-${suffix}`, `asg-${suffix}`);
    }
  }

  function seedWorkItem(db: ReturnType<typeof initDatabase>, id: string, status: string, updatedAtSec: number) {
    db.query(
      `INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES (?, ?, ?, '', 'github', ?)`
    ).run(id, id, status, updatedAtSec);
  }

  const opts = { stackId: "laptop", nowEpochSec: NOW };

  it("maps block reasons to attention kind/severity, deep-linked via session", () => {
    const cases: [BlockReason, AttentionKind, AttentionSeverity][] = [
      [{ kind: "permission.request", payload: { requested_action: "write" } }, "permission", "high"],
      [{ kind: "review.checkpoint", payload: { description: "approve?" } }, "review", "normal"],
      [{ kind: "tool.error", payload: { tool_name: "bash", error_message: "boom" } }, "blocked", "high"],
    ];
    for (const [reason, kind, severity] of cases) {
      const db = freshDb();
      seedBlocked(db, reason);
      reconcileAttention(db, opts);
      const item = getAttentionItem(db, "att:block:asg-1");
      expect(item?.kind).toBe(kind);
      expect(item?.severity).toBe(severity);
      expect(item?.sessionId).toBe("sess-1");
      expect(item?.workItemId).toBeNull();
      expect(item?.stackId).toBe("laptop");
    }
  });

  it("flags stale open work items; ignores terminal + recently-touched ones", () => {
    const db = freshDb();
    seedWorkItem(db, "wi-stale", "open", NOW - 30 * DAY); // open + old → stale
    seedWorkItem(db, "wi-fresh", "open", NOW - 1 * DAY); // open + recent → not stale
    seedWorkItem(db, "wi-closed", "closed", NOW - 30 * DAY); // terminal → never stale
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:wi-stale")?.kind).toBe("stale");
    expect(getAttentionItem(db, "att:stale:wi-stale")?.severity).toBe("low");
    expect(getAttentionItem(db, "att:stale:wi-fresh")).toBeNull();
    expect(getAttentionItem(db, "att:stale:wi-closed")).toBeNull();
  });

  it("resolves a previously-open item once its condition clears", () => {
    const db = freshDb();
    seedBlocked(db, { kind: "permission.request", payload: { requested_action: "write" } });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:block:asg-1")?.status).toBe("open");

    // Assignment unblocks (state → completed, block_reason cleared).
    db.query(`UPDATE agent_task_assignment SET state = 'completed', block_reason = NULL WHERE id = 'asg-1'`).run();
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:block:asg-1")?.status).toBe("resolved");
    expect(listOpenAttention(db)).toEqual([]);
  });

  it("does NOT produce an item for a blocked assignment with no session (no deep-link)", () => {
    const db = freshDb();
    seedBlocked(db, { kind: "tool.error", payload: { tool_name: "bash", error_message: "x" } }, "1", false);
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:block:asg-1")).toBeNull();
    expect(listOpenAttention(db)).toEqual([]);
  });

  it("resolves only the cleared item when one of several conditions clears", () => {
    const db = freshDb();
    seedBlocked(db, { kind: "permission.request", payload: { requested_action: "w" } }, "1");
    seedBlocked(db, { kind: "tool.error", payload: { tool_name: "bash", error_message: "x" } }, "2");
    reconcileAttention(db, opts);
    expect(listOpenAttention(db).map((i) => i.id).sort()).toEqual(["att:block:asg-1", "att:block:asg-2"]);
    // asg-1 unblocks; asg-2 stays blocked.
    db.query(`UPDATE agent_task_assignment SET state = 'completed', block_reason = NULL WHERE id = 'asg-1'`).run();
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:block:asg-1")?.status).toBe("resolved");
    expect(getAttentionItem(db, "att:block:asg-2")?.status).toBe("open");
  });

  it("staleness honours the threshold boundary and resolves once a row is touched", () => {
    const db = freshDb();
    seedWorkItem(db, "wi-1", "open", NOW - 1 * DAY); // fresh → not stale yet
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:wi-1")).toBeNull();
    // Time advances past the 7d threshold → now flagged.
    reconcileAttention(db, { ...opts, nowEpochSec: NOW + 10 * DAY });
    expect(getAttentionItem(db, "att:stale:wi-1")?.status).toBe("open");
    // The work item is touched (updated_at bumped) → resolves on next run.
    db.query(`UPDATE work_items SET updated_at = ? WHERE id = 'wi-1'`).run(NOW + 10 * DAY);
    reconcileAttention(db, { ...opts, nowEpochSec: NOW + 10 * DAY });
    expect(getAttentionItem(db, "att:stale:wi-1")?.status).toBe("resolved");
  });

  it("is idempotent — re-running yields the same single open item per id", () => {
    const db = freshDb();
    seedBlocked(db, { kind: "tool.error", payload: { tool_name: "bash", error_message: "x" } });
    seedWorkItem(db, "wi-stale", "open", NOW - 30 * DAY);
    reconcileAttention(db, opts);
    const first = listOpenAttention(db).map((i) => i.id).sort();
    reconcileAttention(db, opts);
    const second = listOpenAttention(db).map((i) => i.id).sort();
    expect(second).toEqual(first);
    expect(second).toEqual(["att:block:asg-1", "att:stale:wi-stale"]);
  });
});
