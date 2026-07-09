/**
 * G-1114.D.3 — layout for the Network graph.
 * G-1114.E.3 — + multi-cluster (one star per stack-hub) layout.
 * #1008 (network-graph-rendering) — Strata-style LAYERED + ORTHOGONAL routing.
 * MC-D1 (netui-constellation) — REPLACED the async ELK layered DAG with a PURE,
 *   synchronous, deterministic RADIAL layout: each stack-hub sits at a cluster
 *   centre and its agents ring around it, the clusters spread across a coarse
 *   grid. This turns the boxy DAG into the organic "constellation" star-map.
 *
 * ## Algorithm choice — deterministic radial, not ELK `layered`/`force`
 *
 * cortex's topology is a SET of 2-level trees: each stack-hub PARENTS its agents
 * (hub → agent edges), one such tree per stack (the serving stack, each local
 * sibling, each federated peer). The old renderer laid this out with
 * `org.eclipse.elk.layered` (DOWN) — a tidy top-down DAG. The constellation
 * redesign wants an ORGANIC RADIAL reading instead: the hub is a glowing core
 * and its agents orbit it on a ring.
 *
 * The layout is a pure function of the graph data — no physics simulation, no
 * ambient randomness (`Math.random()` is banned in this codebase, and a
 * deterministic layout is also far easier to unit-test than a force scatter):
 *
 *   1. GROUP — bucket each agent under its hub via the hub→agent edges (an agent
 *      with no incoming edge, defensive, forms its own singleton cluster).
 *   2. PLACE CLUSTERS — lay the cluster centres out on a coarse grid (columns =
 *      ceil(sqrt(clusterCount))), a fixed stride apart. Deterministic + tidy;
 *      no overlap for the small stack counts cortex renders.
 *   3. RING THE AGENTS — within each cluster the hub sits at the centre and its
 *      agents are distributed EVENLY by angle on a ring whose radius scales with
 *      the agent count (so a 12-agent stack ring is wider than a 2-agent one).
 *
 * Because it's synchronous + pure, the canvas no longer needs the async ELK
 * effect (no WASM worker): it calls {@link layoutNetworkGraph} directly and
 * renders. The engine import (`elkjs`) is gone.
 *
 * Edges carry a 2-point route (`[hubCentre, agentCentre]`) in `layout.elkPoints`
 * — the constellation edge (`network-elk-edge.tsx`) draws that as a gently
 * curved teal connector rather than a straight/orthogonal DAG elbow.
 */

import type {
  NetworkGraph,
  NetworkGraphNode,
  NetworkGraphEdge,
} from "./network-graph-adapter";

/**
 * Rendered footprint of each node. The circle nodes are small; the values are
 * the diameter of the glowing orb (hub larger than agent) — used to reserve
 * spacing and to centre the ring on the hub.
 */
export const HUB_NODE_SIZE = { width: 64, height: 64 } as const;
export const AGENT_NODE_SIZE = { width: 28, height: 28 } as const;

/**
 * Radial-layout tuning constants (all in layout px). Exported so the tests can
 * assert positions against the same geometry the renderer uses.
 */
export const RADIAL_LAYOUT = {
  /** Base ring radius (px) for a single-agent cluster. */
  baseRingRadius: 160,
  /** Extra ring radius per additional agent, so dense clusters ring wider. */
  radiusPerAgent: 14,
  /** Upper bound on the ring radius so a very dense cluster stays compact. */
  maxRingRadius: 340,
  /** Centre-to-centre distance between adjacent cluster centres on the grid. */
  clusterStride: 900,
  /**
   * Start angle (radians) for the first agent on every ring. A slight offset
   * from straight-up keeps the first spoke from always pointing due north.
   */
  startAngle: -Math.PI / 2,
} as const;

/** A 2D point in the layout coordinate space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * #1008 — the per-edge layout payload the canvas hands to the constellation edge
 * (`network-elk-edge.tsx`). `elkPoints` is the edge route — for the radial
 * layout a 2-point `[hubCentre, agentCentre]` list the edge draws as a gentle
 * curve. The `layout*`/`*Y` fields are the node centres/faces (kept for the
 * edge's dragged-node fallback). All optional.
 */
export interface NetworkEdgeLayout {
  elkPoints?: Point[];
  layoutSourceX?: number;
  layoutSourceY?: number;
  layoutTargetX?: number;
  layoutTargetY?: number;
  sourceTopY?: number;
  targetBottomY?: number;
}

/** One laid-out edge: the base graph edge + its computed route payload. */
export interface LaidOutNetworkEdge extends NetworkGraphEdge {
  layout: NetworkEdgeLayout;
}

/** The layout result: positioned nodes + edges carrying their route points. */
export interface LaidOutNetworkGraph {
  nodes: NetworkGraphNode[];
  edges: LaidOutNetworkEdge[];
}

/** Size lookup: the hub gets the hub footprint, agents the agent footprint. */
function sizeFor(node: NetworkGraphNode): { width: number; height: number } {
  return node.type === "stackHub" ? HUB_NODE_SIZE : AGENT_NODE_SIZE;
}

/** The ring radius for a cluster of `agentCount` agents (clamped). */
export function ringRadiusForCount(agentCount: number): number {
  const raw =
    RADIAL_LAYOUT.baseRingRadius +
    Math.max(0, agentCount - 1) * RADIAL_LAYOUT.radiusPerAgent;
  return Math.min(raw, RADIAL_LAYOUT.maxRingRadius);
}

/**
 * Grid position (column, row) of the `i`-th cluster centre. Columns =
 * `ceil(sqrt(total))` so N clusters form a roughly-square grid, filled
 * left-to-right, top-to-bottom. Deterministic — the same `i`/`total` always
 * yields the same cell.
 */
export function clusterCentre(i: number, total: number): Point {
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / cols));
  const col = i % cols;
  const row = Math.floor(i / cols);
  // Centre the whole grid on the origin so `fitView` frames it symmetrically.
  const x = (col - (cols - 1) / 2) * RADIAL_LAYOUT.clusterStride;
  const y = (row - (rows - 1) / 2) * RADIAL_LAYOUT.clusterStride;
  return { x, y };
}

/**
 * One cluster: its hub node id and the ordered agent node ids ringed around it.
 * A hub with no agents is still a cluster (a lone glowing core).
 */
interface Cluster {
  hubId: string;
  agentIds: string[];
}

/**
 * GROUP the graph into clusters — one per stack-hub — by walking the hub→agent
 * edges. Hubs are emitted in their graph order (the adapter emits the local hub
 * first, then peers), so the cluster grid reads local-first. An agent with no
 * incoming hub edge (defensive — shouldn't happen) becomes its own singleton
 * cluster so it's never dropped.
 *
 * Pure + exported for unit testing.
 */
export function clusterNetworkGraph(graph: NetworkGraph): Cluster[] {
  const hubOrder: string[] = [];
  const agentsByHub = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type === "stackHub") {
      hubOrder.push(n.id);
      if (!agentsByHub.has(n.id)) agentsByHub.set(n.id, []);
    }
  }

  // Map each agent to its hub via the (hub → agent) edge.
  const hubOfAgent = new Map<string, string>();
  for (const e of graph.edges) {
    if (agentsByHub.has(e.source)) hubOfAgent.set(e.target, e.source);
  }

  const orphanCluster: string[] = [];
  for (const n of graph.nodes) {
    if (n.type !== "agent") continue;
    const hub = hubOfAgent.get(n.id);
    if (hub !== undefined) {
      agentsByHub.get(hub)!.push(n.id);
    } else {
      orphanCluster.push(n.id);
    }
  }

  const clusters: Cluster[] = hubOrder.map((hubId) => ({
    hubId,
    agentIds: agentsByHub.get(hubId) ?? [],
  }));
  // Each orphan agent forms its own hub-less singleton cluster (defensive).
  for (const agentId of orphanCluster) {
    clusters.push({ hubId: agentId, agentIds: [] });
  }
  return clusters;
}

/**
 * Position every node with the deterministic RADIAL layout and return the nodes
 * (with `position` set to each node's CENTRE) plus the edges carrying a 2-point
 * `[hubCentre, agentCentre]` route in `layout.elkPoints`.
 *
 * SYNCHRONOUS + PURE — a pure function of the graph data (no engine, no worker,
 * no randomness), so the canvas calls it directly and the tests assert exact
 * positions. An empty graph short-circuits to empty nodes + edges.
 *
 * Positions are the node CENTRES (React Flow with the circle nodes centres each
 * node on its position via CSS `translate(-50%, -50%)`), which also makes the
 * hub→agent edge geometry trivial: the route is just centre-to-centre.
 */
export function layoutNetworkGraph(graph: NetworkGraph): LaidOutNetworkGraph {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const clusters = clusterNetworkGraph(graph);
  const centres = new Map<string, Point>();

  clusters.forEach((cluster, i) => {
    const centre = clusterCentre(i, clusters.length);
    // The hub sits at the cluster centre.
    centres.set(cluster.hubId, centre);

    const count = cluster.agentIds.length;
    if (count === 0) return;
    const radius = ringRadiusForCount(count);
    cluster.agentIds.forEach((agentId, j) => {
      // Even angular distribution around the ring, deterministic start angle.
      const angle = RADIAL_LAYOUT.startAngle + (2 * Math.PI * j) / count;
      centres.set(agentId, {
        x: centre.x + radius * Math.cos(angle),
        y: centre.y + radius * Math.sin(angle),
      });
    });
  });

  const nodes = graph.nodes.map((n) => {
    const c = centres.get(n.id);
    return c ? { ...n, position: { x: c.x, y: c.y } } : n;
  });

  const edges = graph.edges.map((e): LaidOutNetworkEdge => {
    const src = centres.get(e.source);
    const tgt = centres.get(e.target);
    const layout: NetworkEdgeLayout = {};
    if (src && tgt) {
      // A 2-point centre-to-centre route; the edge draws it as a gentle curve.
      layout.elkPoints = [
        { x: src.x, y: src.y },
        { x: tgt.x, y: tgt.y },
      ];
      const srcSize = sizeForId(graph, e.source);
      const tgtSize = sizeForId(graph, e.target);
      layout.layoutSourceX = src.x;
      layout.layoutSourceY = src.y;
      layout.sourceTopY = src.y - srcSize.height / 2;
      layout.layoutTargetX = tgt.x;
      layout.layoutTargetY = tgt.y;
      layout.targetBottomY = tgt.y + tgtSize.height / 2;
    }
    return { ...e, layout };
  });

  return { nodes, edges };
}

/** Footprint of the node with `id` (falls back to the agent size if unknown). */
function sizeForId(
  graph: NetworkGraph,
  id: string,
): { width: number; height: number } {
  const node = graph.nodes.find((n) => n.id === id);
  return node ? sizeFor(node) : AGENT_NODE_SIZE;
}
