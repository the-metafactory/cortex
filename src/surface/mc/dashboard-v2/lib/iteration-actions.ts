/**
 * F-15 — pure enablement matrix for the iteration detail surface's
 * action buttons (Promote / Cancel iteration / edit affordances).
 *
 * Same idiom as `lib/curation-enablement.ts` — a flat per-state cell
 * map with a couple of thin lookup helpers, zero React / DOM coupling
 * — so the matrix can be unit-tested in isolation and the React
 * iteration-detail component is a thin renderer over the result.
 *
 * Per `docs/design-mc-iteration-planning.md`:
 *   - Decision 5: `designing → queued` is the "Promote" action; only
 *     visible when state is `designing`. (Promote is the operator-
 *     driven transition; the kanban can also drag-drop it, but the
 *     detail surface is the canonical click-button path.)
 *   - Decision 5: `* → cancelled` is the explicit destructive path.
 *     Visible from any non-terminal state.
 *   - Decision 9: edit affordances (title / body / priority) are
 *     enabled only on non-terminal iterations. Editing a `done` /
 *     `cancelled` iteration's body would be confusing — the audit
 *     trail has snapshot semantics on terminal rows.
 *   - Decision 10 Q1: `* → done` from non-{in_flight,blocked} is
 *     deferred to Phase G. The detail surface offers no "Mark done"
 *     button; the only way to complete an iteration in v1 is through
 *     the derivation path (all tasks terminal AND source closed,
 *     wired in F-17). This matrix is what enforces that visually.
 */

import type { IterationState } from "./iteration-status";

export type IterationActionVerb =
  | "promote"
  | "cancel"
  | "edit"
  | "addTask"
  | "detachTask";

/** Per-action enablement map. */
export interface IterationActionMatrix {
  /** Move iteration `designing → queued`. Visible only in `designing`. */
  promote: boolean;
  /** Move iteration `* → cancelled`. Visible only on non-terminal rows. */
  cancel: boolean;
  /** Edit title / body / priority. Disabled on terminal rows. */
  edit: boolean;
  /** Open the "+ Add task" affordance. Disabled on terminal rows. */
  addTask: boolean;
  /**
   * Detach an attached task. Same gate as edit — terminal iterations
   * are read-only. (A `done` iteration that lost a task post-hoc
   * would leak into the kanban as `done` with `task_count = 0`,
   * which is fine to display but bad to actively edit.)
   */
  detachTask: boolean;
}

const TERMINAL_STATES: ReadonlySet<IterationState> = new Set([
  "done",
  "cancelled",
]);

/**
 * Resolve the action matrix for a given iteration state.
 *
 * Guarantees:
 *   - Every key is always present (Boolean false rather than `undefined`)
 *     so the React renderer can dereference unconditionally.
 *   - Unknown / null state collapses to "everything disabled" — the
 *     detail header pill renders the raw state but the buttons stay
 *     greyed; matches the loading-state idiom from
 *     `curationMatrixFor(undefined)`.
 */
export function iterationActionMatrix(
  state: IterationState | null | undefined
): IterationActionMatrix {
  if (!state) {
    return {
      promote: false,
      cancel: false,
      edit: false,
      addTask: false,
      detachTask: false,
    };
  }
  const terminal = TERMINAL_STATES.has(state);
  return {
    // Decision 5 — Promote is `designing → queued` only.
    promote: state === "designing",
    // Decision 5 — Cancel is the universal destructive path; visible
    // on every non-terminal row.
    cancel: !terminal,
    // Decisions 1 / 9 — terminal rows are snapshot-immutable.
    edit: !terminal,
    addTask: !terminal,
    detachTask: !terminal,
  };
}

/** Tooltip text for a disabled action; "" when enabled. */
export function disabledTooltip(
  state: IterationState | null | undefined,
  verb: IterationActionVerb
): string {
  if (!state) return "Loading iteration…";
  const matrix = iterationActionMatrix(state);
  if (matrix[verb]) return "";
  // The user-visible reason for each disabled cell. Operator learns the
  // model from the tooltip without reading the spec.
  switch (verb) {
    case "promote":
      return state === "queued" || state === "in_flight" || state === "blocked"
        ? "Already promoted; the iteration is past designing"
        : state === "inbox"
          ? "Promote requires designing first — drag this card to Designing on the kanban"
          : `Iteration is in terminal state '${state}'; cannot promote`;
    case "cancel":
      return `Iteration is already in terminal state '${state}'`;
    case "edit":
      return `Iteration is in terminal state '${state}' — body and title are snapshots`;
    case "addTask":
      return `Iteration is in terminal state '${state}' — task list is frozen`;
    case "detachTask":
      return `Iteration is in terminal state '${state}' — task list is frozen`;
  }
}

/** Short human label for each verb (button text). */
export function labelForAction(verb: IterationActionVerb): string {
  switch (verb) {
    case "promote":
      return "Promote";
    case "cancel":
      return "Cancel iteration";
    case "edit":
      return "Edit";
    case "addTask":
      return "Add task";
    case "detachTask":
      return "Detach";
  }
}

/** Verbs that the operator marks as destructive (red CSS treatment). */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<IterationActionVerb> = new Set([
  "cancel",
  "detachTask",
]);
