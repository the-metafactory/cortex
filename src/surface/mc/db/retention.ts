/**
 * Mission Control retention / prune (#857 orphan rows, #864 events table,
 * #955 stuck-running reap).
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
 *     prunable iff it hangs off the shared `mc-orphan-task` (the bookkeeping
 *     anchor for ALL auto-registered observed sessions), its session is terminal
 *     (`ended_at IS NOT NULL`), and that `ended_at` is older than
 *     {@link ORPHAN_RETENTION_MS}. Real dispatch-projected / principal-created
 *     rows are NEVER touched — the prune's WHERE is anchored on the orphan task
 *     id, which no controlled/dispatch work ever uses.
 *
 *     ST-P2 NOTE: the anchor was *double*-anchored on the `mc-orphan-` agent
 *     prefix AND the orphan task. ST-P2 stopped minting per-session
 *     `mc-orphan-{cc}` agents — observed sessions now attach to the REAL owning
 *     agent (e.g. 'luna') and hang off `mc-orphan-task`. So the **session/
 *     assignment** selection now anchors on the **task** alone (covers BOTH
 *     legacy `mc-orphan-` rows AND new-model observed rows), while the
 *     **agent-deletion** step stays anchored on the `mc-orphan-` prefix so it
 *     only ever deletes the legacy ephemeral agents and CANNOT touch a real
 *     owning agent.
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
 *   - **Stuck-running reap (#955)** is the prevent-side complement to the
 *     terminal-age prune. The terminal-age prune only deletes rows that are
 *     ALREADY terminal (`ended_at` set); orphan sessions whose Stop/SessionEnd
 *     never arrived sit non-terminal forever and the prune never sees them (the
 *     1,044-zombie-tile class). The reaper drives those stuck rows terminal via
 *     `applyTransition` (so `ended_at` is stamped and invariants hold), after
 *     which the existing prune sweeps them on its normal cycle. Liveness is the
 *     latest event timestamp for the session (falling back to `started_at`);
 *     a row quiet past {@link STUCK_RUNNING_TTL_MS} is reaped. `pruneRetention`
 *     runs the reaper FIRST so reap → prune compose in a single sweep.
 *
 *   - **Windows are module constants, not config.** Minimal blast radius: no
 *     new schema on AgentConfigSchema/CortexConfigSchema. Tune here if needed.
 */

import type { Database } from "bun:sqlite";
import { ORPHAN_AGENT_PREFIX, ORPHAN_TASK_ID } from "./sessions";
import { applyTransition } from "./transitions";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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

/**
 * Stuck-running liveness TTL (ST-P3, #955). An orphan observed session that has
 * been in a NON-terminal state (`dispatched`/`running`/`blocked`) with NO event
 * activity for longer than this is presumed dead — its Stop/SessionEnd never
 * arrived, so the F-20 ingestor never auto-completed it and it would sit
 * `running` forever (the 1,044-zombie-tile class).
 *
 * 30 minutes is comfortably above any real heartbeat cadence: an instrumented
 * CC session emits hook events (PreToolUse/PostToolUse/Stop/…) far more often
 * than once every half hour, so 30min of total silence reliably means the
 * process is gone, not merely idle mid-turn. Tune here if a long-running
 * human-paced observed session ever trips it (none observed at 30min).
 *
 * Module constant, mirroring {@link ORPHAN_RETENTION_MS} / {@link
 * EVENTS_RETENTION_MS} — no new config schema, minimal blast radius.
 */
export const STUCK_RUNNING_TTL_MS = 30 * MINUTE_MS;

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

export interface StuckReapResult {
  /** Orphan assignments transitioned to terminal by the liveness reaper. */
  reaped: number;
}

export interface RetentionSummary
  extends OrphanPruneResult,
    EventsPruneResult,
    StuckReapResult {
  /** false when the prune failed (e.g. closed db) — best-effort, never throws. */
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
}

/**
 * Select the orphan assignment ids whose session is terminal beyond the
 * retention window. An assignment qualifies iff:
 *   - it hangs off the shared `mc-orphan-task` — the bookkeeping anchor for ALL
 *     auto-registered observed sessions (legacy `mc-orphan-{cc}`-agent rows AND
 *     ST-P2 real-owning-agent rows both use it). No controlled/dispatch work
 *     ever uses this task, so this single anchor is the safety guarantee, AND
 *   - it has a session whose `ended_at` is non-null and older than the cutoff,
 *     AND it has NO session that is still open (ended_at IS NULL).
 *
 * ST-P2: the prior `ag.id LIKE 'mc-orphan-%'` agent-prefix predicate is GONE
 * here — ST-P2 observed sessions attach to the REAL owning agent (e.g. 'luna'),
 * which carries no prefix, so requiring it would silently STOP pruning the
 * new-model rows (the exact regression P3↔P2 must avoid). The orphan-task anchor
 * covers both row generations. (The agent-DELETION step in `pruneOrphanSessions`
 * keeps the prefix, so a real owning agent is never deleted.)
 *
 * The "no open session" guard means a re-observed orphan (a new dispatched/
 * running session re-attached to the same assignment) is never pruned mid-turn.
 */
function selectPrunableOrphanAssignments(db: Database, cutoffIso: string): string[] {
  const rows = db
    .query(
      `SELECT ata.id AS id
         FROM agent_task_assignment ata
        WHERE ata.task_id = ?
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
    .all(ORPHAN_TASK_ID, cutoffIso) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * A stuck orphan: a non-terminal orphan assignment whose only open session has
 * gone quiet past the liveness TTL. `lastActivityIso` is the best available
 * "last seen" signal on the CURRENT schema — the latest event timestamp for the
 * session, falling back to the session's `started_at` when it has emitted no
 * events at all.
 */
interface StuckOrphan {
  assignmentId: string;
  sessionId: string;
}

/**
 * Select orphan assignments that are STUCK: in a non-terminal state
 * (`dispatched`/`running`/`blocked`), anchored on the shared orphan task (the
 * bookkeeping anchor for ALL auto-registered observed sessions — legacy AND
 * ST-P2 real-owning-agent rows), with an OPEN session (`ended_at IS NULL`) that
 * is `local.observed` and whose last activity is older than the cutoff.
 *
 * ST-P2: the prior `ag.id LIKE 'mc-orphan-%'` predicate is REPLACED. ST-P2
 * observed sessions attach to the REAL owning agent (e.g. 'luna') — requiring
 * the agent prefix would silently STOP reaping the new-model zombies (the exact
 * regression the P3 reaper must keep covering). Instead we anchor on:
 *   - `ata.task_id = mc-orphan-task` — the orphan bookkeeping task no
 *     controlled/dispatch work ever uses (the real-dispatch safety guarantee),
 *   - `s.endpoint_kind = 'local.observed'` — defense-in-depth: only observed
 *     sessions are reaped.
 * Together these can NEVER match a real dispatch assignment (which uses a real
 * task and a controlled endpoint), preserving the "never touch real dispatch"
 * guarantee while now covering BOTH legacy and new-model observed zombies.
 *
 * "Last activity" is `MAX(events.timestamp)` for the session, or — when the
 * session has emitted no events — its `started_at`. A session with ANY event
 * newer than the cutoff is alive and excluded. The open-session join means we
 * never reap an assignment whose session already ended (defense-in-depth: a
 * terminal assignment has no open session anyway).
 */
function selectStuckOrphans(db: Database, cutoffIso: string): StuckOrphan[] {
  const rows = db
    .query(
      `SELECT ata.id AS assignmentId, s.id AS sessionId
         FROM agent_task_assignment ata
         JOIN sessions s ON s.assignment_id = ata.id AND s.ended_at IS NULL
        WHERE ata.task_id = ?
          AND s.endpoint_kind = 'local.observed'
          AND ata.state IN ('dispatched', 'running', 'blocked')
          AND COALESCE(
                (SELECT MAX(e.timestamp) FROM events e WHERE e.session_id = s.id),
                s.started_at
              ) < ?`
    )
    .all(ORPHAN_TASK_ID, cutoffIso) as StuckOrphan[];
  return rows;
}

/**
 * Reap stuck-running orphan sessions (ST-P3, #955) — the zombie-tile fix.
 *
 * Orphan observed sessions are born `dispatched` and rely on the F-20 ingestor
 * to auto-complete them on Stop/SessionEnd. When those terminal events never
 * arrive (the process died, the hook stream was lost), the assignment sits in a
 * non-terminal state FOREVER and the existing terminal-age prune — which only
 * reaps rows with `ended_at` set — can never touch it. They accreted into 1,044
 * zombie tiles and regrow as the event backlog drains.
 *
 * This reaper closes the gap: any orphan assignment quiet past
 * {@link STUCK_RUNNING_TTL_MS} is driven terminal via the EXISTING transition
 * machinery (`applyTransition` with `{ type: "cancel" }` → `cancelled`), which
 * stamps `sessions.ended_at` in the same transaction. We deliberately choose
 * `cancel`/`cancelled` (not `fail`/`failed`):
 *   - `cancel` is the F-20 convention for ABANDONED work and is valid from
 *     EVERY non-terminal state (queued/dispatched/running/blocked), so one
 *     action covers every stuck row uniformly.
 *   - `cancelled` is terminal-final (no re-entry), whereas `failed` implies an
 *     error occurred and allows `principal_requeue` back to `queued` — wrong
 *     semantics for "the process just vanished".
 * Going through `applyTransition` (rather than a raw UPDATE) keeps the state
 * machine, the `ended_at` stamp, and the `state.transition` event all
 * consistent, so the row is then a normal terminal orphan that the existing
 * terminal-age prune sweeps on its next cycle.
 *
 * Each reap is its own `applyTransition` transaction (concurrency-guarded by the
 * state-in-WHERE check there). Idempotent: once cancelled, a row is no longer
 * selected. Never touches real dispatch assignments: `selectStuckOrphans`
 * double-anchors on `ata.task_id = mc-orphan-task` (the bookkeeping anchor) AND
 * `s.endpoint_kind = 'local.observed'` — NOT the `mc-orphan-` agent prefix,
 * which ST-P2 retired for new rows (#972). Nor does it touch a session with a
 * recent event (the TTL cutoff).
 */
export function reapStuckRunningOrphans(db: Database): StuckReapResult {
  const cutoffIso = new Date(Date.now() - STUCK_RUNNING_TTL_MS).toISOString();
  const stuck = selectStuckOrphans(db, cutoffIso);

  let reaped = 0;
  for (const { assignmentId, sessionId } of stuck) {
    const res = applyTransition(db, assignmentId, sessionId, { type: "cancel" });
    if (res.ok) {
      reaped += 1;
    } else {
      // A concurrent transition (e.g. a late Stop event landing the same row
      // terminal between our SELECT and our cancel) is benign — the row is
      // terminal either way. Log for visibility; never throw out of the sweep.
      process.stderr.write(
        `[mc-retention] reap skipped assignment '${assignmentId}': ${res.error}\n`
      );
    }
  }

  return { reaped };
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
 *   3. delete the now-childless LEGACY orphan agents — only those carrying the
 *      `mc-orphan-` prefix with NO remaining assignment. ST-P2 observed sessions
 *      attach to a REAL owning agent (e.g. 'luna'), which carries no prefix and
 *      is therefore NEVER deleted here — we only sweep its (now-pruned) session/
 *      assignment, leaving the real agent intact. The prefix anchor on this step
 *      is the guarantee that a real owning agent is never collateral-damaged.
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
 * Run the full retention sweep: stuck-running reap → orphan terminal-row prune
 * → events age prune.
 *
 * Ordering is load-bearing: the reaper (ST-P3) runs FIRST so zombie orphans
 * that have gone quiet past the liveness TTL are driven terminal (stamping
 * `ended_at`) before the terminal-age prune runs. A row reaped THIS cycle has
 * `ended_at = now`, so it is not yet old enough to prune — it is swept on a
 * later cycle once it ages past {@link ORPHAN_RETENTION_MS}. (The reaper fixes
 * the stuck state; the prune does the eventual deletion. Two phases, composed.)
 *
 * Best-effort: any failure (e.g. a closed db handle, a locked table) is caught
 * and reported as `ok: false` rather than thrown, so a prune failure can NEVER
 * break the host loop that calls it (the hook poller — see poller.ts wiring).
 * Each sub-step is independently transactional; the combined call is NOT
 * wrapped in an outer transaction (the steps are independent, and the events
 * prune should still run even if the reaper/orphan prune are no-ops).
 */
export function pruneRetention(db: Database): RetentionSummary {
  try {
    const stuck = reapStuckRunningOrphans(db);
    const orphans = pruneOrphanSessions(db);
    const events = pruneOldEvents(db);
    return { ok: true, ...stuck, ...orphans, ...events };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reaped: 0,
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
