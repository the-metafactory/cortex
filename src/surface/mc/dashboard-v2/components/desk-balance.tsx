import { scrollBelowDesk } from "../lib/desk-scroll";
import { useEffect, useRef, useState } from "react";
import type { OutlineNode } from "../../../../balance";
import type { MyDayView } from "../../desk/my-day";
import type { DeskView } from "../../desk/types";
import type { ForegroundReading } from "../lib/studio-foreground";
import { getJson } from "../lib/api";
import { useBalanceLocation } from "../hooks/use-balance-location";
import { DeskMirror } from "./desk-mirror";
import { UnfiledBalanceTasks } from "./desk-balance-intake";
import { BalanceAddForm, balanceEntries, TaskDetails, TaskMessageBanner, useBalanceEditor, type TaskAdding } from "./desk-task-details";
import "./desk-balance.css";

import { balanceDestinations } from "../../desk/balance-destinations";
export function balanceMatches(node: OutlineNode, query: string): boolean {
  return node.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || node.children.some(child => balanceMatches(child, query));
}
const openLeaves = (node: OutlineNode): number => node.done ? 0 : node.children.length ? node.children.reduce((sum, child) => sum + openLeaves(child), 0) : 1;


export function DeskBalance({ day, view, foreground, onChanged, onThread, onConversation }: { day: MyDayView; view: DeskView; foreground: ForegroundReading; onChanged: () => void; onThread: (slug: string) => void; onConversation?: (id: string) => void }) {
  const [local, setLocal] = useState<MyDayView | null>(null);
  const current = local?.date === day.date && local.revision >= day.revision ? local : day;
  const [location, go] = useBalanceLocation();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selectionTick, setSelectionTick] = useState(0);
  const editor = useBalanceEditor(current, saved => { setLocal(saved); onChanged(); });
  const { busy, message, change, setMoving } = editor;
  const [adding, setAdding] = useState<TaskAdding | null>(null);
  const inspector = useRef<HTMLElement>(null);
  const outlineHeading = useRef<HTMLHeadingElement>(null);
  const entries = balanceEntries(current.outline);
  const selectedId = location.item ?? entries[0]?.node.id ?? null;
  const entry = entries.find(item => item.node.id === selectedId);
  const destinationChoices = balanceDestinations(current.outline, view.areas, true);
  const destinationIds = new Set(destinationChoices.map(option => option.id));
  const parentChoices = entries.filter(({ node }) => destinationIds.has(node.id));
  const fileParents = balanceDestinations(current.outline, view.areas);
  const roots = current.outline.children.filter(node => !location.area || node.id === location.area);
  const visible = roots.filter(node => balanceMatches(node, location.query));
  const refresh = async (): Promise<void> => {
    try { setLocal(await getJson<MyDayView>("/api/desk/my-day")); onChanged(); }
    catch (error) { editor.setMessage({ kind: "error", text: error instanceof Error ? error.message : "The outline could not be refreshed. Your drafts are kept." }); }
  };
  const beginAdd = (parent: string): void => { setAdding({ parent, title: "", revision: current.revision, date: current.date }); setMoving(null); };
  useEffect(() => {
    if (location.tab === "plan" && location.item && window.matchMedia("(max-width: 760px)").matches) scrollBelowDesk(inspector.current);
  }, [location.item, location.tab, selectionTick]);
  return <div className="dbl">
    <header className="dbl-heading"><div><p className="dbl-eyebrow">The whole picture</p><h1>Balance</h1><p>Your areas, projects and tasks. Choose what deserves room.</p></div><button className="desk-btn pri" disabled={busy || parentChoices.length === 0} onClick={() => { beginAdd(entry && parentChoices.includes(entry) ? entry.node.id : parentChoices[0]?.node.id ?? ""); }}>+ Add task</button></header>
    <nav className="dbl-tabs" aria-label="Balance views"><button className="desk-btn" aria-pressed={location.tab === "plan"} onClick={() => { go({ ...location, tab: "plan" }); }}>Plan</button><button className="desk-btn" aria-pressed={location.tab === "review"} onClick={() => { go({ ...location, tab: "review" }); }}>Weekly review</button><span>Your full hierarchy, beyond today.</span></nav>
    <TaskMessageBanner message={message} busy={busy} onUndo={receipt => void change({ op: "undo", receipt })} />
    {current.studioStatus === "unavailable" && <p role="status">Studio is busy or unreadable. Its last saved outline is shown; refresh when its files are ready.</p>}
    {adding && <BalanceAddForm adding={adding} choices={destinationChoices} busy={busy} heading="Add task" onChange={next => { setAdding({ ...adding, ...next }); }} onCancel={() => { setAdding(null); }} onSubmit={() => { void editor.add(adding).then(saved => { if (saved) { setAdding(null); if (saved.outlineId) go({ tab: "plan", item: saved.outlineId, area: "", query: "" }); } }); }} />}
    {location.tab === "review" ? <div className="dbl-review">{view.mirror ? <DeskMirror mirror={view.mirror} areas={view.areas} foreground={foreground} onThread={onThread} onChanged={onChanged} /> : <p role="status">The weekly review is unavailable. Refresh the Desk to retry.</p>}</div> : <div className="dbl-layout">
      <main className="dbl-outline" aria-label="Balance plan"><header className="dbl-toolbar"><div><h2 ref={outlineHeading} tabIndex={-1}>Your outline</h2><p>Areas → projects → tasks</p></div><div><button className="desk-btn ghost" onClick={() => { setCollapsed(new Set()); }}>Expand all</button><button className="desk-btn ghost" onClick={() => { setCollapsed(new Set(entries.filter(item => item.node.children.length).map(item => item.node.id))); }}>Collapse all</button></div></header>
        <div className="dbl-filters"><input aria-label="Search full hierarchy" placeholder="Find a project or task…" value={location.query} onChange={event => { go({ ...location, query: event.target.value }, true); }} /><select aria-label="Outline area" value={location.area} onChange={event => { go({ ...location, area: event.target.value }, true); }}><option value="">All areas</option>{current.outline.children.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></div>
        <div className="dbl-columns"><span>Task or project</span><span>Importance</span></div>
        <section aria-label="Full Balance hierarchy"><ul className="dbl-tree">{visible.map(node => <BalanceTree key={node.id} node={node} depth={0} query={location.query} collapsed={collapsed} selected={selectedId} date={current.date} studioProjects={new Set(current.studioProjects.map(project => project.id))} today={new Set(current.items.map(item => item.task.id))} onToggle={id => { setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }} onSelect={id => { setMoving(null); setSelectionTick(tick => tick + 1); go({ ...location, item: id }); }} />)}</ul>{visible.length === 0 && <p className="dbl-empty">No items match these area and search filters. <button className="desk-btn ghost" onClick={() => { go({ ...location, area: "", query: "" }, true); }}>Clear filters</button></p>}</section>
        <p className="dbl-foot">A task with children becomes a project. Only its leaves are actionable.</p>
        <UnfiledBalanceTasks day={current} parents={fileParents} busy={busy} change={change} onFiled={id => { go({ tab: "plan", item: id, area: "", query: "" }); }} />
      </main>
      <aside className="dbl-inspector" aria-label="Selected Balance item" ref={inspector} tabIndex={-1}><button className="desk-btn ghost dbl-back" onClick={() => { scrollBelowDesk(outlineHeading.current); }}>← Back to outline</button>
        <TaskDetails id={selectedId} entry={entry} day={current} editor={editor} choices={destinationChoices} onRefresh={() => { void refresh(); }} onAdd={beginAdd} onMoved={id => { go({ ...location, item: id, area: "", query: "" }); }} onThread={onThread} {...(onConversation ? { onConversation } : {})} />
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
    {branch ? <button className="dbl-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`} aria-expanded={open} onClick={() => { onToggle(node.id); }}>{open ? "⌄" : "›"}</button> : <span className="dbl-leaf">{studioProject ? "◇" : node.done ? "✓" : "○"}</span>}
    <button className="dbl-select" aria-pressed={selected === node.id} onClick={() => { onSelect(node.id); }}><strong>{node.title}{node.focusMonth === date.slice(0, 7) ? " ★" : ""}</strong><small>{branch ? `${openLeaves(node)} open${node.ordering === "sequential" ? " · In sequence" : ""}` : depth === 0 ? "Configured area" : studioProject ? "Studio thread" : node.done ? "Complete" : `${node.estimateMinutes === undefined ? "Estimate unknown" : `${node.estimateMinutes} min`}${today.has(node.id) ? " · Today" : ""}${node.dueDate ? ` · Due ${node.dueDate}` : ""}`}</small></button><span className="dbl-weight">{node.weight === 0 ? "Paused" : node.weight}</span>
  </div>{branch && open && <ul>{node.children.map(child => <BalanceTree key={child.id} node={child} depth={depth + 1} query={query} collapsed={collapsed} selected={selected} date={date} studioProjects={studioProjects} today={today} onToggle={onToggle} onSelect={onSelect} />)}</ul>}</li>;
}

