/**
 * Tests for the F-8 task-table filter / sort / empty-state classifier.
 *
 * Pins the migrated logic against the legacy monolith's
 * `applyTasksFilters` / `compareTasksByKey` (`dashboard/index.html` lines
 * ~2177-2237). Behavioural parity through the migration window is the
 * acceptance criterion (F-8 addendum §"What F-8 SHIPS").
 */

import { describe, it, expect } from "bun:test";
import {
  ageLabel,
  applyTaskFilters,
  chipOverflow,
  classifyEmpty,
  compareByKey,
  pickPrimaryAssignment,
  type TaskFilterState,
  type TaskSortState,
} from "../lib/task-table-filter";
import type { TaskListItem, TaskAssignmentRow } from "../../db/tasks";
import type { AssignmentState } from "../../types";

const NOW = Date.parse("2026-04-24T12:00:00.000Z");

function task(over: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: over.id ?? "T-1",
    title: over.title ?? "task",
    priority: over.priority ?? 2,
    status: over.status ?? "open",
    created_at: over.created_at ?? "2026-04-24T11:00:00.000Z",
    updated_at: over.updated_at ?? "2026-04-24T11:30:00.000Z",
    source_system: over.source_system ?? "internal",
    source_ref: over.source_ref ?? null,
    source_url: over.source_url ?? null,
    assignments: over.assignments ?? [],
    aggregate_state: over.aggregate_state ?? null,
    shadow_assignment_id: over.shadow_assignment_id ?? null,
    iteration: over.iteration ?? null,
  };
}

function assn(over: Partial<TaskAssignmentRow> = {}): TaskAssignmentRow {
  return {
    id: over.id ?? "A-1",
    agent_id: over.agent_id ?? "luna",
    agent_name: over.agent_name ?? "Luna",
    state: (over.state ?? "running") as AssignmentState,
    updated_at: over.updated_at ?? "2026-04-24T11:30:00.000Z",
    // F-20.F — session denorm; default to null (the resolver will map
    // that to "ended", matching pre-F-20.F behaviour for callers that
    // didn't override).
    session: over.session ?? null,
  };
}

const NO_FILTERS: TaskFilterState = {
  priorities: new Set(),
  ageMinMinutes: 0,
  search: "",
  includeClosed: false,
  iterationId: null,
};

const DEFAULT_SORT: TaskSortState = { key: "default", dir: "asc" };

describe("applyTaskFilters — filter pass", () => {
  it("returns the input untouched when no filter and key='default'", () => {
    const all = [task({ id: "T-1" }), task({ id: "T-2" })];
    expect(applyTaskFilters(all, NO_FILTERS, DEFAULT_SORT, NOW)).toEqual(all);
  });

  it("priority filter — empty set means all priorities", () => {
    const all = [task({ id: "T-1", priority: 0 }), task({ id: "T-2", priority: 3 })];
    expect(applyTaskFilters(all, NO_FILTERS, DEFAULT_SORT, NOW)).toHaveLength(2);
  });

  it("priority filter — multi-select keeps only matching priorities", () => {
    const all = [
      task({ id: "T-1", priority: 0 }),
      task({ id: "T-2", priority: 1 }),
      task({ id: "T-3", priority: 2 }),
    ];
    const filtered = applyTaskFilters(
      all,
      { ...NO_FILTERS, priorities: new Set([0, 2]) },
      DEFAULT_SORT,
      NOW
    );
    expect(filtered.map((t) => t.id)).toEqual(["T-1", "T-3"]);
  });

  it("age filter — hides tasks younger than the threshold", () => {
    const all = [
      task({ id: "young", created_at: "2026-04-24T11:55:00.000Z" }),  // 5min
      task({ id: "older", created_at: "2026-04-24T11:00:00.000Z" }),  // 60min
    ];
    const filtered = applyTaskFilters(
      all,
      { ...NO_FILTERS, ageMinMinutes: 30 },
      DEFAULT_SORT,
      NOW
    );
    expect(filtered.map((t) => t.id)).toEqual(["older"]);
  });

  it("age filter — keeps every task when threshold is 0", () => {
    const all = [
      task({ id: "young", created_at: "2026-04-24T11:59:00.000Z" }),
      task({ id: "older", created_at: "2026-04-24T10:00:00.000Z" }),
    ];
    expect(applyTaskFilters(all, NO_FILTERS, DEFAULT_SORT, NOW)).toHaveLength(2);
  });

  it("age filter — gracefully ignores non-finite created_at", () => {
    const all = [task({ id: "garbage", created_at: "not-a-date" })];
    expect(
      applyTaskFilters(
        all,
        { ...NO_FILTERS, ageMinMinutes: 60 },
        DEFAULT_SORT,
        NOW
      )
    ).toHaveLength(1);
  });

  it("search — case-insensitive substring match on title", () => {
    const all = [
      task({ id: "T-1", title: "fix Webhook HMAC" }),
      task({ id: "T-2", title: "ship the docs" }),
    ];
    const filtered = applyTaskFilters(
      all,
      { ...NO_FILTERS, search: "WEBHOOK" },
      DEFAULT_SORT,
      NOW
    );
    expect(filtered.map((t) => t.id)).toEqual(["T-1"]);
  });

  it("search — empty string after trim matches everything", () => {
    const all = [task({ id: "T-1" }), task({ id: "T-2" })];
    expect(
      applyTaskFilters(all, { ...NO_FILTERS, search: "   " }, DEFAULT_SORT, NOW)
    ).toHaveLength(2);
  });

  // ---------------------------------------------------------------
  // F-16 — iteration filter (`?iter=<id>`)
  // ---------------------------------------------------------------

  it("F-16 iteration filter — null = no pin (every task survives)", () => {
    const all = [
      task({
        id: "T-1",
        iteration: { id: "it-1", title: "A", state: "designing" },
      }),
      task({ id: "T-2", iteration: null }),
    ];
    expect(
      applyTaskFilters(all, NO_FILTERS, DEFAULT_SORT, NOW)
    ).toHaveLength(2);
  });

  it("F-16 iteration filter — keeps only tasks attached to the pinned iteration", () => {
    const all = [
      task({
        id: "T-1",
        iteration: { id: "it-1", title: "A", state: "designing" },
      }),
      task({
        id: "T-2",
        iteration: { id: "it-2", title: "B", state: "queued" },
      }),
      task({ id: "T-3", iteration: null }),
    ];
    const out = applyTaskFilters(
      all,
      { ...NO_FILTERS, iterationId: "it-1" },
      DEFAULT_SORT,
      NOW
    );
    expect(out.map((t) => t.id)).toEqual(["T-1"]);
  });

  it("F-16 iteration filter — ungrouped tasks are excluded when a pin is active", () => {
    const all = [
      task({ id: "T-1", iteration: null }),
      task({
        id: "T-2",
        iteration: { id: "it-1", title: "A", state: "designing" },
      }),
    ];
    const out = applyTaskFilters(
      all,
      { ...NO_FILTERS, iterationId: "it-1" },
      DEFAULT_SORT,
      NOW
    );
    expect(out.map((t) => t.id)).toEqual(["T-2"]);
  });

  it("F-16 iteration filter — composes with priority filter (AND)", () => {
    const all = [
      task({
        id: "T-1",
        priority: 0,
        iteration: { id: "it-1", title: "A", state: "designing" },
      }),
      task({
        id: "T-2",
        priority: 2,
        iteration: { id: "it-1", title: "A", state: "designing" },
      }),
      task({
        id: "T-3",
        priority: 0,
        iteration: { id: "it-2", title: "B", state: "queued" },
      }),
    ];
    const out = applyTaskFilters(
      all,
      {
        ...NO_FILTERS,
        priorities: new Set([0]),
        iterationId: "it-1",
      },
      DEFAULT_SORT,
      NOW
    );
    expect(out.map((t) => t.id)).toEqual(["T-1"]);
  });
});

describe("applyTaskFilters — sort pass", () => {
  it("default key skips sorting (server order preserved)", () => {
    const all = [task({ id: "first" }), task({ id: "second" })];
    expect(
      applyTaskFilters(all, NO_FILTERS, { key: "default", dir: "asc" }, NOW).map((t) => t.id)
    ).toEqual(["first", "second"]);
  });

  it("priority ASC then DESC by header click", () => {
    const all = [
      task({ id: "a", priority: 3 }),
      task({ id: "b", priority: 1 }),
      task({ id: "c", priority: 0 }),
    ];
    const asc = applyTaskFilters(all, NO_FILTERS, { key: "priority", dir: "asc" }, NOW);
    expect(asc.map((t) => t.id)).toEqual(["c", "b", "a"]);
    const desc = applyTaskFilters(all, NO_FILTERS, { key: "priority", dir: "desc" }, NOW);
    expect(desc.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("title ASC sorts lexicographically (locale-aware)", () => {
    const all = [
      task({ id: "a", title: "banana" }),
      task({ id: "b", title: "apple" }),
    ];
    const sorted = applyTaskFilters(all, NO_FILTERS, { key: "title", dir: "asc" }, NOW);
    expect(sorted.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("agents ASC ranks tasks with fewer assignments first", () => {
    const all = [
      task({ id: "many", assignments: [assn(), assn({ id: "A-2" })] }),
      task({ id: "one", assignments: [assn()] }),
      task({ id: "none" }),
    ];
    const sorted = applyTaskFilters(all, NO_FILTERS, { key: "agents", dir: "asc" }, NOW);
    expect(sorted.map((t) => t.id)).toEqual(["none", "one", "many"]);
  });

  it("age ASC sorts oldest first; DESC sorts newest first", () => {
    const all = [
      task({ id: "newest", created_at: "2026-04-24T11:55:00.000Z" }),
      task({ id: "middle", created_at: "2026-04-24T11:30:00.000Z" }),
      task({ id: "oldest", created_at: "2026-04-24T10:00:00.000Z" }),
    ];
    const asc = applyTaskFilters(all, NO_FILTERS, { key: "age", dir: "asc" }, NOW);
    expect(asc.map((t) => t.id)).toEqual(["oldest", "middle", "newest"]);
    const desc = applyTaskFilters(all, NO_FILTERS, { key: "age", dir: "desc" }, NOW);
    expect(desc.map((t) => t.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("state ASC ranks blocked > running > dispatched > queued > failed > completed > cancelled", () => {
    const states: AssignmentState[] = [
      "cancelled", "completed", "failed", "queued", "dispatched", "running", "blocked",
    ];
    const all = states.map((s, i) => task({ id: `t-${s}`, aggregate_state: s, priority: i }));
    const sorted = applyTaskFilters(all, NO_FILTERS, { key: "state", dir: "asc" }, NOW);
    expect(sorted.map((t) => t.aggregate_state)).toEqual([
      "blocked", "running", "dispatched", "queued", "failed", "completed", "cancelled",
    ]);
  });

  it("state sort partitions null aggregate_state to the bottom regardless of direction", () => {
    const all = [
      task({ id: "blocked", aggregate_state: "blocked" }),
      task({ id: "no-assn-1", aggregate_state: null }),
      task({ id: "running", aggregate_state: "running" }),
      task({ id: "no-assn-2", aggregate_state: null }),
    ];
    const asc = applyTaskFilters(all, NO_FILTERS, { key: "state", dir: "asc" }, NOW);
    expect(asc.map((t) => t.id)).toEqual(["blocked", "running", "no-assn-1", "no-assn-2"]);
    const desc = applyTaskFilters(all, NO_FILTERS, { key: "state", dir: "desc" }, NOW);
    expect(desc.map((t) => t.id)).toEqual(["running", "blocked", "no-assn-1", "no-assn-2"]);
  });

  it("does not mutate the input list", () => {
    const all = [task({ id: "b", priority: 1 }), task({ id: "a", priority: 0 })];
    const ids = all.map((t) => t.id);
    applyTaskFilters(all, NO_FILTERS, { key: "priority", dir: "asc" }, NOW);
    expect(all.map((t) => t.id)).toEqual(ids);
  });
});

describe("compareByKey", () => {
  it("falls back to 0 for an unknown key", () => {
    expect(
      compareByKey(task({ id: "a" }), task({ id: "b" }), "default")
    ).toBe(0);
  });

  it("state comparator returns 99 when aggregate_state is null on either side", () => {
    expect(
      compareByKey(
        task({ aggregate_state: "blocked" }),
        task({ aggregate_state: null }),
        "state"
      )
    ).toBeLessThan(0);
  });
});

describe("classifyEmpty", () => {
  it("classifies an empty server response as 'no-tasks-at-all'", () => {
    expect(classifyEmpty([], NO_FILTERS)).toBe("no-tasks-at-all");
  });

  it("classifies all-closed-but-toggle-off as 'all-closed-hidden'", () => {
    const all = [task({ status: "done" }), task({ status: "cancelled" })];
    expect(classifyEmpty(all, NO_FILTERS)).toBe("all-closed-hidden");
  });

  it("classifies a non-trivial filter that excludes all rows as 'filter-excludes-all'", () => {
    const all = [task({ priority: 0 }), task({ priority: 2 })];
    expect(
      classifyEmpty(all, { ...NO_FILTERS, priorities: new Set([3]) })
    ).toBe("filter-excludes-all");
  });

  it("classifies empty visible with no filter as 'no-match' (rare; usually all-closed)", () => {
    // open task exists, includeClosed default off → not all-closed; no filter → no-match.
    const all = [task({ status: "open" })];
    expect(classifyEmpty(all, NO_FILTERS)).toBe("no-match");
  });

  it("F-16 — iteration filter counts as an active filter (drives 'filter-excludes-all')", () => {
    // An iteration pin that excludes every row should land in
    // 'filter-excludes-all' so the empty-state component renders the
    // "Clear filters" affordance — without this the operator's only
    // path back is to hand-edit the URL, which is the exact UX
    // failure the empty-state classifier exists to prevent.
    const all = [task({ status: "open" })];
    expect(
      classifyEmpty(all, { ...NO_FILTERS, iterationId: "it-not-here" })
    ).toBe("filter-excludes-all");
  });
});

describe("pickPrimaryAssignment", () => {
  it("returns null for empty list", () => {
    expect(pickPrimaryAssignment([])).toBeNull();
  });

  it("prefers blocked over any other state", () => {
    const list = [
      assn({ id: "running", state: "running" }),
      assn({ id: "blocked", state: "blocked" }),
    ];
    expect(pickPrimaryAssignment(list)?.id).toBe("blocked");
  });

  it("within same state, prefers larger updated_at", () => {
    const list = [
      assn({ id: "older", state: "running", updated_at: "2026-04-24T10:00:00.000Z" }),
      assn({ id: "newer", state: "running", updated_at: "2026-04-24T11:00:00.000Z" }),
    ];
    expect(pickPrimaryAssignment(list)?.id).toBe("newer");
  });

  it("falls through to last-resort (rank 99) for unknown state", () => {
    const list = [assn({ state: "foo" as AssignmentState, id: "weird" })];
    expect(pickPrimaryAssignment(list)?.id).toBe("weird");
  });
});

describe("ageLabel", () => {
  it("formats sub-minute as Ns", () => {
    expect(ageLabel("2026-04-24T11:59:30.000Z", NOW)).toBe("30s");
  });
  it("formats sub-hour as Nm", () => {
    // 11:01 → 59 minutes ago → "59m"; rolls over to "1h" at exactly 60.
    expect(ageLabel("2026-04-24T11:01:00.000Z", NOW)).toBe("59m");
  });
  it("formats sub-day as Nh", () => {
    expect(ageLabel("2026-04-24T08:00:00.000Z", NOW)).toBe("4h");
  });
  it("formats >=24h as Nd", () => {
    expect(ageLabel("2026-04-23T11:00:00.000Z", NOW)).toBe("1d");
  });
  it("returns em-dash for unparseable input", () => {
    expect(ageLabel("not-a-date", NOW)).toBe("—");
  });
  it("clamps negative diffs to 0", () => {
    expect(ageLabel("2026-04-24T13:00:00.000Z", NOW)).toBe("0s");
  });
});

describe("chipOverflow", () => {
  it("returns empty visible + 0 overflow for empty list", () => {
    expect(chipOverflow([])).toEqual({ visible: [], overflow: 0 });
  });
  it("renders all assignments as chips when ≤3", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(chipOverflow(list)).toEqual({
      visible: list,
      overflow: 0,
    });
  });
  it("collapses past 3 into 2 named + +N tail", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const out = chipOverflow(list);
    expect(out.visible.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out.overflow).toBe(2);
  });
});
