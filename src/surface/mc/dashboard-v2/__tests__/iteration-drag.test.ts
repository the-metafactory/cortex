/**
 * F-14 — pure drop-target validator tests.
 *
 * Pins every (sourceKind × sourceState × targetState) cell of the drag
 * matrix. Reuses `ITERATION_STATES` from the validator so a future
 * lifecycle change forces the test to update in lock-step (this matches
 * the discipline of `iteration-status.test.ts`).
 *
 * Two layers of coverage:
 *   1. Inbox-source matrix: 6 target columns × 1 source state (null).
 *      Only `designing` is allowed.
 *   2. Iteration-source matrix: every (current × proposed) cell from
 *      `iteration-status.ts` cross-checked against `canTransition`.
 */

import { describe, it, expect } from "bun:test";
import { canDrop, type DragSourceKind } from "../lib/iteration-drag";
import {
  ITERATION_BOARD_COLUMNS,
  type IterationBoardColumn,
} from "../lib/iteration-board-layout";
import {
  canTransition,
  ITERATION_STATES,
  type IterationState,
} from "../lib/iteration-status";

describe("canDrop — inbox source", () => {
  // Per Decision 5: inbox cards may only flow into `designing`.
  for (const col of ITERATION_BOARD_COLUMNS) {
    if (col === "designing") {
      it(`allows inbox → ${col} (the create-iteration gesture)`, () => {
        const d = canDrop("inbox", null, col);
        expect(d.allowed).toBe(true);
      });
    } else {
      it(`rejects inbox → ${col} with a tooltip-suitable reason`, () => {
        const d = canDrop("inbox", null, col);
        expect(d.allowed).toBe(false);
        expect(typeof d.reason).toBe("string");
        expect(d.reason!.length).toBeGreaterThan(0);
      });
    }
  }

  it("rejects inbox → inbox with an `Already in this column` reason (self-drop coalesce, wording matches iteration self-drop)", () => {
    const d = canDrop("inbox", null, "inbox");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("Already in this column");
  });

  it("ignores any non-null sourceState for inbox kind (kind dominates)", () => {
    // If a programming error supplies a sourceState while sourceKind is
    // 'inbox', the validator must ignore it — the kind is the source of
    // truth for the gesture, not the state.
    for (const s of ITERATION_STATES) {
      const d = canDrop("inbox", s, "designing");
      expect(d.allowed).toBe(true);
    }
  });
});

describe("canDrop — iteration source, every (current × proposed) cell", () => {
  // Cross-check: for every (current, proposed) cell where current and
  // proposed are both visible board columns, canDrop should agree with
  // canTransition.
  for (const current of ITERATION_STATES) {
    for (const proposed of ITERATION_BOARD_COLUMNS) {
      const isSelf = current === proposed;
      const ctAllowed = canTransition(current, proposed);
      const expected = !isSelf && ctAllowed;
      it(`iteration ${current} → ${proposed}: allowed=${expected}`, () => {
        const d = canDrop("iteration", current, proposed);
        expect(d.allowed).toBe(expected);
        if (!expected) {
          expect(typeof d.reason).toBe("string");
          expect(d.reason!.length).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe("canDrop — iteration source, defensive cases", () => {
  it("rejects when sourceState is null (programming error guard)", () => {
    const d = canDrop("iteration", null, "designing");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("Iteration has no current state");
  });

  it("rejects self-drop with an `Already in this column` reason (per visible column)", () => {
    for (const col of ITERATION_BOARD_COLUMNS) {
      const d = canDrop("iteration", col as IterationState, col);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("Already in this column");
    }
  });

  it("terminal `done` source rejects every visible target column", () => {
    // `done` is terminal in iteration-status; nothing can move out.
    for (const col of ITERATION_BOARD_COLUMNS) {
      const d = canDrop("iteration", "done", col);
      expect(d.allowed).toBe(false);
    }
  });

  it("rejection reasons are tooltip-suitable (non-empty strings)", () => {
    // Spot-check a couple of representative rejections.
    expect(canDrop("iteration", "inbox", "queued").reason).toMatch(
      /Cannot move from inbox to queued/
    );
    expect(canDrop("iteration", "designing", "in_flight").reason).toMatch(
      /Cannot move from designing to in_flight/
    );
    expect(canDrop("iteration", "blocked", "queued").reason).toMatch(
      /Cannot move from blocked to queued/
    );
  });
});

describe("canDrop — type-shape sanity", () => {
  it("accepts both DragSourceKind values without throwing", () => {
    const kinds: DragSourceKind[] = ["inbox", "iteration"];
    for (const k of kinds) {
      // Should not throw on any valid input combination.
      const d = canDrop(k, k === "inbox" ? null : "designing", "queued");
      expect(typeof d.allowed).toBe("boolean");
    }
  });
});
