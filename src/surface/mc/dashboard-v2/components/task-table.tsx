/**
 * F-8 task table — the primary funnel surface below the focus area.
 *
 * Receives the already-filtered `visible` list from `useTasks`, plus the
 * filter/sort state and mutators. Row click opens the F-7 drill-down on
 * the task's primary active assignment (Decision 5; tie-break for
 * "primary" lives in `lib/task-table-filter.ts`'s `pickPrimaryAssignment`).
 *
 * Per Decision 9 the keyboard shortcuts here are scoped to the dashboard
 * surface — when the drill-down overlay is open it owns every keystroke.
 * Implementation guard: skip the listener when an `INPUT`/`TEXTAREA` is
 * focused or when `drillOpen === true`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "./task-table.css";
import { AgentChips } from "./agent-chips";
import { TaskFilters } from "./task-filters";
import { AddTaskModal } from "./add-task-modal";
import { DispatchButton } from "./dispatch-button";
import { Pill } from "./pill";
import { DEFAULT_AGENT_DISPLAY_NAME } from "../lib/agent-defaults";
import {
  chipPillKind,
  chipTooltip,
  truncateIterationTitle,
} from "../lib/iteration-display";
import {
  ageLabel,
  classifyEmpty,
  pickPrimaryAssignment,
  type TaskFilterState,
  type TaskSortKey,
  type TaskSortState,
} from "../lib/task-table-filter";
import type { TaskListItem } from "../../db/tasks";

/**
 * F-16 — `iteration` column lands between "Title" and "Agents". It's
 * NOT a sortable key (the existing `TaskSortKey` union is sort-only;
 * iteration sort is a Phase G affordance). Modelled as a discriminated
 * shape: sortable columns carry a `sortKey`, the iteration column does
 * not. The header click handler reads `sortKey` and only fires when
 * present.
 *
 * Two reasons to model this explicitly rather than widening
 * `TaskSortKey` with a no-op `"iteration"` value:
 *   1. `compareByKey` is `total` over `TaskSortKey` — adding a key
 *      forces a `case "iteration": return 0` branch that drifts
 *      relative to the column header click handler.
 *   2. The hash codec validates `sort` against `SORT_KEYS`; widening
 *      the union without adding a comparator silently allows
 *      `?sort=iteration:asc` URLs that "work" by doing nothing.
 *
 * The shape below keeps the iteration header a static label.
 */
type ColDef =
  | { kind: "sortable"; sortKey: TaskSortKey; label: string }
  | { kind: "static"; key: string; label: string; ariaLabel?: string };

const COLS: readonly ColDef[] = [
  { kind: "sortable", sortKey: "priority", label: "P" },
  { kind: "sortable", sortKey: "title", label: "Title" },
  { kind: "static", key: "iteration", label: "Iteration" },
  { kind: "sortable", sortKey: "agents", label: "Agents" },
  { kind: "sortable", sortKey: "state", label: "State" },
  { kind: "sortable", sortKey: "age", label: "Age" },
  // F-19 — actions column. Currently single action (Dispatch); kept as a
  // dedicated column so future per-row actions don't reshape the table.
  // `ariaLabel` carries the screen-reader name since `label` is empty
  // (visual minimalism; the column header carries no glyph).
  { kind: "static", key: "actions", label: "", ariaLabel: "Actions" },
];

export interface TaskTableProps {
  all: readonly TaskListItem[];
  visible: readonly TaskListItem[];
  loaded: boolean;
  error: string | null;

  filters: TaskFilterState;
  sort: TaskSortState;

  onTogglePriority: (p: number) => void;
  onAgeChange: (n: number) => void;
  onSearchChange: (s: string) => void;
  onIncludeClosedChange: (v: boolean) => void;
  onToggleSort: (key: TaskSortKey) => void;
  onClear: () => void;

  /**
   * Called when the operator opens a task. Receives the assignment id of
   * the task's primary active assignment (Decision 5 tie-break). For
   * empty-assignment tasks the parent should fall back to the
   * `shadow_assignment_id` (F-12b Decision 7).
   */
  onOpenTask: (task: TaskListItem) => void;

  /** Refetch trigger — passed through to the AddTaskModal success path. */
  onRefetch: () => void;

  /**
   * True when the drill-down overlay is open. Used to suppress this
   * component's keyboard handlers (legacy: `if (!drillEl.hidden) return`).
   */
  drillOpen: boolean;

  /**
   * F-16 — clicking an iteration cell routes the App to the iteration
   * detail surface. Optional so the table can be embedded in tests
   * without iteration routing wired; click-without-handler is a no-op.
   */
  onOpenIteration?: (iterationId: string) => void;

  /**
   * F-19 — operator clicks Dispatch on a task row. Caller fires
   * `POST /api/sessions { taskId }`. Optional so embedding tests
   * without dispatch wiring is a no-op (button stays hidden).
   */
  onDispatch?: (task: TaskListItem) => void;
  /** Set of taskIds with an in-flight dispatch — disables the button. */
  dispatchingTaskIds?: ReadonlySet<string>;
  /** Display name for the agent that will receive the dispatch. Default "Default Agent". */
  dispatchAgentLabel?: string;
}

export function TaskTable(props: TaskTableProps) {
  const {
    all, visible, loaded, error,
    filters, sort,
    onTogglePriority, onAgeChange, onSearchChange,
    onIncludeClosedChange, onToggleSort, onClear,
    onOpenTask, onRefetch, drillOpen,
    onOpenIteration,
    onDispatch,
    dispatchingTaskIds,
    dispatchAgentLabel,
  } = props;

  const [focusedRowIdx, setFocusedRowIdx] = useState(-1);
  const [addOpen, setAddOpen] = useState(false);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const ageInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Clamp focused index when the visible list shrinks below it.
  useEffect(() => {
    if (focusedRowIdx >= visible.length) setFocusedRowIdx(-1);
  }, [visible.length, focusedRowIdx]);

  // Keyboard handlers — scoped to dashboard surface (drill closed).
  // Latest-values ref so the listener can attach once with []-deps.
  const ctxRef = useRef({
    visible, focusedRowIdx, drillOpen, addOpen,
    onOpenTask,
  });
  ctxRef.current = { visible, focusedRowIdx, drillOpen, addOpen, onOpenTask };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ctx = ctxRef.current;
      // Drill-down owns input when open. AddTask modal owns input too.
      if (ctx.drillOpen || ctx.addOpen) return;
      const target = e.target;
      const tag = target instanceof HTMLElement ? target.tagName : "";
      const inInput = tag === "INPUT" || tag === "TEXTAREA";

      if (e.key === "f" && !inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ageInputRef.current?.focus();
        return;
      }
      if (e.key === "/" && !inInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (inInput) return;
      if (e.key === "ArrowDown" && ctx.visible.length > 0) {
        const next = ctx.focusedRowIdx < 0 ? 0 : Math.min(ctx.focusedRowIdx + 1, ctx.visible.length - 1);
        setFocusedRowIdx(next);
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowUp" && ctx.visible.length > 0) {
        const next = Math.max(ctx.focusedRowIdx - 1, 0);
        setFocusedRowIdx(next);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && ctx.focusedRowIdx >= 0) {
        const t = ctx.visible[ctx.focusedRowIdx];
        if (t) {
          e.preventDefault();
          ctx.onOpenTask(t);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll the focused row into view when it changes.
  useEffect(() => {
    if (focusedRowIdx < 0 || !tbodyRef.current) return;
    const row = tbodyRef.current.children[focusedRowIdx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedRowIdx]);

  const handleHeaderClick = useCallback((key: TaskSortKey) => () => {
    onToggleSort(key);
  }, [onToggleSort]);

  return (
    <section className="tasks-section" aria-label="Task table">
      <h2>Tasks</h2>
      {error && (
        <div className="tasks-error" role="alert">
          Failed to load tasks: {error}
        </div>
      )}
      <TaskFilters
        filters={filters}
        onTogglePriority={onTogglePriority}
        onAgeChange={onAgeChange}
        onSearchChange={onSearchChange}
        onIncludeClosedChange={onIncludeClosedChange}
        onClear={onClear}
        onOpenAddTask={() => setAddOpen(true)}
      />

      <div className="tasks-table-wrap">
        <table className="tasks-table" id="tasks-table">
          <thead>
            <tr id="tasks-thead-row">
              {COLS.map((c) => {
                if (c.kind === "static") {
                  // F-16 — non-sortable iteration column: plain
                  // header, no click handler, no sort indicator.
                  // F-19 — `ariaLabel` carries the screen-reader name
                  // when `label` is empty (the actions column has no
                  // visible glyph but still needs an accessible name).
                  return (
                    <th
                      key={c.key}
                      data-col={c.key}
                      {...(c.ariaLabel ? { "aria-label": c.ariaLabel } : {})}
                    >
                      {c.label}
                    </th>
                  );
                }
                const cls =
                  sort.key === c.sortKey
                    ? sort.dir === "desc" ? "sort-desc" : "sort-asc"
                    : "";
                return (
                  <th
                    key={c.sortKey}
                    data-col={c.sortKey}
                    className={cls}
                    onClick={handleHeaderClick(c.sortKey)}
                  >
                    {c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody id="tasks-tbody" ref={tbodyRef}>
            {visible.map((t, idx) => (
              <TaskRow
                key={t.id}
                task={t}
                focused={idx === focusedRowIdx}
                onClick={() => onOpenTask(t)}
                {...(onOpenIteration ? { onOpenIteration } : {})}
                {...(onDispatch ? { onDispatch } : {})}
                dispatching={dispatchingTaskIds?.has(t.id) ?? false}
                dispatchAgentLabel={dispatchAgentLabel ?? DEFAULT_AGENT_DISPLAY_NAME}
              />
            ))}
          </tbody>
        </table>
      </div>

      {!loaded ? (
        <div className="tasks-empty dim">Loading…</div>
      ) : visible.length === 0 ? (
        <TaskTableEmpty all={all} filters={filters} onClear={onClear} />
      ) : null}

      <AddTaskModal
        open={addOpen}
        all={all}
        onClose={() => setAddOpen(false)}
        onCreated={onRefetch}
        onOpenExisting={(task) => {
          setAddOpen(false);
          onOpenTask(task);
        }}
      />

      {/*
        Hidden refs hookup — `f` focuses the age input, `/` focuses search.
        We re-bind to the actual DOM nodes by querying inside the filter
        component's rendered IDs (legacy parity).
      */}
      <FilterRefBinder ageRef={ageInputRef} searchRef={searchInputRef} />
    </section>
  );
}

function TaskRow({
  task,
  focused,
  onClick,
  onOpenIteration,
  onDispatch,
  dispatching,
  dispatchAgentLabel,
}: {
  task: TaskListItem;
  focused: boolean;
  onClick: () => void;
  onOpenIteration?: (iterationId: string) => void;
  onDispatch?: (task: TaskListItem) => void;
  dispatching: boolean;
  dispatchAgentLabel: string;
}) {
  const closed = task.status === "done" || task.status === "cancelled";
  const cls = [
    "task-row",
    focused ? "focused" : "",
    closed ? "closed" : "",
  ].filter(Boolean).join(" ");
  // F-16 — iteration cell click navigates to the detail surface.
  // We stop event propagation so the row's `onClick` (which opens
  // the task drill-down) doesn't ALSO fire — clicking the cell is
  // an iteration-navigation intent, not a task-drill-down intent.
  const handleIterationClick = (
    e: React.MouseEvent<HTMLElement>,
    iterationId: string
  ) => {
    e.stopPropagation();
    onOpenIteration?.(iterationId);
  };
  return (
    <tr
      className={cls}
      data-task-id={task.id}
      tabIndex={0}
      onClick={onClick}
    >
      <td
        className="prio"
        style={{
          color:
            task.priority === 0 ? "var(--bad, #ff6b6b)" :
              task.priority === 1 ? "var(--warn, #f4c95d)" :
                "var(--text-dim, var(--fg-dim))",
        }}
      >
        P{task.priority}
      </td>
      <td className="title">{task.title}</td>
      <td className="iteration">
        {task.iteration ? (
          <button
            type="button"
            className="iteration-cell-btn"
            title={chipTooltip(task.iteration)}
            aria-label={`Open iteration ${task.iteration.title}`}
            onClick={(e) => handleIterationClick(e, task.iteration!.id)}
            disabled={!onOpenIteration}
          >
            <Pill kind={chipPillKind(task.iteration)}>
              {truncateIterationTitle(task.iteration.title)}
            </Pill>
          </button>
        ) : (
          // F-16 — ungrouped tasks render the same em-dash placeholder
          // the legacy `state` column uses. The dashboard's column
          // header is always present so an empty cell would misalign
          // adjacent columns; "—" is the canonical "no value" glyph.
          <span className="no-iteration" title="Not in any iteration">—</span>
        )}
      </td>
      <td className="agents">
        <AgentChips assignments={task.assignments} />
      </td>
      <td className="state">
        {task.aggregate_state === null ? (
          <span className="no-state" title="No assignment yet">—</span>
        ) : (
          <Pill kind={`state-${task.aggregate_state}`}>{task.aggregate_state}</Pill>
        )}
      </td>
      <td className="age">{ageLabel(task.created_at)}</td>
      <td className="actions">
        {/* F-19 — Dispatch is gated on (a) caller passing onDispatch and
         *   (b) the task having no active assignment yet. Closed tasks
         *   (done/cancelled) also hide the button — re-dispatch is
         *   F-19.4 follow-up. */}
        {onDispatch && task.aggregate_state === null && !closed ? (
          <DispatchButton
            agentLabel={dispatchAgentLabel}
            busy={dispatching}
            onConfirm={() => onDispatch(task)}
          />
        ) : null}
      </td>
    </tr>
  );
}

function TaskTableEmpty({
  all,
  filters,
  onClear,
}: {
  all: readonly TaskListItem[];
  filters: TaskFilterState;
  onClear: () => void;
}) {
  const kind = classifyEmpty(all, filters);
  if (kind === "no-tasks-at-all") {
    return (
      <div className="tasks-empty">
        No tasks in this workspace yet. When agents are dispatched or issues are queued, they appear here.
      </div>
    );
  }
  if (kind === "all-closed-hidden") {
    return (
      <div className="tasks-empty">
        All tasks here are closed. Toggle "Show closed" above to see them.
      </div>
    );
  }
  if (kind === "filter-excludes-all") {
    return (
      <div className="tasks-empty">
        No tasks match the current filter.
        <button type="button" onClick={onClear}>Clear filters</button>
      </div>
    );
  }
  return <div className="tasks-empty">No tasks match.</div>;
}

/**
 * Hidden helper — looks up the rendered #age-min and #title-search inputs
 * once after the filter component mounts and stuffs them into the parent
 * refs so the keyboard handler can focus them.
 *
 * This is the smallest possible glue between the keyboard handler in
 * `TaskTable` and the filter component without forcing every TaskFilters
 * caller to manage refs by hand.
 */
function FilterRefBinder({
  ageRef,
  searchRef,
}: {
  ageRef: React.MutableRefObject<HTMLInputElement | null>;
  searchRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  useEffect(() => {
    ageRef.current = document.getElementById("age-min") as HTMLInputElement | null;
    searchRef.current = document.getElementById("title-search") as HTMLInputElement | null;
  });
  return null;
}

/**
 * Convenience export — the parent (App) wires this to its drill-down
 * trigger. Lives here because the tie-break rule (blocked > recent
 * updated_at) belongs to F-8 Decision 5 and the legacy bundles them
 * together.
 *
 * Returns the assignment id to drill on, or `null` when the task has
 * no real or shadow assignment (rare; legacy fallback shows an error
 * pill — the caller can do the same).
 */
export function resolveOpenTarget(task: TaskListItem): string | null {
  const pick = pickPrimaryAssignment(task.assignments);
  if (pick) return pick.id;
  // F-12b — empty-assignment path. Tasks created via the GitHub-import
  // flow ship with a shadow assignment; opening it lets the F-12 toolbar
  // render the "no assignments yet" enablement row (Dispatch + Abandon).
  if (task.shadow_assignment_id) return task.shadow_assignment_id;
  return null;
}
