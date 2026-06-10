/**
 * G-1114.D.4 — pure helpers for the Network node detail panel.
 *
 * The detail panel itself is a pure presentational component, but the
 * SELECTION logic — "given the live agents snapshot + the currently-selected
 * key, what does the panel show?" — is extracted here so it stays unit-testable
 * without a DOM (the same discipline as `agents-display` / `working-grid-display`).
 *
 * The load-bearing rule (D.4 Build step 4): the panel reads off the LIVE
 * `useAgents` snapshot looked up by key, so an open panel reflects presence
 * updates — and if the selected agent disappears from the snapshot (e.g. the
 * registry dropped it), the panel auto-closes. That "is the selection still
 * present?" decision is `resolveSelectedAgent` below.
 *
 * The dispatch-lifecycle join (`selectAgentDispatchActivity`) is a pure FRONTEND
 * join of the already-fetched working-agents projection by `agent_id` — NOT a
 * new backend join. It surfaces ONLY lifecycle metadata (state, task title,
 * priority, active count) — NEVER session interiors (ADR-0007).
 */

import type { AgentPresenceTile } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { NetworkGraphNode } from "./network-graph-adapter";

/**
 * Map a clicked graph node to the agent key the detail panel should select.
 *
 * - An **agent** node → its key (`{principal}/{stack}/{agent_id}`); the panel
 *   opens for it.
 * - The synthetic **stack-hub** node → `null`; clicking the hub doesn't open an
 *   agent panel (it's a layout anchor, not an agent — D.4 keeps the hub-click
 *   a deselect rather than building a stack-summary surface).
 *
 * Extracted as a pure function so the canvas's `onNodeClick` is a one-line
 * delegation testable without mounting xyflow (which can't run in `bun test`).
 */
export function agentKeyFromClickedNode(
  node: Pick<NetworkGraphNode, "type" | "id">,
): string | null {
  return node.type === "agent" ? node.id : null;
}

/**
 * Resolve the currently-selected agent against the live snapshot.
 *
 * - `selectedKey === null` → `null` (nothing selected).
 * - selected key present in the snapshot → the live tile (so the panel reflects
 *   the latest presence — state/caps/heartbeat — as the snapshot refetches).
 * - selected key ABSENT from the snapshot → `null` (the agent disappeared; the
 *   caller treats `null` as "close the panel"). This is the auto-close path.
 *
 * Pure + snapshot-driven: the panel never holds its own copy of the agent's
 * presence, it always re-reads the live tile, so it can't go stale.
 */
export function resolveSelectedAgent(
  agents: readonly AgentPresenceTile[],
  selectedKey: string | null,
): AgentPresenceTile | null {
  if (selectedKey === null) return null;
  return agents.find((a) => a.key === selectedKey) ?? null;
}

/**
 * One agent's dispatch-lifecycle activity, joined from the working-agents
 * projection. LIFECYCLE METADATA ONLY (ADR-0007): the agent's current primary
 * state, the task it's assigned to (title + priority), and how many additional
 * active assignments it has. Explicitly NOT the prompt, tool calls, diffs, or
 * any session interior — those never leave the working-grid projection and never
 * enter the network detail panel.
 */
export interface AgentDispatchActivity {
  /** The agent's current primary work state. */
  primaryState: WorkingAgentTile["primary_state"];
  /** Title of the task the agent is primarily assigned to. */
  taskTitle: string;
  /** Priority of that task (0–3; rendered as P0–P3). */
  taskPriority: number;
  /** `updated_at` ISO timestamp of the primary assignment. */
  updatedAt: string;
  /** Count of additional active assignments beyond the primary. */
  additionalActiveCount: number;
}

/**
 * Frontend join: find the selected agent's dispatch activity in the
 * working-agents snapshot by `agent_id`.
 *
 * - No working-agents tile for this agent (it isn't actively dispatched) →
 *   `null`; the panel renders an "idle / no active dispatch" line instead.
 * - A tile present → the lifecycle-only projection above.
 *
 * The working-agents data is fetched ONCE at app scope (the working grid already
 * consumes it), so this is a zero-cost re-projection — no extra request, no new
 * backend endpoint.
 */
export function selectAgentDispatchActivity(
  workingAgents: readonly WorkingAgentTile[],
  agentId: string,
): AgentDispatchActivity | null {
  const tile = workingAgents.find((w) => w.agent_id === agentId);
  if (!tile) return null;
  return {
    primaryState: tile.primary_state,
    taskTitle: tile.primary_assignment.task_title,
    taskPriority: tile.primary_assignment.task_priority,
    updatedAt: tile.primary_assignment.updated_at,
    additionalActiveCount: tile.additional_active_count,
  };
}
