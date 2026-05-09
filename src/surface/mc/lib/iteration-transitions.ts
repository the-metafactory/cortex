/**
 * F-15 sweep — Single source of truth for the iteration lifecycle matrix.
 *
 * Per Echo grove-v2#42 (Major 1): the transition matrix lived in TWO
 * independent copies (`db/iterations.ts#SERVER_TRANSITIONS` and
 * `dashboard-v2/lib/iteration-status.ts#TRANSITIONS`) with a self-test
 * masquerading as a sync test (compared against a third local literal).
 * Drift between the two real matrices was undetectable.
 *
 * Resolution: extract the matrix + state vocabulary to this pure-data
 * module. Both sides import from here. The "sync test" deletes — there
 * is nothing to sync because there is only one matrix.
 *
 * IMPORTANT: this module MUST stay free of `db/` imports (no `bun:sqlite`,
 * no `Database`) so the dashboard bundle can consume it without dragging
 * SQL into the browser. It also MUST stay free of React imports so the
 * server-side test target can import it without a DOM. Pure data only.
 *
 * Per `docs/design-mc-iteration-planning.md` Decision 1, the lifecycle
 * is Grove-owned. Source state is NEVER an input to the validator —
 * the only inputs are (current state, proposed state). Decision 5
 * specifies who triggers each transition (operator vs derived) but
 * that's policy belonging to the API layer / kanban hook; the matrix
 * answers shape only.
 *
 * Decision 10 Q1 is intentionally NOT foreclosed here: `* → done` is
 * legal from any non-terminal state in the matrix below. v1 expects
 * those to fire via derivation (all tasks terminal AND source closed),
 * but Phase G's "operator-driven done with open tasks" override is
 * possible without expanding this matrix.
 */

/**
 * The seven Grove-normalised iteration states (Decision 1).
 *
 * Canonical here. Re-exported from `db/iterations.ts` (the SQL CHECK
 * source) and from `dashboard-v2/lib/iteration-status.ts` (the UI/
 * validator source) for backwards compatibility with existing imports.
 */
export const ITERATION_STATES = [
  "inbox",
  "designing",
  "queued",
  "in_flight",
  "blocked",
  "done",
  "cancelled",
] as const;

export type IterationState = (typeof ITERATION_STATES)[number];

/**
 * Per-state legal-next-state set.
 *
 * Cells reflect Decision 5's movement rules:
 *   inbox      → designing                   (operator drag)
 *              → cancelled                   (operator)
 *   designing  → queued                      (operator promote)
 *              → cancelled                   (operator)
 *              → inbox                       (operator drag back — "send back to inbox")
 *   queued     → in_flight                   (derived: any task assignment becomes active)
 *              → designing                   (operator demote — fix scope before any work starts)
 *              → cancelled                   (operator)
 *   in_flight  → blocked                     (derived: any assignment hits blocked)
 *              → done                        (derived: all tasks terminal AND source closed)
 *              → cancelled                   (operator)
 *   blocked    → in_flight                   (derived: assignment unblocked)
 *              → done                        (derived: same as above; blocked is a sub-shape of in_flight)
 *              → cancelled                   (operator)
 *   done       → (terminal — no transitions out)
 *   cancelled  → (terminal — no transitions out)
 *
 * Self-transition (current === proposed) is treated as a no-op and is
 * REJECTED — `canTransition('inbox', 'inbox')` returns false. The
 * validator's job is to gate movement; an idempotent re-write to the
 * same state does not need to pass through the gate.
 *
 * Adding a state? Update the matrix AND the
 * `iteration-status.test.ts#every cell` matrix test.
 */
export const TRANSITIONS: Record<IterationState, ReadonlySet<IterationState>> = {
  inbox: new Set<IterationState>(["designing", "cancelled"]),
  designing: new Set<IterationState>(["inbox", "queued", "cancelled"]),
  queued: new Set<IterationState>(["designing", "in_flight", "cancelled"]),
  in_flight: new Set<IterationState>(["blocked", "done", "cancelled"]),
  blocked: new Set<IterationState>(["in_flight", "done", "cancelled"]),
  done: new Set<IterationState>(),
  cancelled: new Set<IterationState>(),
};
