/**
 * Pure-function tests for the dashboard's STATE_RANKS mirror.
 *
 * Pins the dashboard side of the F-8 Decision 4 rank table. The backend
 * side is pinned by `__tests__/tasks.test.ts`. Cross-rank divergence
 * shows up as a fail on either side.
 */

import { describe, it, expect } from "bun:test";
import { STATE_RANKS, STATE_RANK_BY_STATE, rankOf } from "../lib/state-ranks";

describe("STATE_RANKS — dashboard mirror of db/tasks.ts", () => {
  it("preserves the seven-state principal-attention order", () => {
    expect(STATE_RANKS).toEqual([
      "blocked",
      "running",
      "dispatched",
      "queued",
      "failed",
      "completed",
      "cancelled",
    ]);
  });

  it("exposes a state→rank map matching the array", () => {
    expect(STATE_RANK_BY_STATE.blocked).toBe(0);
    expect(STATE_RANK_BY_STATE.running).toBe(1);
    expect(STATE_RANK_BY_STATE.dispatched).toBe(2);
    expect(STATE_RANK_BY_STATE.queued).toBe(3);
    expect(STATE_RANK_BY_STATE.failed).toBe(4);
    expect(STATE_RANK_BY_STATE.completed).toBe(5);
    expect(STATE_RANK_BY_STATE.cancelled).toBe(6);
  });

  it("rankOf returns the array position", () => {
    expect(rankOf("blocked")).toBe(0);
    expect(rankOf("cancelled")).toBe(6);
  });
});
