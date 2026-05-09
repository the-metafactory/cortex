/**
 * Pure-function tests for block-reason rendering helpers.
 *
 * Pins the legacy monolith's `blockReasonOneLiner` and `formatAge`
 * semantics (`src/mission-control/dashboard/index.html:1094` /
 * `:1148`) so the legacy `/` and v2 `/v2` renderers stay consistent
 * through the migration window. Drift was flagged in the MIG-2 sweep
 * review (PR #29 W1 + W2).
 */

import { describe, it, expect } from "bun:test";
import {
  blockReasonOneLiner,
  priorityBorderClass,
  timeAgo,
} from "../lib/block-reason";
import type { BlockReason } from "../../types";

// The legacy renderer is intentionally defensive against malformed
// payloads (real-world Discord webhook drift), so several tests need
// to construct payload shapes that don't match the strict union.
// Cast via this helper to keep the test surface honest about the
// fact that we're exercising defensive paths.
function malformed<T extends BlockReason["kind"]>(
  kind: T,
  payload: Record<string, unknown>,
): BlockReason {
  return { kind, payload } as unknown as BlockReason;
}

describe("blockReasonOneLiner (legacy parity)", () => {
  it("renders permission.request with action only (no target)", () => {
    const result = blockReasonOneLiner({
      kind: "permission.request",
      payload: {
        requested_action: "tool.edit",
        target: "src/mission-control/api/handlers.ts",
      },
    });
    expect(result).toBe("approve: tool.edit");
  });

  it("renders permission.request without action as bare 'approve'", () => {
    const result = blockReasonOneLiner(malformed("permission.request", {}));
    expect(result).toBe("approve");
  });

  it("truncates permission.request action at 40 chars", () => {
    const long = "x".repeat(80);
    const result = blockReasonOneLiner({
      kind: "permission.request",
      payload: { requested_action: long },
    });
    // truncate(s, 40) → 39 chars + ellipsis
    expect(result.length).toBe("approve: ".length + 40);
    expect(result.startsWith("approve: ")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
  });

  it("renders tool.error with tool_name", () => {
    const result = blockReasonOneLiner({
      kind: "tool.error",
      payload: { tool_name: "tool.bash", error_message: "permission denied" },
    });
    expect(result).toBe("error: tool.bash");
  });

  it("renders tool.error without tool_name as bare 'error'", () => {
    const result = blockReasonOneLiner(malformed("tool.error", {}));
    expect(result).toBe("error");
  });

  it("truncates tool.error tool_name at 40 chars", () => {
    const long = "y".repeat(80);
    const result = blockReasonOneLiner(malformed("tool.error", { tool_name: long }));
    expect(result.length).toBe("error: ".length + 40);
    expect(result.endsWith("…")).toBe(true);
  });

  it("renders review.checkpoint with description (truncated to 40)", () => {
    const long = "a".repeat(80);
    const result = blockReasonOneLiner({
      kind: "review.checkpoint",
      payload: { description: long },
    });
    // truncate(s, 40) → 39 chars + ellipsis = 40 chars total after the prefix
    expect(result.length).toBe("review: ".length + 40);
    expect(result.startsWith("review: ")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
  });

  it("renders review.checkpoint without description as bare 'review'", () => {
    const result = blockReasonOneLiner(malformed("review.checkpoint", {}));
    expect(result).toBe("review");
  });

  it("returns 'blocked' for null (legacy contract)", () => {
    expect(blockReasonOneLiner(null)).toBe("blocked");
  });

  it("returns 'blocked' for unknown kind (legacy fallback)", () => {
    // Defensive — the BlockReason union doesn't include this, but the
    // legacy renderer falls through to "blocked" for forward-compat
    // when the server adds a new kind ahead of the client.
    const result = blockReasonOneLiner(
      { kind: "future.unknown", payload: {} } as unknown as BlockReason,
    );
    expect(result).toBe("blocked");
  });
});

describe("priorityBorderClass", () => {
  it("maps 0..3 to p0..p3 and unknowns to pu", () => {
    expect(priorityBorderClass(0)).toBe("p0");
    expect(priorityBorderClass(1)).toBe("p1");
    expect(priorityBorderClass(2)).toBe("p2");
    expect(priorityBorderClass(3)).toBe("p3");
    expect(priorityBorderClass(99)).toBe("pu");
    expect(priorityBorderClass(-1)).toBe("pu");
    expect(priorityBorderClass(Number.NaN)).toBe("pu");
  });
});

describe("timeAgo (legacy parity)", () => {
  const NOW = Date.parse("2026-04-25T12:00:00Z");

  it("renders sub-minute as Ns ago", () => {
    expect(timeAgo("2026-04-25T11:59:42Z", NOW)).toBe("18s ago");
  });

  it("renders sub-hour as Nm ago (no sub-unit precision)", () => {
    expect(timeAgo("2026-04-25T11:54:30Z", NOW)).toBe("5m ago");
  });

  it("renders sub-hour at minute boundary as Nm ago", () => {
    expect(timeAgo("2026-04-25T11:55:00Z", NOW)).toBe("5m ago");
  });

  it("renders sub-day as Nh ago (no sub-unit precision)", () => {
    expect(timeAgo("2026-04-25T09:42:00Z", NOW)).toBe("2h ago");
  });

  it("renders day-or-more as Nd ago", () => {
    expect(timeAgo("2026-04-22T12:00:00Z", NOW)).toBe("3d ago");
  });

  it("returns empty string for invalid input (legacy contract)", () => {
    expect(timeAgo("not-a-date", NOW)).toBe("");
  });
});
