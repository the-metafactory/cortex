/**
 * F-12 curation toolbar — pure per-state enablement matrix.
 *
 * Mirrors `CURATION_MATRIX` in the legacy monolith (`dashboard/index.html`
 * lines ~3483-3526) one-for-one. The matrix is the design-doc's
 * Decision 3 (`docs/design-mc-f12-task-curation.md`); see that file for
 * the why behind each cell. This module is what the React toolbar reads.
 *
 * "Pure function of `assignment.state`" is the F-12 invariant — the UI
 * never duplicates the state-machine's TRANSITIONS table; the matrix is
 * derived from it (with one extension for the abandon-from-completed
 * "abandon-the-task" cell that has no state-machine equivalent).
 */

import type { AssignmentState } from "../../types";

export type CurationVerb = "dispatch" | "requeue" | "handoff" | "abandon";

/**
 * One cell value: `true` = enabled, `string` = disabled with this tooltip.
 *
 * The string form is what the legacy uses for `button.title` — principals
 * learn the model from the disabled tooltip without reading docs (legacy
 * comment, dashboard/index.html:3479).
 */
export type CurationCell = true | string;

export type CurationMatrix = Record<CurationVerb, CurationCell>;

/**
 * Per-state enablement table — the source of truth for which buttons
 * render enabled or disabled-with-tooltip in the F-12 toolbar.
 *
 * Edit alongside the legacy monolith table; the two are pinned to the
 * same Decision 3 matrix.
 */
const CURATION_MATRIX_BY_STATE: Record<AssignmentState, CurationMatrix> = {
  queued: {
    dispatch: "Already dispatched — Dispatch reruns from terminal states",
    requeue: "Already queued — nothing to requeue",
    handoff: true,
    abandon: true,
  },
  dispatched: {
    dispatch: "Already dispatched — Dispatch reruns from terminal states",
    requeue: "Already running — nothing to requeue",
    handoff: true,
    abandon: true,
  },
  running: {
    dispatch: "Already running — Dispatch reruns from terminal states",
    requeue: "Already running — nothing to requeue",
    handoff: true,
    abandon: true,
  },
  blocked: {
    dispatch: "Already running — Dispatch reruns from terminal states",
    requeue: true,
    handoff: true,
    abandon: true,
  },
  failed: {
    dispatch: true, // creates a fresh assignment row
    requeue: true,
    handoff: true, // new-assignment-only per Decision 6
    abandon: true,
  },
  completed: {
    dispatch: true, // re-run on the same task
    requeue: "Rerun via Dispatch creates a fresh assignment",
    handoff: "Task already done — nothing to hand off",
    abandon: true, // principal may close out the task even from completed
  },
  cancelled: {
    dispatch: "Already cancelled — terminal",
    requeue: "Already cancelled — terminal",
    handoff: "Already cancelled — terminal",
    abandon: "Already cancelled",
  },
};

/**
 * Look up the enablement matrix for a given assignment state.
 * Falls back to a "everything disabled" row for unknown states so the
 * UI never crashes on a future-shape state.
 */
export function curationMatrixFor(state: AssignmentState | null | undefined): CurationMatrix {
  if (!state) {
    return {
      dispatch: "Loading assignment…",
      requeue: "Loading assignment…",
      handoff: "Loading assignment…",
      abandon: "Loading assignment…",
    };
  }
  return CURATION_MATRIX_BY_STATE[state] ?? {
    dispatch: `Unknown state: ${state}`,
    requeue: `Unknown state: ${state}`,
    handoff: `Unknown state: ${state}`,
    abandon: `Unknown state: ${state}`,
  };
}

/** True when the verb is enabled for the given state. */
export function isEnabled(state: AssignmentState | null | undefined, verb: CurationVerb): boolean {
  return curationMatrixFor(state)[verb] === true;
}

/** Tooltip text for a disabled cell, or `""` when enabled. */
export function disabledTooltip(state: AssignmentState | null | undefined, verb: CurationVerb): string {
  const cell = curationMatrixFor(state)[verb];
  return typeof cell === "string" ? cell : "";
}

/**
 * Per F-12 Decision 5, "Abandon" routes to a different endpoint
 * depending on whether there's a non-terminal assignment in flight.
 *
 *  - Active assignment present → cancel the assignment via
 *    `POST /api/assignments/:id/abandon` (targetKind = "assignment")
 *  - Otherwise (terminal/completed) → cancel the task via
 *    `POST /api/tasks/:taskId/abandon` (targetKind = "task")
 *
 * Pure helper — the toolbar uses it to render the prompt copy
 * ("Cancel this assignment?" vs "Cancel this task?").
 */
export type AbandonTargetKind = "assignment" | "task";

const TERMINAL_STATES: ReadonlySet<AssignmentState> = new Set([
  "completed", "failed", "cancelled",
]);

export function abandonTargetKind(state: AssignmentState | null | undefined): AbandonTargetKind {
  if (!state) return "assignment";
  return TERMINAL_STATES.has(state) ? "task" : "assignment";
}

/** Verbs that require a confirmation panel (F-12 Decision 8). */
export const VERBS_REQUIRING_CONFIRM: ReadonlySet<CurationVerb> = new Set([
  "abandon", "handoff",
]);

/** Verbs that the principal marks as destructive (gets red CSS treatment). */
export const DESTRUCTIVE_VERBS: ReadonlySet<CurationVerb> = new Set([
  "abandon", "handoff",
]);

export function labelForVerb(verb: CurationVerb): string {
  switch (verb) {
    case "dispatch": return "Dispatch";
    case "requeue": return "Requeue";
    case "handoff": return "Hand off";
    case "abandon": return "Abandon";
  }
}
