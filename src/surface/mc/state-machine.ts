/**
 * Grove Mission Control v2 — Assignment state machine.
 *
 * Pure function. Zero I/O, zero imports from bun:sqlite or fs.
 * The transition table encodes the design spec §3.3.
 */

import type {
  AssignmentState,
  Action,
  ActionType,
  TransitionResult,
} from "./types";

/**
 * Transition table: Map<fromState, Map<actionType, toState>>
 *
 * Cancel is allowed from any non-terminal state — added explicitly
 * to queued, dispatched, running, and blocked.
 */
const TRANSITIONS: ReadonlyMap<
  AssignmentState,
  ReadonlyMap<ActionType, AssignmentState>
> = new Map([
  [
    "queued",
    new Map<ActionType, AssignmentState>([
      ["dispatch", "dispatched"],
      ["cancel", "cancelled"],
    ]),
  ],
  [
    "dispatched",
    new Map<ActionType, AssignmentState>([
      ["start", "running"],
      ["cancel", "cancelled"],
    ]),
  ],
  [
    "running",
    new Map<ActionType, AssignmentState>([
      ["block", "blocked"],
      ["complete", "completed"],
      ["fail", "failed"],
      ["cancel", "cancelled"],
    ]),
  ],
  [
    "blocked",
    new Map<ActionType, AssignmentState>([
      ["resume", "running"],
      ["principal_requeue", "queued"],
      ["cancel", "cancelled"],
    ]),
  ],
  [
    "failed",
    new Map<ActionType, AssignmentState>([
      ["principal_requeue", "queued"],
    ]),
  ],
  // completed — terminal, no outgoing transitions
  // cancelled — terminal, no outgoing transitions
]);

export function transition(
  currentState: AssignmentState,
  action: Action
): TransitionResult {
  const stateTransitions = TRANSITIONS.get(currentState);

  if (!stateTransitions) {
    return {
      ok: false,
      error: `No transitions from terminal state '${currentState}'`,
    };
  }

  const nextState = stateTransitions.get(action.type);

  if (nextState === undefined) {
    return {
      ok: false,
      error: `Invalid transition: '${currentState}' + '${action.type}'`,
    };
  }

  // block action carries a reason; resume and principal_requeue clear it
  if (action.type === "block") {
    return { ok: true, state: nextState, blockReason: action.reason };
  }

  return { ok: true, state: nextState, blockReason: null };
}
