/**
 * F-15 — pure-helper tests for `lib/iteration-actions.ts`.
 *
 * Walks every (state × verb) cell so a future change in the matrix
 * (e.g. Phase G principal-driven done) cannot land silently. Mirrors
 * the matrix-coverage style from `iteration-status.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  DESTRUCTIVE_ACTIONS,
  disabledTooltip,
  iterationActionMatrix,
  labelForAction,
  type IterationActionVerb,
} from "../lib/iteration-actions";
import { ITERATION_STATES, type IterationState } from "../lib/iteration-status";

const ALL_VERBS: IterationActionVerb[] = [
  "promote",
  "cancel",
  "edit",
  "addTask",
  "detachTask",
];

describe("iterationActionMatrix — per-state cells", () => {
  it("inbox: only cancel + edit-affordances available (Promote requires designing)", () => {
    expect(iterationActionMatrix("inbox")).toEqual({
      promote: false,
      cancel: true,
      edit: true,
      addTask: true,
      detachTask: true,
    });
  });

  it("designing: Promote IS visible (Decision 5)", () => {
    expect(iterationActionMatrix("designing")).toEqual({
      promote: true,
      cancel: true,
      edit: true,
      addTask: true,
      detachTask: true,
    });
  });

  it("queued: Promote no longer visible (already promoted)", () => {
    const m = iterationActionMatrix("queued");
    expect(m.promote).toBe(false);
    expect(m.cancel).toBe(true);
    expect(m.edit).toBe(true);
  });

  it("in_flight: Promote disabled, Cancel + edits still allowed", () => {
    const m = iterationActionMatrix("in_flight");
    expect(m.promote).toBe(false);
    expect(m.cancel).toBe(true);
    expect(m.edit).toBe(true);
  });

  it("blocked: same shape as in_flight", () => {
    expect(iterationActionMatrix("blocked")).toEqual(
      iterationActionMatrix("in_flight")
    );
  });

  it("done: every action disabled (terminal — snapshot semantics)", () => {
    for (const v of ALL_VERBS) {
      expect(iterationActionMatrix("done")[v]).toBe(false);
    }
  });

  it("cancelled: every action disabled (terminal)", () => {
    for (const v of ALL_VERBS) {
      expect(iterationActionMatrix("cancelled")[v]).toBe(false);
    }
  });
});

describe("iterationActionMatrix — null / unknown state defensive shape", () => {
  it("null state collapses to everything-disabled", () => {
    for (const v of ALL_VERBS) {
      expect(iterationActionMatrix(null)[v]).toBe(false);
    }
  });

  it("undefined state collapses to everything-disabled", () => {
    for (const v of ALL_VERBS) {
      expect(iterationActionMatrix(undefined)[v]).toBe(false);
    }
  });

  it("matrix has every verb present (never undefined)", () => {
    for (const s of ITERATION_STATES) {
      const m = iterationActionMatrix(s);
      for (const v of ALL_VERBS) {
        expect(typeof m[v]).toBe("boolean");
      }
    }
  });
});

describe("iterationActionMatrix — D10 Q1 invariant", () => {
  it("no `promote` cell EVER moves to done — Phase G feature", () => {
    // Principal-driven done from non-{in_flight,blocked} is deferred to
    // Phase G. This test pins the invariant: the detail surface offers
    // no path to mark an iteration done from the UI; the only `done`
    // path in v1 is the derivation from task termination + source
    // closure (wired in F-17). If Phase G ever lands a "Mark done"
    // button, it goes through a NEW verb, not the `promote` one.
    for (const s of ITERATION_STATES) {
      const m = iterationActionMatrix(s);
      // promote semantically maps to designing → queued ONLY. The
      // matrix would be wrong if any cell true'd up `promote` for a
      // state that wouldn't legally transition into queued.
      if (m.promote) expect(s).toBe("designing");
    }
  });
});

describe("disabledTooltip", () => {
  it("returns empty string for an enabled cell", () => {
    expect(disabledTooltip("designing", "promote")).toBe("");
    expect(disabledTooltip("inbox", "cancel")).toBe("");
  });

  it("returns a 'Loading iteration…' message for null state", () => {
    expect(disabledTooltip(null, "promote")).toMatch(/Loading/);
  });

  it("explains why Promote is unavailable on inbox (drag-to-designing first)", () => {
    expect(disabledTooltip("inbox", "promote")).toMatch(/Designing/);
  });

  it("names the iteration's terminal state for cancel-on-done", () => {
    expect(disabledTooltip("done", "cancel")).toMatch(/done/);
  });

  it("names the iteration's terminal state for cancel-on-cancelled", () => {
    expect(disabledTooltip("cancelled", "cancel")).toMatch(/cancelled/);
  });

  it("returns a 'snapshot' explanation for edit on terminal rows", () => {
    expect(disabledTooltip("done", "edit")).toMatch(/snapshot/);
    expect(disabledTooltip("cancelled", "edit")).toMatch(/snapshot/);
  });
});

describe("labelForAction — exhaustive", () => {
  it("returns a non-empty string for each verb", () => {
    for (const v of ALL_VERBS) {
      expect(labelForAction(v).length).toBeGreaterThan(0);
    }
  });

  it("Promote and Cancel have principal-friendly copy", () => {
    expect(labelForAction("promote")).toBe("Promote");
    expect(labelForAction("cancel")).toBe("Cancel iteration");
  });
});

describe("DESTRUCTIVE_ACTIONS", () => {
  it("contains cancel + detachTask", () => {
    expect(DESTRUCTIVE_ACTIONS.has("cancel")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("detachTask")).toBe(true);
  });

  it("does NOT contain promote (forward motion is not destructive)", () => {
    expect(DESTRUCTIVE_ACTIONS.has("promote")).toBe(false);
  });

  it("does NOT contain edit / addTask", () => {
    expect(DESTRUCTIVE_ACTIONS.has("edit")).toBe(false);
    expect(DESTRUCTIVE_ACTIONS.has("addTask")).toBe(false);
  });
});

describe("matrix coverage — every (state × verb) cell renders a defined boolean", () => {
  for (const state of ITERATION_STATES) {
    for (const verb of ALL_VERBS) {
      it(`${state} · ${verb}: enabled flag and tooltip both resolve`, () => {
        const m = iterationActionMatrix(state);
        expect(typeof m[verb]).toBe("boolean");
        if (!m[verb]) {
          // Disabled cell — tooltip must exist (principal needs to
          // learn why it's greyed out).
          expect(disabledTooltip(state as IterationState, verb).length)
            .toBeGreaterThan(0);
        }
      });
    }
  }
});
