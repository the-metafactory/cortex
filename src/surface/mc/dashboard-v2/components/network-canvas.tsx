/**
 * G-1114.D.1 — Network graph CANVAS (the code-split heavy half).
 *
 * This module is the ONLY place `@xyflow/react` + `elkjs` are imported, so it
 * lands in a **lazily-loaded chunk** that the dashboard pulls only when the
 * principal first opens the Network tab (`network-view.tsx` `React.lazy`-imports
 * it). The default dashboard view is the working grid, not Network — splitting
 * the graph engine (+0.62 MB gzip) out of the entry bundle keeps it off the
 * common load path (PR #905 review: fold the code-split in). This is the
 * dashboard's first code-split; it establishes the pattern for D.4/D.5
 * (DetailPanel, SpotlightSearch) which will only add to this chunk.
 *
 * It owns the ELK layout effect (ELK is async + WASM-Worker-backed, so it only
 * runs once this chunk is loaded and mounted) and renders the React Flow canvas.
 * The pure adapter/layout/legend/card-inners stay in the main bundle — they're
 * tiny + unit-tested and don't pull the engine.
 *
 * ADR-0007: nodes carry presence + lifecycle only — never session interiors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  STACK_HUB_NODE_ID,
  type NetworkGraph,
  type NetworkGraphNode,
} from "../lib/network-graph-adapter";
import { agentKeyFromClickedNode } from "../lib/network-detail-display";
import { layoutNetworkGraph } from "../lib/network-graph-layout";
import { AgentNode, StackHubNode } from "./network-nodes";
import { NetworkLegend } from "./network-legend";

// Registered once at module scope — React Flow warns if `nodeTypes` is a fresh
// object each render.
const nodeTypes: NodeTypes = {
  stackHub: StackHubNode,
  agent: AgentNode,
};

// One ELK engine for this chunk's lifetime, instantiated lazily on first layout.
// Module-scope `new ELK()` spins up a Web Worker, which is unavailable in the
// (DOM-less) unit-test env — deferring it keeps `import`ing this module safe in
// tests while the browser bundle still gets a single shared engine.
let elkSingleton: InstanceType<typeof ELK> | null = null;
function getElk(): InstanceType<typeof ELK> {
  if (!elkSingleton) elkSingleton = new ELK();
  return elkSingleton;
}

export interface NetworkCanvasProps {
  /** The pre-built (un-positioned) graph from the main-bundle adapter. */
  graph: NetworkGraph;
  /**
   * Lift a node selection up to the view (D.4): an agent node → its key, the
   * stack-hub node or empty canvas → `null` (deselect). The view holds the
   * selected key and renders the detail panel.
   */
  onSelectAgent?: (key: string | null) => void;
}

/** The React Flow canvas — rendered once ELK has positioned the nodes. */
function FlowCanvas({
  nodes,
  onSelectAgent,
}: {
  nodes: NetworkGraphNode[];
  onSelectAgent?: (key: string | null) => void;
}) {
  // React Flow's node `data` is typed `Record<string, unknown>`; our discriminated
  // `NetworkNodeData` is structurally compatible but lacks the index signature, so
  // we cast at this single boundary rather than polluting the adapter's data type.
  const rfNodes = nodes as unknown as RfNode[];

  // The hub→agent edges are derivable, but for the star render we don't need
  // visible connectors to read the grouping; the radial placement carries it.
  // We still pass edges so the layout's parent/child relationship is honoured by
  // React Flow's node ordering. Edges are rebuilt here from node ids.
  const edges = useMemo<RfEdge[]>(
    () =>
      nodes
        .filter((n) => n.type === "agent")
        .map((n) => ({
          id: `hub-${n.id}`,
          source: STACK_HUB_NODE_ID,
          target: n.id,
        })),
    [nodes],
  );

  // Node click → lift the agent key up (D.4). The pure
  // `agentKeyFromClickedNode` resolves agent-node→key / hub→null, so this
  // handler is a thin delegation (the click→lift logic itself is unit-tested
  // off the helper, since xyflow can't mount in `bun test`).
  const onNodeClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (!onSelectAgent) return;
      onSelectAgent(
        agentKeyFromClickedNode(node as unknown as NetworkGraphNode),
      );
    },
    [onSelectAgent],
  );

  // Click on empty canvas → deselect (close the panel).
  const onPaneClick = useCallback(() => {
    onSelectAgent?.(null);
  }, [onSelectAgent]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls position="bottom-left" showInteractive={false} />
      <NetworkLegend />
    </ReactFlow>
  );
}

/**
 * The lazy canvas entry. Runs ELK over the incoming graph (async) and mounts the
 * React Flow canvas once positioned. A generation guard drops a stale layout if
 * the graph changed (a presence frame landed) while ELK was mid-flight.
 *
 * Default export so `React.lazy(() => import("./network-canvas"))` resolves it.
 */
export default function NetworkCanvas({
  graph,
  onSelectAgent,
}: NetworkCanvasProps) {
  const [positioned, setPositioned] = useState<NetworkGraphNode[]>([]);
  const genRef = useRef(0);

  useEffect(() => {
    const myGen = ++genRef.current;
    if (graph.nodes.length === 0) {
      setPositioned([]);
      return;
    }
    let cancelled = false;
    void layoutNetworkGraph(getElk(), graph)
      .then((nodes) => {
        // Drop a stale layout: the graph changed (new gen) or the effect was
        // torn down while ELK was mid-flight.
        if (cancelled || genRef.current !== myGen) return;
        setPositioned(nodes);
      })
      .catch((err: unknown) => {
        if (cancelled || genRef.current !== myGen) return;
        // Layout failure shouldn't blank the tab — log and leave the last-good
        // graph. `console.warn` is the only emit path in the bundle.
        // eslint-disable-next-line no-console
        console.warn(
          "[network-canvas] ELK layout failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  if (positioned.length === 0) {
    // Engine loaded + mounted, ELK still computing the first layout.
    return <div className="network-view-empty">Laying out topology…</div>;
  }

  return (
    <ReactFlowProvider>
      <FlowCanvas nodes={positioned} onSelectAgent={onSelectAgent} />
    </ReactFlowProvider>
  );
}
