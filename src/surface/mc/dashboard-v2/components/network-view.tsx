/**
 * G-1114.D.1 — Network graph view (React Flow + ELK).
 *
 * Replaces the simple agents PANEL (the G-1114.B.4 `NetworkPreviewView`) with a
 * laid-out topology graph: the stack as a hub, every agent as a node fanned
 * around it (radial ELK layout). Same data source — `useAgents` → `/api/agents`
 * + the `agent.presence` WS frame — so the graph pops agents in on boot and
 * drops them off when they go offline, live.
 *
 * ## Code-split (PR #905 review)
 *
 * This module stays in the MAIN bundle: it's the chrome (heading + subtitle +
 * empty/loading/error states) plus the PURE `buildNetworkGraph` adapter — all
 * tiny and engine-free. The heavy half — `@xyflow/react` + `elkjs` (the
 * GWT-compiled ELK engine, +0.62 MB gzip) + the async layout effect — lives in
 * `./network-canvas`, which this view `React.lazy`-imports so the engine chunk
 * downloads ONLY when the principal first opens the Network tab. The dashboard's
 * default view is the working grid, so the common load path never pays for the
 * graph engine. This is the dashboard's first code-split.
 *
 * ## State precedence
 *
 * The empty / loading / error states are chosen by the SAME `pickAgentsPanelMode`
 * the panel used, and they render WITHOUT the lazy canvas — so they stay
 * server-renderable and the heavy chunk only loads when there are agents.
 *
 * ADR-0007: nodes carry presence + lifecycle only — never session interiors.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentsState } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import { pickAgentsPanelMode } from "../lib/agents-display";
import { buildNetworkGraph } from "../lib/network-graph-adapter";
import {
  resolveSelectedAgent,
  selectAgentDispatchActivity,
} from "../lib/network-detail-display";
import { NetworkDetailPanel } from "./network-detail-panel";

// Lazy: the xyflow + elk engine chunk loads only when this resolves (first
// entry into the Network tab). Keep this the ONLY dynamic import in the view —
// the other dashboard views stay statically bundled.
const NetworkCanvas = lazy(() => import("./network-canvas"));

export interface NetworkViewProps {
  state: AgentsState;
  /**
   * The working-agents snapshot (already fetched at app scope for the working
   * grid). D.4 joins it by `agent_id` to surface a LIGHT dispatch-activity
   * pointer in the detail panel — never session interiors (ADR-0007). Defaults
   * to empty (the panel renders "no active dispatch" without it).
   */
  workingAgents?: readonly WorkingAgentTile[];
  /**
   * Jump to the working grid (the dashboard's default view). When provided, the
   * detail panel shows a "view in working grid" pointer for the dispatch
   * lifecycle in full.
   */
  onViewInWorkingGrid?: () => void;
}

export function NetworkView({
  state,
  workingAgents = [],
  onViewInWorkingGrid,
}: NetworkViewProps) {
  const mode = pickAgentsPanelMode(state);

  // Pure: snapshot → React-Flow graph (re-derived only when the agents change).
  // Tiny + engine-free, so it stays in the main bundle; the lazy canvas takes
  // the built graph and runs ELK over it.
  const graph = useMemo(() => buildNetworkGraph(state.agents), [state.agents]);

  // D.4 — node-click selection. The canvas lifts the clicked agent's key here;
  // the panel re-reads the LIVE tile off the snapshot by key, so it reflects
  // presence updates and auto-closes if the agent disappears.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedAgent = useMemo(
    () => resolveSelectedAgent(state.agents, selectedKey),
    [state.agents, selectedKey],
  );

  // Auto-close: if the selected agent dropped out of the snapshot (went away),
  // clear the stale key so we don't hold a dead selection. `selectedAgent` is
  // already null for the render; this resets the key for the next click.
  useEffect(() => {
    if (selectedKey !== null && selectedAgent === null) {
      setSelectedKey(null);
    }
  }, [selectedKey, selectedAgent]);

  const dispatch = useMemo(
    () =>
      selectedAgent
        ? selectAgentDispatchActivity(workingAgents, selectedAgent.agent_id)
        : null,
    [workingAgents, selectedAgent],
  );

  const closePanel = useCallback(() => setSelectedKey(null), []);

  // Esc dismisses the detail panel (keyboard a11y; button + pane-click also close).
  useEffect(() => {
    if (selectedKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, closePanel]);

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
          <Suspense
            fallback={
              // The graph-engine chunk is downloading on first tab entry.
              <div className="network-view-empty">Loading network…</div>
            }
          >
            <NetworkCanvas graph={graph} onSelectAgent={setSelectedKey} />
          </Suspense>
          {selectedAgent && (
            <NetworkDetailPanel
              agent={selectedAgent}
              dispatch={dispatch}
              onClose={closePanel}
              onViewInWorkingGrid={onViewInWorkingGrid}
            />
          )}
        </div>
      )}
    </section>
  );
}
