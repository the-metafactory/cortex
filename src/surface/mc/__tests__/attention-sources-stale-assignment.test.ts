/**
 * MC-I1.S7 (#849) — stale-ASSIGNMENT producer completion (G-1113.E.2 deferral).
 *
 * E.2 shipped `att:stale:{wiId}` for stuck WORK ITEMS. This completes the
 * deferred scope: a non-terminal, non-blocked ASSIGNMENT whose most-recent
 * HEARTBEATING session has gone silent past the threshold is "stale" too,
 * deep-linked via its session, under the disjoint `att:stale:asg:` sub-namespace.
 *
 * SCOPING (PR #873 review major 2): only sessions that EMIT heartbeats are
 * judged. `attachHeartbeatToCCSession` is controlled-CC-only; observed/orphan
 * sessions reach `running` via the ingestor but never tick, so a heartbeat-
 * cadence threshold would flap them. The producer requires ≥1 heartbeat liveness
 * row on the most-recent session, so observed/orphan sessions are out of scope.
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

  /**
   * Seed an assignment in `state` with a session of `endpointKind`; updated_at +
   * session started_at at `tsSec`. Pass `heartbeatAtSec` to land a heartbeat
   * liveness row on the session — only heartbeating sessions are stale-judged.
   */
  function seedAssignment(
    db: ReturnType<typeof initDatabase>,
    suffix: string,
    state: string,
    updatedAtSec: number,
    opts: { endpointKind?: string; heartbeatAtSec?: number } = {},
  ) {
    const endpointKind = opts.endpointKind ?? "local.process.controlled";
    db.query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag-1', 'Echo', 'head')`).run();
    db.query(
      `INSERT OR IGNORE INTO tasks (id, title, principal_id, source_system, status) VALUES ('tk-1', 'T', 'andreas', 'github', 'in_progress')`,
    ).run();
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, updated_at) VALUES (?, 'ag-1', 'tk-1', ?, ?)`,
    ).run(`asg-${suffix}`, state, iso(updatedAtSec));
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES (?, ?, ?, ?)`,
    ).run(`sess-${suffix}`, `asg-${suffix}`, endpointKind, iso(updatedAtSec));
    if (opts.heartbeatAtSec !== undefined) heartbeat(db, suffix, opts.heartbeatAtSec);
  }

  /** Land a heartbeat event on a session at `tsSec` (the S6 liveness signal). */
  function heartbeat(db: ReturnType<typeof initDatabase>, suffix: string, tsSec: number) {
    db.query(
      `INSERT INTO events (id, session_id, type, payload, timestamp) VALUES (?, ?, 'system.agent.heartbeat', '{}', ?)`,
    ).run(`ev-${suffix}-${tsSec}`, `sess-${suffix}`, iso(tsSec));
  }

  const opts = { stackId: "laptop", nowEpochSec: NOW };

  it("flags a controlled session whose last heartbeat is past the threshold", () => {
    const db = freshDb();
    // Heartbeated 3h ago, then went silent → stale.
    seedAssignment(db, "stuck", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    reconcileAttention(db, opts);
    const item = getAttentionItem(db, "att:stale:asg:asg-stuck");
    expect(item?.kind).toBe("stale");
    expect(item?.severity).toBe("normal");
    expect(item?.sessionId).toBe("sess-stuck");
    expect(item?.workItemId).toBeNull();
  });

  it("does NOT flag a session kept alive by a recent heartbeat (quiet updated_at)", () => {
    const db = freshDb();
    // updated_at old, but heartbeated 2 min ago → alive.
    seedAssignment(db, "live", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 2 * 60 });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-live")).toBeNull();
  });

  // --- The scoping fix (PR #873 review major 2) ---

  it("does NOT flag an observed session past the threshold (never heartbeats → out of scope)", () => {
    const db = freshDb();
    // A long-quiet observed session: updated_at 5h ago, NO heartbeat row. Under
    // the old updated_at-fallback this flapped; now it's correctly out of scope.
    seedAssignment(db, "obs", "running", NOW - 5 * HOUR, { endpointKind: "local.observed" });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-obs")).toBeNull();
  });

  it("does NOT flag a controlled session that never heartbeated (spawn raced attach)", () => {
    const db = freshDb();
    // Controlled but NO heartbeat row at all → no liveness signal → out of scope.
    seedAssignment(db, "nohb", "running", NOW - 5 * HOUR);
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-nohb")).toBeNull();
  });

  it("flags a controlled silent session past the threshold (has heartbeated, now silent)", () => {
    const db = freshDb();
    seedAssignment(db, "silent", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 90 * 60 });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-silent")?.status).toBe("open");
  });

  it("a fresh heartbeat heals a previously-stale assignment", () => {
    const db = freshDb();
    seedAssignment(db, "heal", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-heal")?.status).toBe("open");

    // The agent ticks a heartbeat → next reconcile resolves it.
    heartbeat(db, "heal", NOW - 30); // 30 s ago
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-heal")?.status).toBe("resolved");
  });

  it("does NOT flag terminal assignments (completed/failed/cancelled)", () => {
    const db = freshDb();
    seedAssignment(db, "done", "completed", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    seedAssignment(db, "failed", "failed", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    seedAssignment(db, "cancelled", "cancelled", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    reconcileAttention(db, opts);
    expect(listOpenAttention(db).filter((i) => i.id.startsWith("att:stale:asg:"))).toEqual([]);
  });

  it("flags queued and dispatched (not just running) when stuck", () => {
    const db = freshDb();
    seedAssignment(db, "q", "queued", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    seedAssignment(db, "d", "dispatched", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-q")?.status).toBe("open");
    expect(getAttentionItem(db, "att:stale:asg:asg-d")?.status).toBe("open");
  });

  it("a recently-heartbeating session is not stale yet", () => {
    const db = freshDb();
    seedAssignment(db, "fresh", "running", NOW - 5 * 60, { heartbeatAtSec: NOW - 5 * 60 });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-fresh")).toBeNull();
  });

  it("honours a custom staleAssignmentAfterMs threshold", () => {
    const db = freshDb();
    // Last heartbeat 10 min ago.
    seedAssignment(db, "custom", "running", NOW - 10 * 60, { heartbeatAtSec: NOW - 10 * 60 });
    // Default (1h) would NOT flag it…
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-custom")).toBeNull();
    // …a 5-min threshold does.
    reconcileAttention(db, { ...opts, staleAssignmentAfterMs: 5 * 60 * 1000 });
    expect(getAttentionItem(db, "att:stale:asg:asg-custom")?.status).toBe("open");
  });

  it("resolves a stale assignment once it transitions terminal", () => {
    const db = freshDb();
    seedAssignment(db, "term", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-term")?.status).toBe("open");
    db.query(`UPDATE agent_task_assignment SET state = 'completed' WHERE id = 'asg-term'`).run();
    reconcileAttention(db, opts);
    expect(getAttentionItem(db, "att:stale:asg:asg-term")?.status).toBe("resolved");
  });

  // --- Resolve → genuine recurrence (PR #873 review nit 1, resolved) ---

  it("re-notifies on a genuine resolve→recur cycle (ML.3 contract upheld)", () => {
    // Review nit 1 proposed suppressing the reopen notification, but that would
    // break the established ML.3 contract that a RESOLVED condition which
    // genuinely recurs re-notifies (you want to know a cleared blocker came
    // back). The flap concern is instead handled by review major 2 — stale-asg
    // is scoped to heartbeating sessions, so the false-positive flap that
    // motivated the nit can't occur. A real heartbeating session that goes
    // quiet → active → quiet IS a genuine recurrence and SHOULD re-notify.
    const db = freshDb();
    seedAssignment(db, "flap", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    const r1 = reconcileAttention(db, opts);
    expect(r1.opened.map((i) => i.id)).toContain("att:stale:asg:asg-flap");

    // Activity heals it (resolve).
    heartbeat(db, "flap", NOW - 30);
    const r2 = reconcileAttention(db, opts);
    expect(r2.resolved.map((i) => i.id)).toContain("att:stale:asg:asg-flap");

    // It genuinely goes quiet again past threshold — re-derives AND re-notifies.
    const r3 = reconcileAttention(db, { ...opts, nowEpochSec: NOW + 5 * HOUR });
    expect(r3.opened.map((i) => i.id)).toContain("att:stale:asg:asg-flap");
    expect(getAttentionItem(db, "att:stale:asg:asg-flap")?.status).toBe("open");
  });

  it("never re-notifies a DISMISSED stale-asg item (dismiss beats recurrence)", () => {
    const db = freshDb();
    seedAssignment(db, "dism", "running", NOW - 5 * HOUR, { heartbeatAtSec: NOW - 3 * HOUR });
    const r1 = reconcileAttention(db, opts);
    expect(r1.opened.map((i) => i.id)).toContain("att:stale:asg:asg-dism");

    // Principal dismisses it.
    db.query(`UPDATE attention_items SET status = 'dismissed' WHERE id = ?`).run(
      "att:stale:asg:asg-dism"
    );
    // Still stale on the next pass — must NOT reopen or re-notify.
    const r2 = reconcileAttention(db, opts);
    expect(r2.opened.map((i) => i.id)).not.toContain("att:stale:asg:asg-dism");
    expect(getAttentionItem(db, "att:stale:asg:asg-dism")?.status).toBe("dismissed");
  });
});
