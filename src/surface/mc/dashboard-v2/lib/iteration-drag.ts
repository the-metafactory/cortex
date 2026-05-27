/**
 * F-14 — pure drop-target validator for the iteration kanban.
 *
 * Resolves "is this drop legal?" for every (sourceKind, sourceState,
 * targetState) triple that the kanban can produce while a card is being
 * dragged. Defers to F-13's `lib/iteration-status.ts#canTransition` for
 * the iteration → iteration case — single source of truth for the
 * Grove-owned lifecycle (Decision 1).
 *
 * Per `docs/design-mc-iteration-planning.md` Decision 5:
 *   - inbox card  → ONLY `designing` is a legal drop. Anywhere else
 *                   (including `inbox` itself) is rejected.
 *   - iteration   → any state per `canTransition(current, target)`. The
 *                   kanban does not render `cancelled` as a drop column
 *                   so that move happens via a different affordance
 *                   (F-15 button), but the validator does not enforce
 *                   that — the layout layer is what hides the column.
 *
 * Returns `{ allowed, reason? }` rather than a bare boolean so the
 * renderer can surface the rejection reason as a tooltip on the
 * disallowed column during the drag (principal gets feedback, not a
 * silent no-op cursor).
 */

import {
  canTransition,
  type IterationState,
} from "./iteration-status";
import type { IterationBoardColumn } from "./iteration-board-layout";

export type DragSourceKind = "inbox" | "iteration";

export interface DropDecision {
  allowed: boolean;
  /** Human-readable rejection reason — surfaced as the drop-target tooltip. */
  reason?: string;
}

/**
 * Decide whether a drag from `(sourceKind, sourceState)` may legally
 * land on `targetState`.
 *
 * For `sourceKind === 'inbox'`, `sourceState` is conceptually `null`
 * (an inbox item is not in the iteration lifecycle). The signature
 * accepts `IterationState | null` so callers don't have to fudge a fake
 * source state.
 */
export function canDrop(
  sourceKind: DragSourceKind,
  sourceState: IterationState | null,
  targetState: IterationBoardColumn
): DropDecision {
  if (sourceKind === "inbox") {
    // Per Decision 5: inbox cards may only flow into `designing`. The
    // gesture creates a new iteration around the inbox item.
    if (targetState === "designing") {
      return { allowed: true };
    }
    if (targetState === "inbox") {
      // Self-drop on the same column — coalesce to no-op rather than
      // surface a "no" message; the principal's intent is unambiguous.
      // Wording matches the iteration-side self-drop branch below.
      return { allowed: false, reason: "Already in this column" };
    }
    return {
      allowed: false,
      reason: "Inbox items can only be dragged into designing",
    };
  }

  // sourceKind === 'iteration'
  if (sourceState === null) {
    // Iteration with no current state — treat as ineligible. Defensive:
    // the F-13 schema ALWAYS persists a state, so this branch indicates
    // a programming error in the renderer rather than a principal action.
    return { allowed: false, reason: "Iteration has no current state" };
  }

  if (sourceState === targetState) {
    // Drop on the same column — coalesce to no-op. Mirrors
    // `canTransition`'s rejection of self-transitions.
    return { allowed: false, reason: "Already in this column" };
  }

  if (canTransition(sourceState, targetState)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Cannot move from ${sourceState} to ${targetState}`,
  };
}
