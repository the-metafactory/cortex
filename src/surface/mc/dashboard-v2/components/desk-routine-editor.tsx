import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getJson } from "../lib/api";
import { RoutineDetailSchema, RoutineInventorySchema, type RoutineDetail, type RoutineInventory } from "../../desk/routine-editor-contract";
import type { RoutineView } from "../../desk/routine-command";
import { defaultRoutinesLocation, type RoutineTab, type WorkspaceTab, type RoutinesLocation } from "../hooks/use-routines-location";
import { RoutineDetailPage, newRoutineEditorSession, type RoutineEditorSession } from "./desk-routine-detail";
import { DeskRoutineCalendar } from "./desk-routine-calendar";
import { RoutineCreation } from "./desk-routine-create";
import { RoutineButton, PendingRoutineChanges } from "./desk-routines";
import { RoutineScheduleEditor, newScheduleSession, type ScheduleSession } from "./desk-routine-schedule";
import { RoutineLifecycleEditor, newLifecycleSession, type LifecycleSession } from "./desk-routine-lifecycle";
import { RoutineDelete, newDeleteSession, type DeleteSession } from "./desk-routine-delete";
import { RoutineActivity, RoutineEvidenceList } from "./desk-routine-evidence";
import { DeskRoutineAttention } from "./desk-routine-attention";
import { DisplayFailureAlert, RoutineDisplayChoice, useRoutineDisplay } from "./desk-routine-display";
import { calendarDays } from "../lib/routine-calendar";
import "./desk-routine-page.css";
export { routineStepTree } from "./desk-routine-detail";

const endpoint = "/api/desk/routine-editor";
const message = (error: unknown): string => error instanceof Error ? error.message : "The routine owner did not answer.";
export function DeskRoutineEditor({ onBack, location: current, onLocation, view, active: pageActive = true, onChanged = () => undefined }: { onBack: () => void; location?: RoutinesLocation; onLocation?: (location: RoutinesLocation) => void; view?: RoutineView; active?: boolean; onChanged?: () => void }) {
  const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [local, setLocal] = useState(defaultRoutinesLocation); const location = current ?? local;
  const go = onLocation ?? setLocal;
  const currentLocation = useRef(location); currentLocation.current = location;
  const [inventory, setInventory] = useState<RoutineInventory | null>(null);
  const currentInventory = useRef(inventory); currentInventory.current = inventory;
  const [details, setDetails] = useState<Record<string, RoutineDetail>>({});
  const [sessions, setSessions] = useState<Record<string, RoutineEditorSession>>({});
  const [deleteSessions, setDeleteSessions] = useState<Record<string, DeleteSession>>({});
  const [lifecycleSessions, setLifecycleSessions] = useState<Record<string, LifecycleSession>>({});
  const [scheduleSessions, setScheduleSessions] = useState<Record<string, ScheduleSession>>({});
  const [error, setError] = useState<string | null>(null); const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [revision, setRevision] = useState(0); const [newRoutine, setNewRoutine] = useState(false); const [search, setSearch] = useState("");
  const tabs = useRef(new Map<RoutineTab, HTMLButtonElement>());
  const workspaceTabs = useRef(new Map<WorkspaceTab, HTMLButtonElement>());
  const workspace = location.workspace ?? "overview";
  const library = useRef<HTMLUListElement>(null);
  const selected = location.routine;
  const display = useRoutineDisplay(revision);
  const days = useMemo(() => calendarDays(location.date, location.view), [location.date, location.view]);
  const displayFailure = Object.entries(display.changes).find(([, change]) => change.error);
  useEffect(() => {
    const abort = new AbortController(); setError(null);
    void getJson(endpoint, { signal: abort.signal }).then((value) => { if (!abort.signal.aborted) setInventory(RoutineInventorySchema.parse(value)); }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(message(failure)); });
    return () => { abort.abort(); };
  }, [revision]);
  useEffect(() => {
    setDetailError(null);
    if (!selected) { setLoading(false); return; }
    const abort = new AbortController(); setLoading(true);
    void getJson(`${endpoint}?id=${encodeURIComponent(selected)}`, { signal: abort.signal }).then((value) => {
      const detail = RoutineDetailSchema.parse(value);
      if (detail.id !== selected) throw new Error("The routine owner returned a different routine. Refresh before editing.");
      if (!abort.signal.aborted) setDetails((previous) => ({ ...previous, [detail.id]: detail }));
    }).catch((failure: unknown) => { if (!abort.signal.aborted) setDetailError(message(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); };
  }, [selected, revision]);
  useEffect(() => {
    if (location.tab !== "workspace") return;
    const list = library.current; const button = list?.querySelector("[aria-current=page]");
    if (!list || !button) return;
    const bounds = list.getBoundingClientRect(); const item = button.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [selected, location.tab, inventory]);
  const refresh = (): void => { setRevision((n) => n + 1); onChanged(); };
  const deleted = (id: string, notice: string): void => {
    setDeletionNotice(notice); setInventory((previous) => previous?.filter((item) => item.id !== id) ?? null); setSearch("");
    const remaining = currentInventory.current?.find((item) => item.id !== id);
    if (currentLocation.current.routine === id) go({ ...currentLocation.current, routine: remaining?.id ?? null, workspace: "overview" });
    refresh();
  };
  const choose = (id: string): void => { go({ ...location, tab: "workspace", workspace: "overview", routine: id }); };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: RoutineTab): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
    const next = event.key === "Home" ? "schedule" : event.key === "End" ? "workspace" : tab === "schedule" ? "workspace" : "schedule";
    go({ ...location, tab: next }); tabs.current.get(next)?.focus();
  };
  const workspaceKey = (event: KeyboardEvent<HTMLButtonElement>, tab: WorkspaceTab): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const order: WorkspaceTab[] = ["overview", "schedule", "flow", "executions"];
    const next = order[event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : (order.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length];
    if (next) { go({ ...location, workspace: next }); workspaceTabs.current.get(next)?.focus(); }
  };
  const routine = inventory?.find((r) => r.id === selected); const detail = selected && routine ? details[selected] : undefined;
  const entries = inventory?.filter((r) => `${r.name ?? ""} ${r.id}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const active = inventory?.filter((r) => r.runtimeConfirmed && r.policy !== "disabled" && !r.paused).length ?? 0;
  const paused = inventory?.filter((r) => r.runtimeConfirmed && r.policy !== "disabled" && r.paused).length ?? 0;
  const unconfirmed = inventory?.filter((r) => !r.runtimeConfirmed).length ?? 0;
  return <div className="desk desk-settings desk-routine-page"><header className="desk-top"><div className="desk-top-in"><span className="desk-brand">Routines</span><button className="desk-btn" type="button" onClick={onBack}>Back to the Desk</button></div></header><main className="desk-set-main">
    <div className="routine-page-heading"><div><h1>Routines</h1><p className="soft">Your schedule at a glance. A workspace for every routine.</p></div><div className="desk-acts">{inventory && <span className="soft">{active} active · {paused} paused · {inventory.length - active - paused - unconfirmed} disabled{unconfirmed > 0 ? ` · ${unconfirmed} unconfirmed` : ""}</span>}<button className="desk-btn" type="button" onClick={() => { setActivityOpen(true); }}>Activity</button><button className="desk-btn" type="button" onClick={refresh}>Refresh routines</button>{(view?.pending.length ?? 0) > 0 && <button className="desk-btn" type="button" aria-expanded={approvalsOpen} aria-controls="routine-approvals" onClick={() => { setApprovalsOpen((open) => !open); }}>{view?.pending.length} awaiting approval</button>}<button className="desk-btn pri" type="button" onClick={() => { setNewRoutine(true); }}>+ New routine</button></div></div>
    {activityOpen && pageActive && <RoutineActivity revision={revision} onClose={() => { setActivityOpen(false); }} />}
    <RoutineCreation open={newRoutine} onClose={() => { setNewRoutine(false); }} onCreated={refresh} />
    {(view?.pending.length ?? 0) > 0 && <section hidden={!approvalsOpen} id="routine-approvals" className="routine-approvals desk-set-card" aria-label="Pending routine approvals"><h2>Waiting for approval</h2>{view?.pending.map((p) => <div key={p.decisionId}><p>{inventory?.find((r) => r.id === p.blueprintId)?.name ?? p.blueprintId} wants to run.</p><div className="desk-acts"><RoutineButton action="approve" target={p.decisionId} onChanged={refresh}>Approve</RoutineButton><RoutineButton action="deny" target={p.decisionId} onChanged={refresh}>Deny</RoutineButton></div></div>)}</section>}
    <PendingRoutineChanges changes={view?.changes ?? []} onChanged={refresh} onCompleted={(request) => { if (request.action === "delete") deleted(request.target, "Routine deleted and verified. Execution evidence remains in Activity."); }} />
    <div className="routine-page-tabs" role="tablist" aria-label="Routines page">{(["schedule", "workspace"] as const).map((tab) => <button key={tab} type="button" role="tab" id={`routines-tab-${tab}`} aria-controls={`routines-panel-${tab}`} aria-selected={location.tab === tab} tabIndex={location.tab === tab ? 0 : -1} ref={(node) => { if (node) tabs.current.set(tab, node); else tabs.current.delete(tab); }} onKeyDown={(event) => { tabKey(event, tab); }} onClick={() => { go({ ...location, tab }); }}>{tab === "schedule" ? "Schedule" : "Routine workspace"}</button>)}</div>
    {deletionNotice && <p role="status">{deletionNotice}</p>}
    {error && <p role="alert">{error} The installed routine library is unavailable.</p>}
    <div role="tabpanel" id="routines-panel-schedule" aria-labelledby="routines-tab-schedule" hidden={location.tab !== "schedule"}><DeskRoutineAttention days={days} timezone={location.timezone} revision={revision} view={view} inventory={inventory} inventoryError={Boolean(error)} active={pageActive && location.tab === "schedule"} onOpen={(id, tab) => { go({ ...location, tab: "workspace", workspace: tab, routine: id }); }} onChanged={refresh} />{display.error && <p role="status">Display preferences are unavailable: {display.error} Every scheduled start is shown.</p>}{displayFailure && <DisplayFailureAlert routineId={displayFailure[0]} name={inventory?.find((r) => r.id === displayFailure[0])?.name ?? displayFailure[0]} change={displayFailure[1]} onRetry={display.change} onKeep={display.dismiss} />}<DeskRoutineCalendar location={location} onLocation={go} inventory={inventory} revision={revision} onSelect={choose} background={display.preferences?.background} onDisplay={display.preferences ? display.change : undefined} /></div>
    <div role="tabpanel" id="routines-panel-workspace" aria-labelledby="routines-tab-workspace" hidden={location.tab !== "workspace"}>
      {!inventory && !error && <p role="status">Reading installed routines…</p>}{inventory?.length === 0 && <p>No installed routines were returned by the configured owner.</p>}
      <div className="desk-routine-layout"><nav aria-label="Installed routines"><h2>Your routines <small>{inventory?.length ?? "…"}</small></h2><label className="routine-library-search">Find a routine<input value={search} onChange={(event) => { setSearch(event.target.value); }} type="search" /></label><ul className="routine-library-list" ref={library}>{entries.map((r) => <li key={r.id}><button type="button" className="routine-library-button" aria-current={selected === r.id ? "page" : undefined} onClick={() => { choose(r.id); }}>{r.name ?? r.id}</button><small>{r.schedule} · {r.timezone ?? "Owner local timezone"}<br />{!r.runtimeConfirmed ? "Scheduling state unconfirmed · " : r.paused && r.policy !== "disabled" ? "Paused · " : ""}{r.policy === "auto" ? "Automatic" : r.policy === "disabled" ? "Disabled · handling policy unknown" : "Approval required"}{r.readOnly ? r.capabilities.editSchedule || r.capabilities.pause ? " · Flow read-only" : " · Read-only" : ""}</small></li>)}</ul>{inventory && inventory.length > 0 && entries.length === 0 && <p>No routines match this search.</p>}</nav><div className="routine-workspace-detail">
        {routine && <><div className="routine-workspace-heading"><div><p className="routine-policy">{!routine.runtimeConfirmed ? "Scheduling state unconfirmed" : routine.readOnly && !routine.capabilities.editSchedule && !routine.capabilities.pause ? "Read-only definition" : routine.policy === "disabled" ? "Disabled" : routine.paused ? "Paused" : "Active"}</p><h2>{routine.name ?? routine.id}</h2><p className="soft">{routine.schedule} · {routine.timezone ?? "Owner local timezone"}</p></div><div className="desk-acts"><RoutineDelete key={`delete:${routine.id}`} id={routine.id} active={pageActive && location.tab === "workspace"} state={deleteSessions[routine.id] ?? newDeleteSession()} onState={(change) => { setDeleteSessions((previous) => ({ ...previous, [routine.id]: change(previous[routine.id] ?? newDeleteSession()) })); }} onChanged={refresh} onDeleted={deleted} /><RoutineLifecycleEditor id={routine.id} paused={routine.paused} enabled={routine.capabilities.pause && routine.runtimeConfirmed} active={pageActive && location.tab === "workspace"} state={lifecycleSessions[routine.id] ?? newLifecycleSession()} onState={(state) => { setLifecycleSessions((previous) => ({ ...previous, [routine.id]: state })); }} onChanged={refresh} /><RoutineScheduleEditor key={routine.id} paused={routine.paused} id={routine.id} enabled={routine.capabilities.editSchedule} active={pageActive && location.tab === "workspace"} state={scheduleSessions[routine.id] ?? newScheduleSession()} onState={(state) => { setScheduleSessions((previous) => ({ ...previous, [routine.id]: state })); }} onChanged={refresh} /></div></div><section className="routine-handling" aria-label="Handling policy"><div><strong>Handling policy</strong><p>{routine.policy === "auto" ? "Handled automatically" : routine.policy === "approval" ? "Asks you before each fire" : "Disabled; previous handling policy is not recorded"}</p></div>{!routine.readOnly && routine.policy !== "disabled" && <RoutineButton key={`${routine.id}:${routine.policy}`} action={routine.policy === "auto" ? "stop" : "auto"} target={routine.id} onChanged={refresh}>{routine.policy === "auto" ? "Stop automatic handling" : "Handle this yourself"}</RoutineButton>}</section></>}
        {selected && <div className="routine-page-tabs routine-workspace-tabs" role="tablist" aria-label="Selected routine workspace">{(["overview", "schedule", "flow", "executions"] as const).map((tab) => <button key={tab} type="button" role="tab" id={`routine-workspace-tab-${tab}`} aria-controls={`routine-workspace-panel-${tab}`} aria-selected={workspace === tab} tabIndex={workspace === tab ? 0 : -1} ref={(node) => { if (node) workspaceTabs.current.set(tab, node); else workspaceTabs.current.delete(tab); }} onKeyDown={(event) => { workspaceKey(event, tab); }} onClick={() => { go({ ...location, workspace: tab }); }}>{tab.slice(0, 1).toUpperCase() + tab.slice(1)}</button>)}</div>}
        <div role="tabpanel" id="routine-workspace-panel-overview" aria-labelledby="routine-workspace-tab-overview" hidden={!selected || workspace !== "overview"}>
          {detail?.flow && <><h3>Flow</h3><ol>{detail.flow.steps.map((step) => <li key={JSON.stringify(step.path)}>{step.action} · {step.purpose}</li>)}</ol><button className="desk-btn" type="button" onClick={() => { go({ ...location, workspace: "flow" }); }}>Inspect flow</button></>}
          {selected && <RoutineEvidenceList key={`recent:${selected}`} routineId={selected} active={pageActive && location.tab === "workspace" && workspace === "overview"} revision={revision} compact onAll={() => { go({ ...location, workspace: "executions" }); }} />}
        </div>
        <div role="tabpanel" id="routine-workspace-panel-schedule" aria-labelledby="routine-workspace-tab-schedule" hidden={!selected || workspace !== "schedule"}>{routine ? <><h3>Installed schedule</h3><p>{routine.schedule} · {routine.timezone ?? "Owner local timezone"}</p><p>{!routine.runtimeConfirmed ? "Scheduling state unconfirmed" : routine.paused ? "Paused" : routine.policy === "disabled" ? "Disabled" : "Active"}. Use Edit schedule above to preview changes before saving.</p><RoutineDisplayChoice routineId={routine.id} saved={display.preferences?.background.has(routine.id) ? "background" : "scheduled"} available={Boolean(display.preferences)} pending={display.changes[routine.id]} onChange={display.change} onDismiss={display.dismiss} /></> : <p>The definition is unavailable. Historical evidence remains in Executions.</p>}</div>
        <div role="tabpanel" id="routine-workspace-panel-flow" aria-labelledby="routine-workspace-tab-flow" hidden={!selected || workspace !== "flow"}>
        {loading && <p role="status">Reading the installed flow…</p>}{detailError && <p role="alert">{detailError} Saved drafts remain available when this routine can be read again.</p>}
        {detail && selected && <RoutineDetailPage key={selected} detail={detail} session={sessions[selected] ?? newRoutineEditorSession()} onSession={(change) => { setSessions((previous) => ({ ...previous, [selected]: change(previous[selected] ?? newRoutineEditorSession()) })); }} onUpdated={(result) => { setDetails((previous) => ({ ...previous, [result.id]: result })); refresh(); }} />}
        </div>
        <div role="tabpanel" id="routine-workspace-panel-executions" aria-labelledby="routine-workspace-tab-executions" hidden={!selected || workspace !== "executions"}>{selected && <RoutineEvidenceList key={`history:${selected}`} routineId={selected} active={pageActive && location.tab === "workspace" && workspace === "executions"} revision={revision} />}</div>
        {selected && inventory && !routine && <p role="status">The selected routine is no longer in the installed library. Its drafts are retained for this visit.</p>}
        {!selected && <p>Select a routine to inspect its installed flow.</p>}
      </div></div>
    </div>
  </main></div>;
}
