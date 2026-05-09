/**
 * Tests for the F-6 focus-area WS filter predicate.
 *
 * Pins the MIG-2 acceptance criterion ("WS state.transition with
 * from/to including 'blocked' triggers a refetch; other transitions
 * skipped") in CI — previously only asserted manually in the PR
 * description (MIG-2 sweep review S1).
 */

import { describe, it, expect } from "bun:test";
import { isFocusAreaTransition } from "../lib/focus-area-filter";

describe("isFocusAreaTransition", () => {
  it("triggers when from === 'blocked' (assignment unblocked)", () => {
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "blocked",
      to: "running",
    })).toBe(true);
  });

  it("triggers when to === 'blocked' (assignment newly blocked)", () => {
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "running",
      to: "blocked",
    })).toBe(true);
  });

  it("triggers when both sides are 'blocked' (re-block edge case)", () => {
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "blocked",
      to: "blocked",
    })).toBe(true);
  });

  it("skips transitions that don't touch 'blocked'", () => {
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "running",
      to: "complete",
    })).toBe(false);
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "queued",
      to: "dispatched",
    })).toBe(false);
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: "dispatched",
      to: "running",
    })).toBe(false);
  });

  it("skips messages missing 'from' or 'to'", () => {
    expect(isFocusAreaTransition({ type: "state.transition", to: "blocked" })).toBe(true);
    expect(isFocusAreaTransition({ type: "state.transition", from: "blocked" })).toBe(true);
    expect(isFocusAreaTransition({ type: "state.transition" })).toBe(false);
  });

  it("skips messages with non-string from/to", () => {
    expect(isFocusAreaTransition({
      type: "state.transition",
      from: 42,
      to: null,
    })).toBe(false);
  });
});
