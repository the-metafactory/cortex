/**
 * MC-I1.S7 (#849) — stale-ASSIGNMENT producer completion (G-1113.E.2 deferral).
 *
 * E.2 shipped `att:stale:{wiId}` for stuck WORK ITEMS. This completes the
 * deferred scope: a non-terminal, non-blocked ASSIGNMENT with no recent
 * activity is "stale" too, deep-linked via its session, under the disjoint
 * `att:stale:asg:` sub-namespace. Last-activity joins the S6 heartbeat liveness
 * row (a recent heartbeat keeps a quiet-`updated_at` session alive; silence past
 * the threshold flags it). Activity (a fresh heartbeat) heals it.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { getAttentionItem, listOpenAttention } from "../db/attention";
import { reconcileAttention } from "../db/attention-sources";

const NOW = 1_900_000_000; // fixed epoch seconds
const HOUR = 60 * 60;

/** ISO string for an epoch-seconds instant (matches sessions/events text columns). */
function iso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

describe("reconcileAttention — stale assignments (MC-I1.S7)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `stale-asg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  /** Seed an assignment in `state` with a session; updated_at + session started_at at `tsSec`. */
  function seedAssignment(
    db: ReturnType<typeof initDatabase>,
    suffix: string,
    state: string,
    updatedAtSec: number,
  ) {
    db.query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag-1', 'Echo', 'head')`).run();
    db.query(
      `INSERT OR IGNORE INTO tasks (id, title, principal_id, source_system, status) VALUES ('tk-1', 'T', 'andreas', 'github', 'in_progress')`,
    ).run();
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, updated_at) VALUES (?, 'ag-1', 'tk-1', ?, ?)`,
    ).run(`asg-${suffix}`, state, iso(updatedAtSec));
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES (?, ?, 'local.process.controlled', ?)`,
    ).run(`sess-${suffix}`, `asg-${suffix}`, iso(updatedAtSec));
  }

  /** Land a heartbeat event on a session at `tsSec` (the S6 liveness signal). */
  function heartbeat(db: ReturnType<typeof initDatabase>, suffix: string, tsSec: number) {
    db.query(
      `INSERT INTO events (id, session_id, type, payload, timestamp) VALUES (?, ?, 'system.agent.heartbeat', '{}', ?)`,
    ).run(`ev-${suffix}-${tsSec}`, `sess-${suffix}`, iso(tsSec));
  }

  const opts = { stackId: "laptop", nowEpochSec: NOW };

  it("flags a running assignment that has gone silent past the threshold", () => {
    const db = freshDb();
    seedAssignment(db, "stuck", "running", NOW - 5 * HOUR); // updated 5h ago, no heartbeat
    reconcileAttention(db, opts);
    const item = getAttentionItem(db, "att:stale:asg:asg-stuck");
    expect(item?.kind).toBe("stale");
    expect(item?.severity).toBe("normal");
    expect(item?.sessionId).toBe("sess-stuck");
    expect(item?.workItemId).toBeNull();
  });

  it("does NOT flag an assignment kept alive by a recent heartbeat (quiet updated_at)", () => {
    const db = freshDb();
    seedAssignment(db, "live", "running", NOW - 5 * HOUR); // updated_at old…
    heartbeat(db, "live", NOW - 2 * 60); // …but heartbeated 2 min ago → alive
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-live")).toBeNull();
  });

  it("flags an assignment whose last heartbeat is itself past the threshold", () => {
    const db = freshDb();
    seedAssignment(db, "silent", "running", NOW - 5 * HOUR);
    heartbeat(db, "silent", NOW - 3 * HOUR); // last heartbeat 3h ago → stale
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-silent")?.status).toBe("open");
  });

  it("a fresh heartbeat heals a previously-stale assignment", () => {
    const db = freshDb();
    seedAssignment(db, "heal", "running", NOW - 5 * HOUR);
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-heal")?.status).toBe("open");

    // The agent ticks a heartbeat → next reconcile resolves it.
    heartbeat(db, "heal", NOW - 30); // 30 s ago
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-heal")?.status).toBe("resolved");
  });

  it("does NOT flag terminal assignments (completed/failed/cancelled) or blocked", () => {
    const db = freshDb();
    seedAssignment(db, "done", "completed", NOW - 5 * HOUR);
    seedAssignment(db, "failed", "failed", NOW - 5 * HOUR);
    seedAssignment(db, "cancelled", "cancelled", NOW - 5 * HOUR);
    reconcileAttention(db, opts);
    expect(listOpenAttention(db).filter((i) => i.id.startsWith("att:stale:asg:"))).toEqual([]);
  });

  it("flags queued and dispatched (not just running) when stuck", () => {
    const db = freshDb();
    seedAssignment(db, "q", "queued", NOW - 5 * HOUR);
    seedAssignment(db, "d", "dispatched", NOW - 5 * HOUR);
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-q")?.status).toBe("open");
    expect(getAttentionItem(db, "att:stale:asg:asg-d")?.status).toBe("open");
  });

  it("a fresh assignment (recent updated_at) is not stale yet", () => {
    const db = freshDb();
    seedAssignment(db, "fresh", "running", NOW - 5 * 60); // 5 min ago
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-fresh")).toBeNull();
  });

  it("honours a custom staleAssignmentAfterMs threshold", () => {
    const db = freshDb();
    seedAssignment(db, "custom", "running", NOW - 10 * 60); // 10 min ago
    // Default (1h) would NOT flag it…
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-custom")).toBeNull();
    // …a 5-min threshold does.
    reconcileAttention(db, { ...opts, staleAssignmentAfterMs: 5 * 60 * 1000 });
    expect(getAttentionItem(db, "att:stale:asg:asg-custom")?.status).toBe("open");
  });

  it("resolves a stale assignment once it transitions terminal", () => {
    const db = freshDb();
    seedAssignment(db, "term", "running", NOW - 5 * HOUR);
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-term")?.status).toBe("open");
    db.query(`UPDATE agent_task_assignment SET state = 'completed' WHERE id = 'asg-term'`).run();
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-term")?.status).toBe("resolved");
  });
});
