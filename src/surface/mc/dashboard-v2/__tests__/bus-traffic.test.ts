/**
 * CK-5 (#1292) — bus-traffic model unit tests.
 *
 * Covers the PURE core: frame → D/A/H scope classification (control frames
 * excluded, ordering H > A > D-fallback), rolling-window pruning, throughput
 * math, and the load-bearing TRUTH-NOT-THEATER contract — zero frames in the
 * window ⇒ `active: false` (static render), a single real frame ⇒ `active: true`.
 */

import { describe, it, expect } from "bun:test";
import {
  classifyFrameScope,
  pruneEvents,
  computeTrafficModel,
  idleTrafficModel,
  formatThroughput,
  DEFAULT_TRAFFIC_WINDOW_MS,
  type TrafficEvent,
} from "../lib/bus-traffic";

describe("classifyFrameScope", () => {
  it("excludes control / keepalive frames (no fabricated hum)", () => {
    for (const t of ["ping", "pong", "connected", "subscribed", "error"]) {
      expect(classifyFrameScope(t)).toBeNull();
    }
  });

  it("routes agent / session / dispatch / event frames to Agentic", () => {
    expect(classifyFrameScope("agent.presence")).toBe("a");
    expect(classifyFrameScope("event")).toBe("a");
    expect(classifyFrameScope("state.transition")).toBe("a");
    expect(classifyFrameScope("mc.dispatch")).toBe("a");
  });

  it("routes human-in-the-loop frames to Human", () => {
    expect(classifyFrameScope("attention.updated")).toBe("h");
    expect(classifyFrameScope("mc.governance")).toBe("h");
    expect(classifyFrameScope("admission.request")).toBe("h");
    expect(classifyFrameScope("handoff.updated")).toBe("h");
  });

  it("prefers Human over Agentic for a human-gated agent action (invariant 19)", () => {
    // Contains both 'dispatch' (agentic hint) and 'approval' (human hint):
    // presence ≠ activity — the human moment wins.
    expect(classifyFrameScope("dispatch.approval")).toBe("h");
  });

  it("falls back to Deterministic for system-emitted surfaced frames", () => {
    expect(classifyFrameScope("task.updated")).toBe("d");
    expect(classifyFrameScope("iteration.created")).toBe("d");
    expect(classifyFrameScope("mc.projection")).toBe("d");
  });
});

describe("pruneEvents", () => {
  it("drops events at or before the window cutoff, keeps the rest in order", () => {
    const now = 10_000;
    const events: TrafficEvent[] = [
      { t: 3_000, scope: "d" }, // 7s old — dropped (window 5s)
      { t: 6_000, scope: "a" }, // 4s old — kept
      { t: 9_500, scope: "h" }, // 0.5s old — kept
    ];
    const kept = pruneEvents(events, now, 5_000);
    expect(kept.map((e) => e.scope)).toEqual(["a", "h"]);
  });
});

describe("computeTrafficModel", () => {
  it("returns a static idle model when no frames fall in the window", () => {
    const now = 100_000;
    const stale: TrafficEvent[] = [{ t: 1_000, scope: "a" }];
    const model = computeTrafficModel(stale, now, 5_000);
    expect(model.active).toBe(false);
    expect(model.total).toBe(0);
    expect(model.throughput).toBe(0);
    expect(model.counts).toEqual({ d: 0, a: 0, h: 0 });
  });

  it("lights up (active) on a single real frame", () => {
    const now = 5_000;
    const model = computeTrafficModel([{ t: 4_900, scope: "a" }], now, 5_000);
    expect(model.active).toBe(true);
    expect(model.total).toBe(1);
    expect(model.counts.a).toBe(1);
  });

  it("computes throughput as frames / window-seconds, rounded to 1 dp", () => {
    const now = 5_000;
    // 10 frames in a 5s window → 2.0 env/s.
    const events: TrafficEvent[] = Array.from({ length: 10 }, (_, i) => ({
      t: now - i * 100,
      scope: "d" as const,
    }));
    const model = computeTrafficModel(events, now, 5_000);
    expect(model.throughput).toBe(2);
    expect(model.total).toBe(10);
  });

  it("tallies D/A/H counts independently", () => {
    const now = 1_000;
    const events: TrafficEvent[] = [
      { t: 900, scope: "d" },
      { t: 910, scope: "d" },
      { t: 920, scope: "a" },
      { t: 930, scope: "h" },
    ];
    const model = computeTrafficModel(events, now, 5_000);
    expect(model.counts).toEqual({ d: 2, a: 1, h: 1 });
  });
});

describe("idleTrafficModel / formatThroughput", () => {
  it("idle model is static with the default window", () => {
    const idle = idleTrafficModel();
    expect(idle.active).toBe(false);
    expect(idle.windowMs).toBe(DEFAULT_TRAFFIC_WINDOW_MS);
  });

  it("formats throughput with the env/s unit", () => {
    expect(formatThroughput(idleTrafficModel())).toBe("0 env/s");
    expect(
      formatThroughput(computeTrafficModel([{ t: 5, scope: "a" }], 10, 1_000)),
    ).toBe("1 env/s");
  });
});
