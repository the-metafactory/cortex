/**
 * G-1114.D.1 — Network graph CANVAS (the code-split heavy half).
 *
 * This module is the ONLY place `@xyflow/react` is imported, so it lands in a
 * **lazily-loaded chunk** that the dashboard pulls only when the principal first
 * opens the Network tab (`network-view.tsx` `React.lazy`-imports it). The default
 * dashboard view is the working grid, not Network — splitting the graph engine
 * out of the entry bundle keeps it off the common load path (PR #905 review:
 * fold the code-split in). This is the dashboard's first code-split; it
 * establishes the pattern for D.4/D.5 (DetailPanel, SpotlightSearch).
 *
 * MC-D1 (netui-constellation) — the ELK dependency is GONE. The old canvas ran an
 * async, WASM-Worker-backed ELK layout in an effect; the constellation redesign
 * replaced it with a PURE, SYNCHRONOUS radial layout ({@link layoutNetworkGraph}),
 * so the canvas positions the nodes inline with a `useMemo` — no effect, no
 * generation guard, no "laying out…" placeholder. Simpler + no worker.
 *
 * ADR-0007: nodes carry presence + lifecycle only — never session interiors.
 */

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  ReactFlowProvider,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  collectLegendStacks,
  type NetworkGraph,
  type NetworkGraphNode,
} from "../lib/network-graph-adapter";
import { agentKeyFromClickedNode } from "../lib/network-detail-display";
import {
  layoutNetworkGraph,
  type LaidOutNetworkEdge,
} from "../lib/network-graph-layout";
import { AgentNode, StackHubNode } from "./network-nodes";
import NetworkElkEdge from "./network-elk-edge";
import { NetworkLegend } from "./network-legend";
import {
  NetworkHoverContext,
  useNetworkHover,
  type NetworkHoverContextValue,
} from "../lib/network-hover-context";

// Registered once at module scope — React Flow warns if `nodeTypes` is a fresh
// object each render.
const nodeTypes: NodeTypes = {
  stackHub: StackHubNode,
  agent: AgentNode,
};

// The custom constellation edge (MC-D1: a gently-curved teal spoke from the hub
// core to each orbiting agent). Still keyed `elk` — the edge type name is a
// stable registration key, not an engine reference. Registered once at module
// scope, same as `nodeTypes`.
const edgeTypes: EdgeTypes = {
  elk: NetworkElkEdge,
};

export interface NetworkCanvasProps {
  /** The pre-built (un-positioned) graph from the main-bundle adapter. */
  graph: NetworkGraph;
  /**
   * Lift a node selection up to the view (D.4): an agent node → its key, the
   * stack-hub node or empty canvas → `null` (deselect). The view holds the
   * selected key and renders the detail panel.
   */
  onSelectAgent?: (key: string | null) => void;
  /**
   * G-1114.F.2 — the cross-component hover-highlight value (the active highlight
   * set + the setter), provided into the node tree via `NetworkHoverContext` so
   * agent nodes light up + report hovers. The hover STATE lives in the view
   * (which has the snapshot + match index); the canvas just bridges it into the
   * xyflow node renderer. Omitted → the inert default (no highlight).
   */
  hover?: NetworkHoverContextValue;
  /**
   * CK-5 (#1292) — REAL bus flow is present AND liveTraffic is on AND motion is
   * permitted (reduced-motion off). Threads to the admitted-peer edges so the
   * dash-flow marches only on real envelope flow. Default false ⇒ static.
   */
  live?: boolean;
}

/** The React Flow canvas — rendered once ELK has positioned the nodes. */
function FlowCanvas({
  nodes,
  laidOutEdges,
  onSelectAgent,
  live = false,
}: {
  nodes: NetworkGraphNode[];
  laidOutEdges: LaidOutNetworkEdge[];
  onSelectAgent?: (key: string | null) => void;
  /**
   * CK-5 (#1292) — REAL bus flow is present AND liveTraffic is on AND motion is
   * permitted. Drives the admitted-peer dash-flow: true ⇒ marching edge, false ⇒
   * static dash (truth-not-theater — zero flow never animates).
   */
  live?: boolean;
}) {
  // React Flow's node `data` is typed `Record<string, unknown>`; our discriminated
  // `NetworkNodeData` is structurally compatible but lacks the index signature, so
  // we cast at this single boundary rather than polluting the adapter's data type.
  const rfNodes = nodes as unknown as RfNode[];

  // #1068 — the per-stack legend rows (one swatch per stack-hub), derived from
  // the positioned nodes. Hub emission order (local first, then peers) is
  // preserved, so the legend reads in layout order.
  const legendStacks = useMemo(
    () => collectLegendStacks({ nodes, edges: [] }),
    [nodes],
  );

  // #1008 — render the ORIGIN-GROUPED edges from the adapter (each agent wired to
  // ITS OWN stack's hub — local, sibling, or foreign), typed `elk` so the custom
  // edge draws ELK's orthogonal route from `data.elkPoints`. This replaces the
  // old code that rebuilt every edge as `STACK_HUB_NODE_ID → agent` (which mis-
  // wired sibling/foreign agents to the LOCAL hub) and used React Flow's default
  // crossing-prone renderer.
  const edges = useMemo<RfEdge[]>(
    () =>
      laidOutEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "elk",
        // The layout payload (elkPoints + face geometry) drives the custom edge.
        // #1068 — fold in the per-stack `stackColor` (from the adapter's edge
        // `data`) so the edge can stroke in its hub's hue.
        data: {
          ...(e.layout as unknown as Record<string, unknown>),
          stackColor: e.data?.stackColor,
          // MC-D3 (#1290) — carry the federation provenance so the constellation
          // edge draws a federated (cross-principal admitted-peer) connector
          // dashed + flowing, and labels it. Local/sibling edges stay solid.
          federated: e.data?.federated ?? false,
          // CK-5 (#1292) — bind the admitted-peer dash-flow to REAL bus flow.
          // The edge animates ONLY when `live`; otherwise it renders a static
          // dash (the relationship is still legible, but nothing pretends to
          // move). Local/sibling edges ignore this (they're never `federated`).
          live,
        } as Record<string, unknown>,
      })),
    [laidOutEdges, live],
  );

  // #1068 — the sticky hub-subtree selection lives in the hover context (set by
  // the view, broadcast through the provider). The canvas reads the toggle here
  // so a hub click flips the selection.
  const { toggleHubSelection } = useNetworkHover();

  // Node click →
  //   - AGENT node → lift its key up (D.4): open the detail panel.
  //   - STACK-HUB node → DESELECT any open agent panel (the hub isn't an agent).
  //     The subtree-selection TOGGLE is owned by the hub card's own
  //     `onClick`/`onKeyDown` (network-nodes.tsx — the a11y `role=button` control
  //     with `aria-pressed` + keyboard activation). The hub card does NOT stop
  //     propagation, so this `onNodeClick` ALSO fires on a hub click; it must NOT
  //     toggle here too, or the two functional `setSelection` calls in the same
  //     event tick cancel out (EMPTY→selected→EMPTY) and the highlight never
  //     sticks (#1070 regression — caught in browser-QA, invisible to the pure-
  //     function unit tests). `agentKeyFromClickedNode` resolves hub→null anyway.
  const onNodeClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const n = node as unknown as NetworkGraphNode;
      if (n.type === "stackHub") {
        onSelectAgent?.(null);
        return;
      }
      onSelectAgent?.(agentKeyFromClickedNode(n));
    },
    [onSelectAgent],
  );

  // Click on empty canvas → deselect EVERYTHING: close the panel AND clear the
  // hub-subtree selection (#1068).
  const onPaneClick = useCallback(() => {
    onSelectAgent?.(null);
    toggleHubSelection(null);
  }, [onSelectAgent, toggleHubSelection]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      proOptions={{ hideAttribution: true }}
    >
      {/* MC-D1 — no <Background>: the constellation reads against a clean
          near-black atmosphere (painted by `.network-canvas-wrap`), not a grid. */}
      <Controls position="bottom-left" showInteractive={false} />
      <NetworkLegend stacks={legendStacks} />
    </ReactFlow>
  );
}

/**
 * The lazy canvas entry. Positions the incoming graph with the SYNCHRONOUS
 * radial layout ({@link layoutNetworkGraph}) and mounts the React Flow canvas.
 *
 * MC-D1: the layout is now a pure function of the graph, so a `useMemo` replaces
 * the old async ELK effect + generation guard + "laying out…" placeholder. When
 * the graph changes (a presence frame lands) the memo recomputes inline.
 *
 * Default export so `React.lazy(() => import("./network-canvas"))` resolves it.
 */
export default function NetworkCanvas({
  graph,
  onSelectAgent,
  hover,
  live = false,
}: NetworkCanvasProps) {
  const { nodes: positioned, edges: laidOutEdges } = useMemo(
    () => layoutNetworkGraph(graph),
    [graph],
  );

  if (positioned.length === 0) {
    // No topology yet (empty snapshot) — nothing to constellate.
    return <div className="network-view-empty">No agents on the network yet.</div>;
  }

  const canvas = (
    <ReactFlowProvider>
      <FlowCanvas
        nodes={positioned}
        laidOutEdges={laidOutEdges}
        onSelectAgent={onSelectAgent}
        live={live}
      />
    </ReactFlowProvider>
  );

  // F.2 — bridge the view's hover-highlight into the node tree. When no hover
  // value is supplied, the context's inert default applies (no highlight).
  return hover ? (
    <NetworkHoverContext.Provider value={hover}>
      {canvas}
    </NetworkHoverContext.Provider>
  ) : (
    canvas
  );
}
