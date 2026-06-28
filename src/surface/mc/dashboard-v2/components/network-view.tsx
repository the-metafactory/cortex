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
import type { AgentPresenceTile, AgentsState } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import { pickAgentsPanelMode } from "../lib/agents-display";
import {
  buildNetworkGraph,
  applyTransportOverlay,
  deriveServingPrincipal,
} from "../lib/network-graph-adapter";
import {
  buildTransportOverlay,
  EMPTY_TRANSPORT_OVERLAY,
} from "../lib/network-transport-overlay";
import type { TransportRosterEventRow } from "../../api/observability-tab";
import {
  resolveSelectedAgent,
  selectAgentDispatchActivity,
} from "../lib/network-detail-display";
import {
  buildCapabilityMatchIndex,
  type MatchTask,
} from "../lib/capability-match";
import {
  computeHighlight,
  type HoverTarget,
} from "../lib/capability-highlight";
import {
  EMPTY_SUBTREE_SELECTION,
  toggleHubSelection as computeToggleHubSelection,
  type SubtreeSelection,
} from "../lib/network-subtree-highlight";
import type { NetworkHoverContextValue } from "../lib/network-hover-context";
import {
  DEFAULT_NETWORK_FILTER,
  collectCapabilityOptions,
  filterAgents,
  type NetworkFilterState,
  type NetworkStateFilter,
  type NetworkScopeFilter,
} from "../lib/network-graph-filter";
import { isSpotlightOpenChord } from "../lib/network-spotlight";
import { NetworkDetailPanel } from "./network-detail-panel";
import { NetworkFilterBar } from "./network-filter-bar";
import { NetworkSpotlight } from "./network-spotlight";
import { NetworkRosterPanel } from "./network-roster-panel";
import { PierQueue } from "./pier-queue";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

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
  /**
   * G-1114.F.3 — dispatch a task DIRECTLY to a LOCAL agent. The caller wires
   * this to the EXISTING dispatch path (`POST /api/sessions` with `agentId`) —
   * F.3 reuses that path, it does not invent a new one. Only ever invoked for a
   * LOCAL agent; the panel disables the affordance for a foreign peer (the
   * dispatch path is local-only). Omitted → no dispatch-direct affordance.
   */
  onDispatchDirect?: (agent: AgentPresenceTile) => void;
  /** G-1114.F.3 — agent keys with an in-flight dispatch-direct request. */
  dispatchingAgentKeys?: ReadonlySet<string>;
  /**
   * G-1114.F.1/F.2 — the tasks (each with a required capability, or `null`) to
   * feed the capability-match index. The MC task model doesn't carry a
   * required-capability column yet, so the default is empty — the hover
   * highlight still works fully off the agents' declared capabilities (hover a
   * capability → matching agents glow). When tasks gain a capability field the
   * caller projects them here and the index lights up task↔agent matches.
   */
  matchTasks?: readonly MatchTask[];
  /**
   * P-14 U2.3 (#935) — signal's projected `system.transport.*` roster (the
   * payload-bearing `transportRoster` from `/api/observability-events`, via
   * `useObservability`). When the principal flips the transport-overlay toggle,
   * the view folds these into per-stack verdict badges + leaf liveness/RTT. Empty
   * default → the overlay has nothing to paint (a non-hub stack, or signal not
   * emitting yet). SOURCED FROM SIGNAL — the view never re-derives substrate health.
   */
  transportRoster?: readonly TransportRosterEventRow[];
  /**
   * MC-A1 (cortex#1275) — joined networks + their admitted roster ⋈ presence →
   * membership verdict, from `/api/networks` (via `useNetworks`). Rendered as
   * first-class trust groups ABOVE the agent-topology canvas. Empty default → the
   * roster panel renders nothing (a non-federated stack is unchanged).
   */
  networks?: readonly NetworkMembershipDTO[];
}

export function NetworkView({
  state,
  workingAgents = [],
  onViewInWorkingGrid,
  onDispatchDirect,
  dispatchingAgentKeys,
  matchTasks = [],
  transportRoster = [],
  networks = [],
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
  // #1008 — derive the serving principal from the FULL snapshot (a filter that
  // hides local agents must not lose it) so BOTH the graph adapter AND the
  // click-through detail panel classify a same-principal sibling as LOCAL, not
  // federated. The adapter derives its own copy internally; the panel needs it
  // threaded as a prop (it's pure — no snapshot access of its own).
  const servingPrincipal = useMemo(
    () => deriveServingPrincipal(state.agents),
    [state.agents],
  );
  const filteredAgents = useMemo(
    () => filterAgents(state.agents, filter),
    [state.agents, filter],
  );

  // Pure: filtered snapshot → React-Flow graph (re-derived when agents OR the
  // filter change). Tiny + engine-free, so it stays in the main bundle; the lazy
  // canvas takes the built graph and runs ELK over it.
  const baseGraph = useMemo(() => buildNetworkGraph(filteredAgents), [filteredAgents]);

  // U2.3 — fold signal's transport verdicts + leaf liveness/RTT into the overlay
  // model, then onto the base graph WHEN the overlay toggle is on. Built off the
  // FULL roster (the verdict for a stack is the verdict regardless of agent
  // filters), but applied to the SCOPE-FILTERED graph — so `local-only` cleanly
  // hides foreign verdicts (those hubs/nodes aren't in the graph to paint onto).
  // SOURCED FROM SIGNAL: `buildTransportOverlay` carries signal's verdict strings
  // verbatim; cortex never re-derives them.
  const transportOverlay = useMemo(
    () =>
      filter.transportOverlay
        ? buildTransportOverlay(transportRoster)
        : EMPTY_TRANSPORT_OVERLAY,
    [filter.transportOverlay, transportRoster],
  );
  const graph = useMemo(
    () =>
      filter.transportOverlay
        ? applyTransportOverlay(baseGraph, transportOverlay)
        : baseGraph,
    [baseGraph, transportOverlay, filter.transportOverlay],
  );

  // F.1 — the capability-match index, built off the FULL snapshot (not the
  // filtered one) so a hovered capability lights every declaring agent
  // consistently regardless of the active filter. Origin-blind: foreign agents
  // match purely on declared capabilities, exactly like local ones.
  const matchIndex = useMemo(
    () =>
      buildCapabilityMatchIndex(
        state.agents.map((a) => ({
          key: a.key,
          capabilities: a.capabilities,
          origin: a.origin,
        })),
        matchTasks,
      ),
    [state.agents, matchTasks],
  );

  // F.2 — the cross-component hover target + the derived highlight set. The
  // hover state lives HERE (the view owns the snapshot + index) and is broadcast
  // into the graph node tree via `NetworkHoverContext` (through the lazy canvas)
  // AND read by the detail panel directly.
  const [hoverTarget, setHoverTarget] = useState<HoverTarget>(null);
  const highlight = useMemo(
    () => computeHighlight(hoverTarget, matchIndex),
    [hoverTarget, matchIndex],
  );

  // #1068 — the STICKY hub-subtree selection. The view owns the graph, so it
  // computes the next selection (pure `toggleHubSelection`) when the canvas
  // reports a hub click. Recomputed against the LIVE graph so the highlight set
  // tracks presence changes; if the selected hub vanishes (its stack dropped out
  // of the snapshot) we clear the stale selection (the effect below).
  const [selection, setSelection] = useState<SubtreeSelection>(
    EMPTY_SUBTREE_SELECTION,
  );
  const onToggleHubSelection = useCallback(
    (clickedHubId: string | null) =>
      setSelection((prev) => computeToggleHubSelection(prev, clickedHubId, graph)),
    [graph],
  );
  // Re-derive the highlight set when the graph changes while a hub is selected
  // (an agent popped in/out of that stack), and clear a selection whose hub no
  // longer exists.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.selectedHubId === null) return prev;
      const stillExists = graph.nodes.some((n) => n.id === prev.selectedHubId);
      if (!stillExists) return EMPTY_SUBTREE_SELECTION;
      return computeToggleHubSelection(
        EMPTY_SUBTREE_SELECTION,
        prev.selectedHubId,
        graph,
      );
    });
  }, [graph]);

  const hover = useMemo<NetworkHoverContextValue>(
    () => ({
      highlight,
      setHoverTarget,
      selection,
      toggleHubSelection: onToggleHubSelection,
    }),
    [highlight, selection, onToggleHubSelection],
  );

  // Filter callbacks.
  const onStateChange = useCallback(
    (s: NetworkStateFilter) => setFilter((f) => ({ ...f, state: s })),
    [],
  );
  const onCapabilityChange = useCallback(
    (cap: string | null) => setFilter((f) => ({ ...f, capability: cap })),
    [],
  );
  // E.4 — scope toggle: include-federated (show local + foreign) vs local-only
  // (hide every foreign peer agent). Threads onto the SAME filter the adapter +
  // spotlight read, so flipping it cleanly removes/restores foreign agents.
  const onScopeChange = useCallback(
    (scope: NetworkScopeFilter) => setFilter((f) => ({ ...f, scope })),
    [],
  );
  // U2.3 — flip the transport overlay (a render lens, not an agent predicate).
  const onTransportOverlayChange = useCallback(
    (on: boolean) => setFilter((f) => ({ ...f, transportOverlay: on })),
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

  // D.4 + #909: join the LOCAL working-agents projection ONLY for a LOCAL agent.
  // A foreign peer agent's dispatch activity lives on ITS stack, not ours — the
  // working-agents projection is this stack's, so joining it for a foreign agent
  // would be wrong (and could false-match a same-named local agent_id). Foreign →
  // null; the detail panel renders "federated peer — activity not local".
  const dispatch = useMemo(
    () =>
      selectedAgent && selectedAgent.origin === "local"
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
        Agent <strong>topology</strong> — the agents on this stack and any
        federated peers, their declared capabilities, and their liveness, laid
        out around each stack&rsquo;s hub. Filter by scope to focus on this stack.
      </p>

      {/* MC-A1 — networks as first-class trust groups (admitted roster ⋈
          presence → membership verdict). Renders nothing when none are joined. */}
      <NetworkRosterPanel networks={networks} localPrincipal={servingPrincipal} />

      {/* MC-B1 (cortex#1278) — Pier queue: PENDING admission requests for the
          networks this principal ADMINS (admin posture). Read-only; renders
          nothing when the principal admins no networks. */}
      <PierQueue networks={networks} />

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
            onScopeChange={onScopeChange}
            onTransportOverlayChange={onTransportOverlayChange}
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
                <NetworkCanvas
                  graph={graph}
                  onSelectAgent={setSelectedKey}
                  hover={hover}
                />
              </Suspense>
            )}
            {selectedAgent && (
              <NetworkDetailPanel
                agent={selectedAgent}
                servingPrincipal={servingPrincipal}
                dispatch={dispatch}
                onClose={closePanel}
                onViewInWorkingGrid={onViewInWorkingGrid}
                {...(onDispatchDirect ? { onDispatchDirect } : {})}
                dispatchBusy={
                  dispatchingAgentKeys?.has(selectedAgent.key) ?? false
                }
                highlightedCapabilities={highlight.capabilities}
                onHoverCapability={(cap) =>
                  setHoverTarget(
                    cap === null
                      ? null
                      : { kind: "capability", capability: cap },
                  )
                }
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
