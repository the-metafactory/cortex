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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Controls,
  Panel,
  ReactFlowProvider,
  useReactFlow,
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
import { AgentNode, StackHubNode, FederatedPeerNode } from "./network-nodes";
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
  // MC-D4 — the absent admitted-federated-peer placeholder (dimmed grey orb).
  federatedPeer: FederatedPeerNode,
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

/**
 * MC — the fullscreen/expand control, rendered as a React Flow `Panel` in the
 * top-right so it sits alongside the zoom controls (bottom-left). A real
 * `<button>` with an `aria-label`, it toggles the canvas wrapper between boxed
 * and viewport-filling. On EVERY toggle it re-fits the graph to the new size
 * (`fitView`) after a paint so the constellation re-centers. Uses `useReactFlow`,
 * so it must render INSIDE the `ReactFlowProvider`.
 */
function FullscreenToggle({
  isFullscreen,
  onToggle,
}: {
  isFullscreen: boolean;
  onToggle: () => void;
}) {
  const { fitView } = useReactFlow();
  // Re-fit whenever the fullscreen state flips: the viewport just resized, so the
  // radial layout should re-center to the new bounds. Deferred to the next frame
  // so the DOM has taken the new size before we measure + fit.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      void fitView({ duration: 200 });
    });
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen, fitView]);
  return (
    <button
      type="button"
      className="network-fullscreen-btn"
      onClick={onToggle}
      aria-pressed={isFullscreen}
      aria-label={
        isFullscreen ? "Exit fullscreen network graph" : "Expand network graph to fullscreen"
      }
      title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
    >
      <span aria-hidden="true">⛶</span>
      <span className="network-fullscreen-btn-label">
        {isFullscreen ? "Exit" : "Fullscreen"}
      </span>
    </button>
  );
}

/** The React Flow canvas — rendered once ELK has positioned the nodes. */
function FlowCanvas({
  nodes,
  laidOutEdges,
  onSelectAgent,
  live = false,
  isFullscreen = false,
  onToggleFullscreen,
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
  /** MC — the canvas wrapper is currently viewport-filling. Drives the button label. */
  isFullscreen?: boolean;
  /** MC — toggle the canvas wrapper between boxed and fullscreen. */
  onToggleFullscreen?: () => void;
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
          // MC-D4 — the DOTTED anchor edge from the local hub to an ABSENT
          // admitted-federated-peer placeholder. Rendered dotted + static
          // (absent = no flow), distinct from the solid local edge and the dashed
          // present-peer `federated` edge.
          federatedAbsent: e.data?.federatedAbsent ?? false,
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
      {/* MC — the fullscreen/expand control, top-right by the zoom controls. Only
          rendered when a toggle is wired (the host may omit it in a test). */}
      {onToggleFullscreen && (
        <Panel position="top-right">
          <FullscreenToggle
            isFullscreen={isFullscreen}
            onToggle={onToggleFullscreen}
          />
        </Panel>
      )}
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

  // MC — fullscreen/expand. The wrapper ref is the fullscreen target; we PREFER
  // the browser Fullscreen API (`requestFullscreen`/`exitFullscreen`) and fall
  // back to a CSS fixed-overlay when it's unavailable/denied (both drive the same
  // `is-fullscreen` class the CSS keys off, so the visual is identical). The
  // browser fires `fullscreenchange` on the API path (incl. the user pressing
  // Esc), and we mirror Esc for the CSS-overlay path ourselves.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // True while we're in the CSS-overlay fallback (no Fullscreen API), so Esc is
  // handled by us rather than the browser.
  const cssFallbackRef = useRef(false);

  const enterFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (el && typeof el.requestFullscreen === "function") {
      el.requestFullscreen().catch((err: unknown) => {
        // Denied / unsupported → CSS-overlay fallback (still fills the viewport).
        // eslint-disable-next-line no-console
        console.warn("[network-canvas] requestFullscreen failed:", err);
        cssFallbackRef.current = true;
        setIsFullscreen(true);
      });
      return;
    }
    // No Fullscreen API at all → CSS-overlay fallback.
    cssFallbackRef.current = true;
    setIsFullscreen(true);
  }, []);

  const exitFullscreen = useCallback(() => {
    if (cssFallbackRef.current) {
      cssFallbackRef.current = false;
      setIsFullscreen(false);
      return;
    }
    if (
      typeof document !== "undefined" &&
      document.fullscreenElement &&
      typeof document.exitFullscreen === "function"
    ) {
      void document.exitFullscreen();
    }
    // The `fullscreenchange` handler flips state for the API path.
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Fullscreen API path: mirror the browser's fullscreen state (covers the user
  // pressing Esc or the browser exiting fullscreen for any reason).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      if (cssFallbackRef.current) return; // CSS fallback owns its own state
      setIsFullscreen(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // CSS-overlay fallback path: Esc exits (the Fullscreen API handles Esc itself).
  useEffect(() => {
    if (!isFullscreen || !cssFallbackRef.current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        exitFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, exitFullscreen]);

  const canvas = (
    <ReactFlowProvider>
      <FlowCanvas
        nodes={positioned}
        laidOutEdges={laidOutEdges}
        onSelectAgent={onSelectAgent}
        live={live}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />
    </ReactFlowProvider>
  );

  // The fullscreen wrapper is ALWAYS mounted (so the ref is stable across the
  // empty/non-empty transition and hooks run unconditionally). When there's no
  // topology yet we render the empty state inside it.
  const inner =
    positioned.length === 0 ? (
      // No topology yet (empty snapshot) — nothing to constellate.
      <div className="network-view-empty">No agents on the network yet.</div>
    ) : hover ? (
      // F.2 — bridge the view's hover-highlight into the node tree. When no hover
      // value is supplied, the context's inert default applies (no highlight).
      <NetworkHoverContext.Provider value={hover}>
        {canvas}
      </NetworkHoverContext.Provider>
    ) : (
      canvas
    );

  return (
    <div
      ref={wrapRef}
      className={
        "network-canvas-fullscreen-target" +
        (isFullscreen ? " is-fullscreen" : "")
      }
      data-fullscreen={isFullscreen ? "true" : undefined}
    >
      {inner}
    </div>
  );
}
