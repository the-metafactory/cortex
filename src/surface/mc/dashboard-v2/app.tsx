/**
 * Top-level <App/> for Grove Mission Control v2 React app.
 *
 * Shell layout (header + main), theme toggle, ⌘K palette, F-6 focus
 * area, V4-flavoured drill-down (MIG-3). Working grid (F-9) + task
 * table (F-8) land in MIG-4 / MIG-5.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./components/command-palette";
import { DrillDown } from "./components/drill-down";
import { FocusArea } from "./components/focus-area";
import { IterationBoard } from "./components/iteration-board";
import { IterationDetail } from "./components/iteration-detail";
import { Keycap, KeySeq } from "./components/keycap";
import { TaskTable, resolveOpenTarget } from "./components/task-table";
import { WorkingGrid } from "./components/working-grid";
import { useIterations } from "./hooks/use-iterations";
import { useMetrics } from "./hooks/use-metrics";
import { useWorkingAgents } from "./hooks/use-working-agents";
import { useWorkingAggregation } from "./hooks/use-working-aggregation";
import { MetricsPanel } from "./components/metrics-panel";
import { SourcesView } from "./components/sources-view";
import { RepositoriesView } from "./components/repositories-view";
import { PlansView } from "./components/plans-view";
import { PhaseDetailView } from "./components/phase-detail-view";
import { WorkItemDetailView } from "./components/work-item-detail-view";
import { AttentionView } from "./components/attention-view";
import { NetworkView } from "./components/network-view";
import { GovernanceView } from "./components/governance-view";
import { ObservabilityView } from "./components/observability-view";
import { Toast } from "./components/toast";
import { useFocusArea } from "./hooks/use-focus-area";
import { useTasks } from "./hooks/use-tasks";
import { useGitLinks } from "./hooks/use-git-links";
import { useSoftwareMode } from "./hooks/use-software-mode";
import { useLegacyIterations } from "./hooks/use-legacy-iterations";
import { useRepositories } from "./hooks/use-repositories";
import { usePlans } from "./hooks/use-plans";
import { usePhaseDetail } from "./hooks/use-phase-detail";
import { useAttention } from "./hooks/use-attention";
import { useAgents } from "./hooks/use-agents";
import { useNetworks } from "./hooks/use-networks";
import { useGovernance } from "./hooks/use-governance";
import { useObservability } from "./hooks/use-observability";
import { useObsMetrics } from "./hooks/use-obs-metrics";
import type { AgentPresenceTile } from "./hooks/use-agents";
import { useWorkItemDetail } from "./hooks/use-work-item-detail";
import { useTheme } from "./hooks/use-theme";
import { useWebSocket } from "./hooks/use-websocket";
import { ApiFailure, postJson } from "./lib/api";
import { DEFAULT_AGENT_DISPLAY_NAME } from "./lib/agent-defaults";
import type { CreateIterationResponse } from "../api/types";
import type { AssignmentListItem } from "../db/assignments";
import type { TaskListItem } from "../db/tasks";
import type { Command } from "./components/command-palette";

/**
 * Top-level dashboard views.
 *
 *   - `default`        — focus row + working grid + task table (execution side).
 *   - `iterations`     — kanban board (planning side; F-14).
 *   - `kanban-detail`  — single-iteration detail surface (F-15). Reached
 *                        from a kanban card click; the close (X) button
 *                        returns to `iterations`.
 *
 * No router lib — `useState` + the existing tab buttons pattern. F-15
 * may upgrade to a hash route if deep-linking turns out to be
 * principal-requested; for now the in-memory view is sufficient.
 */
type DashboardView = "default" | "metrics" | "iterations" | "sources" | "repositories" | "plans" | "phase-detail" | "work-item-detail" | "attention" | "kanban-detail" | "network" | "governance" | "observability";

/**
 * CK-3 / D-1(c) — the legacy escape hatch. The cockpit (in the Network view) is
 * now the stack-scoped home for the ATTENTION + GOVERNANCE surfaces; their
 * whole-dashboard standalone tabs are kept behind `?legacy=1` for ONE release,
 * then CK-10 deletes them. Read once at module load (the flag never changes
 * mid-session). SSR-safe (`renderToStaticMarkup` tests have no `window`).
 */
const LEGACY_ESCAPE_HATCH =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("legacy") === "1";

export function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  // G-1113.C.7 — software mode gates the Repositories panel.
  const { softwareMode, toggle: toggleSoftwareMode } = useSoftwareMode();
  // G-1113.D.6 — legacy-iterations toggle gates the legacy Iterations kanban
  // (default ON until the Plans surface reaches parity).
  const { legacyIterations, toggle: toggleLegacyIterations } = useLegacyIterations();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone?: "ok" | "error" | "info" } | null>(null);

  // Single WebSocket client owned at App level; shared via prop with
  // every feature hook. Future hooks (use-tasks, use-working-agents)
  // attach the same way.
  const ws = useWebSocket();
  const focus = useFocusArea(ws);
  const tasks = useTasks(ws);
  const working = useWorkingAgents(ws);
  // CK-4b (cortex#1295) — cross-stack WORKING rollup feed for the cockpit's
  // "Across stacks" pane-of-glass lane. App-level (principal-wide, own stacks),
  // mirroring `useWorkingAgents`; forwarded through NetworkView → McCockpit.
  const workingAgg = useWorkingAggregation(ws);
  const iterations = useIterations(ws);

  // G-1113.C.6 — batch-fetch PR/branch links for the visible github-sourced
  // tasks so each row can render first-class chips.
  const gitRefs = useMemo(
    () =>
      tasks.visible
        .filter((t) => t.source.provider === "github" && t.source.externalId)
        .map((t) => t.source.externalId as string),
    [tasks.visible]
  );
  const gitLinks = useGitLinks(gitRefs);
  const metrics = useMetrics(ws);
  const [focusSelectedIdx, setFocusSelectedIdx] = useState<number>(-1);

  // F-14 / F-15 — top-nav view switcher. `default` = the four
  // execution-side surfaces; `iterations` = the kanban; `kanban-detail`
  // = a single iteration's detail surface (entered via card click on
  // the kanban, exited via the detail surface's Close button which
  // returns to `iterations`).
  const [view, setView] = useState<DashboardView>("default");
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(null);
  // G-1113.D.4 — selected phase for the phase-detail surface (reached from the
  // Plans overview by clicking a phase; exited back to `plans`).
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  // G-1113.D.5 — selected work item for the work-item-detail surface.
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  // G-1113.E.3 — work-item-detail is reachable from TWO surfaces (phase-detail
  // and the Attention queue); remember which to return to on close so "back"
  // never lands on a blank phase-detail (no phase selected).
  const [workItemBackView, setWorkItemBackView] = useState<DashboardView>("phase-detail");
  // G-1113.C.7 — Repositories panel data (fetched only when on its tab).
  const repos = useRepositories(softwareMode && view === "repositories");
  // G-1113.D.3 — Plans overview data (fetched only when on its tab).
  const plans = usePlans(softwareMode && view === "plans");
  // G-1113.D.4 — phase-detail data (fetched whenever a phase is selected).
  const phaseDetail = usePhaseDetail(view === "phase-detail" ? selectedPhaseId : null);
  // G-1113.D.5 — work-item-detail data (fetched whenever a work item is selected).
  const workItemDetail = useWorkItemDetail(view === "work-item-detail" ? selectedWorkItemId : null);
  // G-1113.E.3 — attention queue data. Enabled on the legacy Attention tab AND on
  // the Network tab (CK-3): the cockpit's ATTENTION lane consumes this ONE
  // snapshot (fetched once + WS-kept-fresh), scoped per-stack in the panel — the
  // single subscription that replaces the folded surfaces' fetch-on-tab-visible.
  const attention = useAttention(
    ws,
    (softwareMode && view === "attention") || view === "network",
  );
  // G-1114.B.4 — stack-local agent-presence data (fetched only when on the
  // Network tab); live-refreshed off the `agent.presence` WS frame.
  const agents = useAgents(ws, view === "network");
  // MC-A1 (cortex#1275) — joined networks + admitted roster ⋈ presence, for the
  // Network view's first-class trust-group panel. Fetched only when the tab is
  // visible; refreshes off the same `agent.presence` signal as `useAgents`.
  const networks = useNetworks(ws, view === "network");
  // G-1115 — governance verdicts. Enabled on the legacy Governance tab AND on the
  // Network tab (CK-3): the cockpit's GOVERN lane folds this audit scoped to the
  // dived stack. Same single-snapshot rationale as `attention` above.
  const governance = useGovernance(ws, view === "governance" || view === "network");
  // P-14 U2.1 (#934) — observability events (signal's four system.* families),
  // fetched when the Observability tab is visible; live-refreshed off the
  // `observability` mc.projection family.
  // P-14 U2.3 (#935) — ALSO fetched on the Network tab: its transport overlay
  // folds signal's `transportRoster` (the verdict-bearing transport family) onto
  // the graph, so the same projection feeds both tabs.
  const observability = useObservability(
    ws,
    view === "observability" || view === "network",
  );
  // P-14 U4.2 (#938) — aggregate metrics panels (tool/spawn/event rates +
  // hook-latency percentiles via the sideband /metrics/summary) and the >14d
  // history view (events past MC's 14-day local prune, sourced from signal's
  // VictoriaLogs via /search). Fetched only when the Observability tab is open.
  const obsMetrics = useObsMetrics(view === "observability");
  // If software mode is toggled OFF while on a software-mode view (Repositories
  // / Plans / phase-detail / work-item-detail / attention), the tab + render
  // both gate off — reset to default so the main area isn't left blank.
  useEffect(() => {
    if (
      !softwareMode &&
      (view === "repositories" ||
        view === "plans" ||
        view === "phase-detail" ||
        view === "work-item-detail" ||
        view === "attention")
    ) {
      setView("default");
    }
  }, [softwareMode, view]);
  // G-1113.D.6 — if the legacy kanban is toggled OFF while on the Iterations
  // tab or its detail surface, reset to default so the main area isn't blank.
  useEffect(() => {
    if (!legacyIterations && (view === "iterations" || view === "kanban-detail")) {
      setView("default");
    }
  }, [legacyIterations, view]);

  // Drill-down state — only one open at a time per F-7 Decision 9.
  const [drillId, setDrillId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);

  // Resolve drill assignment by id. F-6 (focus row) is the canonical
  // source for blocked items; F-8 (task table) opens via the primary
  // active assignment which may not be blocked. We synthesise an
  // AssignmentListItem from the task projection for the latter case so
  // <DrillHeader/> + <CurationToolbar/> have the metadata they need.
  //
  // The synthesised shape is faithful enough for rendering — the drill
  // overlay's WS subscription lifts the freshest server-side state via
  // `state.transition` frames, so any drift here gets corrected in
  // milliseconds. If MIG-5's working-grid wants the same lookup it can
  // share this resolver later.
  const drillAssignment: AssignmentListItem | null = useMemo(() => {
    if (!drillId) return null;
    const fromFocus = focus.items.find((i) => i.id === drillId);
    if (fromFocus) return fromFocus;
    return synthesiseFromTasks(drillId, tasks.all);
  }, [drillId, focus.items, tasks.all]);

  // Global ⌘K — open the palette. Kept at app-level so any future surface
  // (drill-down, task table) can dispatch into the same palette state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
      if (e.shiftKey && e.key === "T" && !targetIsTextInput(e.target)) {
        e.preventDefault();
        toggleTheme();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTheme]);

  // F-19 — task IDs with an in-flight dispatch. Used to disable the
  // button (single-tab two-click protection per Decision 5).
  const [dispatchingTaskIds, setDispatchingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // G-1114.F.3 — agent KEYS with an in-flight dispatch-direct (Network detail
  // panel). Keyed by registry key so a busy state on one agent doesn't disable
  // another. Same two-click protection idea as F-19's task-keyed set.
  const [dispatchingAgentKeys, setDispatchingAgentKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const showToast = useCallback((message: string, tone?: "ok" | "error" | "info") => {
    setToast({ message, tone });
  }, []);

  const sendInput = useCallback(async (
    assignmentId: string,
    text: string,
    images?: Array<{ media_type: string; data: string }>
  ) => {
    const body: { text?: string; images?: typeof images } = {};
    if (text) body.text = text;
    if (images && images.length > 0) body.images = images;
    try {
      await postJson<typeof body, unknown>(
        `/api/assignments/${encodeURIComponent(assignmentId)}/input`,
        body
      );
    } catch (e) {
      // Re-throw so the DrillInput's inline banner can render the
      // status-coded copy. Caller catches `ApiFailure` and pulls
      // status + message off `.info`.
      if (e instanceof ApiFailure) throw e;
      throw new ApiFailure({ status: 0, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const commands: Command[] = [
    {
      id: "toggle-theme",
      group: "view",
      label: `Toggle ${theme === "dark" ? "light" : "dark"} theme`,
      keys: ["⇧", "T"],
      run: () => {
        toggleTheme();
        showToast(`Switched to ${theme === "dark" ? "light" : "dark"} theme`, "ok");
      },
    },
    {
      id: "show-help",
      group: "help",
      label: "Show keyboard shortcuts",
      keys: ["?"],
      run: () => {
        showToast("⌘K palette · ⇧T theme · 1–9 focus card · ↵ open · Esc close · ] / [ cycle · f focus mode", "ok");
      },
    },
  ];

  return (
    <div className="scaffold-shell">
      <header className="scaffold-header">
        <h1>Cortex · Mission Control</h1>
        <div className="right">
          {/*
            G-1113 — Mission Control Cockpit redesign signpost. Links to the
            umbrella issue tracking the cockpit rework. Hardcoded URL per
            plan §5.1 (Phase A grounding) — no ingestion.
          */}
          <a
            className="cockpit-badge mono"
            href="https://github.com/the-metafactory/cortex/issues/354"
            target="_blank"
            rel="noopener noreferrer"
            title="G-1113 · Mission Control Cockpit redesign — umbrella issue"
          >
            G-1113 · Cockpit redesign
          </a>
          <span className="dim mono" style={{ fontSize: 11 }}>
            <Keycap>⌘</Keycap> <Keycap>K</Keycap> palette
          </span>
          <button
            type="button"
            className={`theme-btn${softwareMode ? " active" : ""}`}
            onClick={toggleSoftwareMode}
            aria-pressed={softwareMode}
            title="Toggle software mode (Repositories panel + Git objects)"
          >
            {softwareMode ? "◆ software" : "◇ software"}
          </button>
          <button
            type="button"
            className={`theme-btn${legacyIterations ? " active" : ""}`}
            onClick={toggleLegacyIterations}
            aria-pressed={legacyIterations}
            title="Show the legacy iteration kanban (kept until the Plans surface reaches parity)"
          >
            {legacyIterations ? "◆ legacy" : "◇ legacy"}
          </button>
          <button
            type="button"
            className="theme-btn"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☾ dark" : "☼ light"}
          </button>
        </div>
      </header>

      {/*
        F-14 — top-nav view switcher. Sits between the header and the
        main content. No router lib; the active view is local state.
        F-15 may upgrade to a hash route when detail navigation lands.
      */}
      <nav className="scaffold-tabs" role="tablist" aria-label="Dashboard view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "default"}
          className={`tab${view === "default" ? " active" : ""}`}
          onClick={() => setView("default")}
        >
          Focus / Working / Tasks
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "metrics"}
          className={`tab${view === "metrics" ? " active" : ""}`}
          onClick={() => setView("metrics")}
        >
          Metrics
        </button>
        {legacyIterations && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "iterations"}
            className={`tab${view === "iterations" ? " active" : ""}`}
            onClick={() => setView("iterations")}
          >
            Iterations
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={view === "sources"}
          className={`tab${view === "sources" ? " active" : ""}`}
          onClick={() => setView("sources")}
        >
          Sources
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "network"}
          className={`tab${view === "network" ? " active" : ""}`}
          onClick={() => setView("network")}
        >
          Network
        </button>
        {/* CK-3 / D-1(c) — Governance folds into the stack cockpit (Network view).
            The whole-dashboard tab survives behind `?legacy=1` for one release. */}
        {LEGACY_ESCAPE_HATCH && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "governance"}
            className={`tab${view === "governance" ? " active" : ""}`}
            onClick={() => setView("governance")}
          >
            Governance <span className="dim mono" style={{ fontSize: 9 }}>legacy</span>
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={view === "observability"}
          className={`tab${view === "observability" ? " active" : ""}`}
          onClick={() => setView("observability")}
        >
          Observability
        </button>
        {softwareMode && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "repositories"}
            className={`tab${view === "repositories" ? " active" : ""}`}
            onClick={() => setView("repositories")}
          >
            Repositories
          </button>
        )}
        {softwareMode && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "plans"}
            className={`tab${view === "plans" ? " active" : ""}`}
            onClick={() => setView("plans")}
          >
            Plans
          </button>
        )}
        {/* CK-3 / D-1(c) — Attention folds into the stack cockpit (Network view).
            The whole-dashboard tab survives behind `?legacy=1` for one release. */}
        {softwareMode && LEGACY_ESCAPE_HATCH && (
          <button
            type="button"
            role="tab"
            aria-selected={view === "attention"}
            className={`tab${view === "attention" ? " active" : ""}`}
            onClick={() => setView("attention")}
          >
            Attention <span className="dim mono" style={{ fontSize: 9 }}>legacy</span>
          </button>
        )}
      </nav>

      <main className="scaffold-main">
        {view === "default" && (
          <>
            <FocusArea
              items={focus.items}
              mostActiveAgent={focus.mostActiveAgent}
              loaded={focus.loaded}
              error={focus.error}
              selectedIdx={focusSelectedIdx}
              onSelect={setFocusSelectedIdx}
              onOpen={(item) => setDrillId(item.id)}
            />

            {/*
              F-9 working-agent grid (MIG-5) — sibling section between focus
              area and task table per F-9 Decision 9. Tile click opens the
              drill-down on the agent's current primary assignment; arrow
              keys + Enter navigate when a tile has focus.
            */}
            <WorkingGrid
              agents={working.agents}
              loaded={working.loaded}
              error={working.error}
              focusItemCount={focus.items.length}
              drillOpen={drillId !== null}
              onOpen={(id) => setDrillId(id)}
            />

            {/*
              F-8 task table (MIG-4) — sits below the working grid. Row click
              opens the drill-down on the task's primary active assignment;
              for empty-assignment tasks F-12b's shadow assignment id is
              used instead.
            */}
            <TaskTable
              all={tasks.all}
              visible={tasks.visible}
              loaded={tasks.loaded}
              error={tasks.error}
              gitLinks={gitLinks}
              filters={tasks.filters}
              sort={tasks.sort}
              onTogglePriority={tasks.togglePriority}
              onAgeChange={tasks.setAgeMinMinutes}
              onSearchChange={tasks.setSearch}
              onIncludeClosedChange={tasks.setIncludeClosed}
              onToggleSort={tasks.toggleSort}
              onClear={tasks.clearAll}
              onOpenTask={(t) => {
                const id = resolveOpenTarget(t);
                if (id) setDrillId(id);
                else showToast("This task has no assignment yet.", "error");
              }}
              onRefetch={tasks.refetch}
              drillOpen={drillId !== null}
              // F-16 — clicking the iteration cell routes to the
              // detail surface (same target as the F-7 chip in the
              // drill-header). No drill-down close because the table
              // click is happening with no overlay open.
              onOpenIteration={(iterationId) => {
                // G-1113.D.6 — the iteration cell routes into the legacy kanban;
                // when legacy is toggled off that surface is hidden, so no-op
                // rather than bounce through the reset effect.
                if (!legacyIterations) return;
                setSelectedIterationId(iterationId);
                setView("kanban-detail");
              }}
              // F-19 — dispatch from task row. Per spec Decision 3 the
              // request body is `{ taskId }` only; per Decision 4 the UI
              // is optimistic with rollback on 4xx/5xx and treats the
              // 409 debounce-hit as success.
              dispatchingTaskIds={dispatchingTaskIds}
              dispatchAgentLabel={DEFAULT_AGENT_DISPLAY_NAME}
              onDispatch={async (task) => {
                setDispatchingTaskIds((prev) => {
                  const next = new Set(prev);
                  next.add(task.id);
                  return next;
                });
                try {
                  await postJson<{ taskId: string }, unknown>(
                    "/api/sessions",
                    { taskId: task.id }
                  );
                  showToast(`Dispatched: ${task.title}`, "ok");
                  tasks.refetch();
                } catch (e) {
                  if (
                    e instanceof ApiFailure &&
                    e.info.status === 409
                  ) {
                    // F-19 Decision 4 — debounce hit (another tab raced
                    // us). Treat as success: refetch, no error toast.
                    tasks.refetch();
                  } else {
                    const msg =
                      e instanceof ApiFailure
                        ? e.info.message
                        : e instanceof Error
                          ? e.message
                          : String(e);
                    showToast(`Failed to dispatch: ${msg}`, "error");
                  }
                } finally {
                  setDispatchingTaskIds((prev) => {
                    const next = new Set(prev);
                    next.delete(task.id);
                    return next;
                  });
                }
              }}
            />

            <section className="scaffold-section">
              <h2>Coming next</h2>
              <div className="scaffold-card">
                <p style={{ marginTop: 0 }}>
                  All four feature surfaces are on <code>/v2</code> — focus row, working
                  grid, task table, drill-down. Cutover to <code>/</code> at MIG-6.
                </p>
                <p>
                  <KeySeq keys={["⌘", "K"]} /> opens the command palette.
                  <KeySeq keys={["⇧", "T"]} /> toggles theme.
                  <KeySeq keys={["1"]} />…<Keycap>9</Keycap> select a focus card;
                  <KeySeq keys={["←", "→"]} /> step; <Keycap>↵</Keycap> opens the
                  drill-down. <Keycap>/</Keycap> jumps to title search;
                  {" "}<Keycap>f</Keycap> jumps to age filter;
                  {" "}<Keycap>↑</Keycap>/<Keycap>↓</Keycap> walks task rows.
                </p>
              </div>
            </section>
          </>
        )}

        {view === "metrics" && (
          /*
            F-18 — fleet metrics surface. Three sections: cycle-time
            big-numbers, wait-time stacked bar, per-agent table. The hook
            owns its own window state (default 24h). WS-driven refetch on
            state.transition keeps the panel current as work happens.
          */
          <MetricsPanel state={metrics} />
        )}

        {view === "sources" && (
          /* G-1113.B.4 — provider-neutral Sources config view. */
          <SourcesView />
        )}

        {view === "governance" && LEGACY_ESCAPE_HATCH && (
          /* G-1115 — read-only governance audit surface: verdicts from the
             governed-action stack (pulse P-702) read back off the bus. CK-3/D-1:
             folded into the stack cockpit; this whole-dashboard tab is `?legacy=1`. */
          <GovernanceView state={governance} />
        )}

        {view === "observability" && (
          /* P-14 U2.1 (#934) — signal's four system.* observability families:
             signal health / federation / transport. Federation + transport are
             hub-emitted; a non-hub stack shows an honest explanatory empty
             state (roster arrives via U3.3), never synthesized data. */
          <ObservabilityView state={observability} metrics={obsMetrics} />
        )}

        {view === "network" && (
          /* G-1114.D.1-3 — Network graph view (React Flow + ELK): the stack as a
             hub, agents fanned around it (radial layout), fed by the runtime
             presence registry via /api/agents + the agent.presence WS frame.
             Replaced the G-1114.B.4 simple agents panel. Presence + lifecycle
             only (ADR-0007) — never session interiors. */
          <NetworkView
            state={agents}
            workingAgents={working.agents}
            // CK-5 (#1292) — the app-scope WS drives the constellation's live
            // traffic (dash-flow + atmosphere + bus-traffic strip) as a wildcard
            // subscriber (decision D-10 — one socket, no second feed, no poll).
            ws={ws}
            // U2.3 — signal's projected transport roster (verdict-bearing) feeds
            // the Network view's transport overlay. Empty until the obs fetch
            // lands / on a non-hub stack; the overlay paints nothing then.
            transportRoster={observability.data?.transportRoster ?? []}
            // MC-A1 — joined networks as first-class trust groups (admitted
            // roster ⋈ presence → membership verdict). Empty until the fetch
            // lands / on a non-federated stack; the panel renders nothing then.
            networks={networks.networks}
            // CK-3 — the app-scope snapshots the stack cockpit folds + scopes to
            // the dived stack (ATTENTION / WORKING / GOVERN). One subscription each.
            attention={attention}
            governance={governance}
            workingLoaded={working.loaded}
            workingError={working.error}
            // CK-4b — cross-stack WORKING rollup (metadata-only, ADR-0005) for
            // the cockpit's "Across stacks" lane above the LOCAL working grid.
            workingAggregation={workingAgg.aggregation}
            workingAggregationLoaded={workingAgg.loaded}
            workingAggregationError={workingAgg.error}
            // CK-3 — cockpit attention work-item deep link → work-item-detail
            // (returns to the Network view). Needs software mode (the surface is
            // software-mode-gated); honest toast otherwise.
            onOpenWorkItem={(workItemId) => {
              if (!softwareMode) {
                showToast("Enable software mode to open work items", "info");
                return;
              }
              setSelectedWorkItemId(workItemId);
              setWorkItemBackView("network");
              setView("work-item-detail");
            }}
            // CK-6b — resolve/dismiss an attention item via the CK-6a route
            // (`POST /api/attention/:id/{resolve,dismiss}` over `db/attention
            // setStatus`), gated by FND-6 identity. App owns the call + identity
            // context (mirrors `onDispatchDirect`). Optimistic: drop the row now,
            // then reconcile — `refetch` restores it if the POST failed (the item
            // is still `open` server-side). Approve/Deny is NOT wired (SPX-7/SPX-8).
            onAttentionLifecycle={async (attentionId, action) => {
              attention.dropOptimistic(attentionId);
              try {
                await postJson<Record<string, never>, unknown>(
                  `/api/attention/${encodeURIComponent(attentionId)}/${action}`,
                  {},
                );
                showToast(
                  action === "resolve" ? "Attention resolved" : "Attention dismissed",
                  "ok",
                );
              } catch (e) {
                const msg =
                  e instanceof ApiFailure
                    ? e.info.message
                    : e instanceof Error
                      ? e.message
                      : String(e);
                showToast(`Could not ${action} attention: ${msg}`, "error");
              } finally {
                // Reconcile with server truth (restores the row on failure).
                attention.refetch();
              }
            }}
            onViewInWorkingGrid={() => setView("default")}
            // CK-1 (cortex#1289) — diving the altitude rail to SESSION (an
            // own-local assistant's session) opens the REUSED F-7 drill-down —
            // the same App-level overlay attention/work-item flows drive via
            // `setDrillId`. Own-local only (the Network view's `openSession`
            // refuses a federated peer, ADR-0005), so no interior crosses the
            // sovereignty boundary.
            onOpenSession={(sessionId) => setDrillId(sessionId)}
            // G-1114.F.3 — dispatch-direct to a LOCAL agent, REUSING the
            // existing dispatch path (`POST /api/sessions` with `agentId`). The
            // panel only invokes this for a local agent (foreign peers get a
            // disabled future-state). No taskId → the handler mints a fresh
            // internal task assigned to that agent, exactly as the task-row
            // Dispatch does without a taskId. The DispatchButton's confirm
            // popover gates the call, so no confirmation is bypassed.
            dispatchingAgentKeys={dispatchingAgentKeys}
            onDispatchDirect={async (agent: AgentPresenceTile) => {
              setDispatchingAgentKeys((prev) => {
                const next = new Set(prev);
                next.add(agent.key);
                return next;
              });
              const label = agent.assistant_name ?? agent.agent_id;
              try {
                await postJson<
                  { agentId: string; agentName: string; title: string },
                  unknown
                >("/api/sessions", {
                  agentId: agent.agent_id,
                  agentName: label,
                  title: `Direct dispatch to ${label}`,
                });
                showToast(`Dispatched to ${label}`, "ok");
                // The working-agents grid + the agent-presence panel both
                // refresh live off the WS `state.transition` / `agent.presence`
                // frames the new assignment emits — no explicit refetch needed.
              } catch (e) {
                const msg =
                  e instanceof ApiFailure
                    ? e.info.message
                    : e instanceof Error
                      ? e.message
                      : String(e);
                showToast(`Failed to dispatch: ${msg}`, "error");
              } finally {
                setDispatchingAgentKeys((prev) => {
                  const next = new Set(prev);
                  next.delete(agent.key);
                  return next;
                });
              }
            }}
          />
        )}

        {view === "repositories" && softwareMode && (
          /* G-1113.C.7 — per-repository software-mode panel. */
          <RepositoriesView repositories={repos.repositories} loaded={repos.loaded} />
        )}

        {view === "plans" && softwareMode && (
          /* G-1113.D.3 — plan overview surface. D.4 — clicking a phase opens
             the phase-detail surface. */
          <PlansView
            plans={plans.plans}
            loaded={plans.loaded}
            onOpenPhase={(phaseId) => {
              setSelectedPhaseId(phaseId);
              setView("phase-detail");
            }}
          />
        )}

        {view === "iterations" && (
          /*
            F-14 — iteration kanban surface. F-15 wires the mutation
            callbacks to real endpoints:
              - card click → open detail (`kanban-detail` view).
              - inbox drop on `designing` → POST /api/iterations from
                the inbox item's title + source_*, then navigate to
                detail of the new iteration.
              - iteration drop on a different column → PATCH
                /api/iterations/:id { state } per the canTransition
                matrix.
          */
          <IterationBoard
            iterations={iterations.iterations}
            inboxItems={iterations.inboxItems}
            loaded={iterations.loaded}
            error={iterations.error}
            onOpen={(kind, id) => {
              if (kind === "iteration") {
                setSelectedIterationId(id);
                setView("kanban-detail");
              } else {
                // Inbox card click: there's no detail surface for an
                // inbox row in v1 — the principal's path is to drag it
                // into Designing, then click into the resulting
                // iteration. Mirror that with a toast hint.
                showToast(
                  "Drag the inbox card to Designing to start an iteration",
                  "info"
                );
              }
            }}
            onCreateIterationFromInbox={async (inboxItemId) => {
              // F-15 — POST /api/iterations seeded from the dragged
              // inbox item's title / source_*. The new iteration starts
              // in `designing` (Decision 5 — inbox → designing creates
              // an iteration around the issue). Server validates the
              // state value; the matrix accepts `designing` here
              // because we're CREATE-ing not transitioning.
              const inboxItem = iterations.inboxItems.find(
                (i) => i.id === inboxItemId
              );
              if (!inboxItem) {
                showToast("Inbox item disappeared mid-drag", "error");
                return;
              }
              try {
                const created = await postJson<
                  Record<string, unknown>,
                  CreateIterationResponse
                >("/api/iterations", {
                  title: inboxItem.title,
                  state: "designing",
                  source_system: inboxItem.source_system,
                  source_url: inboxItem.source_url,
                  source_parent_ref: inboxItem.source_external_id ?? null,
                });
                // Attach the dragged inbox task to the new iteration.
                await postJson<{ task_id: string }, unknown>(
                  `/api/iterations/${encodeURIComponent(created.iteration.id)}/tasks`,
                  { task_id: inboxItem.id }
                );
                // Navigate to the new iteration's detail so the
                // principal can immediately write the design notes.
                setSelectedIterationId(created.iteration.id);
                setView("kanban-detail");
                iterations.refetch();
              } catch (e) {
                const msg =
                  e instanceof ApiFailure ? e.info.message : (e as Error).message;
                showToast(`Failed to create iteration: ${msg}`, "error");
              }
            }}
            onMoveIteration={async (iterationId, targetState) => {
              // F-15 — PATCH /api/iterations/:id { state }. The board
              // already gated on `canDrop`, but we send the request
              // regardless and surface the server's response (the
              // server is the source of truth for the matrix).
              try {
                await fetch(
                  `/api/iterations/${encodeURIComponent(iterationId)}`,
                  {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ state: targetState }),
                  }
                ).then(async (res) => {
                  if (!res.ok) {
                    const j = (await res
                      .json()
                      .catch(() => ({}))) as { error?: string };
                    throw new ApiFailure({
                      status: res.status,
                      message: j.error ?? `HTTP ${res.status}`,
                    });
                  }
                });
                // The WS frame will land the row in the new column;
                // the local refetch is belt-and-braces.
                iterations.refetch();
              } catch (e) {
                const msg =
                  e instanceof ApiFailure ? e.info.message : (e as Error).message;
                showToast(`Move failed: ${msg}`, "error");
              }
            }}
          />
        )}

        {view === "kanban-detail" && selectedIterationId && (
          <IterationDetail
            iterationId={selectedIterationId}
            ws={ws}
            onClose={() => {
              setView("iterations");
              setSelectedIterationId(null);
              // Refresh the kanban so the row reflects whatever the
              // principal just changed (the WS frames have already
              // applied optimistic updates, but a refetch is cheap and
              // resyncs any inbox drift).
              iterations.refetch();
            }}
          />
        )}

        {view === "phase-detail" && softwareMode && selectedPhaseId && (
          /* G-1113.D.4 — phase-detail surface (reached from a Plans phase row).
             Guard on selectedPhaseId too (mirrors kanban-detail) so the surface
             never renders a perpetual "Loading…" if view is ever set without one. */
          <PhaseDetailView
            detail={phaseDetail.detail}
            loaded={phaseDetail.loaded}
            onClose={() => {
              setView("plans");
              setSelectedPhaseId(null);
            }}
            onOpenWorkItem={(workItemId) => {
              setSelectedWorkItemId(workItemId);
              setWorkItemBackView("phase-detail");
              setView("work-item-detail");
            }}
          />
        )}

        {view === "work-item-detail" && softwareMode && selectedWorkItemId && (
          /* G-1113.D.5 — work-item detail. Back returns to whichever surface
             opened it (phase-detail or the Attention queue) — see workItemBackView. */
          <WorkItemDetailView
            detail={workItemDetail.detail}
            loaded={workItemDetail.loaded}
            onClose={() => {
              setView(workItemBackView);
              setSelectedWorkItemId(null);
            }}
          />
        )}

        {view === "attention" && softwareMode && LEGACY_ESCAPE_HATCH && (
          /* G-1113.E.3 — attention queue surface (deep-links to WI / session).
             CK-3/D-1: folded into the stack cockpit; this tab is `?legacy=1`. */
          <AttentionView
            entries={attention.entries}
            loaded={attention.loaded}
            onOpenWorkItem={(workItemId) => {
              setSelectedWorkItemId(workItemId);
              setWorkItemBackView("attention");
              setView("work-item-detail");
            }}
            onOpenAssignment={(assignmentId) => setDrillId(assignmentId)}
          />
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      <DrillDown
        assignmentId={drillId}
        focusItems={focus.items}
        assignment={drillAssignment}
        ws={ws}
        onClose={() => { setDrillId(null); setFocusMode(false); }}
        onCycle={(id) => setDrillId(id)}
        focusMode={focusMode}
        onToggleFocusMode={() => setFocusMode((v) => !v)}
        onSendInput={sendInput}
        // F-16 — chip click in the drill-header closes the drill-down
        // and routes to the iteration detail surface (the same
        // `kanban-detail` view F-15 ships from a kanban card click).
        // We close the drill-down first so the principal returns to a
        // clean iteration surface; the existing F-7 history pattern
        // is "Esc closes, no breadcrumb back" so this matches.
        onOpenIteration={(iterationId) => {
          // G-1113.D.6 — guard BEFORE the drill-down teardown: when legacy is
          // off the kanban surface is hidden, so don't tear down the open
          // drill-down for a navigation that the reset effect would bounce.
          if (!legacyIterations) return;
          setDrillId(null);
          setFocusMode(false);
          setSelectedIterationId(iterationId);
          setView("kanban-detail");
        }}
      />

      {toast && (
        <Toast
          message={toast.message}
          tone={toast.tone}
          onDismiss={() => setToast(null)}
        />
      )}

      {/*
        G-1113 Phase A — footer signpost. Links to the cockpit glossary so the
        vocabulary (Stack, Assistant, Cortex Agent, Work Item, …) is one click
        away from the surface. Hardcoded URL per plan §5.1; no ingestion.
      */}
      <footer className="scaffold-footer dim mono">
        <a
          href="https://github.com/the-metafactory/cortex/blob/main/docs/glossary-mission-control.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          Glossary
        </a>
      </footer>
    </div>
  );
}

function targetIsTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * MIG-4 — Build an `AssignmentListItem`-shaped record from a task's
 * roll-up so the drill-down's header / curation-toolbar can render
 * before MIG-5 ships the full assignments map.
 *
 * Block reason is null because the F-8 projection doesn't carry it (the
 * focus query does); the drill-down's WS subscription will overwrite
 * with the freshest server-side state on the next `state.transition`.
 */
function synthesiseFromTasks(
  assignmentId: string,
  allTasks: readonly TaskListItem[]
): AssignmentListItem | null {
  for (const t of allTasks) {
    const a = t.assignments.find((x) => x.id === assignmentId);
    if (!a) continue;
    return {
      id: a.id,
      state: a.state,
      block_reason: null,
      created_at: a.updated_at,  // best available — projection doesn't carry created_at
      updated_at: a.updated_at,
      agent_id: a.agent_id,
      task: {
        id: t.id,
        title: t.title,
        priority: t.priority,
      },
      // F-20.F — carry the projection's session denorm so the drill-
      // input mode resolver can distinguish observed sessions from
      // controlled-but-ended ones. Pre-F-20.F this was hardcoded
      // `null`, which the resolver mapped to `"ended"` and showed
      // "Session ended. History is read-only." for live observed
      // sessions.
      session: a.session,
      // F-16 — carry the task's iteration tag through the synthesis so
      // the F-7 drill-down header chip renders immediately for tasks
      // opened via the F-8 row click. Without this the chip would
      // briefly read "—" until the next `state.transition` WS frame
      // round-tripped the assignments list.
      iteration: t.iteration,
    };
  }
  return null;
}
