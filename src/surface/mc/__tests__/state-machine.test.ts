import { describe, it, expect } from "bun:test";
import { transition } from "../state-machine";
import type { Action, BlockReason } from "../types";

const permissionBlock: BlockReason = {
  kind: "permission.request",
  payload: { requested_action: "tool.bash", target: "rm -rf /", risk_hint: "high" },
};

const toolErrorBlock: BlockReason = {
  kind: "tool.error",
  payload: { tool_name: "tool.bash", error_message: "exit code 1" },
};

const reviewBlock: BlockReason = {
  kind: "review.checkpoint",
  payload: { description: "Ready for human sign-off" },
};

describe("state machine — valid transitions", () => {
  it("queued → dispatch → dispatched", () => {
    const result = transition("queued", { type: "dispatch" });
    expect(result).toEqual({ ok: true, state: "dispatched", blockReason: null });
  });

  it("dispatched → start → running", () => {
    const result = transition("dispatched", { type: "start" });
    expect(result).toEqual({ ok: true, state: "running", blockReason: null });
  });

  it("running → block (permission) → blocked with reason", () => {
    const result = transition("running", { type: "block", reason: permissionBlock });
    expect(result).toEqual({ ok: true, state: "blocked", blockReason: permissionBlock });
  });

  it("running → block (tool.error) → blocked with reason", () => {
    const result = transition("running", { type: "block", reason: toolErrorBlock });
    expect(result).toEqual({ ok: true, state: "blocked", blockReason: toolErrorBlock });
  });

  it("running → block (review.checkpoint) → blocked with reason", () => {
    const result = transition("running", { type: "block", reason: reviewBlock });
    expect(result).toEqual({ ok: true, state: "blocked", blockReason: reviewBlock });
  });

  it("running → complete → completed", () => {
    const result = transition("running", { type: "complete" });
    expect(result).toEqual({ ok: true, state: "completed", blockReason: null });
  });

  it("running → fail → failed", () => {
    const result = transition("running", { type: "fail" });
    expect(result).toEqual({ ok: true, state: "failed", blockReason: null });
  });

  it("blocked → resume → running (clears block_reason)", () => {
    const result = transition("blocked", { type: "resume" });
    expect(result).toEqual({ ok: true, state: "running", blockReason: null });
  });

  it("blocked → operator_requeue → queued (clears block_reason)", () => {
    const result = transition("blocked", { type: "operator_requeue" });
    expect(result).toEqual({ ok: true, state: "queued", blockReason: null });
  });

  it("failed → operator_requeue → queued", () => {
    const result = transition("failed", { type: "operator_requeue" });
    expect(result).toEqual({ ok: true, state: "queued", blockReason: null });
  });

  it("queued → cancel → cancelled", () => {
    const result = transition("queued", { type: "cancel" });
    expect(result).toEqual({ ok: true, state: "cancelled", blockReason: null });
  });

  it("dispatched → cancel → cancelled", () => {
    const result = transition("dispatched", { type: "cancel" });
    expect(result).toEqual({ ok: true, state: "cancelled", blockReason: null });
  });

  it("running → cancel → cancelled", () => {
    const result = transition("running", { type: "cancel" });
    expect(result).toEqual({ ok: true, state: "cancelled", blockReason: null });
  });

  it("blocked → cancel → cancelled", () => {
    const result = transition("blocked", { type: "cancel" });
    expect(result).toEqual({ ok: true, state: "cancelled", blockReason: null });
  });
});

describe("state machine — invalid transitions", () => {
  it("completed is terminal — no transitions out", () => {
    for (const action of [
      { type: "dispatch" },
      { type: "start" },
      { type: "complete" },
      { type: "fail" },
      { type: "resume" },
      { type: "operator_requeue" },
      { type: "cancel" },
    ] as Action[]) {
      const result = transition("completed", action);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("completed");
      }
    }
  });

  it("cancelled is terminal — no transitions out (including cancel itself)", () => {
    // Includes `cancel` — re-cancelling a cancelled assignment must reject,
    // not silently no-op. Idempotent cancel is a separate API decision; the
    // pure machine should not paper over caller mistakes.
    for (const action of [
      { type: "dispatch" },
      { type: "start" },
      { type: "complete" },
      { type: "fail" },
      { type: "resume" },
      { type: "operator_requeue" },
      { type: "cancel" },
    ] as Action[]) {
      const result = transition("cancelled", action);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("cancelled");
      }
    }
  });

  it("queued cannot skip to running (must go through dispatched)", () => {
    const result = transition("queued", { type: "start" });
    expect(result.ok).toBe(false);
  });

  it("queued cannot block directly", () => {
    const result = transition("queued", { type: "block", reason: permissionBlock });
    expect(result.ok).toBe(false);
  });

  it("dispatched cannot complete without starting", () => {
    const result = transition("dispatched", { type: "complete" });
    expect(result.ok).toBe(false);
  });

  it("running cannot be dispatched", () => {
    const result = transition("running", { type: "dispatch" });
    expect(result.ok).toBe(false);
  });

  it("blocked cannot complete (must resume first)", () => {
    const result = transition("blocked", { type: "complete" });
    expect(result.ok).toBe(false);
  });

  it("failed cannot resume (must requeue)", () => {
    const result = transition("failed", { type: "resume" });
    expect(result.ok).toBe(false);
  });
});

describe("state machine — exhaustive matrix", () => {
  // 7 states × 8 actions = 56 (state, action) cells. Hand-written tests cover
  // 22 valid paths; a stray edit to the transition table could add a cell that
  // the hand-written tests don't catch. This loop asserts the exact ok/!ok
  // shape of every cell against an EXPECTED matrix, so any divergence (a new
  // edge, a deleted edge, a renamed state) fails loudly.
  type State =
    | "queued"
    | "dispatched"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  type ActType =
    | "dispatch"
    | "start"
    | "block"
    | "complete"
    | "fail"
    | "resume"
    | "operator_requeue"
    | "cancel";

  const STATES: State[] = [
    "queued",
    "dispatched",
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ];
  const ACTIONS: ActType[] = [
    "dispatch",
    "start",
    "block",
    "complete",
    "fail",
    "resume",
    "operator_requeue",
    "cancel",
  ];

  // EXPECTED[from][action] = toState | null  (null means "rejected").
  const EXPECTED: Record<State, Partial<Record<ActType, State>>> = {
    queued: { dispatch: "dispatched", cancel: "cancelled" },
    dispatched: { start: "running", cancel: "cancelled" },
    running: {
      block: "blocked",
      complete: "completed",
      fail: "failed",
      cancel: "cancelled",
    },
    blocked: {
      resume: "running",
      operator_requeue: "queued",
      cancel: "cancelled",
    },
    completed: {},
    failed: { operator_requeue: "queued" },
    cancelled: {},
  };

  function makeAction(type: ActType): Action {
    if (type === "block") {
      return { type, reason: permissionBlock };
    }
    return { type } as Action;
  }

  for (const from of STATES) {
    for (const actType of ACTIONS) {
      const expected = EXPECTED[from][actType];
      const label = expected
        ? `${from} + ${actType} → ${expected}`
        : `${from} + ${actType} → rejected`;

      it(label, () => {
        const result = transition(from, makeAction(actType));
        if (expected) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.state).toBe(expected);
        } else {
          expect(result.ok).toBe(false);
        }
      });
    }
  }
});

// ============================================================================
// F-12 — pin the verbs the curation toolbar exercises (Decision 3 matrix).
// ============================================================================
//
// The toolbar maps four verbs (Dispatch / Requeue / Hand off / Abandon) onto
// state-machine actions. Three of those four are state-machine-native:
//   - Dispatch        → `dispatch` action (covered upstream)
//   - Requeue         → `operator_requeue` action
//   - Abandon (asgmt) → `cancel` action
//   - Hand off        → composite (cancel + new assignment + dispatch); the
//                       cancel half is `cancel` action.
//
// These tests pin the legality of `operator_requeue` and `cancel` from every
// state in the matrix, so a future regression to the TRANSITIONS table is
// caught at the state-machine layer (the wire-side tests in
// curation-endpoints.test.ts depend on this lower-level invariant).

describe("F-12 — operator_requeue legality (Decision 7)", () => {
  it("blocked → operator_requeue → queued", () => {
    const result = transition("blocked", { type: "operator_requeue" });
    expect(result).toEqual({
      ok: true,
      state: "queued",
      blockReason: null, // requeue clears block_reason
    });
  });

  it("failed → operator_requeue → queued", () => {
    const result = transition("failed", { type: "operator_requeue" });
    expect(result).toEqual({ ok: true, state: "queued", blockReason: null });
  });

  for (const from of [
    "queued",
    "dispatched",
    "running",
    "completed",
    "cancelled",
  ] as const) {
    it(`${from} → operator_requeue → REJECTED`, () => {
      const result = transition(from, { type: "operator_requeue" });
      expect(result.ok).toBe(false);
    });
  }
});

describe("F-12 — cancel legality (Decision 5/6 — Abandon + Hand-off step 1)", () => {
  for (const from of ["queued", "dispatched", "running", "blocked"] as const) {
    it(`${from} → cancel → cancelled`, () => {
      const result = transition(from, { type: "cancel" });
      expect(result).toEqual({
        ok: true,
        state: "cancelled",
        blockReason: null,
      });
    });
  }

  for (const from of ["completed", "failed", "cancelled"] as const) {
    it(`${from} → cancel → REJECTED (terminal state — Decision 5/6 require API-layer guard)`, () => {
      const result = transition(from, { type: "cancel" });
      expect(result.ok).toBe(false);
    });
  }
});
