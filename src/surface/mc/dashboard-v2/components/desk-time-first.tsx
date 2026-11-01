import { useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import type { TodayItem } from "../../../../balance";
import type { MyDayView } from "../../desk/my-day";
import { currentGap, type CalendarAvailability, type CalendarGap } from "../../desk/calendar-availability";
import { nextTask, reorderVisible, savedTaskContext } from "../../desk/time-first";
import { useMyDay } from "../hooks/use-my-day";
import { balanceItemSearch } from "../hooks/use-balance-location";
import { deskSearch } from "../hooks/use-desk-studio";
import { scrollBelowDesk } from "../lib/desk-scroll";
import "./desk-time-first.css";

type DayChanges = ReturnType<typeof useMyDay>;
interface TimeFirstProps {
  day?: MyDayView;
  calendar?: CalendarAvailability;
  now: number;
  before: ReactNode;
  after: ReactNode;
  proposal: ReactNode;
  sweeps: ReactNode;
  preview: ReactNode;
  ambient: ReactNode;
  onChanged: () => void;
}
const time = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayTime = (at: number): string => new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

function gapHeading(gap: CalendarGap): string {
  switch (gap.kind) {
    case "busy": return `A calendar block is in progress until ${time(gap.until)}`;
    case "bounded": return `${gap.minutes} minutes before ${gap.event.title}`;
    case "open": return "No upcoming busy event in this calendar reading";
    case "unknown": return "Calendar availability is not fully known";
  }
}

function choiceLabel(item: TodayItem, gap: CalendarGap, manual: boolean): string {
  const prefix = manual ? "Your choice" : "Next in your day";
  if (gap.kind === "busy") return `${prefix} · A calendar block is in progress`;
  if (gap.kind === "unknown") return `${prefix} · Fit unverified`;
  if (item.task.estimateMinutes === undefined) return `${prefix} · Estimate unknown`;
  if (gap.kind === "open") return prefix;
  return item.task.estimateMinutes <= gap.minutes ? `${prefix} · Fits this gap` : `${prefix} · Needs more time`;
}

export function DeskTimeFirst(props: TimeFirstProps) {
  if (!props.day) return <div className="tf-layout"><main className="tf-main">{props.before}<p role="status">Your saved day is unavailable. Refresh the Desk to retry.</p>{props.proposal}{props.sweeps}{props.after}</main><aside className="tf-side">{props.preview}{props.ambient}</aside></div>;
  return <TimeFirstDay {...props} day={props.day} />;
}

function TimeFirstDay({ day, calendar, now, before, after, proposal, sweeps, preview, ambient, onChanged }: Omit<TimeFirstProps, "day"> & { day: MyDayView }) {
  const changes = useMyDay(day, onChanged);
  const { current, busy, change, retryable } = changes;
  const gap = currentGap(calendar ?? { sources: [], events: [] }, now);
  const recommendation = nextTask(current, gap);
  const selection = current.work.selection;
  const selected = selection.kind === "manual" ? current.items.find(item => item.task.id === selection.id) : selection.kind === "unavailable" || recommendation.kind === "none" ? undefined : recommendation.item;
  const [draft, setDraft] = useState<{ revision: number; ids: string[] } | null>(null);
  const [swap, setSwap] = useState<string | null>(null);
  const priorities = useRef<HTMLElement>(null);
  const showPriorities: MouseEventHandler<HTMLAnchorElement> = event => { event.preventDefault(); scrollBelowDesk(priorities.current); };
  const items = draft ? draft.ids.flatMap(id => { const item = current.items.find(value => value.task.id === id); return item ? [item] : []; }) : current.items;
  const choose = (id: string | null) => void change({ op: "select", id, revision: current.revision });
  const move = (id: string, direction: -1 | 1) => setDraft(value => value ? { ...value, ids: reorderVisible(value.ids, items.map(item => item.task.id), id, direction) } : value);
  const saveOrder = () => draft ? change({ op: "reorder", revision: draft.revision, ids: draft.ids }, () => setDraft(null)) : Promise.resolve(false);
  return <div className="tf-layout">
    <main className="tf-main">
      {before}
      <header className="tf-heading"><div><h1>My day</h1><p>Your overall priorities stay in their saved order.</p></div><span>{current.wins.length} done</span></header>
      {current.phase === "closed" && <DayWins day={current} />}
      <section className="tf-gap" aria-label="Calendar availability">
        <span className="tf-eyebrow">{gap.kind === "bounded" ? "Time available now" : "Today's calendar"}</span>
        <h2>{gapHeading(gap)}</h2>
        {gap.kind === "open" && <p>Read at {time(gap.asOf)} through {dayTime(gap.through)}. Showing your usual priority order.</p>}
        {gap.kind === "unknown" && <details><summary>Why the fit is unverified</summary><ul>{gap.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
      </section>
      <div className="tf-now"><time>{time(now)}</time><span>Now</span></div>
      {proposal}
      {current.phase !== "closed" && <section className="tf-current" aria-label="Selected working task">
        {selection.kind === "unavailable" ? <><h2>Your chosen task is unavailable</h2><p role="status">{selection.reason}</p><button type="button" className="desk-btn" disabled={busy} onClick={() => choose(null)}>Use recommendation</button></> : selected ? <>
          <span className="tf-eyebrow">{choiceLabel(selected, gap, selection.kind === "manual")}</span>
          <h2>{selected.task.title}</h2>
          <p>{selected.task.estimateMinutes === undefined ? "Estimate unknown" : `${selected.task.estimateMinutes} minutes`} · {selected.areaTitle}</p>
          {selection.kind === "automatic" && recommendation.kind === "fit" && <p>The first eligible task in your saved order that fits the {recommendation.minutes}-minute gap.</p>}
          {selection.kind === "automatic" && recommendation.kind === "unverified" && <p>This is the first task in your day order. Calendar coverage cannot prove that it fits now.</p>}
          <details><summary>Why this task</summary><p>{selected.trace}</p></details>
          <div className="tf-actions"><TaskActions item={selected} changes={changes} disabled={draft !== null || retryable} />{selection.kind === "manual" && <button type="button" className="desk-btn ghost" disabled={busy || retryable || draft !== null} onClick={() => choose(null)}>Use recommendation</button>}<a className="desk-btn ghost" href="#today-priorities" onClick={showPriorities}>Choose another</a></div>
        </> : <><h2>Choose what works for you</h2><p>{recommendation.kind === "none" ? recommendation.reason : "Your priorities are available alongside the timeline."}</p><a className="desk-btn" href="#today-priorities" onClick={showPriorities}>See today's priorities</a></>}
      </section>}
      <DayContract changes={changes} />
      {sweeps}
      {after}
    </main>
    <aside className="tf-side" aria-label="Priorities, task context and Catch-up">
      <section ref={priorities} className="tf-priorities" id="today-priorities" tabIndex={-1} aria-label="Today's priorities">
        <header><h2>Today's priorities</h2>{current.phase === "started" && !draft && <button type="button" className="desk-btn ghost" disabled={busy || retryable} onClick={() => setDraft({ revision: current.revision, ids: [...current.work.confirmedIds] })}>Reshuffle</button>}</header>
        <p>{draft ? "Preview order. Confirm to save it." : "Your saved order · Choose freely"}</p>
        {current.studioStatus === "unavailable" && <p role="status">Studio files are busy or unreadable. Showing the last saved outline.</p>}
        {!items.length && <p>No actionable tasks in this day. Add or reopen one in Balance.</p>}
        <ol>{items.map((item, index) => <li key={item.task.id}>
          <button type="button" className="tf-choice" aria-pressed={selected?.task.id === item.task.id} disabled={busy || retryable || draft !== null || current.phase === "closed"} onClick={() => choose(item.task.id)}><span className="tf-rank">{index + 1}</span><span><strong>{item.task.title}</strong><small>{item.areaTitle} · {item.task.estimateMinutes === undefined ? "Estimate unknown" : `${item.task.estimateMinutes} min`}{selected?.task.id === item.task.id ? " · Selected" : ""}</small></span></button>
          {draft && <div className="tf-order"><button type="button" className="desk-btn ghost" disabled={busy || retryable || index === 0} aria-label={`Move ${item.task.title} up`} onClick={() => move(item.task.id, -1)}>↑</button><button type="button" className="desk-btn ghost" disabled={busy || retryable || index === items.length - 1} aria-label={`Move ${item.task.title} down`} onClick={() => move(item.task.id, 1)}>↓</button></div>}
          {current.phase === "proposed" && <><button type="button" className="desk-btn ghost tf-swap" disabled={busy || retryable} onClick={() => setSwap(swap === item.task.id ? null : item.task.id)}>Swap</button>{swap === item.task.id && <div className="tf-alternates"><p>Choose an engine alternate</p>{current.alternates.map(alternate => <button key={alternate.task.id} type="button" className="desk-btn" disabled={busy || retryable} onClick={() => void change({ op: "draft", ids: current.items.map(value => value.task.id === item.task.id ? alternate.task.id : value.task.id) }, () => setSwap(null))}>{alternate.task.title}</button>)}{!current.alternates.length && <p>No other task is available today.</p>}</div>}</>}
        </li>)}</ol>
        {draft && <div className="tf-actions"><button type="button" className="desk-btn pri" disabled={busy || retryable} onClick={() => void saveOrder()}>Confirm reshuffle</button><button type="button" className="desk-btn ghost" disabled={busy || retryable} onClick={() => setDraft(null)}>Cancel reshuffle</button></div>}
        <p>Choosing what fits now leaves your overall priorities unchanged.</p>
        <DaySettings changes={changes} disabled={draft !== null || retryable} />
      </section>
      {preview}
      {selected && <section className="tf-context" aria-label="Selected task context"><span className="tf-eyebrow">Project / goal context</span><p>{[selected.areaTitle, ...selected.path].join(" / ")}</p><h3>{selected.task.title}</h3><p>{savedTaskContext(current.outline, selected)}</p><a className="desk-btn ghost" href={`${balanceItemSearch(typeof window === "undefined" ? "" : window.location.search, selected.task.id)}${typeof window === "undefined" ? "" : window.location.hash}`}>Open task in Balance</a></section>}
      <details className="tf-ambient"><summary>At a glance</summary><div className="desk-margin">{ambient}</div></details>
    </aside>
  </div>;
}

function TaskActions({ item, changes, disabled }: { item: TodayItem; changes: DayChanges; disabled: boolean }) {
  const { current, change, busy } = changes;
  const studio = current.studioTasks.find(task => task.id === item.task.id);
  const search = typeof window === "undefined" ? "" : window.location.search;
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  return <>{studio ? <a className="desk-btn pri" href={`${deskSearch(search, { mode: "studio", thread: studio.slug })}${hash}`}>Respond in Studio</a> : current.phase === "started" && <button type="button" className="desk-btn pri" disabled={busy || disabled} onClick={() => void change({ op: "done", id: item.task.id })}>Done</button>}<button type="button" className="desk-btn ghost" disabled={busy || disabled} onClick={() => void change({ op: "defer", id: item.task.id })}>Not today</button></>;
}

function DayContract({ changes }: { changes: DayChanges }) {
  const { current, busy, change, note, retryable, retry } = changes;
  const ids = current.items.map(item => item.task.id);
  return <section className="tf-contract" aria-label="Day confirmation">
    {current.phase === "proposed" ? <><p>Does this look like your day?</p><div className="tf-actions"><button type="button" className="desk-btn pri" disabled={busy} onClick={() => void change({ op: "start", ids })}>Start the day</button><button type="button" className="desk-btn" disabled={busy || !ids.length} onClick={() => void change({ op: "draft", ids: ids.slice(0, 1) })}>Just one thing</button><button type="button" className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "propose" })}>Refresh proposal</button></div></> : current.phase === "started" && <><DayWins day={current} /><button type="button" className="desk-btn" disabled={busy} onClick={() => void change({ op: "close" })}>Done for today</button></>}
    {current.undos.map(undo => <p key={undo.receipt}>{undo.title} is set aside. <button type="button" className="desk-btn" disabled={busy} onClick={() => void change({ op: "undo", receipt: undo.receipt })}>Undo</button></p>)}
    {note && <p role="status">{note}</p>}{retryable && <button type="button" className="desk-btn" disabled={busy} onClick={() => void retry()}>Retry saved change</button>}
  </section>;
}

function DayWins({ day }: { day: MyDayView }) {
  return <section className="tf-wins"><h2>Wins today</h2>{day.wins.length ? <ul>{day.wins.map((win, index) => <li key={`${win.taskId}:${index}`}>{win.title}</li>)}</ul> : <p>You made room for what matters. No tasks marked done yet.</p>}</section>;
}

function DaySettings({ changes, disabled }: { changes: DayChanges; disabled: boolean }) {
  const { current, busy, change } = changes;
  return <details className="tf-settings"><summary>Day limits</summary><label>My day <input aria-label="My day cap" type="range" min="1" max="7" value={current.cap} disabled={busy || disabled} onChange={event => void change({ op: "cap", cap: Number(event.target.value) })} /><output>{current.cap}</output></label><label>Needs you <input aria-label="Needs you cap" type="range" min="1" max="10" value={current.topN} disabled={busy || disabled} onChange={event => void change({ op: "topN", topN: Number(event.target.value) })} /><output>{current.topN}</output></label><p>{current.capsOverridden ? "Your saved caps apply until Reset." : "Using your defaults."} Defaults: {current.configuredCaps.cap} My day / {current.configuredCaps.topN} Needs you.</p>{current.capsOverridden && <button type="button" className="desk-btn ghost" disabled={busy || disabled} onClick={() => void change({ op: "reset-caps" })}>Reset</button>}</details>;
}
