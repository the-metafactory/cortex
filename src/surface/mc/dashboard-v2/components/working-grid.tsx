/**
 * F-9 working-agent grid (MIG-5 port).
 *
 * Renders one tile per agent with at least one active-non-blocked
 * assignment, server-sorted by `primary_state_rank ASC, updated_at DESC`.
 * Tile click opens the F-7 drill-down on the primary assignment;
 * `+N` badge is inert per Decision 6.
 *
 * Empty-state behaviour (Decision 7):
 *   - section hidden when focus row has entries AND grid is empty
 *     (don't distract from "needs attention")
 *   - "No agents working right now." when both grid and focus row are empty
 *
 * Keyboard: arrow keys navigate tiles when one is focused, Enter opens
 * the drill-down. Gated on the drill-down being closed (mirrors F-8 /
 * legacy F-9 listener discipline).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "./working-grid.css";
import { priorityBorderClass } from "../lib/block-reason";
import { pickWorkingGridMode, priorityLabel } from "../lib/working-grid-display";
import type { WorkingAgentTile } from "../hooks/use-working-agents";

export interface WorkingGridProps {
  agents: WorkingAgentTile[];
  loaded: boolean;
  error: string | null;
  /**
   * True when the focus row has any items. Drives the Decision 7
   * "hide entirely" branch when the grid is empty alongside a focus row.
   */
  focusItemCount: number;
  /** Don't hijack arrow keys while the F-7 drill-down is open. */
  drillOpen: boolean;
  /** Called with the primary assignment id when a tile is activated. */
  onOpen: (assignmentId: string) => void;
}

export function WorkingGrid({
  agents,
  loaded,
  error,
  focusItemCount,
  drillOpen,
  onOpen,
}: WorkingGridProps) {
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Clamp the focused index when the grid shrinks underneath us.
  useEffect(() => {
    if (focusedIdx >= agents.length) setFocusedIdx(-1);
  }, [agents.length, focusedIdx]);

  // Keep the actual DOM focus in sync with focusedIdx (so arrow keys
  // chain — the next keydown still fires on a focused tile).
  useEffect(() => {
    if (focusedIdx < 0) return;
    const el = tileRefs.current[focusedIdx];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIdx]);

  const onTileKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (drillOpen) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(Math.min(idx + 1, agents.length - 1));
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(Math.max(idx - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const a = agents[idx];
      if (a) onOpen(a.primary_assignment.id);
      return;
    }
  }, [agents, drillOpen, onOpen]);

  const mode = pickWorkingGridMode({ agents, loaded, error, focusItemCount });
  if (mode === "hidden") return null;

  return (
    <section className="working-grid-section" aria-label="Working agents">
      <h2>Working</h2>
      {mode === "error" && <div className="working-grid-error">⚠ {error}</div>}
      {mode === "loading" && <div className="working-grid-empty">Loading…</div>}
      {mode === "empty" && (
        <div className="working-grid-empty">No agents working right now.</div>
      )}
      {mode === "tiles" && (
        <div className="working-grid">
          {agents.map((a, idx) => (
            <button
              key={a.agent_id}
              ref={(el) => { tileRefs.current[idx] = el; }}
              type="button"
              className={`working-tile ${priorityBorderClass(a.primary_assignment.task_priority)}${idx === focusedIdx ? " focused" : ""}`}
              onClick={() => onOpen(a.primary_assignment.id)}
              onKeyDown={(e) => onTileKeyDown(e, idx)}
              onFocus={() => setFocusedIdx(idx)}
              data-agent-id={a.agent_id}
            >
              <div className="agent">{a.agent_name}</div>
              <div className="task">{a.primary_assignment.task_title}</div>
              <div className="meta">
                {priorityLabel(a.primary_assignment.task_priority)}
                {" · "}
                <span className={`state-${a.primary_state}`}>{a.primary_state}</span>
              </div>
              {a.additional_active_count > 0 && (
                <div
                  className="badge"
                  title={`${a.additional_active_count} additional active assignment(s)`}
                  aria-hidden="true"
                >
                  +{a.additional_active_count}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

