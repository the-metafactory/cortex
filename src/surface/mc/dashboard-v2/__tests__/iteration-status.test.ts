/**
 * F-13 — Pure transition-validator tests.
 *
 * Pins every cell of the (current × proposed) matrix from
 * `lib/iteration-status.ts` so a future scope-change in the matrix
 * cannot land silently. Mirrors the "every state has a complete row"
 * coverage style of `curation-enablement.test.ts`.
 *
 * Two styles of test:
 *   1. Per-state expected-allowed-set assertions (semantic, readable).
 *   2. Full (current × proposed) matrix cross-check (mechanical, every
 *      cell — 49 assertions for 7 × 7).
 *
 * If you change the TRANSITIONS matrix in `iteration-status.ts`, both
 * styles below must be updated in lock-step.
 */

import { describe, it, expect } from "bun:test";
import {
  canTransition,
  isTerminal,
  ITERATION_STATES,
  nextStates,
  type IterationState,
} from "../lib/iteration-status";
import { ITERATION_STATES as DB_ITERATION_STATES } from "../../db/iterations";

/**
 * Expected legal next states per source state. The test below
 * cross-checks every (current × proposed) cell against this map AND
 * asserts the helper functions agree with it.
 *
 * Mirrors the matrix definition's prose comments — keep in sync.
 */
const EXPECTED: Record<IterationState, ReadonlySet<IterationState>> = {
  inbox: new Set(["designing", "cancelled"]),
  designing: new Set(["inbox", "queued", "cancelled"]),
  queued: new Set(["designing", "in_flight", "cancelled"]),
  in_flight: new Set(["blocked", "done", "cancelled"]),
  blocked: new Set(["in_flight", "done", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};

describe("ITERATION_STATES — vocabulary", () => {
  it("exposes exactly the seven Decision 1 lifecycle states", () => {
    expect([...ITERATION_STATES]).toEqual([
      "inbox",
      "designing",
      "queued",
      "in_flight",
      "blocked",
      "done",
      "cancelled",
    ]);
  });

  it("matches the db/iterations.ts ITERATION_STATES vocabulary verbatim", () => {
    // The db/ layer declares the SQL CHECK source; this validator declares
    // the UI/transition source. They MUST be identical — the assertion
    // here is what pins them in lock-step (see lib/iteration-status.ts
    // module docstring).
    expect([...ITERATION_STATES]).toEqual([...DB_ITERATION_STATES]);
  });
});

describe("canTransition — semantic per-state checks", () => {
  it("inbox → designing or cancelled only", () => {
    expect(canTransition("inbox", "designing")).toBe(true);
    expect(canTransition("inbox", "cancelled")).toBe(true);
    expect(canTransition("inbox", "queued")).toBe(false);
    expect(canTransition("inbox", "in_flight")).toBe(false);
    expect(canTransition("inbox", "blocked")).toBe(false);
    expect(canTransition("inbox", "done")).toBe(false);
    expect(canTransition("inbox", "inbox")).toBe(false); // self-transition rejected
  });

  it("designing → queued, inbox (back), or cancelled", () => {
    expect(canTransition("designing", "queued")).toBe(true);
    expect(canTransition("designing", "inbox")).toBe(true);
    expect(canTransition("designing", "cancelled")).toBe(true);
    expect(canTransition("designing", "in_flight")).toBe(false);
    expect(canTransition("designing", "blocked")).toBe(false);
    expect(canTransition("designing", "done")).toBe(false);
    expect(canTransition("designing", "designing")).toBe(false);
  });

  it("queued → in_flight, designing (demote), or cancelled", () => {
    expect(canTransition("queued", "in_flight")).toBe(true);
    expect(canTransition("queued", "designing")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("queued", "blocked")).toBe(false);
    expect(canTransition("queued", "done")).toBe(false);
    expect(canTransition("queued", "inbox")).toBe(false);
    expect(canTransition("queued", "queued")).toBe(false);
  });

  it("in_flight → blocked, done, or cancelled", () => {
    expect(canTransition("in_flight", "blocked")).toBe(true);
    expect(canTransition("in_flight", "done")).toBe(true);
    expect(canTransition("in_flight", "cancelled")).toBe(true);
    expect(canTransition("in_flight", "queued")).toBe(false);
    expect(canTransition("in_flight", "designing")).toBe(false);
    expect(canTransition("in_flight", "inbox")).toBe(false);
    expect(canTransition("in_flight", "in_flight")).toBe(false);
  });

  it("blocked → in_flight (resume), done, or cancelled", () => {
    expect(canTransition("blocked", "in_flight")).toBe(true);
    expect(canTransition("blocked", "done")).toBe(true);
    expect(canTransition("blocked", "cancelled")).toBe(true);
    expect(canTransition("blocked", "queued")).toBe(false);
    expect(canTransition("blocked", "designing")).toBe(false);
    expect(canTransition("blocked", "inbox")).toBe(false);
    expect(canTransition("blocked", "blocked")).toBe(false);
  });

  it("done is terminal — no transitions out", () => {
    for (const s of ITERATION_STATES) {
      expect(canTransition("done", s)).toBe(false);
    }
  });

  it("cancelled is terminal — no transitions out", () => {
    for (const s of ITERATION_STATES) {
      expect(canTransition("cancelled", s)).toBe(false);
    }
  });
});

describe("canTransition — every (current × proposed) cell", () => {
  // 7 × 7 = 49 assertions. Walks the full matrix and cross-checks against
  // the EXPECTED map above. Any new state added to the union without an
  // EXPECTED entry will fail compilation (the Record's exhaustiveness
  // pins it); any cell whose runtime result disagrees with EXPECTED
  // fails this test.
  for (const current of ITERATION_STATES) {
    for (const proposed of ITERATION_STATES) {
      const expected = EXPECTED[current].has(proposed);
      it(`${current} → ${proposed}: ${expected ? "ALLOWED" : "REJECTED"}`, () => {
        expect(canTransition(current, proposed)).toBe(expected);
      });
    }
  }
});

describe("nextStates", () => {
  it("returns every legal next state for inbox", () => {
    const next = nextStates("inbox");
    expect(new Set(next)).toEqual(new Set(["designing", "cancelled"]));
  });

  it("returns every legal next state for designing", () => {
    const next = nextStates("designing");
    expect(new Set(next)).toEqual(new Set(["inbox", "queued", "cancelled"]));
  });

  it("returns every legal next state for queued", () => {
    const next = nextStates("queued");
    expect(new Set(next)).toEqual(
      new Set(["designing", "in_flight", "cancelled"])
    );
  });

  it("returns every legal next state for in_flight", () => {
    const next = nextStates("in_flight");
    expect(new Set(next)).toEqual(new Set(["blocked", "done", "cancelled"]));
  });

  it("returns every legal next state for blocked", () => {
    const next = nextStates("blocked");
    expect(new Set(next)).toEqual(new Set(["in_flight", "done", "cancelled"]));
  });

  it("returns [] for done (terminal)", () => {
    expect(nextStates("done")).toEqual([]);
  });

  it("returns [] for cancelled (terminal)", () => {
    expect(nextStates("cancelled")).toEqual([]);
  });

  it("agrees with canTransition for every state", () => {
    for (const s of ITERATION_STATES) {
      const allowed = new Set(nextStates(s));
      for (const t of ITERATION_STATES) {
        expect(allowed.has(t)).toBe(canTransition(s, t));
      }
    }
  });
});

describe("isTerminal", () => {
  it("returns true for done and cancelled", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("returns false for every non-terminal state", () => {
    for (const s of [
      "inbox",
      "designing",
      "queued",
      "in_flight",
      "blocked",
    ] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("validator is Grove-only — source state is never an input", () => {
  it("function arity is 2 (current, proposed)", () => {
    expect(canTransition.length).toBe(2);
  });

  it("nextStates arity is 1 (current only)", () => {
    expect(nextStates.length).toBe(1);
  });
});

describe("matrix coverage — defensive future-shape handling", () => {
  it("returns false for any unknown current state", () => {
    expect(canTransition("future-state" as IterationState, "done")).toBe(false);
  });

  it("returns false for any unknown proposed state", () => {
    expect(canTransition("inbox", "future-state" as IterationState)).toBe(
      false
    );
  });

  it("nextStates returns [] for an unknown state", () => {
    expect(nextStates("future-state" as IterationState)).toEqual([]);
  });
});
