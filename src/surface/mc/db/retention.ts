/**
 * Mission Control retention / prune (#857 orphan rows, #864 events table).
 *
 * The live MC pane accretes two row families with no server-side retention:
 *
 *   1. **Orphan auto-registration (#857).** `registerOrphanSession` (db/sessions.ts)
 *      lands one synthetic agent + assignment + session (+ a `state.transition`
 *      event) per distinct `cc_session_id`, FOREVER. The working grid stays
 *      clean (`listWorkingAgents` filters terminal states) but the underlying
 *      agent/assignment/session rows never prune.
 *
 *   2. **Events table (#864).** `events` has only a client-side 500-row
 *      in-memory cap; the hook ingestor + the S6 projection families are steady
 *      writers with no server-side bound.
 *
 * This module is the SINGLE retention mechanism for both. It is hung off a
 * periodic, throttled caller (see `ThrottledPrune`) so it runs at most once per
 * interval regardless of how frequently the host loop ticks.
 *
 * ── Design choices (stated for the PR) ──────────────────────────────────────
 *
 *   - **Orphan terminal-age prune** keys off `sessions.ended_at` (the #857
 *     `applyTransition` fix stamps it on every terminal transition). A row is
 *     prunable iff it is an orphan (its agent carries the `mc-orphan-` prefix
 *     AND hangs off the shared `mc-orphan-task`), its session is terminal
 *     (`ended_at IS NOT NULL`), and that `ended_at` is older than
 *     {@link ORPHAN_RETENTION_MS}. Real dispatch-projected / principal-created
 *     rows are NEVER touched — the prune's WHERE is double-anchored on the
 *     orphan prefix AND the orphan task id.
 *
 *   - **Events prune is AGE-based, not a per-session cap.** Age is the simpler
 *     bound that still caps unbounded growth: a single indexed
 *     `DELETE FROM events WHERE timestamp < cutoff` (served by
 *     `idx_events_timestamp`) vs. a per-session window-function partition scan.
 *     Pruning an orphan SESSION already CASCADE-drops its events
 *     (`events.session_id → sessions.id ON DELETE CASCADE`); this age prune is
 *     the complement that reaps old events whose session is RETAINED (e.g. a
 *     long-lived observed session that keeps emitting).
 *
 *   - **Windows are module constants, not config.** Minimal blast radius: no
 *     new schema on AgentConfigSchema/CortexConfigSchema. Tune here if needed.
 */

import type { Database } from "bun:sqlite";
import { ORPHAN_AGENT_PREFIX, ORPHAN_TASK_ID } from "./sessions";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Orphan terminal-row retention window. Orphan agent/assignment/session rows
 * whose session has been terminal (`ended_at`) for longer than this prune.
 * 7 days keeps roughly a week of observed-session history queryable on the
 * glass before it ages out — orphan volume is ~tens/month, so this is a
 * comfortable buffer.
 */
export const ORPHAN_RETENTION_MS = 7 * DAY_MS;

/**
 * Events retention window. Events older than this prune (independent of whether
 * their session row is retained). 14 days outlives the orphan window so an
 * orphan session's events are reaped WITH the session (CASCADE) rather than
 * ahead of it, and gives a fortnight of drill-down history for retained
 * sessions.
 */
export const EVENTS_RETENTION_MS = 14 * DAY_MS;

// ORPHAN_TASK_ID is imported from ./sessions — the shared orphan anchor task,
// preserved by the prune (only its children go). Single source of truth so the
// DELETE anchor can't drift from the registration site.

export interface OrphanPruneResult {
  prunedSessions: number;
  prunedAssignments: number;
  prunedAgents: number;
}

export interface EventsPruneResult {
  prunedEvents: number;
}

export interface RetentionSummary extends OrphanPruneResult, EventsPruneResult {
  /** false when the prune failed (e.g. closed db) — best-effort, never throws. */
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
}

/**
 * Select the orphan assignment ids whose session is terminal beyond the
 * retention window. An assignment qualifies iff:
 *   - its agent id starts with the orphan prefix, AND
 *   - it hangs off the shared `mc-orphan-task` (double-anchor: belt + braces
 *     against a non-orphan agent ever acquiring the prefix), AND
 *   - it has a session whose `ended_at` is non-null and older than the cutoff,
 *     AND it has NO session that is still open (ended_at IS NULL).
 *
 * The "no open session" guard means a re-observed orphan (a new dispatched/
 * running session re-attached to the same assignment) is never pruned mid-turn.
 */
function selectPrunableOrphanAssignments(db: Database, cutoffIso: string): string[] {
  const rows = db
    .query(
      `SELECT ata.id AS id
         FROM agent_task_assignment ata
         JOIN agents ag ON ag.id = ata.agent_id
        WHERE ata.task_id = ?
          AND ag.id LIKE ? || '%'
          AND EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.assignment_id = ata.id
                   AND s.ended_at IS NOT NULL
                   AND s.ended_at < ?
              )
          AND NOT EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.assignment_id = ata.id
                   AND s.ended_at IS NULL
              )`
    )
    .all(ORPHAN_TASK_ID, ORPHAN_AGENT_PREFIX, cutoffIso) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Prune orphan agent/assignment/session rows (and their CASCADEd events) that
 * are terminal beyond {@link ORPHAN_RETENTION_MS}.
 *
 * Order is FK-safe and runs in ONE transaction (all-or-nothing, idempotent):
 *   1. delete the qualifying sessions   — CASCADE drops their events.
 *   2. delete the qualifying assignments — sessions already gone; the assignment
 *      FK is `ON DELETE CASCADE` off the assignment too, but the agent/task FKs
 *      are RESTRICT so order matters: assignment before agent.
 *   3. delete the now-childless orphan agents — only those with NO remaining
 *      assignment (a re-observed orphan agent may still anchor a live session).
 *
 * The shared `mc-orphan-task` is intentionally preserved (it is the stable
 * anchor; only its child assignments + sessions are reaped).
 */
export function pruneOrphanSessions(db: Database): OrphanPruneResult {
  const cutoffIso = new Date(Date.now() - ORPHAN_RETENTION_MS).toISOString();
  const assignmentIds = selectPrunableOrphanAssignments(db, cutoffIso);

  if (assignmentIds.length === 0) {
    return { prunedSessions: 0, prunedAssignments: 0, prunedAgents: 0 };
  }

  const placeholders = assignmentIds.map(() => "?").join(", ");

  // bun:sqlite's `Statement.run().changes` reports cumulative changes INCLUDING
  // FK cascades (deleting a session also counts its cascaded events), so it
  // can't be trusted for a per-table count. We therefore count the affected
  // rows with explicit SELECTs inside the same transaction, before the deletes.
  const txn = db.transaction(() => {
    const prunedSessions = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM sessions WHERE assignment_id IN (${placeholders})`
        )
        .get(...assignmentIds) as { n: number }
    ).n;

    // Orphan agents that will be left childless once their assignments go.
    const prunedAgents = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM agents ag
            WHERE ag.id LIKE ? || '%'
              AND ag.id IN (
                    SELECT agent_id FROM agent_task_assignment WHERE id IN (${placeholders})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM agent_task_assignment ata
                     WHERE ata.agent_id = ag.id
                       AND ata.id NOT IN (${placeholders})
                  )`
        )
        .get(ORPHAN_AGENT_PREFIX, ...assignmentIds, ...assignmentIds) as { n: number }
    ).n;

    // 1. sessions (CASCADE drops events). Scoped to the prunable assignments.
    db.query(`DELETE FROM sessions WHERE assignment_id IN (${placeholders})`).run(
      ...assignmentIds
    );

    // 2. assignments. The agent/task FKs are RESTRICT so this must run AFTER
    //    sessions (CASCADE off the assignment) and BEFORE the agent delete.
    db.query(`DELETE FROM agent_task_assignment WHERE id IN (${placeholders})`).run(
      ...assignmentIds
    );

    // 3. orphan agents left with no assignment. Re-anchored on the orphan
    //    prefix so a non-orphan agent can never be swept, and on "no remaining
    //    assignment" so a re-observed orphan agent keeps its live session.
    db.query(
      `DELETE FROM agents
        WHERE id LIKE ? || '%'
          AND NOT EXISTS (
                SELECT 1 FROM agent_task_assignment ata
                 WHERE ata.agent_id = agents.id
              )`
    ).run(ORPHAN_AGENT_PREFIX);

    return {
      prunedSessions,
      prunedAssignments: assignmentIds.length,
      prunedAgents,
    };
  });

  return txn();
}

/**
 * Prune `events` older than {@link EVENTS_RETENTION_MS}. Age-based (see module
 * doc for the cap-vs-age rationale). Single indexed DELETE; idempotent.
 *
 * NOTE: this does NOT touch the hook cursor. The poller reads raw JSONL from
 * `~/.claude/events/raw/` and tracks byte offsets in `mc-hook-cursor.json`; it
 * never reads the `events` table, so pruning rows here cannot rewind or corrupt
 * ingestion (verified against hooks/poller.ts + hooks/ingestor.ts).
 */
export function pruneOldEvents(db: Database): EventsPruneResult {
  const cutoffIso = new Date(Date.now() - EVENTS_RETENTION_MS).toISOString();
  const res = db.query(`DELETE FROM events WHERE timestamp < ?`).run(cutoffIso);
  return { prunedEvents: res.changes };
}

/**
 * Run the full retention sweep: orphan terminal-row prune + events age prune.
 *
 * Best-effort: any failure (e.g. a closed db handle, a locked table) is caught
 * and reported as `ok: false` rather than thrown, so a prune failure can NEVER
 * break the host loop that calls it (the hook poller — see embed.ts wiring).
 * Each sub-prune is independently transactional; the combined call is NOT
 * wrapped in an outer transaction (the two are unrelated row families, and the
 * events prune should still run even if the orphan prune is a no-op).
 */
export function pruneRetention(db: Database): RetentionSummary {
  try {
    const orphans = pruneOrphanSessions(db);
    const events = pruneOldEvents(db);
    return { ok: true, ...orphans, ...events };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      prunedSessions: 0,
      prunedAssignments: 0,
      prunedAgents: 0,
      prunedEvents: 0,
    };
  }
}

export interface ThrottledPruneOptions {
  /** Minimum ms between runs. */
  intervalMs: number;
  /** The work to throttle (e.g. () => pruneRetention(db)). */
  run: () => void;
  /** Injectable clock (defaults to Date.now) for deterministic tests. */
  now?: () => number;
  /** Called with any error `run` throws. Defaults to a stderr line. */
  onError?: (err: unknown) => void;
}

/**
 * Gate a frequently-ticked caller down to one run per `intervalMs`.
 *
 * The hook poller ticks every ~2s; running a full table prune every tick would
 * be wasteful and lock-prone. `ThrottledPrune.maybeRun()` is called every tick
 * but only invokes `run` when at least `intervalMs` has elapsed since the last
 * run STARTED.
 *
 * Crucially, the last-run clock advances even when `run` throws — so a failing
 * prune does NOT turn into a tight-loop retry storm (it waits a full interval
 * before retrying), and `maybeRun` never throws out of the caller.
 */
export class ThrottledPrune {
  private lastRunMs = -Infinity;
  private readonly intervalMs: number;
  private readonly run: () => void;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  constructor(opts: ThrottledPruneOptions) {
    this.intervalMs = opts.intervalMs;
    this.run = opts.run;
    this.now = opts.now ?? Date.now;
    this.onError =
      opts.onError ??
      ((err: unknown) =>
        process.stderr.write(
          `[mc-retention] prune failed: ${err instanceof Error ? err.message : String(err)}\n`
        ));
  }

  /** Run the prune iff the interval has elapsed. Never throws. */
  maybeRun(): void {
    const t = this.now();
    if (t - this.lastRunMs < this.intervalMs) return;
    // Advance the clock BEFORE running so a throw still consumes the interval
    // (no tight-loop retry on a persistently-failing prune).
    this.lastRunMs = t;
    try {
      this.run();
    } catch (err) {
      this.onError(err);
    }
  }
}
