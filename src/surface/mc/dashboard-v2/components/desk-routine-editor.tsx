import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getJson } from "../lib/api";
import { RoutineDetailSchema, RoutineInventorySchema, type RoutineDetail, type RoutineInventory } from "../../desk/routine-editor-contract";
import type { RoutineView } from "../../desk/routine-command";
import { defaultRoutinesLocation, type RoutineTab, type RoutinesLocation } from "../hooks/use-routines-location";
import { RoutineDetailPage, newRoutineEditorSession, type RoutineEditorSession } from "./desk-routine-detail";
import { DeskRoutineCalendar } from "./desk-routine-calendar";
import { RoutineCreation } from "./desk-routine-create";
import { RoutineButton } from "./desk-routines";
import "./desk-routine-page.css";
export { routineStepTree } from "./desk-routine-detail";

const endpoint = "/api/desk/routine-editor";
const message = (error: unknown): string => error instanceof Error ? error.message : "The routine owner did not answer.";
export function DeskRoutineEditor({ onBack, location: current, onLocation, view, onChanged = () => undefined }: { onBack: () => void; location?: RoutinesLocation; onLocation?: (location: RoutinesLocation) => void; view?: RoutineView; onChanged?: () => void }) {
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [local, setLocal] = useState(defaultRoutinesLocation); const location = current ?? local;
  const go = onLocation ?? setLocal;
  const [inventory, setInventory] = useState<RoutineInventory | null>(null);
  const [details, setDetails] = useState<Record<string, RoutineDetail>>({});
  const [sessions, setSessions] = useState<Record<string, RoutineEditorSession>>({});
  const [error, setError] = useState<string | null>(null); const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [revision, setRevision] = useState(0); const [newRoutine, setNewRoutine] = useState(false); const [search, setSearch] = useState("");
  const tabs = useRef(new Map<RoutineTab, HTMLButtonElement>());
  const library = useRef<HTMLUListElement>(null);
  const selected = location.routine;
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
  const choose = (id: string): void => { go({ ...location, tab: "workspace", routine: id }); };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: RoutineTab): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
    const next = event.key === "Home" ? "schedule" : event.key === "End" ? "workspace" : tab === "schedule" ? "workspace" : "schedule";
    go({ ...location, tab: next }); tabs.current.get(next)?.focus();
  };
  const routine = inventory?.find((r) => r.id === selected); const detail = selected && routine ? details[selected] : undefined;
  const entries = inventory?.filter((r) => `${r.name ?? ""} ${r.id}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const active = inventory?.filter((r) => r.policy !== "disabled").length ?? 0;
  return <div className="desk desk-settings desk-routine-page"><header className="desk-top"><div className="desk-top-in"><span className="desk-brand">Routines</span><button className="desk-btn" type="button" onClick={onBack}>Back to the Desk</button></div></header><main className="desk-set-main">
    <div className="routine-page-heading"><div><h1>Routines</h1><p className="soft">Your schedule at a glance. A workspace for every routine.</p></div><div className="desk-acts">{inventory && <span className="soft">{active} active · {inventory.length - active} disabled</span>}<button className="desk-btn" type="button" onClick={refresh}>Refresh routines</button>{(view?.pending.length ?? 0) > 0 && <button className="desk-btn" type="button" aria-expanded={approvalsOpen} aria-controls="routine-approvals" onClick={() => { setApprovalsOpen((open) => !open); }}>{view?.pending.length} awaiting approval</button>}<button className="desk-btn pri" type="button" onClick={() => { setNewRoutine(true); }}>+ New routine</button></div></div>
    <RoutineCreation open={newRoutine} onClose={() => { setNewRoutine(false); }} onCreated={refresh} />
    {(view?.pending.length ?? 0) > 0 && <section hidden={!approvalsOpen} id="routine-approvals" className="routine-approvals desk-set-card" aria-label="Pending routine approvals"><h2>Waiting for approval</h2>{view?.pending.map((p) => <div key={p.decisionId}><p>{inventory?.find((r) => r.id === p.blueprintId)?.name ?? p.blueprintId} wants to run.</p><div className="desk-acts"><RoutineButton action="approve" target={p.decisionId} onChanged={refresh}>Approve</RoutineButton><RoutineButton action="deny" target={p.decisionId} onChanged={refresh}>Deny</RoutineButton></div></div>)}</section>}
    {view?.changes.map((change) => <p key={change.requestId}>A routine change is awaiting confirmation. <RoutineButton action={change.action} target={change.target} retryId={change.requestId} onChanged={refresh}>Check pending change</RoutineButton></p>)}
    <div className="routine-page-tabs" role="tablist" aria-label="Routines page">{(["schedule", "workspace"] as const).map((tab) => <button key={tab} type="button" role="tab" id={`routines-tab-${tab}`} aria-controls={`routines-panel-${tab}`} aria-selected={location.tab === tab} tabIndex={location.tab === tab ? 0 : -1} ref={(node) => { if (node) tabs.current.set(tab, node); else tabs.current.delete(tab); }} onKeyDown={(event) => { tabKey(event, tab); }} onClick={() => { go({ ...location, tab }); }}>{tab === "schedule" ? "Schedule" : "Routine workspace"}</button>)}</div>
    {error && <p role="alert">{error} The installed routine library is unavailable.</p>}
    <div role="tabpanel" id="routines-panel-schedule" aria-labelledby="routines-tab-schedule" hidden={location.tab !== "schedule"}><DeskRoutineCalendar location={location} onLocation={go} inventory={inventory} revision={revision} onSelect={choose} /></div>
    <div role="tabpanel" id="routines-panel-workspace" aria-labelledby="routines-tab-workspace" hidden={location.tab !== "workspace"}>
      {!inventory && !error && <p role="status">Reading installed routines…</p>}{inventory?.length === 0 && <p>No installed routines were returned by the configured owner.</p>}
      <div className="desk-routine-layout"><nav aria-label="Installed routines"><h2>Your routines <small>{inventory?.length ?? "…"}</small></h2><label className="routine-library-search">Find a routine<input value={search} onChange={(event) => { setSearch(event.target.value); }} type="search" /></label><ul className="routine-library-list" ref={library}>{entries.map((r) => <li key={r.id}><button type="button" className="routine-library-button" aria-current={selected === r.id ? "page" : undefined} onClick={() => { choose(r.id); }}>{r.name ?? r.id}</button><small>{r.schedule} · {r.timezone ?? "Owner local timezone"}<br />{r.policy === "auto" ? "Automatic" : r.policy === "disabled" ? "Disabled · handling policy unknown" : "Approval required"}{r.readOnly ? " · Read-only" : ""}</small></li>)}</ul>{inventory && inventory.length > 0 && entries.length === 0 && <p>No routines match this search.</p>}</nav><div className="routine-workspace-detail">
        {routine && <><div className="routine-workspace-heading"><div><p className="routine-policy">{routine.readOnly ? "Read-only definition" : routine.policy === "disabled" ? "Disabled" : "Active"}</p><h2>{routine.name ?? routine.id}</h2><p className="soft">{routine.schedule} · {routine.timezone ?? "Owner local timezone"}</p></div></div><section className="routine-handling" aria-label="Handling policy"><div><strong>Handling policy</strong><p>{routine.policy === "auto" ? "Handled automatically" : routine.policy === "approval" ? "Asks you before each fire" : "Disabled; previous handling policy is not recorded"}</p></div>{!routine.readOnly && routine.policy !== "disabled" && <RoutineButton key={`${routine.id}:${routine.policy}`} action={routine.policy === "auto" ? "stop" : "auto"} target={routine.id} onChanged={refresh}>{routine.policy === "auto" ? "Stop automatic handling" : "Handle this yourself"}</RoutineButton>}</section></>}
        {loading && <p role="status">Reading the installed flow…</p>}{detailError && <p role="alert">{detailError} Saved drafts remain available when this routine can be read again.</p>}
        {detail && selected && <RoutineDetailPage key={selected} detail={detail} session={sessions[selected] ?? newRoutineEditorSession()} onSession={(change) => { setSessions((previous) => ({ ...previous, [selected]: change(previous[selected] ?? newRoutineEditorSession()) })); }} onUpdated={(result) => { setDetails((previous) => ({ ...previous, [result.id]: result })); refresh(); }} />}
        {selected && inventory && !routine && <p role="status">The selected routine is no longer in the installed library. Its drafts are retained for this visit.</p>}
        {!selected && <p>Select a routine to inspect its installed flow.</p>}
      </div></div>
    </div>
  </main></div>;
}
