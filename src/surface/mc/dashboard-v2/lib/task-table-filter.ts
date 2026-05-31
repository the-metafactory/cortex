/**
 * F-8 task table — pure filter + sort + empty-state classification.
 *
 * Extracted from the legacy monolith's `applyTasksFilters` /
 * `compareTasksByKey` (`dashboard/index.html:2177-2237`) so the same logic
 * runs in the React app and is unit-testable without a DOM.
 *
 * The functions in here are deliberately pure — they take the full task
 * list + filter state and return a new sorted/filtered array. No state,
 * no setters, no side effects. Per F-8 Decision 4 the aggregate-state
 * comparator partitions tasks with `aggregate_state === null` to the
 * bottom regardless of sort direction (legacy comment at L2197-L2201).
 */

import type { TaskListItem } from "../../db/tasks";
import type { AssignmentState } from "../../types";
import { STATE_RANK_BY_STATE } from "./state-ranks";

/** Sort columns the principal can toggle from the table header. */
export type TaskSortKey =
  | "default"   // server-default order (priority ASC, updated_at DESC)
  | "priority"
  | "title"
  | "agents"
  | "state"
  | "age";

export type SortDir = "asc" | "desc";

export interface TaskSortState {
  key: TaskSortKey;
  dir: SortDir;
}

export interface TaskFilterState {
  /**
   * Empty set = "all priorities" (no filter). When non-empty, only tasks
   * whose `priority` is in the set survive.
   *
   * Per F-8 Decision 3 v1 priority filter is a multi-select. We use a
   * `Set<number>` because membership tests are O(1) and the legacy hash
   * roundtrip serializes to a comma-separated list.
   */
  priorities: Set<number>;
  /** Hide tasks younger than this many minutes (0 = no threshold). */
  ageMinMinutes: number;
  /** Case-insensitive substring match on title; "" = no filter. */
  search: string;
  /**
   * F-8 Decision 6 — closed tasks are server-filtered by default; this
   * flag is mirrored client-side because the empty-state classifier needs
   * it ("all closed" vs "no tasks at all" vs "filter excludes all").
   */
  includeClosed: boolean;
  /**
   * F-16 — pin the table to a single iteration. NULL = no filter (all
   * tasks visible). When set, only tasks whose denormalised
   * `iteration.id` matches survive. Driven by the `?iter=<id>` hash
   * param so a principal can deep-link "tasks in iteration X" from
   * the iteration detail surface or share a kanban-context URL.
   *
   * Per design spec §"Surface 3" — "extend the task-table hash-state
   * filter to include `?iter=<id>` so principals can pin to one
   * iteration. Optional but nice — defer if it adds significant
   * complexity." Implementation cost is one new field + four lines
   * in the hash codec; the principal value is high (one-click
   * "what tasks are in this iteration").
   */
  iterationId: string | null;
}

/**
 * Apply filters then (optionally) re-sort. Mirrors the legacy two-pass
 * partition for `aggregate_state` ordering — see comment in the body for
 * the "null last always" invariant.
 *
 * `nowMs` is parameterised so tests can pin time without touching the
 * global clock.
 */
export function applyTaskFilters(
  all: readonly TaskListItem[],
  filters: TaskFilterState,
  sort: TaskSortState,
  nowMs: number = Date.now()
): TaskListItem[] {
  const ageThresholdMs = filters.ageMinMinutes * 60 * 1000;
  const needle = filters.search.trim().toLowerCase();

  const filtered = all.filter((t) => {
    if (filters.priorities.size > 0 && !filters.priorities.has(t.priority)) return false;
    if (ageThresholdMs > 0) {
      const created = Date.parse(t.created_at);
      if (Number.isFinite(created) && nowMs - created < ageThresholdMs) return false;
    }
    if (needle.length > 0 && !t.title.toLowerCase().includes(needle)) return false;
    // F-16 — iteration pin. Match on the denormalised tag id; tasks
    // without an iteration (`t.iteration === null`) are excluded when
    // the filter is active. The "ungrouped" lane is reachable via a
    // sentinel filter value (deferred — principals can clear the
    // filter to see ungrouped tasks).
    if (filters.iterationId !== null) {
      if (!t.iteration || t.iteration.id !== filters.iterationId) return false;
    }
    return true;
  });

  if (sort.key === "default") return filtered;

  const mul = sort.dir === "desc" ? -1 : 1;
  if (sort.key === "state") {
    // Two-pass partition: tasks with `aggregate_state === null` always sink
    // to the bottom regardless of direction. A single-pass comparator
    // can't express "null last always" because desc flips every return.
    // Mirrors legacy `applyTasksFilters` (dashboard/index.html:2197-2209).
    const withState: TaskListItem[] = [];
    const nullState: TaskListItem[] = [];
    for (const row of filtered) {
      if (row.aggregate_state === null) nullState.push(row);
      else withState.push(row);
    }
    withState.sort((a, b) => compareByKey(a, b, sort.key) * mul);
    return withState.concat(nullState);
  }

  // Sort a copy — never mutate the input.
  return filtered.slice().sort((a, b) => compareByKey(a, b, sort.key) * mul);
}

/**
 * Pure comparator for one sort column. Exported only so unit tests can
 * pin per-column ordering without standing up the whole pipeline.
 */
export function compareByKey(
  a: TaskListItem,
  b: TaskListItem,
  key: TaskSortKey
): number {
  if (key === "priority") return a.priority - b.priority;
  if (key === "title") return a.title.localeCompare(b.title);
  if (key === "agents") return a.assignments.length - b.assignments.length;
  if (key === "state") {
    // Null aggregate_state is handled by the partition pass above; by the
    // time we get here both sides are non-null. Fallback to 99 keeps the
    // function total when called directly (e.g. from a unit test).
    const ra = a.aggregate_state ? STATE_RANK_BY_STATE[a.aggregate_state] : 99;
    const rb = b.aggregate_state ? STATE_RANK_BY_STATE[b.aggregate_state] : 99;
    return ra - rb;
  }
  if (key === "age") {
    // Newer tasks have larger `created_at`; ASC = oldest first.
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  }
  return 0;
}

/** What the table should render when `visible` is empty — F-8 Decision 7. */
export type TaskEmptyKind =
  | "no-tasks-at-all"
  | "all-closed-hidden"
  | "filter-excludes-all"
  | "no-match";

/**
 * Classify the empty-state copy. Order matters — "no tasks at all" beats
 * the closed/filter cases because it's the single most informative thing
 * to say ("dashboard is empty"). Mirrors legacy `renderTasksEmpty`.
 */
export function classifyEmpty(
  all: readonly TaskListItem[],
  filters: TaskFilterState
): TaskEmptyKind {
  if (all.length === 0) return "no-tasks-at-all";
  const anyOpen = all.some((t) => t.status !== "done" && t.status !== "cancelled");
  if (!filters.includeClosed && !anyOpen) return "all-closed-hidden";
  const filterActive =
    filters.priorities.size > 0 ||
    filters.ageMinMinutes > 0 ||
    filters.search.length > 0 ||
    // F-16 — iteration pin counts as an active filter so the empty
    // state's "Clear filters" button surfaces (principal's path back
    // when an iteration filter excludes everything).
    filters.iterationId !== null;
  if (filterActive) return "filter-excludes-all";
  return "no-match";
}

/**
 * F-8 Decision 5 — pick the "primary active" assignment for drill-down
 * entry from a task's assignments roll-up.
 *
 *  1. Prefer the lowest aggregate-state rank (blocked first).
 *  2. Within the same rank, prefer the most-recent `updated_at`.
 *
 * Returns `null` for an empty list. Pure; mirrors the legacy
 * `pickPrimaryAssignment` (dashboard/index.html:2433-2448).
 */
export function pickPrimaryAssignment<
  T extends { state: AssignmentState; updated_at: string }
>(assignments: readonly T[]): T | null {
  if (!assignments || assignments.length === 0) return null;
  let best: T | null = null;
  let bestRank = Infinity;
  let bestUpdated = -Infinity;
  for (const a of assignments) {
    const r = STATE_RANK_BY_STATE[a.state] ?? 99;
    const u = Date.parse(a.updated_at) || 0;
    if (r < bestRank || (r === bestRank && u > bestUpdated)) {
      best = a;
      bestRank = r;
      bestUpdated = u;
    }
  }
  return best;
}

/**
 * Short relative-age label for the table cell — `5s`, `12m`, `3h`, `2d`.
 *
 * Mirrors the legacy `ageLabel` in `dashboard/index.html:2383-2395`.
 * Returns `"—"` for an unparseable input so the table cell never renders
 * the literal string `"NaNs"` on a corrupt timestamp.
 */
export function ageLabel(iso: string, nowMs: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, nowMs - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/**
 * F-8 Decision 2 — agent-chip overflow shape. Returns the slice that
 * renders as named chips plus the `+N` overflow count. When there are 3
 * or fewer assignments, every one renders as a named chip (overflow = 0);
 * past that threshold the first 2 render plus a `+N` tail (matches the
 * legacy `MAX_VISIBLE = 3` slice rule at dashboard/index.html:2363-2380).
 */
export function chipOverflow<T>(
  assignments: readonly T[]
): { visible: T[]; overflow: number } {
  if (!assignments || assignments.length === 0) return { visible: [], overflow: 0 };
  const MAX_VISIBLE = 3;
  // Legacy slice: when overflow exists, keep only MAX_VISIBLE - 1 named chips
  // and let the `+N` tail fill the third slot.
  const tailReserved = assignments.length > MAX_VISIBLE ? 1 : 0;
  const visible = assignments.slice(0, MAX_VISIBLE - tailReserved);
  const overflow = assignments.length - visible.length;
  return { visible: [...visible], overflow };
}
