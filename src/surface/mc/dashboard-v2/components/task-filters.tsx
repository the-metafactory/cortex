/**
 * F-8 task-filter bar — priority chips + age threshold + title search +
 * Show-closed toggle + Clear-filters button + the F-12b "+ Add task"
 * trigger sitting at the right edge.
 *
 * State is owned by `useTasks` (single source of truth, hash-persisted);
 * this component is purely presentational.
 */

import type { TaskFilterState } from "../lib/task-table-filter";

const PRIORITIES: readonly number[] = [0, 1, 2, 3];

export interface TaskFiltersProps {
  filters: TaskFilterState;
  onTogglePriority: (p: number) => void;
  onAgeChange: (n: number) => void;
  onSearchChange: (s: string) => void;
  onIncludeClosedChange: (v: boolean) => void;
  onClear: () => void;
  onOpenAddTask: () => void;
}

export function TaskFilters({
  filters,
  onTogglePriority,
  onAgeChange,
  onSearchChange,
  onIncludeClosedChange,
  onClear,
  onOpenAddTask,
}: TaskFiltersProps) {
  return (
    <div className="tasks-filters" id="tasks-filters">
      <div className="group">
        <span>Priority</span>
        {PRIORITIES.map((p) => {
          const on = filters.priorities.has(p);
          return (
            <label
              key={p}
              data-p={p}
              className={on ? "on" : ""}
              onClick={(e) => {
                // Intercept the label click so the underlying checkbox
                // doesn't fire a duplicate `change` and the `<input>` is
                // visual-only (legacy parity).
                e.preventDefault();
                onTogglePriority(p);
              }}
            >
              <input
                type="checkbox"
                checked={on}
                readOnly
                aria-label={`Filter to P${p}`}
              />
              {` P${p}`}
            </label>
          );
        })}
      </div>

      <div className="group">
        <span>Age ≥</span>
        <input
          type="number"
          id="age-min"
          min={0}
          step={1}
          placeholder="0"
          value={filters.ageMinMinutes > 0 ? String(filters.ageMinMinutes) : ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onAgeChange(Number.isFinite(n) && n > 0 ? n : 0);
          }}
        />
        <span>min</span>
      </div>

      <div className="group">
        <input
          type="search"
          id="title-search"
          placeholder="Search titles (/)"
          value={filters.search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            // Match the legacy: Esc inside a tasks-filter input blurs.
            if (e.key === "Escape") {
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </div>

      <label className="closed-toggle">
        <input
          type="checkbox"
          id="closed-toggle"
          checked={filters.includeClosed}
          onChange={(e) => onIncludeClosedChange(e.target.checked)}
        />
        Show closed
      </label>

      <button
        type="button"
        className="clear-btn"
        id="clear-filters"
        onClick={onClear}
      >
        Clear filters
      </button>

      {/* F-12b Decision 1 — sits at the right edge via margin-left:auto. */}
      <button
        type="button"
        className="add-task-btn"
        id="add-task-btn"
        onClick={onOpenAddTask}
      >
        + Add task
      </button>
    </div>
  );
}
