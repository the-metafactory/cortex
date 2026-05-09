/**
 * F-8 Decision 2 — agent-chip row inside the "Agents" column.
 *
 * Oldest-first chips (matches dispatch order — the assignments roll-up
 * already comes back ordered by `created_at ASC` from the server).
 * Terminal-state chips (completed/failed/cancelled) render at half
 * opacity with a strike-through; overflow past 3 collapses into a
 * `+N` chip that on click is currently inert (chip click is a no-op
 * per Decision 5; the row body opens the drill-down).
 */

import { chipOverflow } from "../lib/task-table-filter";
import type { TaskAssignmentRow } from "../../db/tasks";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface AgentChipsProps {
  assignments: readonly TaskAssignmentRow[];
}

export function AgentChips({ assignments }: AgentChipsProps) {
  if (!assignments || assignments.length === 0) {
    // Per Decision 4 empty-assignment tasks render a dim em-dash; the
    // aggregate state cell shows the same fallback (`—`).
    return <span className="no-state">—</span>;
  }
  const { visible, overflow } = chipOverflow(assignments);
  return (
    <>
      {visible.map((a) => (
        <span
          key={a.id}
          className={`agent-chip${TERMINAL.has(a.state) ? " terminal" : ""}`}
          title={`${a.agent_name} · ${a.state}`}
        >
          {a.agent_name}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="agent-chip overflow"
          title={`${overflow} more assignment(s) — click row to drill down`}
        >
          +{overflow}
        </span>
      )}
    </>
  );
}
