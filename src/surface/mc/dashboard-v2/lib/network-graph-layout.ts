/**
 * G-1114.D.3 — ELK layout for the Network graph.
 *
 * Positions the stack-hub + agent nodes (from {@link buildNetworkGraph}) using
 * elkjs. The topology is a star — one hub with every agent as a spoke — so ELK's
 * **radial** algorithm is the natural fit: it places the root (the hub) at the
 * centre and fans the agents around it on a ring. That reads as "the agents on
 * this stack" far better than a left-to-right layered DAG would.
 *
 * ELK runs asynchronously (`elk.layout` returns a promise), so the view computes
 * the layout in an effect and stores the positioned nodes in state (see
 * `network-view.tsx`). This module keeps the ELK wiring isolated and injectable:
 * `layoutNetworkGraph` takes an `ElkLike` so a test can pass a deterministic stub
 * instead of spinning up the real WASM-backed engine.
 */

import type { NetworkGraph, NetworkGraphNode } from "./network-graph-adapter";

/** Rendered footprint of each node, fed to ELK so it reserves real space. */
export const HUB_NODE_SIZE = { width: 180, height: 64 } as const;
export const AGENT_NODE_SIZE = { width: 200, height: 96 } as const;

/**
 * ELK layout options for the radial star. Tuned for a hub-and-spoke:
 *   - `algorithm: radial` — root-centred concentric placement.
 *   - a generous `radius` so agent cards (≤200px) don't overlap on the ring.
 *   - `spacing.nodeNode` keeps siblings apart when the ring gets crowded.
 */
export const NETWORK_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "org.eclipse.elk.radial",
  "elk.radial.radius": "220",
  "elk.spacing.nodeNode": "60",
  // Centre the hub (the layout root) at the origin so the agents fan around it.
  "elk.radial.centerOnRoot": "true",
};

/** One ELK input node (subset of the elkjs node shape we set). */
interface ElkInputNode {
  id: string;
  width: number;
  height: number;
}

/** One ELK input edge. */
interface ElkInputEdge {
  id: string;
  sources: string[];
  targets: string[];
}

/** The ELK graph we hand to `elk.layout`. */
export interface ElkInputGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkInputNode[];
  edges: ElkInputEdge[];
}

/** One positioned node ELK returns (only the fields we read). */
export interface ElkLaidOutNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** The ELK result shape we read back. */
export interface ElkLaidOutGraph {
  children?: ElkLaidOutNode[];
}

/** The minimal elkjs surface we depend on — injectable for tests. */
export interface ElkLike {
  layout(graph: ElkInputGraph): Promise<ElkLaidOutGraph>;
}

/** Size lookup: the hub gets the hub footprint, agents the agent footprint. */
function sizeFor(node: NetworkGraphNode): { width: number; height: number } {
  return node.type === "stackHub" ? HUB_NODE_SIZE : AGENT_NODE_SIZE;
}

/**
 * Build the ELK input graph from the React-Flow graph. Pure — separated from the
 * async `elk.layout` call so the translation (node sizing, edge mapping, options)
 * is unit-testable without running the engine.
 */
export function toElkGraph(graph: NetworkGraph): ElkInputGraph {
  return {
    id: "root",
    layoutOptions: NETWORK_ELK_OPTIONS,
    children: graph.nodes.map((n) => {
      const { width, height } = sizeFor(n);
      return { id: n.id, width, height };
    }),
    edges: graph.edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };
}

/**
 * Run ELK over the graph and return the input nodes with ELK's computed
 * positions applied. Edges are unchanged (React Flow routes hub→agent edges with
 * its default renderer; the radial layout doesn't need explicit edge bend points
 * for a star).
 *
 * An empty graph short-circuits (no ELK call) and returns empty nodes. A node
 * ELK didn't position (shouldn't happen, but defensive) keeps its incoming
 * `{0,0}` so it renders at the origin rather than vanishing.
 */
export async function layoutNetworkGraph(
  elk: ElkLike,
  graph: NetworkGraph,
): Promise<NetworkGraphNode[]> {
  if (graph.nodes.length === 0) return [];

  const result = await elk.layout(toElkGraph(graph));
  const positions = new Map<string, { x: number; y: number }>();
  for (const c of result.children ?? []) {
    positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }

  return graph.nodes.map((n) => {
    const pos = positions.get(n.id);
    return pos ? { ...n, position: pos } : n;
  });
}
