/**
 * F-8 task table hook.
 *
 * Fetches `GET /api/tasks` once at mount and re-fetches on `state.transition`,
 * `task.created`, and `task.updated` WS frames (debounced 100 ms — matches
 * the legacy `TASKS_REFETCH_DEBOUNCE_MS` at dashboard/index.html:2146).
 *
 * Per F-8 Decision 1 the server-default sort + `includeClosed` flag are
 * driven by the `includeClosed` filter, which round-trips to the server
 * (changing `includeClosed` is the only filter mutation that re-issues
 * the network request — every other filter is client-side over the
 * already-fetched 500-row payload, per Decision 1).
 *
 * Concurrency model mirrors `use-focus-area`: per-fetch generation +
 * `AbortController` so out-of-order responses can't clobber a fresher
 * WS-triggered refetch (sweep W3 from MIG-2). Hash state is owned here
 * so the URL stays canonical across React StrictMode remount cycles.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import {
  applyTaskFilters,
  type TaskFilterState,
  type TaskSortState,
} from "../lib/task-table-filter";
import {
  defaultHashState,
  parseHash,
  serializeHash,
} from "../lib/task-table-hash";
import type { WsClient, WsMessage } from "./use-websocket";
import { useProjectionRefetch } from "./use-projection-refetch";
import { ITERATION_STATES, type IterationState } from "../../db/iterations";
import type { TaskListItem } from "../../db/tasks";
import {
  patchIterationOnRows,
  validateIterationUpdatedPayload,
  validateTaskUpdatedPayload,
  type IterationTagPatch,
} from "../lib/iteration-display";

const TASKS_REFETCH_DEBOUNCE_MS = 100;

interface TasksResponse {
  tasks: TaskListItem[];
}

export interface TasksHookState {
  /** All tasks the server returned for the current `includeClosed` setting. */
  all: TaskListItem[];
  /** Filtered + sorted projection of `all` per the current filter/sort state. */
  visible: TaskListItem[];
  loaded: boolean;
  error: string | null;

  filters: TaskFilterState;
  sort: TaskSortState;

  // Filter / sort mutators — each writes to the hash and re-applies.
  // `setIncludeClosed` re-fetches because the server payload changes.
  togglePriority: (p: number) => void;
  setAgeMinMinutes: (n: number) => void;
  setSearch: (s: string) => void;
  setIncludeClosed: (v: boolean) => void;
  toggleSort: (key: TaskSortState["key"]) => void;
  clearAll: () => void;
  /**
   * F-16 — pin the table to a single iteration (or pass `null` to
   * clear). Mirrors the `?iter=<id>` hash param. No round-trip — the
   * filter is purely client-side over the already-fetched payload.
   */
  setIterationFilter: (id: string | null) => void;

  /** Manual refetch — used by the "+ Add task" success path. */
  refetch: () => void;
}

export function useTasks(ws: WsClient): TasksHookState {
  // Initial state: parse the hash once at mount so a deep-link URL
  // restores filters before the first fetch.
  const initial = parseHash(typeof location === "object" ? location.hash : "");

  const [all, setAll] = useState<TaskListItem[]>([]);
  const [visible, setVisible] = useState<TaskListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<TaskFilterState>(initial.filters);
  const [sort, setSort] = useState<TaskSortState>(initial.sort);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);
  const inflightRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  // Keep refs synced so `refetch` doesn't need filters/sort in its deps.
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const sortRef = useRef(sort); sortRef.current = sort;

  const recomputeVisible = useCallback((rows: TaskListItem[]) => {
    setVisible(applyTaskFilters(rows, filtersRef.current, sortRef.current));
  }, []);

  const refetch = useCallback(async () => {
    if (!aliveRef.current) return;
    inflightRef.current?.abort();
    const controller = new AbortController();
    inflightRef.current = controller;
    const myGen = ++genRef.current;

    try {
      const includeClosed = filtersRef.current.includeClosed;
      const qs = includeClosed ? "?includeClosed=true" : "";
      const body = await getJson<TasksResponse>(`/api/tasks${qs}`, {
        signal: controller.signal,
      });
      if (!aliveRef.current || myGen !== genRef.current) return;
      const rows = body.tasks ?? [];
      setAll(rows);
      recomputeVisible(rows);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (!aliveRef.current || myGen !== genRef.current) return;
      const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
      setError(msg);
    } finally {
      if (inflightRef.current === controller) inflightRef.current = null;
      if (aliveRef.current && myGen === genRef.current) setLoaded(true);
    }
  }, [recomputeVisible]);

  // Initial fetch + lifetime tracking. Mirror of `use-focus-area`.
  useEffect(() => {
    aliveRef.current = true;
    refetch();
    return () => {
      aliveRef.current = false;
      genRef.current++;
      inflightRef.current?.abort();
      inflightRef.current = null;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refetch]);

  // WS subscriptions — re-fetch on every state.transition, plus task.created
  // and task.updated. Per F-8 final scope-summary paragraph: F-6 filters
  // blocked-only because focus-area membership only changes there; F-8
  // can't filter because aggregate_state depends on the full seven-state
  // rank, so any transition can flip a task's aggregate.
  const subscribe = ws.subscribe;
  useEffect(() => {
    const onAny = (_msg: WsMessage) => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, TASKS_REFETCH_DEBOUNCE_MS);
    };
    const u1 = subscribe("state.transition", onAny);
    const u2 = subscribe("task.created", onAny);
    const u3 = subscribe("task.updated", onAny);
    return () => {
      u1(); u2(); u3();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [subscribe, refetch]);

  // C-863 — refresh off the S6 `mc.projection` broadcast: a `dispatch.lifecycle`
  // projection write can flip a task's aggregate state (any dispatch transition
  // ranks into the seven-state aggregate), so the task table re-reads on it. Uses
  // its own (wider) trailing debounce so a dispatch fan-out coalesces into one
  // refetch; `refetch` is the same stable zero-arg callback the WS effect uses.
  useProjectionRefetch(ws, "tasks", refetch);

  // F-16 — patch the denormalised `iteration` tag on cached task rows
  // when an `iteration.updated` frame arrives. Two reasons NOT to
  // refetch like the assignment path:
  //
  //   1. The frame already carries the new (id, title, state); we
  //      can mutate in place without paying a round-trip. The kanban
  //      hook does the same.
  //   2. The set of tasks attached to an iteration doesn't change on
  //      a body / title / state edit — only attach/detach changes
  //      that, and those now broadcast a `task.updated` (F-16 sweep,
  //      Echo grove-v2#43 Major 1) which carries the fresh
  //      `TaskListItem` so we replace the row in place rather than
  //      try to patch via id (which can't observe `null → attached`).
  //
  // We subscribe to the BROADCAST `iteration.updated` (header-only
  // `IterationListItem`) since that's the wire shape we apply. The
  // narrower `iteration.detail_updated` is for the detail surface
  // and carries the body / tasks delta we don't need here.
  //
  // Per Echo grove-v2#43 sweep:
  //   - Major 3 — patch logic centralised in `patchIterationOnRows`
  //     so use-tasks + use-focus-area share one implementation.
  //   - Major 4 — runtime shape check via
  //     `validateIterationUpdatedPayload` so a malformed frame is
  //     dropped silently instead of crashing the cached row at render.
  //   - Major 2 — the `iteration.state_changed` subscription is
  //     belt-and-braces: defensive against a future broadcast-ordering
  //     refactor. The current order has `iteration.updated` arriving
  //     first with the new state already present, so the state-changed
  //     handler is redundant in steady state. Costs nothing and
  //     protects against ordering regressions.
  useEffect(() => {
    function onIterationUpdated(msg: WsMessage) {
      const patch = validateIterationUpdatedPayload(msg["iteration"]);
      if (!patch) return;
      setAll((rows) => patchIterationOnRows(rows, patch));
      setVisible((rows) => patchIterationOnRows(rows, patch));
    }
    function onIterationStateChanged(msg: WsMessage) {
      const id = msg["iterationId"];
      const to = msg["to"];
      if (
        typeof id !== "string" ||
        typeof to !== "string" ||
        !ITERATION_STATES.includes(to as IterationState)
      ) return;
      const patch: IterationTagPatch = { id, state: to as IterationState };
      setAll((rows) => patchIterationOnRows(rows, patch));
      setVisible((rows) => patchIterationOnRows(rows, patch));
    }
    function onTaskUpdated(msg: WsMessage) {
      // Echo grove-v2#43 Major 1 — replace the cached row in place.
      // The fresh `TaskListItem` carries the up-to-date `iteration`
      // denorm (including the `null → attached`, `attached → null`,
      // and inter-iteration moves that `iteration.updated` cannot
      // patch).
      //
      // Per Echo grove-v2#43 sweep #2 — runtime shape check via
      // `validateTaskUpdatedPayload`, symmetric with the iteration
      // validator. A malformed frame with `iteration: { title: 42 }`
      // would otherwise crash `chipText`'s `.slice(...)` at render.
      const task = validateTaskUpdatedPayload(msg["task"]);
      if (!task) return;
      const replaceById = (rows: TaskListItem[]): TaskListItem[] => {
        let changed = false;
        const next = rows.map((row) => {
          if (row.id !== task.id) return row;
          changed = true;
          return task;
        });
        return changed ? next : rows;
      };
      setAll(replaceById);
      setVisible(replaceById);
    }
    const u1 = subscribe("iteration.updated", onIterationUpdated);
    const u2 = subscribe("iteration.state_changed", onIterationStateChanged);
    const u3 = subscribe("task.updated", onTaskUpdated);
    return () => {
      u1();
      u2();
      u3();
    };
  }, [subscribe]);

  // ----- mutators -----

  // After any filter/sort change: persist to hash, recompute visible.
  // `includeClosed` additionally re-fetches because the server payload
  // changes (closed rows are server-side excluded by default).
  const writeHash = useCallback((nextFilters: TaskFilterState, nextSort: TaskSortState) => {
    const hash = serializeHash({ filters: nextFilters, sort: nextSort });
    if (typeof location !== "object" || typeof history !== "object") return;
    if (location.hash === hash) return;
    // replaceState — don't pollute history with every keystroke.
    const fallback = window.location.pathname + window.location.search;
    history.replaceState(null, "", hash || fallback);
  }, []);

  const togglePriority = useCallback((p: number) => {
    setFilters((prev) => {
      const next = { ...prev, priorities: new Set(prev.priorities) };
      if (next.priorities.has(p)) next.priorities.delete(p);
      else next.priorities.add(p);
      writeHash(next, sortRef.current);
      // Recompute against the CURRENT `all` rows synchronously via the
      // ref-bound recompute helper.
      filtersRef.current = next;
      // Apply against the freshest known `all` — read it via state's
      // closure (we're inside a setState updater so this is safe).
      return next;
    });
  }, [writeHash]);

  const setAgeMinMinutes = useCallback((n: number) => {
    setFilters((prev) => {
      const next = { ...prev, ageMinMinutes: Number.isFinite(n) && n > 0 ? n : 0 };
      writeHash(next, sortRef.current);
      filtersRef.current = next;
      return next;
    });
  }, [writeHash]);

  const setSearch = useCallback((s: string) => {
    setFilters((prev) => {
      const next = { ...prev, search: s };
      writeHash(next, sortRef.current);
      filtersRef.current = next;
      return next;
    });
  }, [writeHash]);

  const setIncludeClosed = useCallback((v: boolean) => {
    setFilters((prev) => {
      const next = { ...prev, includeClosed: v };
      writeHash(next, sortRef.current);
      filtersRef.current = next;
      return next;
    });
    // Server round-trip — payload composition changes.
    // `setFilters` above already mutated `filtersRef`, so `refetch` reads
    // the new value.
    refetch();
  }, [refetch, writeHash]);

  const setIterationFilter = useCallback((id: string | null) => {
    // F-16 — pin the table to a single iteration. Pure client-side
    // (no refetch) — the filter operates on the already-fetched
    // `all` payload via `applyTaskFilters`. Round-trips to
    // `?iter=<id>` so the URL is shareable.
    setFilters((prev) => {
      const next = { ...prev, iterationId: id };
      writeHash(next, sortRef.current);
      filtersRef.current = next;
      return next;
    });
  }, [writeHash]);

  const toggleSort = useCallback((key: TaskSortState["key"]) => {
    setSort((prev) => {
      const next: TaskSortState = prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" };
      writeHash(filtersRef.current, next);
      sortRef.current = next;
      return next;
    });
  }, [writeHash]);

  const clearAll = useCallback(() => {
    const fresh = defaultHashState();
    setFilters(fresh.filters);
    setSort(fresh.sort);
    filtersRef.current = fresh.filters;
    sortRef.current = fresh.sort;
    writeHash(fresh.filters, fresh.sort);
    refetch(); // includeClosed may have flipped
  }, [refetch, writeHash]);

  // Re-derive visible whenever filters, sort, or all change.
  useEffect(() => {
    recomputeVisible(all);
  }, [filters, sort, all, recomputeVisible]);

  // Hashchange listener — back/forward navigation should restore filters.
  useEffect(() => {
    const onHash = () => {
      const next = parseHash(location.hash);
      setFilters(next.filters);
      setSort(next.sort);
      filtersRef.current = next.filters;
      sortRef.current = next.sort;
      // Re-fetch in case includeClosed differs.
      refetch();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refetch]);

  return {
    all,
    visible,
    loaded,
    error,
    filters,
    sort,
    togglePriority,
    setAgeMinMinutes,
    setSearch,
    setIncludeClosed,
    toggleSort,
    clearAll,
    setIterationFilter,
    refetch,
  };
}
