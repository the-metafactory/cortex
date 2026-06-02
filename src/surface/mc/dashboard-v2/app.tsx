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
import { MetricsPanel } from "./components/metrics-panel";
import { SourcesView } from "./components/sources-view";
import { RepositoriesView } from "./components/repositories-view";
import { PlansView } from "./components/plans-view";
import { PhaseDetailView } from "./components/phase-detail-view";
import { Toast } from "./components/toast";
import { useFocusArea } from "./hooks/use-focus-area";
import { useTasks } from "./hooks/use-tasks";
import { useGitLinks } from "./hooks/use-git-links";
import { useSoftwareMode } from "./hooks/use-software-mode";
import { useRepositories } from "./hooks/use-repositories";
import { usePlans } from "./hooks/use-plans";
import { usePhaseDetail } from "./hooks/use-phase-detail";
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
type DashboardView = "default" | "metrics" | "iterations" | "sources" | "repositories" | "plans" | "phase-detail" | "kanban-detail";

export function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  // G-1113.C.7 — software mode gates the Repositories panel.
  const { softwareMode, toggle: toggleSoftwareMode } = useSoftwareMode();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone?: "ok" | "error" | "info" } | null>(null);

  // Single WebSocket client owned at App level; shared via prop with
  // every feature hook. Future hooks (use-tasks, use-working-agents)
  // attach the same way.
  const ws = useWebSocket();
  const focus = useFocusArea(ws);
  const tasks = useTasks(ws);
  const working = useWorkingAgents(ws);
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
  // G-1113.C.7 — Repositories panel data (fetched only when on its tab).
  const repos = useRepositories(softwareMode && view === "repositories");
  // G-1113.D.3 — Plans overview data (fetched only when on its tab).
  const plans = usePlans(softwareMode && view === "plans");
  // G-1113.D.4 — phase-detail data (fetched whenever a phase is selected).
  const phaseDetail = usePhaseDetail(view === "phase-detail" ? selectedPhaseId : null);
  // If software mode is toggled OFF while on a software-mode view (Repositories
  // / Plans / phase-detail), the tab + render both gate off — reset to default
  // so the main area isn't left blank.
  useEffect(() => {
    if (!softwareMode && (view === "repositories" || view === "plans" || view === "phase-detail")) {
      setView("default");
    }
  }, [softwareMode, view]);

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
        <h1>Grove · Mission Control</h1>
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
        <button
          type="button"
          role="tab"
          aria-selected={view === "iterations"}
          className={`tab${view === "iterations" ? " active" : ""}`}
          onClick={() => setView("iterations")}
        >
          Iterations
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "sources"}
          className={`tab${view === "sources" ? " active" : ""}`}
          onClick={() => setView("sources")}
        >
          Sources
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
