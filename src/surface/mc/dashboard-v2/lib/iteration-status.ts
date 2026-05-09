/**
 * F-13 — Pure transition validator for the iteration lifecycle.
 *
 * Per Echo grove-v2#42 (Major 1) — the matrix and state vocabulary
 * are owned by `src/mission-control/lib/iteration-transitions.ts`
 * (a pure-data module with zero `db/` and zero React imports). Both
 * this validator and `db/iterations.ts` import from there, so a
 * dashboard/server matrix drift is now impossible by construction.
 * The previous "sync test" pattern was undetectable for drift; the
 * single source of truth removes the failure mode entirely.
 *
 * The functions below stay here so dashboard call sites keep their
 * import path. They are thin wrappers over the shared `TRANSITIONS`
 * map.
 *
 * Per `docs/design-mc-iteration-planning.md` Decision 1, the lifecycle
 * is Grove-owned. Source state is NEVER an input to this validator —
 * the only inputs are (current state, proposed state). Decision 5
 * specifies who triggers each transition (operator vs derived) but
 * that's policy belonging to the API layer / kanban hook; the validator
 * answers shape only.
 */

import {
  ITERATION_STATES,
  TRANSITIONS,
  type IterationState,
} from "../../lib/iteration-transitions";

/**
 * Re-export the canonical state vocabulary for dashboard call sites
 * that already imported from this module. The single source of truth
 * lives in `lib/iteration-transitions.ts`.
 */
export { ITERATION_STATES, type IterationState };

/**
 * True iff `proposed` is a legal next state from `current`.
 *
 * Returns false for:
 *   - any unknown state (defensive: future-shape strings caught here)
 *   - self-transitions (current === proposed)
 *   - any (current, proposed) pair not in the TRANSITIONS matrix
 */
export function canTransition(
  current: IterationState,
  proposed: IterationState
): boolean {
  const allowed = TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.has(proposed);
}

/**
 * Enumerate the legal next states from `current`. Order is the
 * canonical insertion order from the matrix definition above (so the
 * UI can render the operator's options deterministically).
 *
 * Returns `[]` for terminal states and unknown states — callers can
 * detect "no moves possible" with `nextStates(s).length === 0`.
 */
export function nextStates(current: IterationState): IterationState[] {
  const allowed = TRANSITIONS[current];
  if (!allowed) return [];
  return [...allowed];
}

/**
 * True for terminal states (`done`, `cancelled`). Convenience for the
 * UI to grey out cards that can't move anywhere.
 */
export function isTerminal(state: IterationState): boolean {
  return state === "done" || state === "cancelled";
}
