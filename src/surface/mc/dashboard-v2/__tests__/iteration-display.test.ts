/**
 * F-16 — tests for the iteration-display lib (chip text formatter,
 * truncation, tooltip, pill kind).
 *
 * Pure / no DOM. The helpers feed the F-7 drill-down header chip and
 * the F-8 task-table iteration column; pinning their behaviour here
 * means a future tweak to the truncation rule (or a new colour
 * palette) flips one place.
 */

import { describe, it, expect } from "bun:test";
import {
  ITERATION_TITLE_MAX_CHARS,
  chipPillKind,
  chipText,
  chipTooltip,
  patchIterationOnRows,
  truncateIterationTitle,
  validateIterationUpdatedPayload,
  validateTaskUpdatedPayload,
} from "../lib/iteration-display";
import type { TaskIterationTag } from "../../db/tasks";

const TAG = (over: Partial<TaskIterationTag> = {}): TaskIterationTag => ({
  id: over.id ?? "it-1",
  title: over.title ?? "Some iteration",
  state: over.state ?? "designing",
});

describe("truncateIterationTitle", () => {
  it("returns the input unchanged when shorter than the cap", () => {
    expect(truncateIterationTitle("short")).toBe("short");
  });

  it("returns the input unchanged at exactly the cap (no trailing ellipsis)", () => {
    const exact = "x".repeat(ITERATION_TITLE_MAX_CHARS);
    expect(truncateIterationTitle(exact)).toBe(exact);
  });

  it("truncates with a single ellipsis char when over the cap", () => {
    const over = "x".repeat(ITERATION_TITLE_MAX_CHARS + 5);
    const out = truncateIterationTitle(over);
    expect(out.length).toBe(ITERATION_TITLE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves the leading prefix when truncating", () => {
    const out = truncateIterationTitle("Sprint Alpha — week three planning notes");
    expect(out.startsWith("Sprint Alpha")).toBe(true);
  });

  it("is total over the empty string (no crash on schema relaxation)", () => {
    expect(truncateIterationTitle("")).toBe("");
  });
});

describe("chipText", () => {
  it("renders 'Iteration: <title> (state)' with the lifecycle state", () => {
    expect(chipText(TAG({ title: "Plan A", state: "designing" }))).toBe(
      "Iteration: Plan A (designing)"
    );
  });

  it("includes the state for every legal lifecycle value", () => {
    // Pin the format against a future change that drops the state
    // suffix. The state vocabulary lives in lib/iteration-transitions
    // — listing the values here doesn't introduce a new source of
    // truth; it documents the chip surface.
    const states: TaskIterationTag["state"][] = [
      "inbox",
      "designing",
      "queued",
      "in_flight",
      "blocked",
      "done",
      "cancelled",
    ];
    for (const s of states) {
      expect(chipText(TAG({ title: "T", state: s }))).toBe(
        `Iteration: T (${s})`
      );
    }
  });

  it("uses the truncated title (cap applies inside chipText)", () => {
    const long = "x".repeat(ITERATION_TITLE_MAX_CHARS + 10);
    const out = chipText(TAG({ title: long, state: "queued" }));
    // The truncated section is bounded by `ITERATION_TITLE_MAX_CHARS`.
    expect(out).toContain("…");
    // The state suffix is still rendered after truncation.
    expect(out.endsWith("(queued)")).toBe(true);
  });
});

describe("chipTooltip", () => {
  it("renders the FULL title (untruncated) plus the state", () => {
    const long = "Sprint Alpha — week three planning notes (extended)";
    expect(chipTooltip(TAG({ title: long, state: "in_flight" }))).toBe(
      `${long} (in_flight)`
    );
  });
});

describe("chipPillKind", () => {
  it("emits the iteration + iteration-<state> token pair", () => {
    expect(chipPillKind(TAG({ state: "designing" }))).toBe(
      "iteration iteration-designing"
    );
  });

  it("never collides with the existing `state-<assignmentState>` family", () => {
    // The drill-down header renders BOTH pill families side-by-side
    // (assignment state + iteration tag); collision would visually
    // confuse the operator. This test pins that the tokens are
    // distinct namespaces.
    const tag = TAG({ state: "blocked" });
    expect(chipPillKind(tag)).not.toContain("state-");
    expect(chipPillKind(tag)).toContain("iteration-");
  });
});

// ---------------------------------------------------------------------------
// F-16 sweep — patchIterationOnRows + validateIterationUpdatedPayload
// (Echo grove-v2#43 Major 3 + 4)
// ---------------------------------------------------------------------------

interface RowFixture {
  id: string;
  iteration: TaskIterationTag | null;
}

const ROWS = (overrides: Partial<RowFixture>[] = []): RowFixture[] =>
  overrides.length > 0
    ? overrides.map((o, i) => ({
        id: o.id ?? `row-${i}`,
        iteration: o.iteration ?? null,
      }))
    : [
        { id: "r1", iteration: TAG({ id: "it-1", title: "Alpha", state: "designing" }) },
        { id: "r2", iteration: TAG({ id: "it-2", title: "Beta", state: "queued" }) },
        { id: "r3", iteration: null },
      ];

describe("patchIterationOnRows", () => {
  it("returns the SAME array reference when nothing matched", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, { id: "it-99", title: "x" });
    expect(out).toBe(rows);
  });

  it("returns the SAME array reference when matched but identity-equal", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, {
      id: "it-1",
      title: "Alpha",
      state: "designing",
    });
    expect(out).toBe(rows);
  });

  it("patches title in place and returns a NEW array", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, { id: "it-1", title: "Alpha-renamed" });
    expect(out).not.toBe(rows);
    expect(out[0]!.iteration!.title).toBe("Alpha-renamed");
    // Other rows share reference (no spurious re-render).
    expect(out[1]).toBe(rows[1]);
    expect(out[2]).toBe(rows[2]);
  });

  it("patches state independently of title", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, { id: "it-1", state: "queued" });
    expect(out[0]!.iteration!.state).toBe("queued");
    expect(out[0]!.iteration!.title).toBe("Alpha");
  });

  it("patches both title and state in one pass", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, {
      id: "it-1",
      title: "Renamed",
      state: "in_flight",
    });
    expect(out[0]!.iteration!.title).toBe("Renamed");
    expect(out[0]!.iteration!.state).toBe("in_flight");
  });

  it("ignores rows with iteration: null (ungrouped)", () => {
    const rows = ROWS();
    const out = patchIterationOnRows(rows, { id: "it-1", title: "x" });
    expect(out[2]!.iteration).toBeNull();
  });
});

describe("validateIterationUpdatedPayload", () => {
  it("returns the patch on a well-formed payload", () => {
    const out = validateIterationUpdatedPayload({
      id: "it-1",
      title: "Alpha",
      state: "designing",
    });
    expect(out).toEqual({ id: "it-1", title: "Alpha", state: "designing" });
  });

  it("returns null for non-object input", () => {
    expect(validateIterationUpdatedPayload(null)).toBeNull();
    expect(validateIterationUpdatedPayload(undefined)).toBeNull();
    expect(validateIterationUpdatedPayload("string")).toBeNull();
    expect(validateIterationUpdatedPayload(42)).toBeNull();
  });

  it("returns null when id is missing or wrong type", () => {
    expect(validateIterationUpdatedPayload({})).toBeNull();
    expect(validateIterationUpdatedPayload({ id: 42 })).toBeNull();
    expect(validateIterationUpdatedPayload({ id: "" })).toBeNull();
  });

  it("returns null when title is wrong type (the `title: 42` regression)", () => {
    expect(
      validateIterationUpdatedPayload({ id: "it-1", title: 42 })
    ).toBeNull();
  });

  it("returns null when state is out of vocabulary (the `state: bogus` regression)", () => {
    expect(
      validateIterationUpdatedPayload({ id: "it-1", state: "bogus" })
    ).toBeNull();
  });

  it("returns null when state is wrong type", () => {
    expect(
      validateIterationUpdatedPayload({ id: "it-1", state: 42 })
    ).toBeNull();
  });

  it("accepts partial payloads (id + title only, id + state only, id alone)", () => {
    expect(validateIterationUpdatedPayload({ id: "it-1" })).toEqual({ id: "it-1" });
    expect(validateIterationUpdatedPayload({ id: "it-1", title: "x" })).toEqual({
      id: "it-1",
      title: "x",
    });
    expect(
      validateIterationUpdatedPayload({ id: "it-1", state: "queued" })
    ).toEqual({ id: "it-1", state: "queued" });
  });
});

// Per Echo grove-v2#43 sweep #2 — symmetric validator for the
// `task.updated` payload. The TS cast (`as TaskListItem`) is a lie;
// without runtime checks a malformed `iteration: { title: 42 }` would
// crash chipText's `.slice(...)` at render.
describe("validateTaskUpdatedPayload", () => {
  // Validator runtime-checks only the load-bearing fields the chip
  // renderers consume (id, title, iteration). It returns the input
  // *raw* on success — a full `TaskListItem` is the broadcast contract,
  // but the validator doesn't enforce every field. Tests use minimal
  // fixtures and assert non-null vs null.
  function isAccepted(raw: unknown): boolean {
    return validateTaskUpdatedPayload(raw) !== null;
  }

  it("accepts a well-formed payload (no iteration)", () => {
    expect(isAccepted({ id: "t-1", title: "T", iteration: null })).toBe(true);
  });

  it("accepts a well-formed payload (with iteration)", () => {
    expect(
      isAccepted({
        id: "t-1",
        title: "T",
        iteration: { id: "it-1", title: "Alpha", state: "designing" },
      })
    ).toBe(true);
  });

  it("returns null for non-object input", () => {
    expect(validateTaskUpdatedPayload(null)).toBeNull();
    expect(validateTaskUpdatedPayload(undefined)).toBeNull();
    expect(validateTaskUpdatedPayload("string")).toBeNull();
    expect(validateTaskUpdatedPayload(42)).toBeNull();
  });

  it("returns null when id is missing or wrong type", () => {
    expect(validateTaskUpdatedPayload({})).toBeNull();
    expect(validateTaskUpdatedPayload({ id: 42, title: "T" })).toBeNull();
    expect(validateTaskUpdatedPayload({ id: "", title: "T" })).toBeNull();
  });

  it("returns null when title is wrong type", () => {
    expect(
      validateTaskUpdatedPayload({ id: "t-1", title: 42 })
    ).toBeNull();
  });

  it("returns null when iteration.title is wrong type (the M4 regression vector)", () => {
    expect(
      validateTaskUpdatedPayload({
        id: "t-1",
        title: "T",
        iteration: { id: "it-1", title: 42, state: "designing" },
      })
    ).toBeNull();
  });

  it("returns null when iteration.state is out of vocabulary (the M4 regression vector)", () => {
    expect(
      validateTaskUpdatedPayload({
        id: "t-1",
        title: "T",
        iteration: { id: "it-1", title: "Alpha", state: "bogus" },
      })
    ).toBeNull();
  });

  it("rejects iteration shapes that the iteration validator would also reject", () => {
    expect(
      validateTaskUpdatedPayload({
        id: "t-1",
        title: "T",
        iteration: { /* missing id */ title: "Alpha", state: "designing" },
      })
    ).toBeNull();
  });

  it("requires both title and state when iteration is present (broadcast contract)", () => {
    // The broadcast always sends a fully populated iteration denorm
    // (the JOIN always populates both title + state). A frame missing
    // either is malformed.
    expect(
      validateTaskUpdatedPayload({
        id: "t-1",
        title: "T",
        iteration: { id: "it-1", state: "designing" },
      })
    ).toBeNull();
    expect(
      validateTaskUpdatedPayload({
        id: "t-1",
        title: "T",
        iteration: { id: "it-1", title: "Alpha" },
      })
    ).toBeNull();
  });
});
