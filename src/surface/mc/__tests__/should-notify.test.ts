/**
 * F-11 — `shouldNotify` policy tests.
 *
 * One row per cell of the Decision 1 / Decision 3 matrix in
 * `docs/design-mc-f11-discord-notifications.md`. The pure function
 * encodes that matrix; these tests are a 1:1 truth-table.
 */
import { describe, it, expect } from "bun:test";
import {
  shouldNotify,
} from "../notifications/should-notify";
import type {
  AssignmentState,
  BlockReason,
} from "../types";

function permission(risk?: "high" | "medium" | "low"): BlockReason {
  return {
    kind: "permission.request",
    payload: {
      requested_action: "tool.bash",
      ...(risk !== undefined ? { risk_hint: risk } : {}),
    },
  };
}
const toolError: BlockReason = {
  kind: "tool.error",
  payload: { tool_name: "bash", error_message: "exit 1" },
};
const reviewCheckpoint: BlockReason = {
  kind: "review.checkpoint",
  payload: { description: "please review the diff" },
};

describe("shouldNotify — silent transitions (Decision 1, lower half of matrix)", () => {
  const silentTargets: AssignmentState[] = [
    "queued",
    "dispatched",
    "running",
    "cancelled",
  ];
  for (const to of silentTargets) {
    it(`${to} returns null`, () => {
      expect(
        shouldNotify({
          from: "running",
          to,
          priority: 0,
          blockReason: null,
        })
      ).toBeNull();
    });
  }

  it("blocked → running is silent (self-resolved)", () => {
    expect(
      shouldNotify({
        from: "blocked",
        to: "running",
        priority: 0,
        blockReason: null,
      })
    ).toBeNull();
  });
});

describe("shouldNotify — completed", () => {
  it("P0 completed → silent channel post (low visual weight)", () => {
    const intent = shouldNotify({
      from: "running",
      to: "completed",
      priority: 0,
      blockReason: null,
    });
    expect(intent).not.toBeNull();
    expect(intent!.audiences).toEqual(["channel"]);
    expect(intent!.severity).toBe("silent");
    expect(intent!.urgencyTag).toBeNull();
  });

  it("P1+ completed → null (dashboard-only)", () => {
    for (const priority of [1, 2, 3]) {
      const intent = shouldNotify({
        from: "running",
        to: "completed",
        priority,
        blockReason: null,
      });
      expect(intent).toBeNull();
    }
  });
});

describe("shouldNotify — failed", () => {
  it("P0 failed → channel post + ping (P0-ERR)", () => {
    const intent = shouldNotify({
      from: "running",
      to: "failed",
      priority: 0,
      blockReason: null,
    });
    expect(intent!.audiences).toEqual(["channel"]);
    expect(intent!.severity).toBe("ping");
    expect(intent!.urgencyTag).toBe("P0-ERR");
  });

  it("P1 failed → channel post, no ping, P1-ERR tag", () => {
    const intent = shouldNotify({
      from: "running",
      to: "failed",
      priority: 1,
      blockReason: null,
    });
    expect(intent!.audiences).toEqual(["channel"]);
    expect(intent!.severity).toBe("silent");
    expect(intent!.urgencyTag).toBe("P1-ERR");
  });

  it("P2 / P3 failed → channel post, no ping, no tag", () => {
    for (const priority of [2, 3]) {
      const intent = shouldNotify({
        from: "running",
        to: "failed",
        priority,
        blockReason: null,
      });
      expect(intent!.audiences).toEqual(["channel"]);
      expect(intent!.severity).toBe("silent");
      expect(intent!.urgencyTag).toBeNull();
    }
  });
});

describe("shouldNotify — blocked, permission.request", () => {
  it("P0 + risk=high → DM + channel + ping, P0-HIGH", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 0,
      blockReason: permission("high"),
    });
    expect(intent!.audiences).toEqual(["dm", "channel"]);
    expect(intent!.severity).toBe("ping");
    expect(intent!.urgencyTag).toBe("P0-HIGH");
  });

  it("P0 + risk=medium → DM only, no ping, P0", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 0,
      blockReason: permission("medium"),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.severity).toBe("silent");
    expect(intent!.urgencyTag).toBe("P0");
  });

  it("P0 + risk=low → DM only, P0", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 0,
      blockReason: permission("low"),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBe("P0");
  });

  it("P1 + risk=high → DM + channel + ping, P1-HIGH", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 1,
      blockReason: permission("high"),
    });
    expect(intent!.audiences).toEqual(["dm", "channel"]);
    expect(intent!.severity).toBe("ping");
    expect(intent!.urgencyTag).toBe("P1-HIGH");
  });

  it("P1 + risk=medium → DM only, P1", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 1,
      blockReason: permission("medium"),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBe("P1");
  });

  it("P2 + risk=high → DM, no ping, [HIGH] tag", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 2,
      blockReason: permission("high"),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.severity).toBe("silent");
    expect(intent!.urgencyTag).toBe("HIGH");
  });

  it("P2 + risk=medium → DM, no ping, no tag", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 2,
      blockReason: permission("medium"),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBeNull();
  });

  it("P3 + risk_hint absent → treated as medium (no tag)", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 3,
      blockReason: permission(undefined),
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBeNull();
  });
});

describe("shouldNotify — blocked, tool.error", () => {
  it("P0 → DM + channel + ping, P0-ERR", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 0,
      blockReason: toolError,
    });
    expect(intent!.audiences).toEqual(["dm", "channel"]);
    expect(intent!.severity).toBe("ping");
    expect(intent!.urgencyTag).toBe("P0-ERR");
  });

  it("P1 → DM only, no ping, P1-ERR", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 1,
      blockReason: toolError,
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBe("P1-ERR");
  });

  it("P2/P3 → DM only, no tag", () => {
    for (const priority of [2, 3]) {
      const intent = shouldNotify({
        from: "running",
        to: "blocked",
        priority,
        blockReason: toolError,
      });
      expect(intent!.audiences).toEqual(["dm"]);
      expect(intent!.urgencyTag).toBeNull();
    }
  });
});

describe("shouldNotify — blocked, review.checkpoint", () => {
  it("P0 → DM only, no ping (principal opted in)", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 0,
      blockReason: reviewCheckpoint,
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.severity).toBe("silent");
    expect(intent!.urgencyTag).toBe("P0");
  });

  it("P2 → DM only, no tag", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 2,
      blockReason: reviewCheckpoint,
    });
    expect(intent!.audiences).toEqual(["dm"]);
    expect(intent!.urgencyTag).toBeNull();
  });
});

describe("shouldNotify — defensive fallbacks", () => {
  it("blocked with null blockReason still emits a DM (schema-violation safety)", () => {
    const intent = shouldNotify({
      from: "running",
      to: "blocked",
      priority: 1,
      blockReason: null,
    });
    expect(intent!.audiences).toEqual(["dm"]);
  });
});

// `shouldNotifyInputRequested` was removed alongside `maybeNotifyInputRequested`
// (W2 in PR #23 review) — the `principal.input.requested` event is contemplated
// by Decision 1's matrix but not yet emitted by Mission Control v2. When the
// emitter lands in a follow-up F-1?, restore both functions and a matching test.
