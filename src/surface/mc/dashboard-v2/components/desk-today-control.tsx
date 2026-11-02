import { useState } from "react";
import type { OutlineNode } from "../../../../balance";
import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";

export function TodayControl({ node, day, busy, change }: { node: OutlineNode; day: MyDayView; busy: boolean; change: (command: MyDayCommand) => Promise<unknown> }) {
  const [swapping, setSwapping] = useState(false);
  if (node.children.length > 0 || node.done) return null;
  if (day.phase === "closed") return <p className="dbl-help">Today is closed. This task stays in Balance.</p>;
  if (day.items.some(item => item.task.id === node.id)) return <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => void change({ op: "today-remove", id: node.id, revision: day.revision })}>Remove from today</button>;
  const count = day.phase === "started" ? day.work.confirmedIds.length : day.items.length;
  const full = count >= day.cap;
  const add = (replace: string | null): void => { void change({ op: "today-add", id: node.id, revision: day.revision, replace }).then(() => { setSwapping(false); }); };
  return <>
    <button type="button" className="desk-btn ghost" aria-expanded={full ? swapping : undefined} disabled={busy} onClick={() => { if (full) setSwapping(!swapping); else add(null); }}>Add to today</button>
    {full && swapping && <div className="tf-alternates" role="group" aria-label="Choose a task to move out of today"><p>Today is full ({count} of {day.cap}). Choose a task to move out.</p>{day.items.filter(item => !item.task.done).map(item => <button key={item.task.id} type="button" className="desk-btn" disabled={busy} onClick={() => { add(item.task.id); }}>{item.task.title}</button>)}{!day.items.some(item => !item.task.done) && <p>No open task can move out today.</p>}</div>}
  </>;
}
