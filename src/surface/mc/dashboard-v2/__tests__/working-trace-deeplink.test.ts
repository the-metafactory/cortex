/**
 * CK-8 — unit tests for the WORKING row → signal-trace deep-link resolver.
 *
 * Pins the three honest states and the load-bearing invariants:
 *   - LOCAL + anchored     → a link to the loopback timeline endpoint
 *   - CROSS-STACK          → honest degrade (NEVER a link; ADR-0005)
 *   - LOCAL + non-anchored → honest absence (no correlatable trace)
 *
 * A separate `describe` asserts PARITY with the server-side `ANCHOR_TASK_PREFIX`
 * so the browser-safe mirror can never silently drift from the projection that
 * mints the anchor task id.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveTraceDeepLink,
  traceTimelineHref,
  crossStackLabel,
  DISPATCH_ANCHOR_TASK_PREFIX,
} from "../lib/working-trace-deeplink";
import { ANCHOR_TASK_PREFIX } from "../../projection/anchor";

describe("resolveTraceDeepLink", () => {
  it("LOCAL + anchored task → a timeline deep link on the derived trace_id", () => {
    const link = resolveTraceDeepLink({
      taskId: `${DISPATCH_ANCHOR_TASK_PREFIX}abc-123`,
      origin: "local",
    });
    expect(link.kind).toBe("local");
    if (link.kind !== "local") throw new Error("unreachable");
    expect(link.traceId).toBe("abc-123");
    expect(link.timelineHref).toBe(
      "/api/observability/traces/abc-123/timeline",
    );
  });

  it("undefined origin is treated as LOCAL (pre-#1008 responses)", () => {
    const link = resolveTraceDeepLink({
      taskId: `${DISPATCH_ANCHOR_TASK_PREFIX}deadbeef`,
      origin: undefined,
    });
    expect(link.kind).toBe("local");
  });

  it("CROSS-STACK origin → honest degrade, NEVER a link (ADR-0005)", () => {
    const link = resolveTraceDeepLink({
      // Even a perfectly anchored task id must NOT produce a link off-origin:
      // the peer's trace is unreachable through this daemon's loopback proxy.
      taskId: `${DISPATCH_ANCHOR_TASK_PREFIX}abc-123`,
      origin: { principal: "jc", stack: "work" },
    });
    expect(link.kind).toBe("cross-stack");
    if (link.kind !== "cross-stack") throw new Error("unreachable");
    expect(link.stackLabel).toBe("jc/work");
  });

  it("LOCAL + non-anchored task → honest absence (no correlatable trace)", () => {
    for (const taskId of ["orphan-abc", "mc-shadow", "", DISPATCH_ANCHOR_TASK_PREFIX]) {
      const link = resolveTraceDeepLink({ taskId, origin: "local" });
      expect(link.kind).toBe("none");
    }
  });

  it("traceTimelineHref encodes the trace id (path-injection safe)", () => {
    expect(traceTimelineHref("a/b?c")).toBe(
      "/api/observability/traces/a%2Fb%3Fc/timeline",
    );
  });

  it("crossStackLabel renders {principal}/{stack}", () => {
    expect(crossStackLabel({ principal: "andreas", stack: "meta-factory" })).toBe(
      "andreas/meta-factory",
    );
  });
});

describe("anchor-prefix parity", () => {
  it("the browser-safe mirror equals the server ANCHOR_TASK_PREFIX", () => {
    // If the dispatch-lifecycle projection ever renames its anchor prefix, this
    // fails and forces the mirror to be updated in lockstep — the deep link
    // would otherwise silently stop correlating.
    expect(DISPATCH_ANCHOR_TASK_PREFIX).toBe(ANCHOR_TASK_PREFIX);
  });
});
