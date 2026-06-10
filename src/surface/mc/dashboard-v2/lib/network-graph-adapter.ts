/**
 * G-1114.D.2 — graph data adapter (registry snapshot → React Flow graph).
 *
 * Pure projection from the agents-panel snapshot (`AgentPresenceTile[]`, the
 * same data `useAgents` feeds the panel) into the React Flow `nodes`/`edges`
 * shape the Network graph view (G-1114.D.1) renders. Kept out of the React tree
 * so the mapping is unit-testable without a DOM — the canvas component consumes
 * the output and hands it to ELK (G-1114.D.3) for positioning.
 *
 * ## Topology for stack-local Phase D
 *
 * There are NO inherent agent-to-agent edges yet: federation topology (peer
 * principals) is Phase E and capability-routing edges are Phase F. So for the
 * stack-local cut we synthesise a single **stack-root hub node** and attach
 * every agent to it with one `stack → agent` edge. That gives ELK a real tree
 * to lay out (a radial/star around the hub reads as "the agents on this stack")
 * AND visually groups the agents under their stack — strictly better than a pile
 * of disconnected nodes ELK would scatter arbitrarily.
 *
 * The hub is derived, not an agent: its id is reserved (`__stack__`) so it can
 * never collide with an agent key, and it carries the `{principal}/{stack}`
 * label lifted from the agents (all stack-local agents share one principal+stack;
 * if the snapshot is somehow mixed, the first agent's pair labels the hub and the
 * rest still attach — the hub is a layout anchor, not an assertion).
 *
 * ADR-0007: nodes carry presence + lifecycle metadata only (identity,
 * capabilities, state, offline reason, heartbeat) — NEVER session interiors.
 */

import type { AgentPresenceTile } from "../hooks/use-agents";

/** Reserved id for the synthetic stack-root hub node (never a valid agent key). */
export const STACK_HUB_NODE_ID = "__stack__";

/** React Flow node `data` payload for the synthetic stack-root hub. */
export interface StackHubNodeData {
  kind: "stack-hub";
  /** `{principal}` the stack belongs to (best-effort from the agents). */
  principal: string | null;
  /** `{stack}` label. */
  stack: string | null;
  /** Count of agents attached to this hub. */
  agentCount: number;
}

/** React Flow node `data` payload for one agent. */
export interface AgentNodeData {
  kind: "agent";
  /** Stable registry key (`{principal}/{stack}/{agent_id}`). */
  key: string;
  /** Logical agent id (`luna`, `echo`, …). */
  agentId: string;
  /** Soma assistant name, or `null` (falls back to `agentId` at render). */
  assistantName: string | null;
  /** Declared capability set (latest observed). */
  capabilities: readonly string[];
  /** Liveness state. */
  state: "online" | "offline";
  /** Offline reason (`ttl_lapse` / `shutdown` / …) when offline; else `null`. */
  offlineReason: string | null;
  /** Epoch-ms of the last `agent.heartbeat` observed, or `null`. */
  lastHeartbeatAt: number | null;
}

/** Discriminated union of every node `data` shape in the graph. */
export type NetworkNodeData = StackHubNodeData | AgentNodeData;

/** A React-Flow-shaped node BEFORE ELK assigns a position (position is 0,0). */
export interface NetworkGraphNode {
  id: string;
  /** Custom node type registered on the canvas (`stackHub` | `agent`). */
  type: "stackHub" | "agent";
  data: NetworkNodeData;
  position: { x: number; y: number };
}

/** A React-Flow-shaped edge (hub → agent for the stack-local cut). */
export interface NetworkGraphEdge {
  id: string;
  source: string;
  target: string;
}

/** The adapter's output: nodes + edges, pre-layout. */
export interface NetworkGraph {
  nodes: NetworkGraphNode[];
  edges: NetworkGraphEdge[];
}

/**
 * Project the agents snapshot into a React-Flow graph.
 *
 * - **Empty snapshot →** an empty graph (`{ nodes: [], edges: [] }`). The view
 *   renders its empty state rather than a lone hub with nothing attached.
 * - **Non-empty →** one stack-hub node + one agent node per tile + one
 *   `hub → agent` edge per tile.
 *
 * Pure and order-preserving: agent nodes follow the snapshot order (the registry
 * order), so the layout is deterministic for a given snapshot.
 */
export function buildNetworkGraph(
  agents: readonly AgentPresenceTile[],
): NetworkGraph {
  if (agents.length === 0) {
    return { nodes: [], edges: [] };
  }

  const first = agents[0]!;
  const hub: NetworkGraphNode = {
    id: STACK_HUB_NODE_ID,
    type: "stackHub",
    position: { x: 0, y: 0 },
    data: {
      kind: "stack-hub",
      principal: first.principal ?? null,
      stack: first.stack ?? null,
      agentCount: agents.length,
    },
  };

  const nodes: NetworkGraphNode[] = [hub];
  const edges: NetworkGraphEdge[] = [];

  for (const a of agents) {
    nodes.push({
      id: a.key,
      type: "agent",
      position: { x: 0, y: 0 },
      data: {
        kind: "agent",
        key: a.key,
        agentId: a.agent_id,
        assistantName: a.assistant_name,
        capabilities: a.capabilities,
        state: a.state,
        offlineReason: a.offline_reason,
        lastHeartbeatAt: a.last_heartbeat_at,
      },
    });
    edges.push({
      id: `hub-${a.key}`,
      source: STACK_HUB_NODE_ID,
      target: a.key,
    });
  }

  return { nodes, edges };
}
