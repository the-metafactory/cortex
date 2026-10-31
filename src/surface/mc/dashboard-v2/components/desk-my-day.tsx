import { useRef, useState } from "react";
import type { OutlineNode } from "../../../../balance";
import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { postJson } from "../lib/api";
import "./desk-my-day.css";

export async function submitMyDay(date: string, command: MyDayCommand, requestId: string = crypto.randomUUID()): Promise<{ view: MyDayView; undo?: string }> {
  return postJson("/api/desk/my-day", { date, command, requestId });
}
export function MyDayLane({ day, onChanged }: { day: MyDayView; onChanged: () => void }) {
  const [local, setLocal] = useState<MyDayView | null>(null);
  const current = local?.date === day.date && local.revision > day.revision ? local : day;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outline, setOutline] = useState(false);
  const [swap, setSwap] = useState<string | null>(null);
  const retry = useRef<{ payload: string; id: string } | null>(null);
  const change = async (command: MyDayCommand): Promise<boolean> => {
    if (busy) return false;
    const payload = JSON.stringify({ date: current.date, command });
    const requestId = retry.current?.payload === payload ? retry.current.id : crypto.randomUUID();
    retry.current = { payload, id: requestId };
    setBusy(true);
    try {
      const result = await submitMyDay(current.date, command, requestId);
      retry.current = null;
      setLocal(result.view);
      setNote(command.op === "defer" ? "Set aside for today. Undo is kept below." : "Saved.");
      onChanged();
      return true;
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not save. Try again.");
      return false;
    } finally { setBusy(false); }
  };
  const ids = current.items.map(i => i.task.id);
  return <section className="desk-myday" aria-label="My day">
    <header><h2>My day</h2><span>{current.phase === "proposed" ? "Your proposed day" : current.phase === "closed" ? "Day complete" : "Your intention today"}</span></header>
    <div className="myday-dials">
      <label>My day <input aria-label="My day cap" type="range" min="1" max="7" value={current.cap} disabled={busy} onChange={e => void change({ op: "cap", cap: Number(e.target.value) })} /><output>{current.cap}</output></label>
      <label>Needs you <input aria-label="Needs you cap" type="range" min="1" max="10" value={current.topN} disabled={busy} onChange={e => void change({ op: "topN", topN: Number(e.target.value) })} /><output>{current.topN}</output></label>
    </div>
    <p className="myday-cap-source">{current.capsOverridden ? "Your saved caps apply until Reset." : "Using your defaults."} Defaults: {current.configuredCaps.cap} My day / {current.configuredCaps.topN} Needs you. {current.capsOverridden && <button className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "reset-caps" })}>Reset</button>}</p>
    {current.phase === "closed" && <Wins day={current} />}
    {current.phase !== "closed" && <>
      {current.items.length === 0 && <p className="myday-empty">A little space. Add a task to your outline to shape your day.</p>}
      <ol className="myday-list">{current.items.map(item => <li key={item.task.id}>
        <div><strong>{item.task.title}</strong><small>{item.areaTitle}{item.path.length ? ` · ${item.path.join(" / ")}` : ""}</small></div>
        <details><summary className="myday-because">Because: {item.reason} <span>· Why this</span></summary><p>{item.trace}</p></details>
        <div className="myday-actions">
          {current.phase === "started" && <button className="desk-btn pri" disabled={busy} onClick={() => void change({ op: "done", id: item.task.id })}>Done</button>}
          <button className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "defer", id: item.task.id })}>→ not today</button>
          {current.phase === "proposed" && <button className="desk-btn ghost" onClick={() => setSwap(swap === item.task.id ? null : item.task.id)}>Swap</button>}
        </div>
        {swap === item.task.id && current.phase === "proposed" && <div className="myday-alternates"><p>Choose an engine alternate</p>{current.alternates.map(a => <button className="desk-btn" key={a.task.id} disabled={busy} onClick={() => { void change({ op: "draft", ids: ids.map(id => id === item.task.id ? a.task.id : id) }); setSwap(null); }}>{a.task.title}</button>)}{current.alternates.length === 0 && <p>No other task is available today.</p>}</div>}
      </li>)}</ol>
      {current.phase === "proposed" ? <div className="myday-contract"><p>Does this look like your day?</p><button className="desk-btn pri" disabled={busy} onClick={() => void change({ op: "start", ids })}>Start the day</button> <button className="desk-btn" disabled={busy || ids.length === 0} onClick={() => void change({ op: "draft", ids: ids.slice(0, 1) })}>Just one thing</button> <button className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "propose" })}>Refresh proposal</button></div> : <><Wins day={current} /><button className="desk-btn" disabled={busy} onClick={() => void change({ op: "close" })}>Done for today</button></>}
    </>}
    {current.undos.map(u => <div className="myday-undo" key={u.receipt}>{u.title} is set aside. <button className="desk-btn" disabled={busy} onClick={() => void change({ op: "undo", receipt: u.receipt })}>Undo</button></div>)}
    {note && <p role="status">{note}</p>}
    <button className="desk-btn ghost myday-outline-toggle" aria-expanded={outline} onClick={() => setOutline(!outline)}>Edit outline {outline ? "−" : "+"}</button>
    {outline && <OutlineEditor key={current.date} day={current} busy={busy} change={change} />}
  </section>;
}
function Wins({ day }: { day: MyDayView }) {
  return <div className="myday-wins"><h3>Wins today</h3>{day.wins.length ? <ul>{day.wins.map((w, i) => <li key={`${w.taskId}:${i}`}>{w.title}</li>)}</ul> : <p>You made room for what matters. No tasks marked done yet.</p>}</div>;
}
function OutlineEditor({ day, busy, change }: { day: MyDayView; busy: boolean; change: (command: MyDayCommand) => Promise<boolean> }) {
  const [adding, setAdding] = useState(day.outline.children[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"task" | "project">("task");
  const parents: OutlineNode[] = [];
  const walk = (node: OutlineNode) => { if (!node.effort) parents.push(node); node.children.forEach(walk); };
  day.outline.children.forEach(walk);
  return <div className="myday-outline"><p>Weights are relative to siblings. Choose up to three focus projects this month.</p>
    <h3>Inbox</h3><p>File a task into an area or project to include it in the engine’s next proposal.</p>
    {day.inbox.map(node => <div key={node.id}><strong>{node.title}</strong>{node.dueDate && <small> · due {node.dueDate}</small>} {day.sources.find(s => s.taskId === node.id)?.url && <a href={day.sources.find(s => s.taskId === node.id)?.url}>Source</a>} <select aria-label={`File ${node.title}`} defaultValue="" disabled={busy} onChange={e => { if (e.target.value) void change({ op: "file", id: node.id, parent: e.target.value }); }}><option value="">File into…</option>{parents.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></div>)}
    <h3>Areas</h3>
    {day.outline.children.map(node => <OutlineRow key={node.id} node={node} day={day} busy={busy} change={change} area />)}
    <form onSubmit={e => { e.preventDefault(); void change({ op: "add", parent: adding, title, kind }).then(ok => { if (ok) setTitle(""); }); }}>
      <label>Add to<select aria-label="New task parent" value={adding} onChange={e => setAdding(e.target.value)}>{parents.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
      <select aria-label="New outline kind" value={kind} onChange={e => setKind(e.target.value === "project" ? "project" : "task")}><option value="task">Task</option><option value="project">Project</option></select>
      <input aria-label="New outline title" placeholder="A small next step…" value={title} onChange={e => setTitle(e.target.value)} required maxLength={300} /><button className="desk-btn" disabled={busy}>Add</button>
    </form>
  </div>;
}
function OutlineRow({ node, day, busy, change, area = false }: { node: OutlineNode; day: MyDayView; busy: boolean; change: (command: MyDayCommand) => Promise<boolean>; area?: boolean }) {
  const [editing, setEditing] = useState(false);
  const snapshot = () => ({ title: node.title, weight: node.weight, dueDate: node.dueDate ?? "", ...(node.focusMonth ? { focusMonth: node.focusMonth } : {}) });
  const [baseline, setBaseline] = useState(snapshot);
  const [title, setTitle] = useState(node.title);
  const [weight, setWeight] = useState(node.weight);
  const [dueDate, setDue] = useState(node.dueDate ?? "");
  const [focus, setFocus] = useState(node.focusMonth === day.date.slice(0, 7));
  const [yes, setYes] = useState(false);
  const source = day.sources.find(s => s.taskId === node.id);
  return <div className="myday-outline-row" data-outline-id={node.id}><div><strong>{node.done && node.effort ? "✓ " : ""}{node.title}</strong> <small>weight {node.weight}{node.focusMonth === day.date.slice(0, 7) ? " · focus" : ""}</small> <button className="desk-btn ghost" onClick={() => {
    if (!editing) {
      setBaseline(snapshot()); setTitle(node.title); setWeight(node.weight); setDue(node.dueDate ?? ""); setFocus(node.focusMonth === day.date.slice(0, 7)); setYes(false);
    }
    setEditing(!editing);
  }}>Edit</button>{source && (source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">Source</a> : <small>From {source.kind}: {source.key}</small>)}</div>
    {editing && <form onSubmit={e => { e.preventDefault(); void change({ op: "edit", id: node.id, title, weight, dueDate, focus, yes, before: baseline }).then(ok => { if (ok) setEditing(false); }); }}>
      {!area && <label>Title<input value={title} onChange={e => setTitle(e.target.value)} required /></label>}
      <label>Relative weight<input type="number" min="0" max="100" value={weight} onChange={e => setWeight(Number(e.target.value))} /></label>
      {!area && <label>Due<input type="date" value={dueDate} onChange={e => setDue(e.target.value)} /></label>}
      {!area && !node.effort && <label><input type="checkbox" checked={focus} onChange={e => { setFocus(e.target.checked); setYes(false); }} />Focus this month</label>}
      {focus && node.focusMonth !== day.date.slice(0, 7) && <fieldset><legend>Before you say yes</legend>{day.yesFilter.map(q => <p key={q}>{q}</p>)}<label><input type="checkbox" checked={yes} onChange={e => setYes(e.target.checked)} required />I have considered these questions and choose this focus.</label></fieldset>}
      <button className="desk-btn" disabled={busy}>Save</button>
    </form>}
    {node.children.map(child => <OutlineRow key={child.id} node={child} day={day} busy={busy} change={change} />)}
  </div>;
}
