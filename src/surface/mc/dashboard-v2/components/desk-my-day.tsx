import { useRef, useState } from "react";
import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { deskSearch } from "../hooks/use-desk-studio";
import { balanceSearch } from "../hooks/use-balance-location";
import { postJson } from "../lib/api";
import "./desk-my-day.css";

export async function submitMyDay(date: string, command: MyDayCommand, requestId: string = crypto.randomUUID()): Promise<{ view: MyDayView; undo?: string; notice?: string; outlineId?: string }> {
  return postJson("/api/desk/my-day", { date, command, requestId });
}
export function MyDayLane({ day, onChanged }: { day: MyDayView; onChanged: () => void }) {
  const [local, setLocal] = useState<MyDayView | null>(null);
  const current = local?.date === day.date && local.revision > day.revision ? local : day;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
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
    {current.studioStatus === "unavailable" && <p role="status">Studio files are busy or unreadable. Showing the last saved outline; refresh when they are ready.</p>}
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
          {current.studioTasks.find(t => t.id === item.task.id) ? <a className="desk-btn pri" href={studioHref(current.studioTasks.find(t => t.id === item.task.id)?.slug ?? "")}>Respond in Studio</a> : current.phase === "started" && <button className="desk-btn pri" disabled={busy} onClick={() => void change({ op: "done", id: item.task.id })}>Done</button>}
          <button className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "defer", id: item.task.id })}>→ not today</button>
          {current.phase === "proposed" && <button className="desk-btn ghost" onClick={() => setSwap(swap === item.task.id ? null : item.task.id)}>Swap</button>}
        </div>
        {swap === item.task.id && current.phase === "proposed" && <div className="myday-alternates"><p>Choose an engine alternate</p>{current.alternates.map(a => <button className="desk-btn" key={a.task.id} disabled={busy} onClick={() => { void change({ op: "draft", ids: ids.map(id => id === item.task.id ? a.task.id : id) }); setSwap(null); }}>{a.task.title}</button>)}{current.alternates.length === 0 && <p>No other task is available today.</p>}</div>}
      </li>)}</ol>
      {current.phase === "proposed" ? <div className="myday-contract"><p>Does this look like your day?</p><button className="desk-btn pri" disabled={busy} onClick={() => void change({ op: "start", ids })}>Start the day</button> <button className="desk-btn" disabled={busy || ids.length === 0} onClick={() => void change({ op: "draft", ids: ids.slice(0, 1) })}>Just one thing</button> <button className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "propose" })}>Refresh proposal</button></div> : <><Wins day={current} /><button className="desk-btn" disabled={busy} onClick={() => void change({ op: "close" })}>Done for today</button></>}
    </>}
    {current.undos.map(u => <div className="myday-undo" key={u.receipt}>{u.title} is set aside. <button className="desk-btn" disabled={busy} onClick={() => void change({ op: "undo", receipt: u.receipt })}>Undo</button></div>)}
    {note && <p role="status">{note}</p>}
    <a className="desk-btn ghost myday-outline-toggle" href={`${balanceSearch(typeof window === "undefined" ? "" : window.location.search, { tab: "plan", item: null, area: "", query: "" })}${typeof window === "undefined" ? "" : window.location.hash}`}>Edit outline in Balance →</a>
  </section>;
}
function Wins({ day }: { day: MyDayView }) {
  return <div className="myday-wins"><h3>Wins today</h3>{day.wins.length ? <ul>{day.wins.map((w, i) => <li key={`${w.taskId}:${i}`}>{w.title}</li>)}</ul> : <p>You made room for what matters. No tasks marked done yet.</p>}</div>;
}

function studioHref(slug: string): string {
  const location = typeof window === "undefined" ? null : window.location;
  return `${deskSearch(location?.search ?? "", { mode: "studio", thread: slug })}${location?.hash ?? ""}`;
}
