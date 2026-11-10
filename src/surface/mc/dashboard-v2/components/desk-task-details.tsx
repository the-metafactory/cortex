import { useRef, useState, type ReactNode } from "react";
import type { OutlineNode } from "../../../../balance";
import { balanceDetails, type BalanceCommand, type BalanceDetails } from "../../desk/balance-command";
import type { BalanceDestination } from "../../desk/balance-destinations";
import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { submitMyDay } from "../lib/desk-my-day-action";
import { DeskSourceLink } from "./desk-link";
import { DestinationPicker } from "./desk-destination-picker";
import { positionChoices } from "../lib/balance-drop";
import { SourceConversations } from "./desk-source-conversations";
import { TodayControl } from "./desk-today-control";
import "./desk-task-details.css";

export interface TaskEntry { node: OutlineNode; parent: OutlineNode; path: string[] }
export interface TaskDraft { node: OutlineNode; details: BalanceDetails; revision: number; date: string; yes: boolean }
export interface TaskMoving { id: string; parent: string; index?: number; revision: number; date: string }
export interface TaskAdding { parent: string; title: string; revision: number; date: string }
export type TaskMessage = { kind: "saved" | "error"; text: string; undo?: string } | null;
type Saved = Awaited<ReturnType<typeof submitMyDay>>;
export type BalanceChange = (command: MyDayCommand, date?: string) => Promise<Saved | null>;

export function balanceEntries(root: OutlineNode): TaskEntry[] {
  const entries: TaskEntry[] = [];
  const walk = (parent: OutlineNode, path: string[]): void => {
    for (const node of parent.children) {
      entries.push({ node, parent, path });
      walk(node, [...path, node.title]);
    }
  };
  walk(root, []);
  return entries;
}

export const isArea = (day: MyDayView, id: string): boolean => day.outline.children.some(root => root.id === id);
export const isSourceOwned = (day: MyDayView, id: string): boolean => id.startsWith("studio-response:") || day.studioProjects.some(project => project.id === id);

export function detailsCommand(draft: TaskDraft): BalanceCommand {
  return { op: "outline-edit", id: draft.node.id, revision: draft.revision, details: draft.details, yes: draft.yes };
}

export function useBalanceEditor(day: MyDayView, onSaved: (view: MyDayView) => void) {
  const [drafts, setDrafts] = useState(new Map<string, TaskDraft>());
  const [message, setMessage] = useState<TaskMessage>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<TaskMoving | null>(null);
  const retry = useRef(new Map<string, string>());
  const change: BalanceChange = async (command, date = day.date) => {
    if (busy) return null;
    const payload = JSON.stringify({ date, command });
    const requestId = retry.current.get(payload) ?? crypto.randomUUID();
    retry.current.set(payload, requestId);
    setBusy(true);
    setMessage(null);
    try {
      const result = await submitMyDay(date, command, requestId);
      retry.current.delete(payload);
      setMessage({ kind: "saved", text: result.notice ?? "Saved. Today's confirmed choices keep their order.", ...(result.undo ? { undo: result.undo } : {}) });
      onSaved(result.view);
      return result;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "The save was not confirmed. Your draft is kept; retry the same change." });
      return null;
    } finally { setBusy(false); }
  };
  const setDraft = (next: TaskDraft): void => { setDrafts(previous => new Map(previous).set(next.node.id, next)); setMoving(null); };
  const discard = (id: string): void => { setDrafts(previous => { const next = new Map(previous); next.delete(id); return next; }); };
  const draftFor = (entry: TaskEntry | undefined, id: string | null): { draft: TaskDraft | null; dirty: boolean } => {
    const edited = id ? drafts.get(id) : undefined;
    return { draft: edited ?? (entry ? { node: entry.node, details: balanceDetails(entry.node, day.date), revision: day.revision, date: day.date, yes: false } : null), dirty: edited !== undefined };
  };
  const add = (adding: TaskAdding): Promise<Saved | null> => change({ op: "outline-add", parent: adding.parent, title: adding.title, revision: adding.revision }, adding.date);
  return { busy, message, setMessage, change, add, setDraft, discard, draftFor, moving, setMoving };
}
export type BalanceEditor = ReturnType<typeof useBalanceEditor>;

export function TaskMessageBanner({ message, busy = false, onUndo }: { message: TaskMessage; busy?: boolean; onUndo?: (receipt: string) => void }) {
  const receipt = message?.undo;
  return message && <p className={`dbl-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}{receipt && onUndo && <> <button type="button" className="desk-btn" disabled={busy} onClick={() => { onUndo(receipt); }}>Undo</button></>}</p>;
}

export function BalanceAddForm({ adding, choices, busy, heading, onChange, onSubmit, onCancel }: { adding: { parent: string; title: string }; choices: BalanceDestination[]; busy: boolean; heading: string; onChange: (next: { parent: string; title: string }) => void; onSubmit: () => void; onCancel: () => void }) {
  return <form className="dbl-create" onSubmit={event => { event.preventDefault(); onSubmit(); }}><h2>{heading}</h2><DestinationPicker label="New Balance parent" value={adding.parent} options={choices} disabled={busy} onChange={parent => { onChange({ ...adding, parent }); }} /><label>Title<input aria-label="New Balance title" value={adding.title} onChange={event => { onChange({ ...adding, title: event.target.value }); }} required maxLength={300} disabled={busy} /></label><button className="desk-btn pri" disabled={busy || !choices.some(option => option.id === adding.parent)}>Confirm add</button><button type="button" className="desk-btn" disabled={busy} onClick={onCancel}>Cancel</button><p>Adding a subtask turns its parent into a project. A new task joins today's priorities when it outranks an open task there or today has room.</p></form>;
}

export function TaskDetails({ id, entry, day, editor, choices, titled = true, compact = false, locked = false, onRefresh, onAdd, onMoved, onThread, onConversation, children }: { id: string | null; titled?: boolean; compact?: boolean; locked?: boolean; entry: TaskEntry | undefined; day: MyDayView; editor: BalanceEditor; choices: BalanceDestination[]; onRefresh: () => void; onAdd: (parent: string) => void; onMoved: (id: string) => void; onThread: (slug: string) => void; onConversation?: (id: string) => void; children?: ReactNode }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const { draft, dirty } = editor.draftFor(entry, id);
  if (!draft) return <p>{id ? "This outline item is no longer available. Choose another item." : "Add a task to begin shaping your outline."}</p>;
  const { change, moving, setMoving } = editor;
  const busy = editor.busy || locked;
  const node = entry?.node ?? draft.node;
  const editing = !compact || editingId === id || dirty;
  const finishEditing = (): void => { editor.discard(draft.node.id); setEditingId(previous => previous === draft.node.id ? null : previous); };
  const save = (): void => { void change(detailsCommand(draft), draft.date).then(saved => { if (saved) finishEditing(); }); };
  const complete = (): void => {
    if (!entry) return;
    if (node.children.length && !node.done && !window.confirm("Close this project? Its leaves will not be marked complete or given completion credit.")) return;
    void change({ op: node.done ? "outline-reopen" : "outline-complete", id: node.id, revision: day.revision, confirm: true });
  };
  const descendants = new Set(moving ? [node.id, ...balanceEntries(node).map(item => item.node.id)] : []);
  const moveChoices = choices.filter(option => !descendants.has(option.id));
  return <div className="dtd">
    {editing ? <><DetailsForm draft={draft} entry={entry} day={day} titled={titled} busy={busy} dirty={dirty} onDraft={editor.setDraft} onSave={save} onDiscard={() => { finishEditing(); onRefresh(); }} />{compact && <button type="button" className="desk-btn ghost" disabled={busy} onClick={finishEditing}>Cancel editing</button>}</> : <TaskSummary node={node} entry={entry} day={day} titled={titled} busy={busy} onEdit={() => { setEditingId(node.id); }} />}
    <DetailsActions node={node} entry={entry} day={day} busy={busy} dirty={dirty} onAdd={() => { setMoving(null); onAdd(node.id); }} onMove={() => { setMoving({ id: node.id, parent: entry?.parent.id ?? "", revision: day.revision, date: day.date }); }} onComplete={complete} onThread={onThread} change={change} />
    {moving?.id === node.id && <form className="dbl-move" onSubmit={event => { event.preventDefault(); void change({ op: "outline-move", id: moving.id, parent: moving.parent, revision: moving.revision, ...(moving.index === undefined ? {} : { index: moving.index }) }, moving.date).then(saved => { if (saved) { setMoving(null); onMoved(moving.id); } }); }}><DestinationPicker label="Move Balance parent" value={moving.parent} options={moveChoices} disabled={busy} onChange={parent => { setMoving({ id: moving.id, parent, revision: moving.revision, date: moving.date }); }} /><label>Position<select aria-label="Move Balance position" value={moving.index ?? ""} disabled={busy} onChange={event => { const { value } = event.target; setMoving({ id: moving.id, parent: moving.parent, revision: moving.revision, date: moving.date, ...(value === "" ? {} : { index: Number(value) }) }); }}><option value="">At the end</option>{positionChoices(day.outline, moving.id, moving.parent).map(option => <option key={option.index} value={option.index}>Before {option.title}</option>)}</select></label><button className="desk-btn pri" disabled={busy || !moveChoices.some(option => option.id === moving.parent)}>Confirm move</button><button type="button" className="desk-btn" disabled={busy} onClick={() => { setMoving(null); }}>Cancel</button></form>}
    {children}
    {onConversation && entry && !isArea(day, node.id) && <SourceConversations source={{ owner: node.children.length ? "balance-project" : "balance-task", id: node.id }} onOpen={onConversation} />}
  </div>;
}

export function TaskSummary({ node, entry, day, titled, busy, onEdit }: { node: OutlineNode; entry: TaskEntry | undefined; day: MyDayView; titled: boolean; busy: boolean; onEdit: () => void }) {
  const details = balanceDetails(node, day.date);
  return <section className="dtd-summary" aria-label="Saved task details">
    {titled && <h2>{node.title}</h2>}
    <p className="dbl-breadcrumb">{entry && entry.path.length > 0 ? entry.path.join(" / ") : "Top-level area"}</p>
    <dl><div><dt>Estimate</dt><dd>{details.estimateMinutes === null ? "Unknown" : `${details.estimateMinutes} minutes`}</dd></div>{details.dueDate && <div><dt>Due</dt><dd><time dateTime={details.dueDate}>{details.dueDate}</time></dd></div>}{details.context && <div><dt>Context</dt><dd>{details.context}</dd></div>}<div><dt>Importance</dt><dd>{details.weight}</dd></div><div><dt>Effort</dt><dd>{details.effort === 4 ? "Large" : details.effort === 2 ? "Medium" : "Small"} · {details.effort}</dd></div></dl>
    {details.note && <p className="dtd-note">{details.note}</p>}
    <button type="button" className="desk-btn" disabled={busy || !entry} onClick={onEdit}>Edit</button>
  </section>;
}

function DetailsForm({ draft, entry, day, titled, busy, dirty, onDraft, onSave, onDiscard }: { draft: TaskDraft; entry: TaskEntry | undefined; day: MyDayView; titled: boolean; busy: boolean; dirty: boolean; onDraft: (draft: TaskDraft) => void; onSave: () => void; onDiscard: () => void }) {
  const node = entry?.node ?? draft.node;
  const area = isArea(day, node.id);
  const sourceOwned = isSourceOwned(day, node.id);
  const update = (patch: Partial<BalanceDetails>): void => { onDraft({ ...draft, details: { ...draft.details, ...patch }, yes: patch.focus !== undefined ? false : draft.yes }); };
  const siblings = entry?.parent.children ?? [];
  const total = siblings.reduce((sum, sibling) => sum + sibling.weight, 0);
  const nextTotal = total - node.weight + draft.details.weight;
  const share = nextTotal > 0 ? Math.round(100 * draft.details.weight / nextTotal) : 0;
  const newFocus = draft.details.focus && node.focusMonth !== day.date.slice(0, 7);
  return <>
    {titled && <><p className="dbl-eyebrow">{area ? "Configured area" : sourceOwned ? "From Studio" : node.children.length ? "Project details" : "Task details"}</p><h2>{node.title}</h2></>}<p className="dbl-breadcrumb">{(entry?.path.join(" / ") ?? "") || "Top-level area"}</p>
    {!entry && <p role="alert">This item is no longer available. Your unsaved draft is kept here for copying; it cannot overwrite a missing item.</p>}
    {dirty && (draft.revision !== day.revision || draft.date !== day.date) && <p role="status">The saved outline has changed. Your draft and its original version are kept; saving will report a conflict.</p>}
    <form onSubmit={event => { event.preventDefault(); onSave(); }}>
      <label>Title<input aria-label="Balance item title" value={draft.details.title} readOnly={area || sourceOwned} disabled={busy} onChange={event => { update({ title: event.target.value }); }} required maxLength={300} /></label>{(area || sourceOwned) && <p className="dbl-help">The title comes from its configured area or Studio source.</p>}
      <label>Importance <output>{draft.details.weight}</output><input aria-label="Balance importance" type="range" min="0" max="100" value={draft.details.weight} disabled={busy} onChange={event => { update({ weight: Number(event.target.value) }); }} /></label><p className="dbl-help">Relative to siblings · {Number.isFinite(share) ? share : 0}% of their total weight. Zero pauses this branch.</p>
      {(area || node.children.length > 0) && <><label>Children become available<select aria-label="Children ordering" value={draft.details.ordering} disabled={busy} onChange={event => { update({ ordering: event.target.value === "sequential" ? "sequential" : "parallel" }); }}><option value="parallel">In parallel</option><option value="sequential">In sequence</option></select></label>{!area && <label className="dbl-check"><input type="checkbox" checked={draft.details.focus} disabled={busy} onChange={event => { update({ focus: event.target.checked }); }} />Focus this month</label>}<p className="dbl-help">Up to three projects can be in focus this month.</p></>}
      {!area && node.children.length === 0 && <><div className="dbl-pair"><label>Estimate · minutes<input aria-label="Balance estimate minutes" type="number" min="1" step="1" value={draft.details.estimateMinutes ?? ""} placeholder="Unknown" disabled={busy} onChange={event => { update({ estimateMinutes: event.target.value === "" ? null : Number(event.target.value) }); }} /></label><label>Effort credit<select aria-label="Balance effort credit" value={draft.details.effort} disabled={busy} onChange={event => { update({ effort: event.target.value === "4" ? 4 : event.target.value === "2" ? 2 : 1 }); }}><option value="1">Small · 1</option><option value="2">Medium · 2</option><option value="4">Large · 4</option></select></label></div><p className="dbl-help">An absent estimate stays unknown. Minutes are separate from effort credit.</p></>}
      {!area && <><label>Due date<input aria-label="Balance due date" type="date" value={draft.details.dueDate} disabled={busy} onChange={event => { update({ dueDate: event.target.value }); }} /></label><label>Context<input aria-label="Balance context" value={draft.details.context} maxLength={120} disabled={busy} onChange={event => { update({ context: event.target.value }); }} placeholder="No context" /></label></>}
      <label>Notes<textarea aria-label="Balance notes" value={draft.details.note} disabled={busy} maxLength={10_000} onChange={event => { update({ note: event.target.value }); }} /></label>
      {newFocus && <fieldset><legend>Before you say yes</legend>{day.yesFilter.map(question => <p key={question}>{question}</p>)}<label className="dbl-check"><input type="checkbox" required checked={draft.yes} disabled={busy} onChange={event => { onDraft({ ...draft, yes: event.target.checked }); }} />I have considered these questions and choose this focus.</label></fieldset>}
      <button className="desk-btn pri dbl-save" disabled={busy || !entry}>Save changes</button>{dirty && <button type="button" className="desk-btn ghost" disabled={busy} onClick={onDiscard}>Discard draft and reload saved version</button>}
    </form>
  </>;
}

function DetailsActions({ node, entry, day, busy, dirty, onAdd, onMove, onComplete, onThread, change }: { node: OutlineNode; entry: TaskEntry | undefined; day: MyDayView; busy: boolean; dirty: boolean; onAdd: () => void; onMove: () => void; onComplete: () => void; onThread: (slug: string) => void; change: BalanceChange }) {
  const area = isArea(day, node.id);
  const sourceOwned = isSourceOwned(day, node.id);
  const source = day.sources.find(link => link.taskId === node.id);
  const studio = day.studioProjects.find(link => link.id === node.id) ?? day.studioTasks.find(link => link.id === node.id);
  return <div className="dbl-actions"><button className="desk-btn ghost" disabled={busy || dirty || !entry || (node.done ?? false) || node.id.startsWith("studio-response:")} onClick={onAdd}>+ Add subtask</button>{!area && !sourceOwned && <><button className="desk-btn ghost" disabled={busy || dirty || !entry} onClick={onMove}>Move…</button><button className="desk-btn" disabled={busy || dirty || !entry} onClick={onComplete}>{node.done ? "Reopen" : node.children.length ? "Close project" : "Mark complete"}</button></>}{!area && entry && <TodayControl node={node} day={day} busy={busy || dirty} change={change} />}{dirty && <p className="dbl-help">Save or discard the draft before changing this item's structure.</p>}
    {source && <DeskSourceLink source={source} />}{studio && <button className="desk-btn ghost" onClick={() => { onThread(studio.slug); }}>Open Studio thread →</button>}
  </div>;
}
