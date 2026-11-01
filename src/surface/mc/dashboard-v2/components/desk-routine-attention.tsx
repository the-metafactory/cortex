import { useEffect, useMemo, useState } from "react";
import type { RoutineView } from "../../desk/routine-command";
import type { RoutineInventory } from "../../desk/routine-editor-contract";
import type { RoutineEvidenceRecord } from "../../desk/routine-evidence-contract";
import type { WorkspaceTab } from "../hooks/use-routines-location";
import { attentionGroups, readPeriodHistory, type AttentionGroup, type PeriodHistory } from "../lib/routine-attention";
import { calendarPeriod } from "../lib/routine-calendar";
import { evidenceLabel, evidenceOrigin } from "../lib/routine-evidence";
import { ExecutionViewer } from "./desk-routine-evidence";
import { RoutineButton } from "./desk-routines";

const pageSize = 10;
const stamp = (at: string, timezone: string): string => new Date(at).toLocaleString(undefined, { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
type HistoryState = { key: string } & ({ kind: "loading" } | { kind: "error"; message: string } | ({ kind: "ready" } & PeriodHistory));

export function AttentionSummary({ groups, history, view, inventoryError, timezone }: { groups: AttentionGroup[]; history: HistoryState | { kind: "inactive" }; view: RoutineView | undefined; inventoryError: boolean; timezone: string }) {
  const evidence = history.kind === "ready" ? `${history.checked} recorded decisions read; ${history.coverage === "partial" ? `partial` : history.reachedStart || history.oldest === null ? "this period's history is covered" : `the owner retains no records before ${stamp(history.oldest, timezone)}`}${history.coverage === "complete" ? "" : `: loaded back to ${history.oldest ? stamp(history.oldest, timezone) : "no records"}, older records in this period were not read`}` : history.kind === "error" ? `Execution evidence unavailable: ${history.message} Failures in this period are unknown.` : history.kind === "loading" ? "Reading recorded execution evidence for this period…" : "Execution evidence not loaded.";
  const approvals = view === undefined ? "Pending approvals not loaded." : view.error ? `Pending approvals unavailable: ${view.error}` : null;
  return <>
    <p className="soft routine-attention-coverage">{evidence}{approvals ? ` ${approvals}` : ""}{inventoryError ? " Installed routine library unavailable; scheduling uncertainty is unknown." : ""}</p>
    {groups.length === 0 && history.kind === "ready" && <p>No pending approvals, recorded failures or scheduling uncertainty were loaded for this period. This is not a health check.</p>}
  </>;
}

function GroupDetail({ group, timezone, records, onOpen, onChanged }: { group: AttentionGroup; timezone: string; records: RoutineEvidenceRecord[]; onOpen: (routineId: string, workspace: WorkspaceTab) => void; onChanged: () => void }) {
  const [page, setPage] = useState(0);
  const [inspect, setInspect] = useState<RoutineEvidenceRecord | null>(null);
  const items = group.kind === "approval" ? group.approvals.length : group.records.length;
  const pages = Math.max(1, Math.ceil(items / pageSize));
  return <div className="routine-attention-detail">
    {group.kind === "approval" && <ul>{group.approvals.slice(page * pageSize, (page + 1) * pageSize).map((pending) => <li key={pending.decisionId}><span>Matched {stamp(pending.matchedAt, timezone)} · expires {stamp(pending.expiresAt, timezone)}</span><div className="desk-acts"><RoutineButton action="approve" target={pending.decisionId} onChanged={onChanged}>Approve</RoutineButton><RoutineButton action="deny" target={pending.decisionId} onChanged={onChanged}>Deny</RoutineButton></div></li>)}</ul>}
    {(group.kind === "failure" || group.kind === "evidence") && <ul>{group.records.slice(page * pageSize, (page + 1) * pageSize).map((record) => <li key={record.decisionId}><span>{evidenceLabel(record)} · <time dateTime={record.at}>{stamp(record.execution.kind === "observed" ? record.execution.startedAt : record.at, timezone)}</time></span><button className="desk-btn" type="button" onClick={() => { setInspect(record); }}>Inspect execution</button></li>)}</ul>}
    {group.kind === "scheduling" && <p>The routine owner could not confirm whether this routine is scheduled. Its planned starts may be missing or stale.</p>}
    {pages > 1 && <div className="desk-acts"><button className="desk-btn" type="button" disabled={page === 0} onClick={() => { setPage(page - 1); }}>Previous</button><span>Page {page + 1} of {pages}</span><button className="desk-btn" type="button" disabled={page + 1 >= pages} onClick={() => { setPage(page + 1); }}>Next</button></div>}
    <button className="desk-btn" type="button" onClick={() => { onOpen(group.routineId, group.kind === "failure" || group.kind === "evidence" ? "executions" : "overview"); }}>Open routine workspace</button>
    {inspect && <ExecutionViewer key={inspect.decisionId} record={inspect} origin={evidenceOrigin(inspect, records)} onClose={() => { setInspect(null); }} />}
  </div>;
}

export function DeskRoutineAttention({ days, timezone, revision, view, inventory, inventoryError, active, onOpen, onChanged }: { days: string[]; timezone: string; revision: number; view: RoutineView | undefined; inventory: RoutineInventory | null; inventoryError: boolean; active: boolean; onOpen: (routineId: string, workspace: WorkspaceTab) => void; onChanged: () => void }) {
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<HistoryState>({ key: "", kind: "loading" });
  const [open, setOpen] = useState<string | null>(null);
  const key = JSON.stringify([days, timezone, revision, retry]);
  const history: HistoryState = snapshot.key === key ? snapshot : { key, kind: "loading" };
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController(); setSnapshot({ key, kind: "loading" }); setOpen(null);
    let period: { start: string; end: string };
    try { period = calendarPeriod(days, timezone); } catch (error) { setSnapshot({ key, kind: "error", message: error instanceof Error ? error.message : "Choose a calendar period." }); return () => { abort.abort(); }; }
    void readPeriodHistory(period.start, period.end, abort.signal).then((result) => { if (!abort.signal.aborted) setSnapshot({ key, kind: "ready", ...result }); }).catch((error: unknown) => { if (!abort.signal.aborted) setSnapshot({ key, kind: "error", message: error instanceof Error ? error.message : "The evidence owner did not answer." }); });
    return () => { abort.abort(); };
  }, [key, days, timezone, active]);
  const records = useMemo(() => history.kind === "ready" ? history.records : [], [history]);
  const groups = useMemo(() => attentionGroups({ pending: view?.error ? [] : view?.pending ?? [], records, inventory }), [view, records, inventory]);
  return <section className="routine-attention desk-set-card" aria-label="Needs attention">
    <div className="routine-calendar-toolbar"><h2>Needs attention{groups.length > 0 ? ` · ${groups.length}` : ""}</h2>{history.kind === "error" && <button className="desk-btn" type="button" onClick={() => { setRetry((n) => n + 1); }}>Retry evidence</button>}</div>
    {groups.length > 0 && <ul className="routine-attention-list">{groups.map((group) => <li key={group.key} className={`routine-attention-${group.kind}`}>
      <button type="button" className="routine-attention-row" aria-expanded={open === group.key} onClick={() => { setOpen(open === group.key ? null : group.key); }}>
        <strong>{group.name}</strong><span>{group.reason}</span><small>{group.kind === "scheduling" ? "Current owner state" : `${group.count} loaded${group.latest ? ` · latest ${stamp(group.latest, timezone)}` : ""}`}</small>
      </button>
      {open === group.key && <GroupDetail group={group} timezone={timezone} records={records} onOpen={onOpen} onChanged={onChanged} />}
    </li>)}</ul>}
    <AttentionSummary groups={groups} history={history} view={view} inventoryError={inventoryError} timezone={timezone} />
  </section>;
}
