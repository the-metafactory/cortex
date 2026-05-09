/**
 * Tests for the F-12 curation toolbar's per-state enablement matrix.
 *
 * The matrix in `lib/curation-enablement.ts` is the only place the
 * toolbar reads to decide which buttons are enabled. Pinning every cell
 * here means a future state-machine refactor can't silently change the
 * UI's blast radius.
 *
 * Cross-references the legacy monolith table at
 * `dashboard/index.html` lines ~3483-3526.
 */

import { describe, it, expect } from "bun:test";
import {
  abandonTargetKind,
  curationMatrixFor,
  DESTRUCTIVE_VERBS,
  disabledTooltip,
  isEnabled,
  labelForVerb,
  VERBS_REQUIRING_CONFIRM,
  type CurationVerb,
} from "../lib/curation-enablement";
import type { AssignmentState } from "../../types";

const ALL_STATES: readonly AssignmentState[] = [
  "queued", "dispatched", "running", "blocked",
  "failed", "completed", "cancelled",
];

const ALL_VERBS: readonly CurationVerb[] = ["dispatch", "requeue", "handoff", "abandon"];

describe("curationMatrixFor — Decision 3 enablement matrix", () => {
  it("queued: handoff + abandon enabled; dispatch + requeue disabled", () => {
    const m = curationMatrixFor("queued");
    expect(m.dispatch).toMatch(/Already dispatched/);
    expect(m.requeue).toMatch(/Already queued/);
    expect(m.handoff).toBe(true);
    expect(m.abandon).toBe(true);
  });

  it("dispatched: handoff + abandon enabled; dispatch + requeue disabled", () => {
    const m = curationMatrixFor("dispatched");
    expect(m.dispatch).toMatch(/Already dispatched/);
    expect(m.requeue).toMatch(/Already running/);
    expect(m.handoff).toBe(true);
    expect(m.abandon).toBe(true);
  });

  it("running: handoff + abandon enabled; dispatch + requeue disabled", () => {
    const m = curationMatrixFor("running");
    expect(m.dispatch).toMatch(/Already running/);
    expect(m.requeue).toMatch(/Already running/);
    expect(m.handoff).toBe(true);
    expect(m.abandon).toBe(true);
  });

  it("blocked: requeue + handoff + abandon enabled; dispatch disabled", () => {
    const m = curationMatrixFor("blocked");
    expect(m.dispatch).toMatch(/Already running/);
    expect(m.requeue).toBe(true);
    expect(m.handoff).toBe(true);
    expect(m.abandon).toBe(true);
  });

  it("failed: every verb enabled (dispatch reruns; handoff new-assignment-only)", () => {
    const m = curationMatrixFor("failed");
    expect(m.dispatch).toBe(true);
    expect(m.requeue).toBe(true);
    expect(m.handoff).toBe(true);
    expect(m.abandon).toBe(true);
  });

  it("completed: dispatch + abandon enabled; requeue + handoff disabled", () => {
    const m = curationMatrixFor("completed");
    expect(m.dispatch).toBe(true);
    expect(m.requeue).toMatch(/Rerun via Dispatch/);
    expect(m.handoff).toMatch(/already done/);
    expect(m.abandon).toBe(true);
  });

  it("cancelled: every verb disabled (terminal)", () => {
    const m = curationMatrixFor("cancelled");
    expect(m.dispatch).toMatch(/cancelled/);
    expect(m.requeue).toMatch(/cancelled/);
    expect(m.handoff).toMatch(/cancelled/);
    expect(m.abandon).toMatch(/cancelled/);
  });

  it("null state: every verb disabled with 'Loading…' tooltip", () => {
    const m = curationMatrixFor(null);
    for (const v of ALL_VERBS) {
      expect(m[v]).toMatch(/Loading/);
    }
  });

  it("undefined state: same loading fallback as null", () => {
    const m = curationMatrixFor(undefined);
    for (const v of ALL_VERBS) {
      expect(m[v]).toMatch(/Loading/);
    }
  });

  it("future-shape state: every verb disabled with the state name in the tooltip", () => {
    const m = curationMatrixFor("future-state" as AssignmentState);
    for (const v of ALL_VERBS) {
      expect(m[v]).toMatch(/future-state/);
    }
  });
});

describe("isEnabled / disabledTooltip helpers", () => {
  it("isEnabled returns true only when the cell is === true", () => {
    expect(isEnabled("blocked", "requeue")).toBe(true);
    expect(isEnabled("blocked", "dispatch")).toBe(false);
    expect(isEnabled("cancelled", "abandon")).toBe(false);
  });

  it("disabledTooltip returns the cell string when disabled, else empty", () => {
    expect(disabledTooltip("blocked", "dispatch")).toMatch(/Already running/);
    expect(disabledTooltip("blocked", "requeue")).toBe("");
  });

  it("isEnabled is false for any verb when state is null/unknown", () => {
    for (const v of ALL_VERBS) {
      expect(isEnabled(null, v)).toBe(false);
      expect(isEnabled(undefined, v)).toBe(false);
    }
  });
});

describe("abandonTargetKind — F-12 Decision 5 routing rule", () => {
  it("returns 'assignment' for any non-terminal state", () => {
    for (const s of ["queued", "dispatched", "running", "blocked"] as const) {
      expect(abandonTargetKind(s)).toBe("assignment");
    }
  });

  it("returns 'task' for terminal states (completed/failed/cancelled)", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(abandonTargetKind(s)).toBe("task");
    }
  });

  it("returns 'assignment' for null/undefined (defensive default)", () => {
    expect(abandonTargetKind(null)).toBe("assignment");
    expect(abandonTargetKind(undefined)).toBe("assignment");
  });
});

describe("VERBS_REQUIRING_CONFIRM / DESTRUCTIVE_VERBS", () => {
  it("requires confirm for abandon and handoff only", () => {
    expect(VERBS_REQUIRING_CONFIRM.has("abandon")).toBe(true);
    expect(VERBS_REQUIRING_CONFIRM.has("handoff")).toBe(true);
    expect(VERBS_REQUIRING_CONFIRM.has("dispatch")).toBe(false);
    expect(VERBS_REQUIRING_CONFIRM.has("requeue")).toBe(false);
  });

  it("marks abandon and handoff destructive (reuses CSS .destructive)", () => {
    expect(DESTRUCTIVE_VERBS.has("abandon")).toBe(true);
    expect(DESTRUCTIVE_VERBS.has("handoff")).toBe(true);
    expect(DESTRUCTIVE_VERBS.has("dispatch")).toBe(false);
    expect(DESTRUCTIVE_VERBS.has("requeue")).toBe(false);
  });
});

describe("labelForVerb — operator-facing copy", () => {
  it("returns the canonical sentence-case label for every verb", () => {
    expect(labelForVerb("dispatch")).toBe("Dispatch");
    expect(labelForVerb("requeue")).toBe("Requeue");
    expect(labelForVerb("handoff")).toBe("Hand off");
    expect(labelForVerb("abandon")).toBe("Abandon");
  });
});

describe("matrix coverage", () => {
  it("every assignment state has a complete row (4 cells, no undefined)", () => {
    for (const s of ALL_STATES) {
      const m = curationMatrixFor(s);
      for (const v of ALL_VERBS) {
        expect(m[v]).not.toBeUndefined();
        expect(typeof m[v] === "boolean" || typeof m[v] === "string").toBe(true);
      }
    }
  });
});
