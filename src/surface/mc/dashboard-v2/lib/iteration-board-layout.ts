/**
 * F-14 — pure column-grouping helper for the iteration kanban surface.
 *
 * Inputs:
 *   - `iterations`: every non-cancelled iteration the server returned
 *     (`GET /api/iterations`, sorted server-side by priority + updated_at +
 *     id per F-13's `db/iterations.ts#listIterations`).
 *   - `inboxItems`: upstream-imported tasks not yet attached to any
 *     iteration (`GET /api/inbox?source=github&limit=100`, sorted server-
 *     side by `updated_at DESC, id ASC`).
 *
 * Output: a record keyed by the six visible kanban columns. Each entry is
 * a tagged union so the renderer can switch on `kind` without re-running
 * a type-narrowing query against the source arrays.
 *
 * Per `docs/design-mc-iteration-planning.md` Decision 4 the kanban shows
 * SIX columns (`inbox / designing / queued / in_flight / blocked / done`).
 * The seventh state from Decision 1, `cancelled`, is server-filtered out
 * of the iterations list (F-13 default). It is intentionally absent from
 * the layout so a sparsely-populated board doesn't push the visible
 * columns off-screen.
 *
 * Per Decision 5 inbox items live in the `inbox` column ONLY. An iteration
 * in state `inbox` would also live there — but the F-13 schema does not
 * model that case (an iteration is a Grove-owned entity created when an
 * inbox item is dragged into `designing`). The layout treats both as
 * routable to `inbox` defensively, in case a future code path inserts
 * an iteration with `state = 'inbox'`.
 *
 * Sort within a column is preserved from the input arrays — the server
 * already applies the canonical ordering per F-13 / Decision 10 Q4
 * (priority ASC → updated_at DESC). This helper intentionally never
 * re-sorts; doing so would re-introduce client-side ordering policy that
 * `lib/task-table-filter.ts` already rejects.
 */

import type { InboxItem, IterationListItem } from "../../db/iterations";

/** The six columns visible on the kanban (Decision 4). */
export const ITERATION_BOARD_COLUMNS = [
  "inbox",
  "designing",
  "queued",
  "in_flight",
  "blocked",
  "done",
] as const;

export type IterationBoardColumn = (typeof ITERATION_BOARD_COLUMNS)[number];

/**
 * Tagged union for entries within a column. The renderer uses `kind` to
 * pick its card component; the actual record (`item`) carries the data.
 */
export type ColumnEntry =
  | { kind: "inbox"; item: InboxItem }
  | { kind: "iteration"; item: IterationListItem };

export type IterationBoardLayout = Record<IterationBoardColumn, ColumnEntry[]>;

/**
 * Group iterations and inbox items into the six kanban columns.
 *
 * Empty arrays for missing columns — the renderer always sees the full
 * column shape and can render a per-column empty-state without checking
 * for `undefined`.
 */
export function buildIterationBoardLayout(
  iterations: readonly IterationListItem[],
  inboxItems: readonly InboxItem[]
): IterationBoardLayout {
  const layout: IterationBoardLayout = {
    inbox: [],
    designing: [],
    queued: [],
    in_flight: [],
    blocked: [],
    done: [],
  };

  // Inbox items always land in the `inbox` column. Server already applied
  // the most-recent-first ordering — preserve it.
  for (const item of inboxItems) {
    layout.inbox.push({ kind: "inbox", item });
  }

  // Iterations route by `state`. Only the six visible states land in the
  // layout; `cancelled` (and any future state we don't render) is dropped
  // defensively. The server already filters `cancelled` out by default,
  // so this is belt-and-braces.
  for (const item of iterations) {
    if (isBoardColumn(item.state)) {
      layout[item.state].push({ kind: "iteration", item });
    }
  }

  return layout;
}

/**
 * Type guard — true when `state` is one of the six visible columns.
 *
 * Exported so the drop-target code can reuse it without re-importing the
 * column tuple.
 */
export function isBoardColumn(state: string): state is IterationBoardColumn {
  // O(6) linear scan — fine; this function is hot in the drag path but
  // 6 string compares is faster than the Set construction overhead.
  for (const c of ITERATION_BOARD_COLUMNS) {
    if (c === state) return true;
  }
  return false;
}
