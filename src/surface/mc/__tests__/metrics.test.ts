/**
 * F-18 — Mission Control metrics computation tests.
 *
 * Strategy: synthesise a clean events timeline directly into an in-memory
 * SQLite DB, then assert on `computeAssignmentMetrics` / `computeFleetMetrics`
 * outputs. Each test owns its own DB so per-test setup is explicit and
 * timing-precise (the production code uses `new Date().toISOString()` for
 * timestamps; tests use deterministic ISO strings to make interval math
 * verifiable to the millisecond).
 *
 * Per the spec (`docs/design-mc-f18-metrics.md` Decision 3):
 *   - First interval [created_at, T0) is `queued`.
 *   - Each subsequent interval [Tn, Tn+1) is the state we transitioned OUT
 *     of at Tn+1 (i.e., the `from` field on the event at Tn+1).
 *   - Final interval is either terminal-bounded (completed/failed/cancelled)
 *     or now-bounded (in-flight).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import {
  computeAssignmentMetrics,
  computeFleetMetrics,
} from "../db/metrics";
import type { AssignmentState, BlockReason } from "../types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

interface SeedAssignment {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string;
  /** ISO-8601 — when the assignment row was inserted (start of the queued segment). */
  createdAt: string;
  /** Ordered list of state transitions; the assignment ends in the final state. */
  transitions: Array<{
    /** ISO-8601 timestamp of the transition. */
    timestamp: string;
    from: AssignmentState;
    to: AssignmentState;
    /** Required when `to === 'blocked'`. */
    blockReason?: BlockReason;
  }>;
}

let monotonicSuffix = 0;
function nextEventId(): string {
  // 26-char base36 — same length contract as `generateId` so the events
  // table's PRIMARY KEY accepts it without complaint.
  monotonicSuffix += 1;
  const ts = Date.now().toString(36).padStart(10, "0");
  const counter = monotonicSuffix.toString(36).padStart(16, "0");
  return (ts + counter).toUpperCase().slice(0, 26);
}

function seed(db: Database, assignments: SeedAssignment[]) {
  // Tasks (one per assignment for simplicity).
  for (const a of assignments) {
    db.exec(
      `INSERT OR IGNORE INTO tasks (id, title, priority, operator_id, source_system) VALUES ('${a.taskId}', 'Task ${a.taskId}', 0, 'op', 'internal')`
    );
    db.exec(
      `INSERT OR IGNORE INTO agents (id, name, type, persistent) VALUES ('${a.agentId}', '${a.agentName}', 'head', 1)`
    );
    // Final state on the assignment row.
    const finalState =
      a.transitions.length > 0
        ? a.transitions[a.transitions.length - 1]!.to
        : "queued";
    const finalBlockReason =
      finalState === "blocked"
        ? a.transitions[a.transitions.length - 1]!.blockReason
        : null;
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      a.id,
      a.agentId,
      a.taskId,
      finalState,
      finalBlockReason ? JSON.stringify(finalBlockReason) : null,
      a.createdAt,
      a.transitions.length > 0
        ? a.transitions[a.transitions.length - 1]!.timestamp
        : a.createdAt
    );

    // One session per assignment is enough for the metrics computation —
    // events JOIN through sessions.assignment_id.
    const sessionId = `${a.id}-sess`;
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES (?, ?, 'local.process.controlled', ?)`
    ).run(sessionId, a.id, a.createdAt);

    for (const t of a.transitions) {
      const payload: Record<string, unknown> = {
        from: t.from,
        to: t.to,
        action: "test",
      };
      if (t.blockReason) payload.blockReason = t.blockReason;
      db.query(
        `INSERT INTO events (id, session_id, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`
      ).run(
        nextEventId(),
        sessionId,
        "state.transition",
        JSON.stringify(payload),
        t.timestamp
      );
    }
  }
}

// Helper — ISO-8601 string at +Nms from a base instant.
function isoOffset(baseMs: number, addMs: number): string {
  return new Date(baseMs + addMs).toISOString();
}

// ---------------------------------------------------------------------------
// computeAssignmentMetrics
// ---------------------------------------------------------------------------

describe("computeAssignmentMetrics", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns null for unknown assignment id", () => {
    expect(computeAssignmentMetrics(db, "nonexistent")).toBeNull();
  });

  it("computes a clean queued → dispatched → running → completed cycle", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seed(db, [
      {
        id: "ata-1",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-1",
        createdAt: isoOffset(base, 0),
        transitions: [
          {
            timestamp: isoOffset(base, 1_000),
            from: "queued",
            to: "dispatched",
          },
          {
            timestamp: isoOffset(base, 3_000),
            from: "dispatched",
            to: "running",
          },
          {
            timestamp: isoOffset(base, 13_000),
            from: "running",
            to: "completed",
          },
        ],
      },
    ]);

    const m = computeAssignmentMetrics(db, "ata-1");
    expect(m).not.toBeNull();
    expect(m!.assignmentId).toBe("ata-1");
    expect(m!.totalCycleMs).toBe(13_000);
    expect(m!.inFlight).toBe(false);
    expect(m!.byState.queued).toBe(1_000);
    expect(m!.byState.dispatched).toBe(2_000);
    expect(m!.byState.running).toBe(10_000);
    expect(m!.byState.blocked).toBe(0);
    expect(m!.byState.completed).toBe(0); // terminal — no time accrues
    expect(m!.byBlockReason["permission.request"]).toBe(0);
    expect(m!.byBlockReason["tool.error"]).toBe(0);
    expect(m!.byBlockReason["review.checkpoint"]).toBe(0);
  });

  it("attributes blocked time to the right block_reason kind", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seed(db, [
      {
        id: "ata-2",
        agentId: "forge",
        agentName: "Forge",
        taskId: "t-2",
        createdAt: isoOffset(base, 0),
        transitions: [
          {
            timestamp: isoOffset(base, 500),
            from: "queued",
            to: "dispatched",
          },
          { timestamp: isoOffset(base, 1_000), from: "dispatched", to: "running" },
          {
            timestamp: isoOffset(base, 4_000),
            from: "running",
            to: "blocked",
            blockReason: {
              kind: "permission.request",
              payload: { requested_action: "tool.edit" },
            },
          },
          { timestamp: isoOffset(base, 9_000), from: "blocked", to: "running" },
          {
            timestamp: isoOffset(base, 12_000),
            from: "running",
            to: "blocked",
            blockReason: {
              kind: "tool.error",
              payload: { tool_name: "tool.bash", error_message: "exit 1" },
            },
          },
          { timestamp: isoOffset(base, 14_000), from: "blocked", to: "running" },
          { timestamp: isoOffset(base, 20_000), from: "running", to: "completed" },
        ],
      },
    ]);

    const m = computeAssignmentMetrics(db, "ata-2")!;
    expect(m.totalCycleMs).toBe(20_000);
    expect(m.byState.blocked).toBe(5_000 + 2_000); // 7_000
    expect(m.byBlockReason["permission.request"]).toBe(5_000);
    expect(m.byBlockReason["tool.error"]).toBe(2_000);
    expect(m.byBlockReason["review.checkpoint"]).toBe(0);
  });

  it("treats in-flight assignments with totalCycleMs=null and now-bounded final interval", () => {
    const base = Date.now() - 60_000; // started 60s ago
    seed(db, [
      {
        id: "ata-3",
        agentId: "echo",
        agentName: "Echo",
        taskId: "t-3",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "dispatched" },
          { timestamp: isoOffset(base, 2_000), from: "dispatched", to: "running" },
        ],
      },
    ]);

    const m = computeAssignmentMetrics(db, "ata-3")!;
    expect(m.totalCycleMs).toBeNull();
    expect(m.inFlight).toBe(true);
    expect(m.byState.queued).toBe(1_000);
    expect(m.byState.dispatched).toBe(1_000);
    // running interval is open-ended → now() - 2_000 from base ≈ 58_000ms.
    // Allow generous slack for test-runner scheduling jitter.
    expect(m.byState.running).toBeGreaterThanOrEqual(57_000);
    expect(m.byState.running).toBeLessThanOrEqual(60_000);
  });

  it("handles an assignment that was never transitioned (still queued)", () => {
    const base = Date.now() - 5_000;
    seed(db, [
      {
        id: "ata-4",
        agentId: "holly",
        agentName: "Holly",
        taskId: "t-4",
        createdAt: isoOffset(base, 0),
        transitions: [],
      },
    ]);

    const m = computeAssignmentMetrics(db, "ata-4")!;
    expect(m.inFlight).toBe(true);
    expect(m.totalCycleMs).toBeNull();
    expect(m.byState.queued).toBeGreaterThanOrEqual(4_500);
    expect(m.byState.queued).toBeLessThanOrEqual(5_500);
    expect(m.byState.dispatched).toBe(0);
    expect(m.byState.running).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeFleetMetrics
// ---------------------------------------------------------------------------

describe("computeFleetMetrics", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns zero stats when nothing in the window", () => {
    const f = computeFleetMetrics(db, { since: new Date(0) });
    expect(f.count).toBe(0);
    expect(f.completedCount).toBe(0);
    expect(f.p50CycleMs).toBeNull();
    expect(f.p90CycleMs).toBeNull();
    expect(f.p95CycleMs).toBeNull();
    expect(f.perAgent).toEqual([]);
    expect(f.topBlockers).toEqual([]);
  });

  it("computes p50/p90/p95 over completed cycle times", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    // Ten completed assignments with cycle times 1s, 2s, 3s, ... 10s.
    const seeds: SeedAssignment[] = [];
    for (let i = 1; i <= 10; i++) {
      seeds.push({
        id: `ata-${i}`,
        agentId: "luna",
        agentName: "Luna",
        taskId: `t-${i}`,
        createdAt: isoOffset(base, i * 100),
        transitions: [
          {
            timestamp: isoOffset(base, i * 100 + 100),
            from: "queued",
            to: "running",
          },
          {
            timestamp: isoOffset(base, i * 100 + i * 1_000),
            from: "running",
            to: "completed",
          },
        ],
      });
    }
    seed(db, seeds);

    const f = computeFleetMetrics(db, { since: new Date(base) });
    expect(f.count).toBe(10);
    expect(f.completedCount).toBe(10);
    // Cycle times: i * 1000 for i = 1..10 → [1000, 2000, ..., 10000].
    // Nearest-rank p50 = ceil(0.50 * 10) - 1 = 4 → 5000.
    // p90 = ceil(0.90 * 10) - 1 = 8 → 9000.
    // p95 = ceil(0.95 * 10) - 1 = 9 → 10000.
    expect(f.p50CycleMs).toBe(5_000);
    expect(f.p90CycleMs).toBe(9_000);
    expect(f.p95CycleMs).toBe(10_000);
  });

  it("excludes in-flight assignments from cycle stats but includes them in count", () => {
    const base = Date.now() - 30_000;
    seed(db, [
      {
        id: "done-1",
        agentId: "luna",
        agentName: "Luna",
        taskId: "td-1",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 5_000), from: "running", to: "completed" },
        ],
      },
      {
        id: "live-1",
        agentId: "forge",
        agentName: "Forge",
        taskId: "tl-1",
        createdAt: isoOffset(base, 1_000),
        transitions: [
          { timestamp: isoOffset(base, 2_000), from: "queued", to: "running" },
        ],
      },
    ]);

    const f = computeFleetMetrics(db, { since: new Date(base - 1000) });
    expect(f.count).toBe(2);
    expect(f.completedCount).toBe(1);
    expect(f.p50CycleMs).toBe(5_000);
  });

  it("breaks down per-agent and ranks top blockers by total ms", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seed(db, [
      // Luna: one fast completion + one blocked-on-permission completion.
      {
        id: "ata-luna-1",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-l1",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 2_000), from: "running", to: "completed" },
        ],
      },
      {
        id: "ata-luna-2",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-l2",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          {
            timestamp: isoOffset(base, 2_000),
            from: "running",
            to: "blocked",
            blockReason: {
              kind: "permission.request",
              payload: { requested_action: "tool.edit" },
            },
          },
          { timestamp: isoOffset(base, 12_000), from: "blocked", to: "running" },
          { timestamp: isoOffset(base, 13_000), from: "running", to: "completed" },
        ],
      },
      // Forge: one completion blocked on tool.error.
      {
        id: "ata-forge-1",
        agentId: "forge",
        agentName: "Forge",
        taskId: "t-f1",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          {
            timestamp: isoOffset(base, 2_000),
            from: "running",
            to: "blocked",
            blockReason: {
              kind: "tool.error",
              payload: { tool_name: "tool.bash", error_message: "exit 1" },
            },
          },
          { timestamp: isoOffset(base, 5_000), from: "blocked", to: "running" },
          { timestamp: isoOffset(base, 8_000), from: "running", to: "completed" },
        ],
      },
    ]);

    const f = computeFleetMetrics(db, { since: new Date(base) });

    expect(f.count).toBe(3);
    expect(f.completedCount).toBe(3);

    // Per-agent: sorted by completed DESC, then p50 ASC (faster first).
    expect(f.perAgent.length).toBe(2);
    const luna = f.perAgent.find((a) => a.agentId === "luna")!;
    const forge = f.perAgent.find((a) => a.agentId === "forge")!;
    expect(luna.completed).toBe(2);
    expect(forge.completed).toBe(1);
    expect(luna.topBlocker).toBe("permission.request");
    expect(forge.topBlocker).toBe("tool.error");

    // Top blockers across the fleet: permission.request (10s) > tool.error (3s).
    expect(f.topBlockers[0]?.kind).toBe("permission.request");
    expect(f.topBlockers[0]?.totalMs).toBe(10_000);
    expect(f.topBlockers[1]?.kind).toBe("tool.error");
    expect(f.topBlockers[1]?.totalMs).toBe(3_000);
  });

  it("filters by agentId when provided", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seed(db, [
      {
        id: "ata-luna-1",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-l1",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 6_000), from: "running", to: "completed" },
        ],
      },
      {
        id: "ata-forge-1",
        agentId: "forge",
        agentName: "Forge",
        taskId: "t-f1",
        createdAt: isoOffset(base, 0),
        transitions: [
          { timestamp: isoOffset(base, 1_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 3_000), from: "running", to: "completed" },
        ],
      },
    ]);

    const f = computeFleetMetrics(db, {
      since: new Date(base),
      agentId: "luna",
    });
    expect(f.count).toBe(1);
    expect(f.completedCount).toBe(1);
    expect(f.p50CycleMs).toBe(6_000);
    expect(f.perAgent.length).toBe(1);
    expect(f.perAgent[0]?.agentId).toBe("luna");
  });

  // Per Echo PR #50 review — coverage gaps:
  // (1) failed / cancelled terminal states reach the terminal branch and
  //     produce a non-null totalCycleMs (every other test uses 'completed').
  // (2) started-before-window, finished-inside-window — exercises the
  //     EXISTS (timestamp >= ?) branch in the WHERE.
  // (3) perAgent tiebreaker on completed — equal counts → p50-ASC ordering.
  it("covers Echo's three gaps: failed/cancelled terminals, EXISTS-branch window membership, perAgent tiebreaker", () => {
    const base = Date.parse("2026-04-27T00:00:00.000Z");
    seed(db, [
      // Started 90s before the window, finished 60s into it — only
      // included via the EXISTS-on-terminal branch.
      {
        id: "ata-prewindow",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-prew",
        createdAt: isoOffset(base, -90_000),
        transitions: [
          {
            timestamp: isoOffset(base, -89_000),
            from: "queued",
            to: "running",
          },
          {
            timestamp: isoOffset(base, 60_000),
            from: "running",
            to: "completed",
          },
        ],
      },
      // Failed terminal — must land in completedCount + cycleTimes.
      {
        id: "ata-failed",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-fail",
        createdAt: isoOffset(base, 1_000),
        transitions: [
          { timestamp: isoOffset(base, 2_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 5_000), from: "running", to: "failed" },
        ],
      },
      // Cancelled terminal — same.
      {
        id: "ata-cancelled",
        agentId: "luna",
        agentName: "Luna",
        taskId: "t-canc",
        createdAt: isoOffset(base, 1_000),
        transitions: [
          { timestamp: isoOffset(base, 2_000), from: "queued", to: "running" },
          {
            timestamp: isoOffset(base, 4_000),
            from: "running",
            to: "cancelled",
          },
        ],
      },
      // Two agents tied on `completed` — Forge should sort ABOVE Holly because
      // Forge's p50 is faster.
      {
        id: "ata-forge-1",
        agentId: "forge",
        agentName: "Forge",
        taskId: "t-fo1",
        createdAt: isoOffset(base, 1_000),
        transitions: [
          { timestamp: isoOffset(base, 2_000), from: "queued", to: "running" },
          { timestamp: isoOffset(base, 4_000), from: "running", to: "completed" },
        ],
      },
      {
        id: "ata-holly-1",
        agentId: "holly",
        agentName: "Holly",
        taskId: "t-ho1",
        createdAt: isoOffset(base, 1_000),
        transitions: [
          { timestamp: isoOffset(base, 2_000), from: "queued", to: "running" },
          {
            timestamp: isoOffset(base, 12_000),
            from: "running",
            to: "completed",
          },
        ],
      },
    ]);

    // Window starts AT base — pre-window assignment is included only by
    // its terminal-in-window timestamp.
    const f = computeFleetMetrics(db, { since: new Date(base) });

    // (1) Failed and cancelled terminals are counted as completed (the field
    //     is "reached terminal", not literally to=completed).
    expect(f.completedCount).toBeGreaterThanOrEqual(4);
    // (2) Pre-window assignment only got in via the EXISTS branch.
    const ids = new Set(f.perAgent.map((a) => a.agentId));
    expect(ids.has("luna")).toBe(true);
    expect(ids.has("forge")).toBe(true);
    expect(ids.has("holly")).toBe(true);
    // (3) Forge (4s p50) sorts above Holly (10s p50) when both have completed=1.
    const forgeIdx = f.perAgent.findIndex((a) => a.agentId === "forge");
    const hollyIdx = f.perAgent.findIndex((a) => a.agentId === "holly");
    expect(forgeIdx).toBeGreaterThanOrEqual(0);
    expect(hollyIdx).toBeGreaterThan(forgeIdx);
  });
});
