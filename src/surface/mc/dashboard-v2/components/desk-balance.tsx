import { useEffect, useRef, useState } from "react";
import type { OutlineNode } from "../../../../balance";
import { balanceDetails, type BalanceCommand, type BalanceDetails } from "../../desk/balance-command";
import type { MyDayView } from "../../desk/my-day";
import type { DeskView } from "../../desk/types";
import type { ForegroundReading } from "../lib/studio-foreground";
import { getJson } from "../lib/api";
import { useBalanceLocation } from "../hooks/use-balance-location";
import { DeskMirror } from "./desk-mirror";
import { UnfiledBalanceTasks } from "./desk-balance-intake";
import { submitMyDay } from "./desk-my-day";
import "./desk-balance.css";

interface Entry { node: OutlineNode; parent: OutlineNode; path: string[] }
interface Draft { node: OutlineNode; details: BalanceDetails; revision: number; date: string; yes: boolean }
type Message = { kind: "saved" | "error"; text: string } | null;
export function balanceEntries(root: OutlineNode): Entry[] {
  const entries: Entry[] = [];
  const walk = (parent: OutlineNode, path: string[]): void => {
    for (const node of parent.children) {
      entries.push({ node, parent, path });
      walk(node, [...path, node.title]);
    }
  };
  walk(root, []);
  return entries;
}
export function balanceMatches(node: OutlineNode, query: string): boolean {
  return node.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || node.children.some(child => balanceMatches(child, query));
}
const isSourceOwned = (day: MyDayView, id: string): boolean => id.startsWith("studio-response:") || day.studioProjects.some(project => project.id === id);
const openLeaves = (node: OutlineNode): number => node.done ? 0 : node.children.length ? node.children.reduce((sum, child) => sum + openLeaves(child), 0) : 1;
function scrollBelowDesk(element: HTMLElement | null): void {
  if (!element) return;
  const headerHeight = document.querySelector(".desk-top")?.getBoundingClientRect().height ?? 0;
  window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - headerHeight - 16 });
  element.focus({ preventScroll: true });
}

export function DeskBalance({ day, view, foreground, onChanged, onThread }: { day: MyDayView; view: DeskView; foreground: ForegroundReading; onChanged: () => void; onThread: (slug: string) => void }) {
  const [local, setLocal] = useState<MyDayView | null>(null);
  const current = local?.date === day.date && local.revision >= day.revision ? local : day;
  const [location, go] = useBalanceLocation();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selectionTick, setSelectionTick] = useState(0);
  const [drafts, setDrafts] = useState(new Map<string, Draft>());
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ parent: string; title: string; revision: number; date: string } | null>(null);
  const [moving, setMoving] = useState<{ id: string; parent: string; revision: number; date: string } | null>(null);
  const retry = useRef(new Map<string, string>());
  const inspector = useRef<HTMLElement>(null);
  const outlineHeading = useRef<HTMLHeadingElement>(null);
  const entries = balanceEntries(current.outline);
  const selectedId = location.item ?? entries[0]?.node.id ?? null;
  const entry = entries.find(item => item.node.id === selectedId);
  const edited = selectedId ? drafts.get(selectedId) : undefined;
  const draft = edited ?? (entry ? { node: entry.node, details: balanceDetails(entry.node, current.date), revision: current.revision, date: current.date, yes: false } : null);
  const parentChoices = entries.filter(({ node }) => !node.done && !node.id.startsWith("studio-response:"));
  const fileParents = parentChoices.filter(({ node }) => current.outline.children.includes(node) || node.children.length > 0);
  const roots = current.outline.children.filter(node => !location.area || node.id === location.area);
  const visible = roots.filter(node => balanceMatches(node, location.query));
  const refresh = async (): Promise<void> => {
    try { setLocal(await getJson<MyDayView>("/api/desk/my-day")); onChanged(); }
    catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "The outline could not be refreshed. Your drafts are kept." }); }
  };
  const change = async (command: BalanceCommand, date = current.date): Promise<Awaited<ReturnType<typeof submitMyDay>> | null> => {
    if (busy) return null;
    const payload = JSON.stringify({ date, command });
    const requestId = retry.current.get(payload) ?? crypto.randomUUID();
    retry.current.set(payload, requestId);
    setBusy(true);
    setMessage(null);
    try {
      const result = await submitMyDay(date, command, requestId);
      retry.current.delete(payload);
      setLocal(result.view);
      setMessage({ kind: "saved", text: result.notice ?? "Saved. Today's confirmed choices keep their order." });
      onChanged();
      return result;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "The save was not confirmed. Your draft is kept; retry the same change." });
      return null;
    } finally { setBusy(false); }
  };
  const setDraft = (next: Draft): void => { setDrafts(previous => new Map(previous).set(next.node.id, next)); setMoving(null); };
  const discard = (id: string): void => setDrafts(previous => { const next = new Map(previous); next.delete(id); return next; });
  const beginAdd = (parent: string): void => { setAdding({ parent, title: "", revision: current.revision, date: current.date }); setMoving(null); };
  useEffect(() => {
    if (location.tab === "plan" && location.item && window.matchMedia("(max-width: 760px)").matches) scrollBelowDesk(inspector.current);
  }, [location.item, location.tab, selectionTick]);
  return <div className="dbl">
    <header className="dbl-heading"><div><p className="dbl-eyebrow">The whole picture</p><h1>Balance</h1><p>Your areas, projects and tasks. Choose what deserves room.</p></div><button className="desk-btn pri" disabled={busy || parentChoices.length === 0} onClick={() => beginAdd(entry && parentChoices.includes(entry) ? entry.node.id : parentChoices[0]?.node.id ?? "")}>+ Add task</button></header>
    <nav className="dbl-tabs" aria-label="Balance views"><button className="desk-btn" aria-pressed={location.tab === "plan"} onClick={() => go({ ...location, tab: "plan" })}>Plan</button><button className="desk-btn" aria-pressed={location.tab === "review"} onClick={() => go({ ...location, tab: "review" })}>Weekly review</button><span>Your full hierarchy, beyond today.</span></nav>
    {message && <p className={`dbl-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    {current.studioStatus === "unavailable" && <p role="status">Studio is busy or unreadable. Its last saved outline is shown; refresh when its files are ready.</p>}
    {adding && <form className="dbl-create" onSubmit={event => { event.preventDefault(); void change({ op: "outline-add", parent: adding.parent, title: adding.title, revision: adding.revision }, adding.date).then(saved => { if (saved) { setAdding(null); if (saved.outlineId) go({ tab: "plan", item: saved.outlineId, area: "", query: "" }); } }); }}><h2>Add task</h2><label>Parent<select aria-label="New Balance parent" value={adding.parent} disabled={busy} onChange={event => setAdding({ ...adding, parent: event.target.value })}>{parentChoices.map(item => <option value={item.node.id} key={item.node.id}>{[...item.path, item.node.title].join(" / ")}</option>)}</select></label><label>Title<input aria-label="New Balance title" value={adding.title} onChange={event => setAdding({ ...adding, title: event.target.value })} required maxLength={300} disabled={busy} /></label><button className="desk-btn pri" disabled={busy}>Confirm add</button><button type="button" className="desk-btn" disabled={busy} onClick={() => setAdding(null)}>Cancel</button><p>Adding a subtask turns its parent into a project. It does not add work to today's confirmed list.</p></form>}
    {location.tab === "review" ? <div className="dbl-review">{view.mirror ? <DeskMirror mirror={view.mirror} areas={view.areas} foreground={foreground} onThread={onThread} /> : <p role="status">The weekly review is unavailable. Refresh the Desk to retry.</p>}</div> : <div className="dbl-layout">
      <main className="dbl-outline" aria-label="Balance plan"><header className="dbl-toolbar"><div><h2 ref={outlineHeading} tabIndex={-1}>Your outline</h2><p>Areas → projects → tasks</p></div><div><button className="desk-btn ghost" onClick={() => setCollapsed(new Set())}>Expand all</button><button className="desk-btn ghost" onClick={() => setCollapsed(new Set(entries.filter(item => item.node.children.length).map(item => item.node.id)))}>Collapse all</button></div></header>
        <div className="dbl-filters"><input aria-label="Search full hierarchy" placeholder="Find a project or task…" value={location.query} onChange={event => go({ ...location, query: event.target.value }, true)} /><select aria-label="Outline area" value={location.area} onChange={event => go({ ...location, area: event.target.value }, true)}><option value="">All areas</option>{current.outline.children.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></div>
        <div className="dbl-columns"><span>Task or project</span><span>Importance</span></div>
        <section aria-label="Full Balance hierarchy"><ul className="dbl-tree">{visible.map(node => <BalanceTree key={node.id} node={node} depth={0} query={location.query} collapsed={collapsed} selected={selectedId} date={current.date} studioProjects={new Set(current.studioProjects.map(project => project.id))} today={new Set(current.items.map(item => item.task.id))} onToggle={id => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onSelect={id => { setMoving(null); setSelectionTick(tick => tick + 1); go({ ...location, item: id }); }} />)}</ul>{visible.length === 0 && <p className="dbl-empty">No items match these area and search filters. <button className="desk-btn ghost" onClick={() => go({ ...location, area: "", query: "" }, true)}>Clear filters</button></p>}</section>
        <p className="dbl-foot">A task with children becomes a project. Only its leaves are actionable.</p>
        <UnfiledBalanceTasks day={current} parents={fileParents.map(parent => ({ id: parent.node.id, label: [...parent.path, parent.node.title].join(" / ") }))} busy={busy} change={change} onFiled={id => go({ tab: "plan", item: id, area: "", query: "" })} />
      </main>
      <aside className="dbl-inspector" aria-label="Selected Balance item" ref={inspector} tabIndex={-1}><button className="desk-btn ghost dbl-back" onClick={() => scrollBelowDesk(outlineHeading.current)}>← Back to outline</button>
        {draft ? <BalanceInspector draft={draft} entry={entry} day={current} busy={busy} dirty={edited !== undefined} onDraft={setDraft} onSave={() => { void change({ op: "outline-edit", id: draft.node.id, revision: draft.revision, details: draft.details, yes: draft.yes }, draft.date).then(saved => { if (saved) { discard(draft.node.id); } }); }} onDiscard={() => { discard(draft.node.id); void refresh(); }} onAdd={() => beginAdd(draft.node.id)} onMove={() => setMoving({ id: draft.node.id, parent: entry?.parent.id ?? "", revision: current.revision, date: current.date })} onComplete={() => { const node = entry?.node; if (!node) return; if (node.children.length && !node.done && !window.confirm("Close this project? Its leaves will not be marked complete or given completion credit.")) return; void change({ op: node.done ? "outline-reopen" : "outline-complete", id: node.id, revision: current.revision, confirm: true }); }} onThread={onThread} /> : <p>{selectedId ? "This outline item is no longer available. Choose another item from the outline." : "Add a task to begin shaping your outline."}</p>}
        {moving && draft && moving.id === draft.node.id && <form className="dbl-move" onSubmit={event => { event.preventDefault(); void change({ op: "outline-move", id: moving.id, parent: moving.parent, revision: moving.revision }, moving.date).then(saved => { if (saved) { setMoving(null); go({ ...location, item: moving.id, area: "", query: "" }); } }); }}><label>Move to<select aria-label="Move Balance parent" value={moving.parent} disabled={busy} onChange={event => setMoving({ ...moving, parent: event.target.value })}>{parentChoices.filter(item => !balanceEntries(draft.node).some(child => child.node.id === item.node.id) && item.node.id !== draft.node.id).map(item => <option key={item.node.id} value={item.node.id}>{[...item.path, item.node.title].join(" / ")}</option>)}</select></label><button className="desk-btn pri" disabled={busy}>Confirm move</button><button type="button" className="desk-btn" disabled={busy} onClick={() => setMoving(null)}>Cancel</button></form>}
      </aside>
    </div>}
  </div>;
}

function BalanceTree({ node, depth, query, collapsed, selected, date, studioProjects, today, onToggle, onSelect }: { node: OutlineNode; depth: number; query: string; collapsed: Set<string>; selected: string | null; date: string; studioProjects: Set<string>; today: Set<string>; onToggle: (id: string) => void; onSelect: (id: string) => void }) {
  if (!balanceMatches(node, query)) return null;
  const branch = node.children.length > 0;
  const studioProject = studioProjects.has(node.id);
  const open = Boolean(query) || !collapsed.has(node.id);
  return <li><div className={`dbl-row ${selected === node.id ? "selected" : ""} ${node.done ? "done" : ""}`} style={{ paddingInlineStart: 12 + Math.min(depth, 7) * 14 }}>
    {branch ? <button className="dbl-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`} aria-expanded={open} onClick={() => onToggle(node.id)}>{open ? "⌄" : "›"}</button> : <span className="dbl-leaf">{studioProject ? "◇" : node.done ? "✓" : "○"}</span>}
    <button className="dbl-select" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}><strong>{node.title}{node.focusMonth === date.slice(0, 7) ? " ★" : ""}</strong><small>{branch ? `${openLeaves(node)} open${node.ordering === "sequential" ? " · In sequence" : ""}` : depth === 0 ? "Configured area" : studioProject ? "Studio thread" : node.done ? "Complete" : `${node.estimateMinutes === undefined ? "Estimate unknown" : `${node.estimateMinutes} min`}${today.has(node.id) ? " · Today" : ""}${node.dueDate ? ` · Due ${node.dueDate}` : ""}`}</small></button><span className="dbl-weight">{node.weight === 0 ? "Paused" : node.weight}</span>
  </div>{branch && open && <ul>{node.children.map(child => <BalanceTree key={child.id} node={child} depth={depth + 1} query={query} collapsed={collapsed} selected={selected} date={date} studioProjects={studioProjects} today={today} onToggle={onToggle} onSelect={onSelect} />)}</ul>}</li>;
}

function BalanceInspector({ draft, entry, day, busy, dirty, onDraft, onSave, onDiscard, onAdd, onMove, onComplete, onThread }: { draft: Draft; entry: Entry | undefined; day: MyDayView; busy: boolean; dirty: boolean; onDraft: (draft: Draft) => void; onSave: () => void; onDiscard: () => void; onAdd: () => void; onMove: () => void; onComplete: () => void; onThread: (slug: string) => void }) {
  const node = entry?.node ?? draft.node;
  const area = day.outline.children.some(root => root.id === node.id);
  const sourceOwned = isSourceOwned(day, node.id);
  const source = day.sources.find(link => link.taskId === node.id);
  const studio = day.studioProjects.find(link => link.id === node.id) ?? day.studioTasks.find(link => link.id === node.id);
  const update = (patch: Partial<BalanceDetails>): void => { onDraft({ ...draft, details: { ...draft.details, ...patch }, yes: patch.focus !== undefined ? false : draft.yes }); };
  const siblings = entry?.parent.children ?? [];
  const total = siblings.reduce((sum, sibling) => sum + sibling.weight, 0);
  const nextTotal = total - node.weight + draft.details.weight;
  const share = nextTotal > 0 ? Math.round(100 * draft.details.weight / nextTotal) : 0;
  const newFocus = draft.details.focus && node.focusMonth !== day.date.slice(0, 7);
  return <>
    <p className="dbl-eyebrow">{area ? "Configured area" : sourceOwned ? "From Studio" : node.children.length ? "Project details" : "Task details"}</p><h2>{node.title}</h2><p className="dbl-breadcrumb">{entry?.path.join(" / ") || "Top-level area"}</p>
    {!entry && <p role="alert">This item is no longer available. Your unsaved draft is kept here for copying; it cannot overwrite a missing item.</p>}
    {dirty && (draft.revision !== day.revision || draft.date !== day.date) && <p role="status">The saved outline has changed. Your draft and its original version are kept; saving will report a conflict.</p>}
    <form onSubmit={event => { event.preventDefault(); onSave(); }}>
      <label>Title<input aria-label="Balance item title" value={draft.details.title} readOnly={area || sourceOwned} disabled={busy} onChange={event => update({ title: event.target.value })} required maxLength={300} /></label>{(area || sourceOwned) && <p className="dbl-help">The title comes from its configured area or Studio source.</p>}
      <label>Importance <output>{draft.details.weight}</output><input aria-label="Balance importance" type="range" min="0" max="100" value={draft.details.weight} disabled={busy} onChange={event => update({ weight: Number(event.target.value) })} /></label><p className="dbl-help">Relative to siblings · {Number.isFinite(share) ? share : 0}% of their total weight. Zero pauses this branch.</p>
      {(area || node.children.length > 0) && <><label>Children become available<select aria-label="Children ordering" value={draft.details.ordering} disabled={busy} onChange={event => update({ ordering: event.target.value === "sequential" ? "sequential" : "parallel" })}><option value="parallel">In parallel</option><option value="sequential">In sequence</option></select></label>{!area && <label className="dbl-check"><input type="checkbox" checked={draft.details.focus} disabled={busy} onChange={event => update({ focus: event.target.checked })} />Focus this month</label>}<p className="dbl-help">Up to three projects can be in focus this month.</p></>}
      {!area && node.children.length === 0 && <><div className="dbl-pair"><label>Estimate · minutes<input aria-label="Balance estimate minutes" type="number" min="1" step="1" value={draft.details.estimateMinutes ?? ""} placeholder="Unknown" disabled={busy} onChange={event => update({ estimateMinutes: event.target.value === "" ? null : Number(event.target.value) })} /></label><label>Effort credit<select aria-label="Balance effort credit" value={draft.details.effort} disabled={busy} onChange={event => update({ effort: event.target.value === "4" ? 4 : event.target.value === "2" ? 2 : 1 })}><option value="1">Small · 1</option><option value="2">Medium · 2</option><option value="4">Large · 4</option></select></label></div><p className="dbl-help">An absent estimate stays unknown. Minutes are separate from effort credit.</p></>}
      {!area && <><label>Due date<input aria-label="Balance due date" type="date" value={draft.details.dueDate} disabled={busy} onChange={event => update({ dueDate: event.target.value })} /></label><label>Context<input aria-label="Balance context" value={draft.details.context} maxLength={120} disabled={busy} onChange={event => update({ context: event.target.value })} placeholder="No context" /></label></>}
      <label>Notes<textarea aria-label="Balance notes" value={draft.details.note} disabled={busy} maxLength={10_000} onChange={event => update({ note: event.target.value })} /></label>
      {newFocus && <fieldset><legend>Before you say yes</legend>{day.yesFilter.map(question => <p key={question}>{question}</p>)}<label className="dbl-check"><input type="checkbox" required checked={draft.yes} disabled={busy} onChange={event => onDraft({ ...draft, yes: event.target.checked })} />I have considered these questions and choose this focus.</label></fieldset>}
      <button className="desk-btn pri dbl-save" disabled={busy || !entry}>Save changes</button>{dirty && <button type="button" className="desk-btn ghost" disabled={busy} onClick={onDiscard}>Discard draft and reload saved version</button>}
    </form>
    <div className="dbl-actions"><button className="desk-btn ghost" disabled={busy || dirty || !entry || node.done || node.id.startsWith("studio-response:")} onClick={onAdd}>+ Add subtask</button>{!area && !sourceOwned && <><button className="desk-btn ghost" disabled={busy || dirty || !entry} onClick={onMove}>Move…</button><button className="desk-btn" disabled={busy || dirty || !entry} onClick={onComplete}>{node.done ? "Reopen" : node.children.length ? "Close project" : "Mark complete"}</button></>}{dirty && <p className="dbl-help">Save or discard the draft before changing this item's structure.</p>}
      {source && (source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">Open original source</a> : <p>From {source.kind}</p>)}{studio && <button className="desk-btn ghost" onClick={() => onThread(studio.slug)}>Open Studio thread →</button>}
    </div>
  </>;
}
