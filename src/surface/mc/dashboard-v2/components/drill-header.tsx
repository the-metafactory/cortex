/**
 * Drill-down header — agent × task line, state pill, focus-mode toggle,
 * close button, plan/progress strip (todo pane), artefact chips.
 *
 * F-16 — also renders the iteration chip below the agent×task line
 * when the drill-down's task belongs to an iteration. Click navigates
 * to the iteration detail surface (Surface 2 in the design spec).
 * Mirrors the F-8 task-table iteration column (same denorm, same
 * visual vocabulary).
 *
 * Per migration addendum Decision 11.
 */

import { useTodoState, type TodoItem } from "../hooks/use-todo-state";
import { useArtefacts } from "../hooks/use-artefacts";
import { Pill, StatePill } from "./pill";
import { chipText, chipTooltip, chipPillKind } from "../lib/iteration-display";
import type { McEvent } from "../../types";
import type { AssignmentListItem } from "../../db/assignments";

export interface DrillHeaderProps {
  assignment: AssignmentListItem | null;
  events: McEvent[];
  onClose: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  /**
   * F-16 — invoked when the operator clicks the iteration chip. Routes
   * the parent App to the kanban-detail view for the given iteration
   * id (same surface F-15 ships). Optional so this component is still
   * usable from contexts without iteration routing wired (tests; future
   * standalone embedding).
   */
  onOpenIteration?: (iterationId: string) => void;
}

export function DrillHeader({
  assignment,
  events,
  onClose,
  focusMode,
  onToggleFocusMode,
  onOpenIteration,
}: DrillHeaderProps) {
  const { todos } = useTodoState(events);
  const artefacts = useArtefacts(events);
  const hasStrip = !!todos || !!artefacts.branch || !!artefacts.prUrl || !!artefacts.issueRef;
  // F-16 — surface the iteration chip only when the assignment's task
  // is grouped (the LEFT JOIN's null path → ungrouped). Per the design
  // spec we explicitly OMIT the chip for ungrouped tasks rather than
  // rendering "—"; the operator's signal "this task is loose" is the
  // chip's absence, not a placeholder. (The F-8 column shows "—"
  // because the column header is always present and an empty cell
  // would misalign rows.)
  const iteration = assignment?.iteration ?? null;

  return (
    <>
      <div className="drill-header">
        <div className="title">
          <span className="agent">{assignment?.agent_id ?? "—"}</span>
          <span className="sep">·</span>
          <span className="task">{assignment?.task.title ?? "(no task)"}</span>
          {assignment && <StatePill state={assignment.state} />}
        </div>
        <div className="actions">
          <button
            type="button"
            className="focus-btn"
            onClick={onToggleFocusMode}
            aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
            title={`${focusMode ? "Exit" : "Enter"} focus mode (f)`}
          >
            {focusMode ? "exit focus" : "focus mode"}
          </button>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            aria-label="Close drill-down"
            title="Close (Esc)"
          >
            close
          </button>
        </div>
      </div>

      {iteration && (
        // F-16 — iteration chip row. Sits between the title row and
        // the plan/progress strip so it stays visible regardless of
        // whether todos/artefacts are present (`drill-strip` hides
        // when empty). Click handler is gated on `onOpenIteration`
        // because some parents may not wire it; click-without-handler
        // is a no-op (button still focusable for keyboard parity).
        <div className="drill-iteration-row">
          <button
            type="button"
            className="drill-iteration-chip"
            title={chipTooltip(iteration)}
            aria-label={`Open iteration ${iteration.title}`}
            onClick={() => onOpenIteration?.(iteration.id)}
            disabled={!onOpenIteration}
          >
            <Pill kind={chipPillKind(iteration)}>
              {chipText(iteration)}
            </Pill>
          </button>
        </div>
      )}

      <div className="drill-strip" hidden={!hasStrip}>
        {todos && <TodoPane todos={todos} />}
        {(artefacts.branch || artefacts.prUrl || artefacts.issueRef) && (
          <div className="artefact-row">
            {artefacts.branch && (
              <span className="artefact-chip" title="Branch (heuristic)">
                <span className="label">branch</span>{artefacts.branch}
              </span>
            )}
            {artefacts.prUrl && (
              <a className="artefact-chip" href={artefacts.prUrl} target="_blank" rel="noopener noreferrer" title="PR">
                <span className="label">pr</span>{shortPr(artefacts.prUrl)}
              </a>
            )}
            {artefacts.issueRef && (
              <a className="artefact-chip"
                 href={artefacts.issueRef.startsWith("http") ? artefacts.issueRef : undefined}
                 target="_blank" rel="noopener noreferrer" title="Issue">
                <span className="label">issue</span>{shortIssue(artefacts.issueRef)}
              </a>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function TodoPane({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="todo-pane">
      <h3>Plan ({todos.filter((t) => t.status === "completed").length}/{todos.length})</h3>
      {todos.map((t, i) => (
        <div key={i} className={`todo-item ${t.status}`}>
          <span className="marker">{markerFor(t.status)}</span>
          <span className="text">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
        </div>
      ))}
    </div>
  );
}

function markerFor(status: TodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  return "○";
}

function shortPr(url: string): string {
  // .../pull/123 → "owner/repo#123"
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
}

function shortIssue(ref: string): string {
  if (ref.startsWith("http")) {
    const m = ref.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : ref;
  }
  return ref;
}
