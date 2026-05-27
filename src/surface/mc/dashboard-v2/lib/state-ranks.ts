/**
 * Assignment-state attention ranks.
 *
 * Mirrors `STATE_RANKS` in `src/mission-control/db/tasks.ts` (the F-8
 * Decision 4 source of truth). Lower = more principal attention.
 *
 * Used by:
 *  - F-8 task table (MIG-4): aggregate-state computation client-side
 *    sort fallback.
 *  - F-9 working-agent grid (MIG-5): tile-rank ordering (excluding
 *    blocked, which sits at rank 0 server-side but is filtered out of
 *    the grid because it's already in F-6).
 *  - F-7 drill-down "primary active" tie-break (MIG-3).
 *
 * Kept here as a TS constant rather than fetched from the server: the
 * order rarely changes, and a single source of truth lives in the
 * backend's `STATE_RANKS`. If they ever diverge the F-8 cross-rank
 * test in `__tests__/tasks.test.ts` catches the backend side; a unit
 * test in this app catches the dashboard side.
 */

import type { AssignmentState } from "../../types";

export const STATE_RANKS: readonly AssignmentState[] = [
  "blocked",
  "running",
  "dispatched",
  "queued",
  "failed",
  "completed",
  "cancelled",
];

/**
 * Convenience map: state → rank. Useful for sorters that need numeric
 * comparison rather than index lookup.
 */
export const STATE_RANK_BY_STATE: Readonly<Record<AssignmentState, number>> = Object.freeze(
  Object.fromEntries(STATE_RANKS.map((s, i) => [s, i])) as Record<AssignmentState, number>
);

export function rankOf(state: AssignmentState): number {
  return STATE_RANK_BY_STATE[state] ?? STATE_RANKS.length;
}
