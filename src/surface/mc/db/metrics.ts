/**
 * Grove Mission Control v3 — F-18 metrics computation.
 *
 * Read-only over the existing schema. No new tables, no new event kinds.
 * See `docs/design-mc-f18-metrics.md` for the full spec.
 *
 * Algorithm (Decision 3): walk `state.transition` events for an assignment
 * in `timestamp ASC` order. The first interval [created_at, T0) is `queued`
 * (assignments insert with state='queued'). Each subsequent interval
 * [Tn, Tn+1) was spent in the state we transitioned OUT of at Tn+1
 * (= the `from` field on the event at Tn+1). The final interval is bounded
 * by either the terminal transition's timestamp (completed/failed/cancelled)
 * or `now()` for in-flight assignments. Block-reason intervals are
 * attributed to the kind recorded on the transition INTO blocked.
 *
 * Computation lives in TS rather than SQL because:
 *   - The same `BlockReason` tagged-union type used elsewhere can be reused
 *     without JSON-extract gymnastics in SQLite.
 *   - At Phase B operator scale (tens to hundreds of assignments per
 *     window), the total event row count is small enough that linear
 *     interval math in TS is comparable to a SQL window-function pass.
 *   - Future percentile / cost extensions are easier to express in TS
 *     without contorting the SQL.
 *
 * If the windowed query ever exceeds O(10⁴) events, the right move is the
 * SQL-side windowing pattern from F-7's events endpoint, NOT a more clever
 * SQL aggregation here. Filed as F-19.3.
 */

import type { Database } from "bun:sqlite";
import type { AssignmentState, BlockReason } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BlockReasonKind = BlockReason["kind"];

const ASSIGNMENT_STATES_ARR: readonly AssignmentState[] = [
  "queued",
  "dispatched",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

const TERMINAL_STATES = new Set<AssignmentState>([
  "completed",
  "failed",
  "cancelled",
]);

const BLOCK_REASON_KINDS: readonly BlockReasonKind[] = [
  "permission.request",
  "tool.error",
  "review.checkpoint",
];

export interface AssignmentMetrics {
  assignmentId: string;
  /** Total ms from queued → terminal. Null when in-flight. */
  totalCycleMs: number | null;
  /** Sum of ms in each state across the assignment's lifetime. */
  byState: Record<AssignmentState, number>;
  /** Sum of ms blocked, broken down by block_reason.kind. */
  byBlockReason: Record<BlockReasonKind, number>;
  /** True if no terminal transition has fired yet (right edge = now()). */
  inFlight: boolean;
}

export interface FleetMetrics {
  /** Echo of the window the caller asked for — useful for client cache keys. */
  windowSinceIso: string;
  /** Assignments observed in the window (started OR finished inside it). */
  count: number;
  /** Subset that reached a terminal state — basis for cycle-time stats. */
  completedCount: number;
  p50CycleMs: number | null;
  p90CycleMs: number | null;
  p95CycleMs: number | null;
  /** Mean ms per assignment in each state across the window's assignments. */
  meanByState: Record<AssignmentState, number>;
  /** Mean ms per assignment blocked under each kind. */
  meanByBlockReason: Record<BlockReasonKind, number>;
  /** Top three block-reason kinds by total ms across the window, descending. */
  topBlockers: {
    kind: BlockReasonKind;
    totalMs: number;
    /** Distinct assignments that hit this block reason at least once. */
    assignments: number;
  }[];
  /** Per-agent breakdown. Sorted by completed DESC, then p50 ASC (faster first). */
  perAgent: {
    agentId: string;
    agentName: string;
    completed: number;
    p50CycleMs: number | null;
    /** Block reason consuming the most blocked time for this agent. Null
     *  if the agent had no blocked time inside the window. */
    topBlocker: BlockReasonKind | null;
  }[];
}

export interface FleetMetricsOptions {
  since: Date;
  /** When set, restrict to one agent. perAgent then has at most one row. */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  agent_id: string;
  agent_name: string;
  state: AssignmentState;
  created_at: string;
}

interface TransitionRow {
  assignment_id: string;
  timestamp: string;
  payload: string;
}

interface TransitionPayload {
  from: AssignmentState;
  to: AssignmentState;
  blockReason?: BlockReason;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyByState(): Record<AssignmentState, number> {
  const out = {} as Record<AssignmentState, number>;
  for (const s of ASSIGNMENT_STATES_ARR) out[s] = 0;
  return out;
}

function emptyByBlockReason(): Record<BlockReasonKind, number> {
  const out = {} as Record<BlockReasonKind, number>;
  for (const k of BLOCK_REASON_KINDS) out[k] = 0;
  return out;
}

function parseIsoMs(iso: string): number {
  // SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" (space, no Z).
  // Application code generates `new Date().toISOString()` which is
  // "YYYY-MM-DDTHH:MM:SS.sssZ". Both are accepted by `Date.parse` on V8 /
  // Bun, but the SQLite form is parsed as local time on some engines. We
  // normalise the SQLite form to ISO-8601 UTC before parsing so the math
  // is timezone-independent.
  const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Walk one assignment's transitions and accumulate intervals into the
 * per-state and per-block-reason buckets.
 *
 * Mutates `byState` and `byBlockReason` in place. Returns the assignment's
 * cycle-time + in-flight flag.
 */
function accumulateIntervals(
  createdAtMs: number,
  transitions: { ts: number; from: AssignmentState; to: AssignmentState; blockReason?: BlockReason }[],
  byState: Record<AssignmentState, number>,
  byBlockReason: Record<BlockReasonKind, number>,
  nowMs: number
): { totalCycleMs: number | null; inFlight: boolean } {
  // Each transition closes the interval [prevTs, t.ts) attributed to the
  // state we were IN during that interval (= the `from` on this transition,
  // OR `queued` for the very first interval since the implicit initial
  // state is queued).
  let prevTs = createdAtMs;
  // Track the state we're CURRENTLY in. Starts at queued (the implicit
  // post-insert state); each transition flips us to the `to`.
  let currentState: AssignmentState = "queued";
  // Block reason that owns the current interval IF we are in `blocked`.
  let activeBlockReason: BlockReasonKind | null = null;

  let terminalReached = false;

  for (const t of transitions) {
    // The interval [prevTs, t.ts) belongs to `currentState` (which equals
    // t.from in a well-formed log). We trust the recorded `from` over the
    // walked currentState if they disagree — the recorded value is what
    // happened.
    const interval = Math.max(0, t.ts - prevTs);
    const intervalState = t.from;
    byState[intervalState] += interval;
    if (intervalState === "blocked" && activeBlockReason !== null) {
      byBlockReason[activeBlockReason] += interval;
    }

    // Apply the transition.
    currentState = t.to;
    if (t.to === "blocked") {
      activeBlockReason = t.blockReason?.kind ?? null;
    } else {
      activeBlockReason = null;
    }
    if (TERMINAL_STATES.has(t.to)) {
      terminalReached = true;
    }
    prevTs = t.ts;
  }

  // Final open-ended interval: from `prevTs` to either the terminal
  // timestamp (already consumed by the terminal transition above — its
  // `from` was attributed to `intervalState`, and `currentState` is now
  // a terminal state which gets zero time) or `now()` for in-flight.
  if (!terminalReached) {
    const tail = Math.max(0, nowMs - prevTs);
    byState[currentState] += tail;
    if (currentState === "blocked" && activeBlockReason !== null) {
      byBlockReason[activeBlockReason] += tail;
    }
  }

  // Cycle time: queued + dispatched + running + blocked time, OR
  // (terminal_ts - created_at) — both are equivalent when terminal fires.
  // Use the simpler latter when terminal reached; null when in-flight.
  if (!terminalReached) {
    return { totalCycleMs: null, inFlight: true };
  }
  return { totalCycleMs: prevTs - createdAtMs, inFlight: false };
}

function loadTransitionsForAssignment(
  db: Database,
  assignmentId: string
): { ts: number; from: AssignmentState; to: AssignmentState; blockReason?: BlockReason }[] {
  const rows = db
    .query(
      `SELECT s.assignment_id AS assignment_id, e.timestamp AS timestamp, e.payload AS payload
       FROM events e
       JOIN sessions s ON e.session_id = s.id
       WHERE s.assignment_id = ? AND e.type = 'state.transition'
       ORDER BY e.timestamp ASC, e.id ASC`
    )
    .all(assignmentId) as TransitionRow[];

  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as TransitionPayload;
    return {
      ts: parseIsoMs(r.timestamp),
      from: payload.from,
      to: payload.to,
      blockReason: payload.blockReason,
    };
  });
}

// ---------------------------------------------------------------------------
// computeAssignmentMetrics
// ---------------------------------------------------------------------------

export function computeAssignmentMetrics(
  db: Database,
  assignmentId: string
): AssignmentMetrics | null {
  const ata = db
    .query(
      `SELECT a.id AS id, a.agent_id AS agent_id, ag.name AS agent_name, a.state AS state, a.created_at AS created_at
       FROM agent_task_assignment a
       JOIN agents ag ON a.agent_id = ag.id
       WHERE a.id = ?`
    )
    .get(assignmentId) as AssignmentRow | null;
  if (!ata) return null;

  const transitions = loadTransitionsForAssignment(db, assignmentId);
  const byState = emptyByState();
  const byBlockReason = emptyByBlockReason();
  const { totalCycleMs, inFlight } = accumulateIntervals(
    parseIsoMs(ata.created_at),
    transitions,
    byState,
    byBlockReason,
    Date.now()
  );

  return {
    assignmentId,
    totalCycleMs,
    byState,
    byBlockReason,
    inFlight,
  };
}

// ---------------------------------------------------------------------------
// Percentile (nearest-rank — see Decision 3)
// ---------------------------------------------------------------------------

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1)
  );
  return sortedAsc[idx]!;
}

// ---------------------------------------------------------------------------
// computeFleetMetrics
// ---------------------------------------------------------------------------

interface FleetAssignmentRow {
  id: string;
  agent_id: string;
  agent_name: string;
  state: AssignmentState;
  created_at: string;
}

export function computeFleetMetrics(
  db: Database,
  opts: FleetMetricsOptions
): FleetMetrics {
  const sinceIso = opts.since.toISOString();
  const sinceMs = opts.since.getTime();

  // Pull every assignment that intersects the window. An assignment counts
  // when:
  //   - created_at >= since (started inside the window), OR
  //   - terminal transition timestamp >= since (finished inside the window).
  // We compute terminal_ts via a correlated subquery over state.transition
  // events with `to IN terminal states`. SQLite's `json_extract` reads the
  // payload JSON without needing a parsed-payload table.
  const params: string[] = [sinceIso, sinceIso];
  let agentFilter = "";
  if (opts.agentId) {
    agentFilter = "AND a.agent_id = ?";
    params.push(opts.agentId);
  }

  // Window membership (Decision 3): assignment counts when EITHER its
  // created_at is in the window OR a terminal transition fired in the
  // window. The EXISTS subquery handles the terminal-side check; a
  // SELECT-side correlated subquery for terminal_ts would be dead work
  // (the per-assignment walker re-derives terminal status from the
  // transition list).
  const rows = db
    .query(
      `SELECT
         a.id AS id,
         a.agent_id AS agent_id,
         ag.name AS agent_name,
         a.state AS state,
         a.created_at AS created_at
       FROM agent_task_assignment a
       JOIN agents ag ON a.agent_id = ag.id
       WHERE (a.created_at >= ?
              OR EXISTS (
                SELECT 1
                FROM events e
                JOIN sessions s ON e.session_id = s.id
                WHERE s.assignment_id = a.id
                  AND e.type = 'state.transition'
                  AND json_extract(e.payload, '$.to') IN ('completed','failed','cancelled')
                  AND e.timestamp >= ?
              ))
         ${agentFilter}`
    )
    .all(...params) as FleetAssignmentRow[];

  if (rows.length === 0) {
    return {
      windowSinceIso: sinceIso,
      count: 0,
      completedCount: 0,
      p50CycleMs: null,
      p90CycleMs: null,
      p95CycleMs: null,
      meanByState: emptyByState(),
      meanByBlockReason: emptyByBlockReason(),
      topBlockers: [],
      perAgent: [],
    };
  }

  // Per-assignment buckets — needed for the per-agent roll-up below.
  interface AgentBucket {
    agentId: string;
    agentName: string;
    completed: number;
    cycleTimes: number[];
    blockedByKind: Record<BlockReasonKind, number>;
  }
  const perAgentMap = new Map<string, AgentBucket>();

  // Fleet-wide aggregates.
  const totalByState = emptyByState();
  const totalByBlockReason = emptyByBlockReason();
  const blockerHits = emptyByBlockReason();
  const cycleTimes: number[] = [];
  let completedCount = 0;
  const nowMs = Date.now();

  for (const row of rows) {
    const transitions = loadTransitionsForAssignment(db, row.id);
    const byState = emptyByState();
    const byBlockReason = emptyByBlockReason();
    const { totalCycleMs, inFlight } = accumulateIntervals(
      parseIsoMs(row.created_at),
      transitions,
      byState,
      byBlockReason,
      nowMs
    );

    // Roll up into fleet totals.
    for (const s of ASSIGNMENT_STATES_ARR) totalByState[s] += byState[s];
    for (const k of BLOCK_REASON_KINDS) {
      totalByBlockReason[k] += byBlockReason[k];
      if (byBlockReason[k] > 0) blockerHits[k] += 1;
    }
    if (!inFlight && totalCycleMs !== null) {
      cycleTimes.push(totalCycleMs);
      completedCount += 1;
    }

    // Per-agent bucket.
    let bucket = perAgentMap.get(row.agent_id);
    if (!bucket) {
      bucket = {
        agentId: row.agent_id,
        agentName: row.agent_name,
        completed: 0,
        cycleTimes: [],
        blockedByKind: emptyByBlockReason(),
      };
      perAgentMap.set(row.agent_id, bucket);
    }
    if (!inFlight && totalCycleMs !== null) {
      bucket.completed += 1;
      bucket.cycleTimes.push(totalCycleMs);
    }
    for (const k of BLOCK_REASON_KINDS) {
      bucket.blockedByKind[k] += byBlockReason[k];
    }
  }

  // Compute means (over total assignments observed, not just completed).
  const meanByState = emptyByState();
  const meanByBlockReason = emptyByBlockReason();
  for (const s of ASSIGNMENT_STATES_ARR) {
    meanByState[s] = Math.round(totalByState[s] / rows.length);
  }
  for (const k of BLOCK_REASON_KINDS) {
    meanByBlockReason[k] = Math.round(totalByBlockReason[k] / rows.length);
  }

  // Top blockers — descending by totalMs, drop zero entries, cap at 3.
  const topBlockers = BLOCK_REASON_KINDS.map((kind) => ({
    kind,
    totalMs: totalByBlockReason[kind],
    assignments: blockerHits[kind],
  }))
    .filter((e) => e.totalMs > 0)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 3);

  // Per-agent rollup. p50 from sorted cycleTimes; topBlocker = argmax over
  // blockedByKind; ties resolved deterministically by enum order.
  const perAgent = Array.from(perAgentMap.values()).map((b) => {
    const sorted = [...b.cycleTimes].sort((x, y) => x - y);
    const p50 = percentile(sorted, 0.5);
    let topBlocker: BlockReasonKind | null = null;
    let topMs = 0;
    for (const k of BLOCK_REASON_KINDS) {
      if (b.blockedByKind[k] > topMs) {
        topMs = b.blockedByKind[k];
        topBlocker = k;
      }
    }
    return {
      agentId: b.agentId,
      agentName: b.agentName,
      completed: b.completed,
      p50CycleMs: p50,
      topBlocker,
    };
  });

  // Sort: completed DESC, p50 ASC (null p50 sorts last), agentName ASC tiebreaker.
  perAgent.sort((a, b) => {
    if (b.completed !== a.completed) return b.completed - a.completed;
    if (a.p50CycleMs === null && b.p50CycleMs !== null) return 1;
    if (a.p50CycleMs !== null && b.p50CycleMs === null) return -1;
    if (a.p50CycleMs !== null && b.p50CycleMs !== null && a.p50CycleMs !== b.p50CycleMs) {
      return a.p50CycleMs - b.p50CycleMs;
    }
    return a.agentName.localeCompare(b.agentName);
  });

  const sortedCycle = [...cycleTimes].sort((a, b) => a - b);

  return {
    windowSinceIso: sinceIso,
    count: rows.length,
    completedCount,
    p50CycleMs: percentile(sortedCycle, 0.5),
    p90CycleMs: percentile(sortedCycle, 0.9),
    p95CycleMs: percentile(sortedCycle, 0.95),
    meanByState,
    meanByBlockReason,
    topBlockers,
    perAgent,
  };
}

// Used by `windowToSinceDate` in API handlers — exported for testability.
export const FLEET_WINDOW_ALLOWLIST = ["24h", "7d", "30d"] as const;
export type FleetWindow = (typeof FLEET_WINDOW_ALLOWLIST)[number];

export function windowToSinceDate(w: FleetWindow, now: Date = new Date()): Date {
  const ms =
    w === "24h" ? 24 * 3_600_000 : w === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - ms);
}
