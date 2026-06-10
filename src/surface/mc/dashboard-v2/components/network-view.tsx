/**
 * G-1114.D.1 — Network graph view (React Flow + ELK).
 *
 * Replaces the simple agents PANEL (the G-1114.B.4 `NetworkPreviewView`) with a
 * laid-out topology graph: the stack as a hub, every agent as a node fanned
 * around it (radial ELK layout). Same data source — `useAgents` → `/api/agents`
 * + the `agent.presence` WS frame — so the graph pops agents in on boot and
 * drops them off when they go offline, live.
 *
 * ## Async layout
 *
 * ELK runs asynchronously. The view derives the React-Flow graph from the agents
 * snapshot (pure adapter), then runs ELK in an effect and stores the positioned
 * nodes in state. A generation guard drops a stale layout if the snapshot changed
 * while ELK was mid-flight (e.g. a presence frame landed during layout).
 *
 * ## State precedence
 *
 * The empty / loading / error states are chosen by the SAME `pickAgentsPanelMode`
 * the panel used, and they render WITHOUT mounting xyflow — so they're
 * server-renderable and the heavy canvas only mounts when there are agents.
 *
 * ADR-0007: nodes carry presence + lifecycle only — never session interiors.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { AgentsState } from "../hooks/use-agents";
import { pickAgentsPanelMode } from "../lib/agents-display";
import {
  buildNetworkGraph,
  STACK_HUB_NODE_ID,
  type NetworkGraphNode,
} from "../lib/network-graph-adapter";
import { layoutNetworkGraph } from "../lib/network-graph-layout";
import { AgentNode, StackHubNode } from "./network-nodes";
import { NetworkLegend } from "./network-legend";

// Registered once at module scope — React Flow warns if `nodeTypes` is a fresh
// object each render.
const nodeTypes: NodeTypes = {
  stackHub: StackHubNode,
  agent: AgentNode,
};

// One ELK engine for the view's lifetime, instantiated lazily on first layout.
// Module-scope `new ELK()` spins up a Web Worker, which is unavailable in the
// (DOM-less) unit-test env — deferring it keeps `import`ing this module safe in
// tests while the browser bundle still gets a single shared engine.
let elkSingleton: InstanceType<typeof ELK> | null = null;
function getElk(): InstanceType<typeof ELK> {
  if (!elkSingleton) elkSingleton = new ELK();
  return elkSingleton;
}

export interface NetworkViewProps {
  state: AgentsState;
}

/** The xyflow canvas — only mounted when there are positioned nodes. */
function NetworkCanvas({ nodes }: { nodes: NetworkGraphNode[] }) {
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
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls position="bottom-left" showInteractive={false} />
      <NetworkLegend />
    </ReactFlow>
  );
}

export function NetworkView({ state }: NetworkViewProps) {
  const mode = pickAgentsPanelMode(state);

  // Pure: snapshot → React-Flow graph (re-derived only when the agents change).
  const graph = useMemo(() => buildNetworkGraph(state.agents), [state.agents]);

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
        // Drop a stale layout: the snapshot changed (new gen) or the effect was
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
          "[network-view] ELK layout failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  return (
    <section className="scaffold-section network-view" aria-label="Network (agent topology)">
      <h2>Network</h2>
      <p className="dim network-view-subtitle">
        Stack-local agent <strong>topology</strong> — the agents on this stack,
        their declared capabilities, and their liveness, laid out around the
        stack hub. Cross-stack federated peers arrive in G-1114.E.
      </p>

      {mode === "error" && (
        <div className="network-view-error">⚠ {state.error}</div>
      )}
      {mode === "loading" && (
        <div className="network-view-empty">Loading…</div>
      )}
      {mode === "empty" && (
        <div className="network-view-empty">No agents observed yet.</div>
      )}
      {mode === "list" && (
        <div className="network-canvas-wrap">
          {positioned.length > 0 ? (
            <ReactFlowProvider>
              <NetworkCanvas nodes={positioned} />
            </ReactFlowProvider>
          ) : (
            // Agents loaded, ELK still computing the first layout.
            <div className="network-view-empty">Laying out topology…</div>
          )}
        </div>
      )}
    </section>
  );
}
