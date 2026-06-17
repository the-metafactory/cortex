/**
 * G-1114.D.3 — ELK layout for the Network graph.
 * G-1114.E.3 — + multi-cluster (one star per stack-hub) layout.
 * #1008 (network-graph-rendering) — Strata-style LAYERED + ORTHOGONAL routing.
 *
 * Positions the stack-hub + agent nodes (from {@link buildNetworkGraph}) using
 * elkjs and returns BOTH the positioned nodes AND ELK's computed edge bend
 * points (`elkPoints`), so the canvas can render clean orthogonal connectors
 * (see `network-elk-edge.tsx`) instead of React Flow's default crossing-prone
 * straight/bezier edges.
 *
 * ## Algorithm choice — `layered` (DOWN), not `force`
 *
 * Phase D used `radial`; Phase E switched to `force` to handle several
 * disconnected stack-clusters. But `force` (stress) is a physics scatter: it has
 * no notion of "hub above its agents", so clusters drift, overlap edges cross,
 * and with several stacks the whole thing converges on the densest hub — exactly
 * the crossing-lines mess #1008 reported.
 *
 * cortex's topology is a SET of 2-level trees: each stack-hub PARENTS its agents
 * (hub → agent edges), one such tree per stack (the serving stack, each local
 * sibling, each federated peer). `org.eclipse.elk.layered` with `direction: DOWN`
 * is the natural fit — it places each hub on the top layer and its agents on the
 * layer below, a tidy top-down cluster per stack. `separateConnectedComponents`
 * packs the per-stack trees side by side (each stack its own clean column-group),
 * and `crossingMinimization` + `nodePlacement: NETWORK_SIMPLEX` straighten the
 * hub→agent edges. With `edgeRouting: ORTHOGONAL`, ELK emits right-angled bend
 * points we render as rounded-corner polylines — no diagonal crossings.
 *
 * A single-cluster (local-only) graph lays out as one tidy hub-over-agents tree,
 * preserving the Phase-D "your stack, agents fanned below" reading.
 *
 * ELK runs asynchronously (`elk.layout` returns a promise), so the view computes
 * the layout in an effect and stores the positioned nodes in state (see
 * `network-view.tsx`). This module keeps the ELK wiring isolated and injectable:
 * `layoutNetworkGraph` takes an `ElkLike` so a test can pass a deterministic stub
 * instead of spinning up the real WASM-backed engine.
 */

import type {
  NetworkGraph,
  NetworkGraphNode,
  NetworkGraphEdge,
} from "./network-graph-adapter";

/** Rendered footprint of each node, fed to ELK so it reserves real space. */
export const HUB_NODE_SIZE = { width: 180, height: 64 } as const;
export const AGENT_NODE_SIZE = { width: 200, height: 96 } as const;

/**
 * ELK layout options for the multi-cluster LAYERED layout (#1008). Tuned for
 * one-or-more hub→agents trees laid top-down, adapted from Strata's layered
 * config (`arc-library/strata/ui/src/constants.ts`):
 *   - `algorithm: layered` + `direction: DOWN` — each stack-hub on the top layer,
 *     its agents on the layer below: a tidy top-down cluster per stack (replaces
 *     the `force` scatter that crossed edges + converged on the densest hub).
 *   - `edgeRouting: ORTHOGONAL` — right-angled connectors; ELK emits the bend
 *     points we render as rounded polylines (no diagonal crossings).
 *   - `crossingMinimization.strategy: LAYER_SWEEP` + `thoroughness` — minimise
 *     edge crossings within each cluster.
 *   - `nodePlacement.strategy: NETWORK_SIMPLEX` — straighten hub→agent edges so
 *     agents sit cleanly under their hub.
 *   - `separateConnectedComponents` + `spacing.componentComponent` — pack each
 *     disconnected stack-tree (serving stack + each sibling + each peer) as its
 *     own side-by-side group, NOT one giant overlapping scatter.
 *   - `spacing.*` keep agent cards (≤200px) and the per-stack columns apart.
 */
export const NETWORK_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "org.eclipse.elk.layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "48",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.layered.spacing.edgeNodeBetweenLayers": "32",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.thoroughness": "7",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  // Pack each disconnected stack-tree (serving stack + each sibling + each peer)
  // as its own side-by-side group rather than overlapping them.
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "120",
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

/** A 2D point in ELK's layout coordinate space. */
export interface ElkPoint {
  x: number;
  y: number;
}

/**
 * One routed edge ELK returns. ORTHOGONAL routing populates `sections[0]` with a
 * `startPoint`, optional `bendPoints`, and an `endPoint` — the right-angled path
 * we render as a rounded polyline. (Strata reads the same `sections[0]` shape.)
 */
export interface ElkLaidOutEdge {
  id: string;
  sections?: {
    startPoint: ElkPoint;
    bendPoints?: ElkPoint[];
    endPoint: ElkPoint;
  }[];
}

/** The ELK result shape we read back. */
export interface ElkLaidOutGraph {
  children?: ElkLaidOutNode[];
  edges?: ElkLaidOutEdge[];
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
 * #1008 — the per-edge layout payload the canvas hands to the custom ELK edge
 * (`network-elk-edge.tsx`). `elkPoints` is ELK's orthogonal route
 * (`[startPoint, ...bendPoints, endPoint]`); the `layout*`/`*Y` fields are the
 * source/target node faces, used by the edge to clamp endpoints to the node
 * boundary and to detect a dragged node (fall back to a smoothstep then). All
 * optional — an edge ELK didn't route (defensive) carries no `elkPoints` and the
 * edge component falls back to a straight line.
 */
export interface NetworkEdgeLayout {
  elkPoints?: ElkPoint[];
  layoutSourceX?: number;
  layoutSourceY?: number;
  layoutTargetX?: number;
  layoutTargetY?: number;
  sourceTopY?: number;
  targetBottomY?: number;
}

/** One laid-out edge: the base graph edge + its computed ELK route payload. */
export interface LaidOutNetworkEdge extends NetworkGraphEdge {
  layout: NetworkEdgeLayout;
}

/** The layout result: positioned nodes + edges carrying ELK's bend points. */
export interface LaidOutNetworkGraph {
  nodes: NetworkGraphNode[];
  edges: LaidOutNetworkEdge[];
}

/**
 * Run ELK over the graph and return the positioned nodes AND the edges carrying
 * ELK's computed orthogonal bend points (`layout.elkPoints`), so the canvas can
 * render clean right-angled connectors instead of crossing-prone straight/bezier
 * edges. The bend points are extracted from each edge's `sections[0]`
 * (`startPoint` + `bendPoints` + `endPoint`), exactly as Strata's layout does.
 *
 * An empty graph short-circuits (no ELK call) and returns empty nodes + edges. A
 * node ELK didn't position (shouldn't happen, but defensive) keeps its incoming
 * `{0,0}`; an edge ELK didn't route carries no `elkPoints` (the edge component
 * falls back to a straight line).
 */
export async function layoutNetworkGraph(
  elk: ElkLike,
  graph: NetworkGraph,
): Promise<LaidOutNetworkGraph> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const result = await elk.layout(toElkGraph(graph));

  // Index the laid-out nodes by id — for positions AND for the source/target
  // face geometry the edge clamps to.
  const laidOut = new Map<string, ElkLaidOutNode>();
  for (const c of result.children ?? []) laidOut.set(c.id, c);

  const nodes = graph.nodes.map((n) => {
    const c = laidOut.get(n.id);
    return c ? { ...n, position: { x: c.x ?? 0, y: c.y ?? 0 } } : n;
  });

  // Extract each edge's orthogonal route from ELK's `sections[0]`.
  const routes = new Map<string, ElkPoint[]>();
  for (const e of result.edges ?? []) {
    const section = e.sections?.[0];
    if (section) {
      routes.set(e.id, [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]);
    }
  }

  const edges = graph.edges.map((e): LaidOutNetworkEdge => {
    const elkPoints = routes.get(e.id);
    const src = laidOut.get(e.source);
    const tgt = laidOut.get(e.target);
    const layout: NetworkEdgeLayout = elkPoints ? { elkPoints } : {};
    if (elkPoints && src) {
      layout.layoutSourceX = (src.x ?? 0) + (src.width ?? 0) / 2;
      layout.layoutSourceY = (src.y ?? 0) + (src.height ?? 0);
      layout.sourceTopY = src.y ?? 0;
    }
    if (elkPoints && tgt) {
      layout.layoutTargetX = (tgt.x ?? 0) + (tgt.width ?? 0) / 2;
      layout.layoutTargetY = tgt.y ?? 0;
      layout.targetBottomY = (tgt.y ?? 0) + (tgt.height ?? 0);
    }
    return { ...e, layout };
  });

  return { nodes, edges };
}
