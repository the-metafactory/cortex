/**
 * Grove Mission Control v3 — shared "most-recent session per assignment"
 * helpers.
 *
 * Per Echo's PR #57 review: `db/assignments.ts` (focus-area / drill-down)
 * and `db/tasks.ts` (task table / F-20.F session denorm) both surface
 * the most-recent session for an assignment via the same shape of
 * correlated-subquery + LEFT JOIN. Three diverged copies (two in
 * tasks.ts, one in assignments.ts) with one already using a different
 * tiebreak shipped — same-second insert ties resolved differently
 * across `/api/tasks` and `/api/assignments`, feeding the drill-down
 * inconsistent state across surfaces. This module is the single
 * source of truth.
 *
 * Tiebreak: `started_at DESC, id DESC`. `started_at` defaults to
 * `datetime('now')` (1-second granularity) and the id is monotonic
 * (`generateId` in `db/events.ts` is time-sortable per writer), so
 * the id break stays consistent with insertion order. A future
 * sub-second `started_at` migration would render the id break
 * redundant — keep the order anyway as defensive determinism.
 */

import type { EndpointKind } from "../types";
import { normalizeSqliteDatetime } from "./datetime";

/**
 * SQL fragment for a LEFT JOIN that resolves to the most-recent session
 * row for the assignment aliased `a` in the surrounding query. Yields
 * the four columns `hydrateSession` expects:
 * `session_id`, `session_endpoint_kind`, `session_started_at`,
 * `session_ended_at`.
 *
 * Use as: `${MOST_RECENT_SESSION_LEFT_JOIN("a")}` after the JOINs your
 * query already has, before the WHERE.
 */
export function mostRecentSessionLeftJoin(assignmentAlias: string): string {
  return `LEFT JOIN sessions s ON s.id = (
    SELECT id FROM sessions
    WHERE assignment_id = ${assignmentAlias}.id
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  )`;
}

/**
 * Column projections for the SELECT clause that pair with
 * `mostRecentSessionLeftJoin`. Use as: `${MOST_RECENT_SESSION_COLUMNS}`
 * inside the SELECT list.
 */
export const MOST_RECENT_SESSION_COLUMNS = `
  s.id            AS session_id,
  s.endpoint_kind AS session_endpoint_kind,
  s.started_at    AS session_started_at,
  s.ended_at      AS session_ended_at
`;

/** Row shape produced by `MOST_RECENT_SESSION_COLUMNS`. */
export interface SessionDenormRow {
  session_id: string | null;
  session_endpoint_kind: string | null;
  session_started_at: string | null;
  session_ended_at: string | null;
}

/**
 * Hydrate a `SessionDenormRow` into the wire-shape session denorm shared
 * by `AssignmentListItem.session` and `TaskAssignmentRow.session`.
 *
 * Returns null when the LEFT JOIN missed (no session row for the
 * assignment yet). The early return narrows TS so the remaining
 * `session_*` columns can be unwrapped without `!` non-null asserts —
 * the schema's NOT-NULL constraints on `endpoint_kind` / `started_at`
 * are real, but pinning that invariant at the type level beats trusting
 * an invisible runtime guarantee.
 */
export function hydrateSession(
  row: SessionDenormRow
): {
  id: string;
  endpoint_kind: EndpointKind;
  started_at: string;
  ended_at: string | null;
} | null {
  if (row.session_id === null) return null;
  // After the guard, the schema's NOT-NULL constraints on
  // `endpoint_kind` and `started_at` plus the FK make the remaining
  // columns non-null too. Defensive fallbacks would mask a corrupt
  // schema rather than fix it.
  if (row.session_endpoint_kind === null || row.session_started_at === null) {
    throw new Error(
      `corrupt session row: id=${row.session_id} but endpoint_kind/started_at is null`
    );
  }
  return {
    id: row.session_id,
    endpoint_kind: row.session_endpoint_kind as EndpointKind,
    started_at: normalizeSqliteDatetime(row.session_started_at),
    ended_at: row.session_ended_at
      ? normalizeSqliteDatetime(row.session_ended_at)
      : null,
  };
}
