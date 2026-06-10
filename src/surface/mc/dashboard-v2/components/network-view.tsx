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
import {
  DEFAULT_NETWORK_FILTER,
  collectCapabilityOptions,
  filterAgents,
  type NetworkFilterState,
  type NetworkStateFilter,
} from "../lib/network-graph-filter";
import { isSpotlightOpenChord } from "../lib/network-spotlight";
import { NetworkDetailPanel } from "./network-detail-panel";
import { NetworkFilterBar } from "./network-filter-bar";
import { NetworkSpotlight } from "./network-spotlight";

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

  // D.5 — filters. The filter state lives here so it feeds BOTH the graph adapter
  // and the spotlight off ONE filtered snapshot (filter + search stay consistent).
  // Capability options are derived from the FULL (unfiltered) snapshot so the
  // dropdown never drops the option that's currently selected as agents come/go.
  const [filter, setFilter] = useState<NetworkFilterState>(DEFAULT_NETWORK_FILTER);
  const capabilityOptions = useMemo(
    () => collectCapabilityOptions(state.agents),
    [state.agents],
  );
  const filteredAgents = useMemo(
    () => filterAgents(state.agents, filter),
    [state.agents, filter],
  );

  // Pure: filtered snapshot → React-Flow graph (re-derived when agents OR the
  // filter change). Tiny + engine-free, so it stays in the main bundle; the lazy
  // canvas takes the built graph and runs ELK over it.
  const graph = useMemo(() => buildNetworkGraph(filteredAgents), [filteredAgents]);

  // Filter callbacks.
  const onStateChange = useCallback(
    (s: NetworkStateFilter) => setFilter((f) => ({ ...f, state: s })),
    [],
  );
  const onCapabilityChange = useCallback(
    (cap: string | null) => setFilter((f) => ({ ...f, capability: cap })),
    [],
  );
  const onClearFilters = useCallback(() => setFilter(DEFAULT_NETWORK_FILTER), []);

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

  // D.5 — Cmd+K spotlight. Open state is local to the Network view (the spotlight
  // only makes sense here), and selecting a hit reuses D.4's selection path.
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const openSpotlight = useCallback(() => setSpotlightOpen(true), []);
  const closeSpotlight = useCallback(() => setSpotlightOpen(false), []);
  const onSpotlightSelect = useCallback((key: string) => {
    // Reuse D.4's selection: set the key → the live tile resolves → panel opens.
    setSelectedKey(key);
  }, []);

  // Cmd+K / Ctrl+K opens the spotlight. Registered on the CAPTURE phase so it
  // runs BEFORE the app-level global ⌘K palette (a bubble-phase listener) and
  // `stopPropagation()`s it — on the Network tab, ⌘K opens the agent spotlight,
  // not the generic command palette. Only armed while the view is mounted (the
  // tab is active), so it doesn't shadow ⌘K elsewhere.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if (isSpotlightOpenChord(e)) {
        e.preventDefault();
        e.stopPropagation();
        setSpotlightOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyCapture, true);
    return () => window.removeEventListener("keydown", onKeyCapture, true);
  }, []);

  // Esc precedence (D.5 over D.4): if the spotlight is open, Esc closes IT first
  // and the detail panel stays; only when the spotlight is closed does Esc
  // dismiss the panel. The spotlight overlay (CommandPalette) also handles its
  // own Esc internally, but this guard makes the precedence explicit + covers the
  // case where focus isn't in the overlay input.
  useEffect(() => {
    if (selectedKey === null && !spotlightOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (spotlightOpen) {
        setSpotlightOpen(false);
        return;
      }
      closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, spotlightOpen, closePanel]);

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
        <>
          <NetworkFilterBar
            filter={filter}
            capabilityOptions={capabilityOptions}
            onStateChange={onStateChange}
            onCapabilityChange={onCapabilityChange}
            onClear={onClearFilters}
            onOpenSpotlight={openSpotlight}
          />
          <div className="network-canvas-wrap">
            {filteredAgents.length === 0 ? (
              // The snapshot has agents but the active filter excludes them all.
              // Keep the filter bar above so the principal can clear/relax it.
              <div className="network-view-empty">
                No agents match the current filters.
              </div>
            ) : (
              <Suspense
                fallback={
                  // The graph-engine chunk is downloading on first tab entry.
                  <div className="network-view-empty">Loading network…</div>
                }
              >
                <NetworkCanvas graph={graph} onSelectAgent={setSelectedKey} />
              </Suspense>
            )}
            {selectedAgent && (
              <NetworkDetailPanel
                agent={selectedAgent}
                dispatch={dispatch}
                onClose={closePanel}
                onViewInWorkingGrid={onViewInWorkingGrid}
              />
            )}
          </div>
          <NetworkSpotlight
            open={spotlightOpen}
            onClose={closeSpotlight}
            agents={filteredAgents}
            onSelect={onSpotlightSelect}
          />
        </>
      )}
    </section>
  );
}
