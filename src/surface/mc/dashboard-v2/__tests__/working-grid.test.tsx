/**
 * F-9 working-grid pure-helper tests.
 *
 * Component itself uses hooks (focused-tile state, refs); covering it
 * needs jsdom + RTL which the migration addendum's Decision 8 puts
 * post-migration. The branching that decides which mode the grid is in
 * (hidden / error / loading / empty / tiles) is extracted into
 * `lib/working-grid-display.ts` so it stays unit-testable here.
 */

import { describe, it, expect } from "bun:test";
import {
  pickWorkingGridMode,
  priorityLabel,
} from "../lib/working-grid-display";
import type { WorkingAgentTile } from "../hooks/use-working-agents";

function tile(over: Partial<WorkingAgentTile> = {}): WorkingAgentTile {
  return {
    agent_id: "ag-1",
    agent_name: "Luna",
    agent_type: "head",
    primary_state_rank: 1,
    primary_state: "running",
    primary_assignment: {
      id: "a-1",
      task_id: "t-1",
      task_title: "Implement focus area",
      task_priority: 1,
      updated_at: "2026-04-26T00:00:00.000Z",
    },
    additional_active_count: 0,
    ...over,
  };
}

describe("pickWorkingGridMode — F-9 Decision 7 branching", () => {
  it("returns 'hidden' when loaded + grid empty + focus row has entries", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: null, focusItemCount: 3,
    })).toBe("hidden");
  });

  it("returns 'tiles' whenever agents > 0, regardless of focus / loaded / error", () => {
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: true, error: null, focusItemCount: 0,
    })).toBe("tiles");
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: false, error: null, focusItemCount: 5,
    })).toBe("tiles");
    expect(pickWorkingGridMode({
      agents: [tile()], loaded: true, error: "stale boot error", focusItemCount: 0,
    })).toBe("tiles");
  });

  it("returns 'error' when grid empty + boot error + no focus distraction", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: "HTTP 500", focusItemCount: 0,
    })).toBe("error");
  });

  it("returns 'loading' pre-boot with empty grid + no error", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: false, error: null, focusItemCount: 0,
    })).toBe("loading");
  });

  it("returns 'empty' when loaded + both grid and focus row empty", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: null, focusItemCount: 0,
    })).toBe("empty");
  });

  it("hidden takes precedence over error (so error doesn't flash next to focus)", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: true, error: "HTTP 500", focusItemCount: 1,
    })).toBe("hidden");
  });

  it("loading wins over empty — empty requires loaded=true", () => {
    expect(pickWorkingGridMode({
      agents: [], loaded: false, error: null, focusItemCount: 0,
    })).toBe("loading");
  });
});

describe("priorityLabel — legacy parity", () => {
  it("renders P0..P3 for valid integer priorities", () => {
    expect(priorityLabel(0)).toBe("P0");
    expect(priorityLabel(1)).toBe("P1");
    expect(priorityLabel(2)).toBe("P2");
    expect(priorityLabel(3)).toBe("P3");
  });

  it("renders P? for out-of-range, negative, fractional, or non-integer values", () => {
    expect(priorityLabel(-1)).toBe("P?");
    expect(priorityLabel(4)).toBe("P?");
    expect(priorityLabel(99)).toBe("P?");
    expect(priorityLabel(1.5)).toBe("P?");
    expect(priorityLabel(NaN)).toBe("P?");
  });
});
