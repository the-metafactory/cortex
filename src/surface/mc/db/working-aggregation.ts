/**
 * CK-4a / #1295 — cross-stack WORKING aggregation (LOCAL read model).
 *
 * The data half of the cockpit's cross-stack WORKING lane. `workingTileKey`
 * React-key namespacing was never a data model; this projects a SCHEMA-level
 * rollup keyed on `sessions.origin_stack_id` (decision D-8), aggregating the
 * principal's OWN stacks — the sessions a single (aggregating, #1008 MC-DB)
 * daemon can already see — into per-origin WORKING metadata.
 *
 * ── SCOPE BOUNDARY (CK-4a — stated once, enforced by shape) ──────────────────
 * WORKING tile METADATA — state, counts, origin, timestamps — aggregates across
 * the principal's own stacks (this module). Dispatch (spawn) and SESSION-interior
 * drill stay LOCAL-only per ADR-0005 / #989 / #1008: this rollup NEVER carries a
 * session id, prompt, tool call, diff, or any other interior — only counts and a
 * provider-retry hint. A federated PEER's rows (a non-null `originStackId` that is
 * not this daemon's own stack) therefore yield the SAME metadata-only shape as a
 * local origin — an aggregate tile, never a drillable interior. That invariant is
 * the local mirror of the worker's `DashboardSnapshot` no-interiors guard
 * (worker/src/routes/state.ts + its dashboard-snapshot-contract test): this read
 * flows THROUGH that same metadata-only discipline, never beside it. The shape is
 * pinned by `__tests__/working-aggregation.test.ts` (allow-list of keys).
 *
 * ── Provider-retry is LOCAL-only ─────────────────────────────────────────────
 * `providerRetry` is sourced from `agent_task_assignment.retry_after_ms` — the
 * dispatch lifecycle's `not_now { retry_after_ms }` back-pressure. That lifecycle
 * never crosses the federation boundary (dispatch stays local), so the D1 / cloud
 * projection (worker `DashboardSnapshot.workingAggregation`) carries the same
 * typed field but always `null`; only THIS local read model populates it.
 */

import type { Database } from "bun:sqlite";

/**
 * Provider back-pressure status for a stack's WORKING lane. Metadata ONLY — a
 * semantic state tag + a delay in ms; never an interior.
 */
export interface ProviderRetryStatus {
  /** The dispatch lifecycle's back-pressure state. `not_now` ⇒ rate/capacity exhausted. */
  state: "not_now";
  /** Earliest-retry delay in ms (the soonest across the stack's pending assignments). */
  retryAfterMs: number;
}

/**
 * One origin-stack's WORKING rollup — pure lifecycle METADATA (see the scope
 * boundary above). Byte-shape-mirrored (not imported — separate bundle boundary,
 * per lib/session-tree.ts) by the worker's `WorkingOriginRollup` in
 * worker/src/routes/state.ts; the two are kept congruent by their respective
 * shape guards. The local copy additionally POPULATES `providerRetry` (local-only).
 */
export interface WorkingStackAggregate {
  /**
   * The stack these WORKING sessions originated on. `null` ⇒ own/local-stack
   * origin (the pre-CK-4a / single-stack case, or a session-less pending
   * dispatch on this daemon). A non-null value that is not this daemon's own
   * stack is a federated PEER — still metadata-only here.
   */
  originStackId: string | null;
  /** Count of active (non-terminal, working-state) sessions on this origin stack. */
  activeSessionCount: number;
  /**
   * Of those active sessions, how many are SUB-AGENTS — i.e. carry a
   * `parent_session_id` (the substrate-projection edge; CONTEXT.md §Session tree).
   */
  subAgentCount: number;
  /** Provider back-pressure across this origin's assignments; `null` ⇒ none pending. */
  providerRetry: ProviderRetryStatus | null;
}

/** The three assignment states that qualify a session as "working" (mirrors working-agents.ts). */
const WORKING_STATES = "('running','dispatched','queued')";

/** The assignment states a pending provider-retry can sit in (pre-terminal). */
const RETRYABLE_STATES = "('queued','dispatched','running','blocked')";

interface MetaRow {
  origin: string | null;
  // COUNT(*) and SUM(CASE …) over a GROUP BY group are always non-null numbers.
  active: number;
  subagents: number;
}

interface RetryRow {
  origin: string | null;
  // MIN() is null only if every value in the group is null; the WHERE clause
  // excludes null retry_after_ms, so returned groups are non-null — but kept
  // nullable + guarded defensively against the empty-group edge.
  soonest: number | null;
}

/**
 * Aggregate the principal's own stacks into per-origin WORKING metadata.
 *
 * "Active" matches the WORKING grid partition exactly: a session that is itself
 * open (`sessions.ended_at IS NULL`) AND whose owning assignment is in a working
 * state (running/dispatched/queued) — the same partition `listWorkingAgents`
 * qualifies a tile on. Sub-agent counts derive from `parent_session_id`.
 *
 * `providerRetry` folds `agent_task_assignment.retry_after_ms` per origin. A
 * pending-retry assignment that has NOT spawned a session yet (session-less,
 * pre-spawn) has no session-borne origin, so it attributes to the `null`
 * (own/local) bucket via the LEFT JOIN — an honest "a local dispatch is waiting
 * on the provider", never fabricated against a peer.
 *
 * Deterministic order: the `null` (own/local) origin first, then origin id ASC.
 */
export function listWorkingAggregation(db: Database): WorkingStackAggregate[] {
  const metaRows = db
    .query(
      `SELECT s.origin_stack_id AS origin,
              COUNT(*) AS active,
              SUM(CASE WHEN s.parent_session_id IS NOT NULL THEN 1 ELSE 0 END) AS subagents
       FROM sessions s
       JOIN agent_task_assignment a ON a.id = s.assignment_id
       WHERE s.ended_at IS NULL
         AND a.state IN ${WORKING_STATES}
       GROUP BY s.origin_stack_id`
    )
    .all() as MetaRow[];

  const retryRows = db
    .query(
      `SELECT s.origin_stack_id AS origin,
              MIN(a.retry_after_ms) AS soonest
       FROM agent_task_assignment a
       LEFT JOIN sessions s
         ON s.assignment_id = a.id AND s.ended_at IS NULL
       WHERE a.retry_after_ms IS NOT NULL
         AND a.state IN ${RETRYABLE_STATES}
       GROUP BY s.origin_stack_id`
    )
    .all() as RetryRow[];

  // Merge the two folds on the shared origin key. Every origin that appears in
  // EITHER fold gets a tile — an origin with only a pending retry (no active
  // session yet) is honest WORKING state, and one with only sessions has a null
  // retry.
  const byOrigin = new Map<string | null, WorkingStackAggregate>();

  const ensure = (origin: string | null): WorkingStackAggregate => {
    let agg = byOrigin.get(origin);
    if (!agg) {
      agg = { originStackId: origin, activeSessionCount: 0, subAgentCount: 0, providerRetry: null };
      byOrigin.set(origin, agg);
    }
    return agg;
  };

  for (const r of metaRows) {
    const agg = ensure(r.origin);
    agg.activeSessionCount = r.active;
    agg.subAgentCount = r.subagents;
  }

  for (const r of retryRows) {
    if (r.soonest == null) continue;
    const agg = ensure(r.origin);
    agg.providerRetry = { state: "not_now", retryAfterMs: r.soonest };
  }

  return [...byOrigin.values()].sort((a, b) => {
    // null (own/local) origin sorts first; then origin id ascending.
    if (a.originStackId === b.originStackId) return 0;
    if (a.originStackId === null) return -1;
    if (b.originStackId === null) return 1;
    return a.originStackId < b.originStackId ? -1 : 1;
  });
}
