/**
 * CK-4b (cortex#1295) — cross-stack WORKING aggregate pure-helper tests.
 *
 * The component needs a React renderer; the branching that decides the mode,
 * the schema-origin keying, and the honest (queued-only, NO "awaiting hands")
 * copy live in `lib/working-aggregate-display.ts` so they stay DOM-free-testable.
 */

import { describe, it, expect } from "bun:test";
import {
  pickWorkingAggregateMode,
  aggregateTileKey,
  originStackLabel,
  activeSessionSummary,
  subAgentSummary,
  queuedRetryLabel,
  formatRetryAfter,
} from "../lib/working-aggregate-display";
import type { WorkingStackAggregate } from "../hooks/use-working-aggregation";

function agg(over: Partial<WorkingStackAggregate> = {}): WorkingStackAggregate {
  return {
    originStackId: null,
    activeSessionCount: 1,
    subAgentCount: 0,
    providerRetry: null,
    ...over,
  };
}

describe("pickWorkingAggregateMode", () => {
  it("returns 'tiles' whenever there is ≥1 rollup, regardless of loaded/error", () => {
    expect(pickWorkingAggregateMode({ aggregates: [agg()], loaded: true, error: null })).toBe("tiles");
    expect(pickWorkingAggregateMode({ aggregates: [agg()], loaded: false, error: "boot" })).toBe("tiles");
  });

  it("returns 'error' when empty + boot error", () => {
    expect(pickWorkingAggregateMode({ aggregates: [], loaded: true, error: "HTTP 500" })).toBe("error");
  });

  it("returns 'loading' pre-boot with empty rollups + no error", () => {
    expect(pickWorkingAggregateMode({ aggregates: [], loaded: false, error: null })).toBe("loading");
  });

  it("returns 'empty' when loaded + no origins working", () => {
    expect(pickWorkingAggregateMode({ aggregates: [], loaded: true, error: null })).toBe("empty");
  });

  it("has NO 'hidden' branch — the cross-stack lane is always-present context", () => {
    // tiles win even when a boot error is stale alongside real rollups.
    expect(pickWorkingAggregateMode({ aggregates: [agg()], loaded: true, error: "stale" })).toBe("tiles");
  });
});

describe("aggregateTileKey — keyed on SCHEMA origin (not the React-key hack)", () => {
  it("keys distinct origin stacks distinctly", () => {
    const local = aggregateTileKey(null);
    const work = aggregateTileKey("andreas/work");
    const peer = aggregateTileKey("jc/home");
    expect(local).toBe("local");
    expect(work).toBe("andreas/work");
    expect(peer).toBe("jc/home");
    expect(new Set([local, work, peer]).size).toBe(3);
  });

  it("maps a null origin (own/local bucket) to a stable 'local' key", () => {
    expect(aggregateTileKey(null)).toBe("local");
  });
});

describe("originStackLabel", () => {
  it("labels null as own/local", () => {
    expect(originStackLabel(null)).toBe("local");
  });
  it("labels a non-null origin verbatim (own sibling OR federated peer)", () => {
    expect(originStackLabel("andreas/work")).toBe("andreas/work");
    expect(originStackLabel("jc/home")).toBe("jc/home");
  });
});

describe("activeSessionSummary", () => {
  it("renders 'N working'", () => {
    expect(activeSessionSummary(0)).toBe("0 working");
    expect(activeSessionSummary(3)).toBe("3 working");
  });
});

describe("subAgentSummary — session-tree child counts (accessible text)", () => {
  it("pluralizes correctly and is honest about zero", () => {
    expect(subAgentSummary(0)).toBe("no sub-agents");
    expect(subAgentSummary(1)).toBe("1 sub-agent");
    expect(subAgentSummary(4)).toBe("4 sub-agents");
  });
  it("treats negatives defensively as zero", () => {
    expect(subAgentSummary(-2)).toBe("no sub-agents");
  });
});

describe("queuedRetryLabel — honest queued (D-9: NO 'awaiting hands')", () => {
  it("returns null when there is no pending back-pressure", () => {
    expect(queuedRetryLabel(null)).toBeNull();
  });

  it("renders 'queued · retry in <delay>' for a pending not_now", () => {
    expect(queuedRetryLabel({ state: "not_now", retryAfterMs: 3000 })).toBe("queued · retry in 3s");
  });

  it("NEVER renders the deferred 'awaiting hands' copy", () => {
    const label = queuedRetryLabel({ state: "not_now", retryAfterMs: 5000 }) ?? "";
    expect(label).not.toContain("awaiting hands");
    expect(label).not.toContain("hands");
  });
});

describe("formatRetryAfter — deterministic, no Date/Intl", () => {
  it("floors sub-second to <1s and clamps non-positive to 0s", () => {
    expect(formatRetryAfter(0)).toBe("0s");
    expect(formatRetryAfter(-100)).toBe("0s");
    expect(formatRetryAfter(NaN)).toBe("0s");
    expect(formatRetryAfter(400)).toBe("<1s");
  });
  it("rounds to whole seconds under a minute", () => {
    expect(formatRetryAfter(1000)).toBe("1s");
    expect(formatRetryAfter(2600)).toBe("3s");
    expect(formatRetryAfter(59_000)).toBe("59s");
  });
  it("renders minutes (+ seconds) at/above a minute", () => {
    expect(formatRetryAfter(60_000)).toBe("1m");
    expect(formatRetryAfter(90_000)).toBe("1m 30s");
    expect(formatRetryAfter(125_000)).toBe("2m 5s");
  });
});
