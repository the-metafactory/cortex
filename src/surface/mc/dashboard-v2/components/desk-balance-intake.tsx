import { useState } from "react";
import { findNode, type OutlineNode } from "../../../../balance";
import type { BalanceCommand } from "../../desk/balance-command";
import type { MyDayView } from "../../desk/my-day";

import { DestinationPicker } from "./desk-destination-picker";

interface FilingIntent { task: OutlineNode; parent: string; revision: number; date: string }
export function UnfiledBalanceTasks({ day, parents, busy, change, onFiled }: {
  day: MyDayView;
  parents: { id: string; label: string }[];
  busy: boolean;
  change: (command: Extract<BalanceCommand, { op: "outline-file" }>, date: string) => Promise<{ outlineId?: string } | null>;
  onFiled: (id: string) => void;
}) {
  const [filing, setFiling] = useState<FilingIntent | null>(null);
  const sources = new Map(day.sources.map(source => [source.taskId, source]));
  const pendingMissing = filing !== null && !day.inbox.some(task => task.id === filing.task.id);
  const savedTask = filing ? findNode(day.outline, filing.task.id) : null;
  return <section className="dbl-intake" aria-label="Unfiled Balance tasks">
    <h2>Unfiled tasks <span>{day.inbox.length}</span></h2>
    <p>Source items you chose to plan. Confirm their place in the outline; filing does not add them to today's confirmed choices.</p>
    {day.inbox.length === 0 ? <p>No unfiled tasks.</p> : <ul>{day.inbox.map(task => {
      const source = sources.get(task.id);
      return <li key={task.id}><strong>{task.title}</strong><small>{source ? `From ${source.kind}` : "Saved task"}{task.dueDate ? ` · Due ${task.dueDate}` : ""}</small>
        {source?.url && <a href={source.url} target="_blank" rel="noopener noreferrer">Original source</a>}
        <button className="desk-btn" disabled={busy} onClick={() => { setFiling({ task, parent: "", revision: day.revision, date: day.date }); }}>File in outline</button>
      </li>;
    })}</ul>}
    {parents.length === 0 && day.inbox.length > 0 && <p>No configured area or open project is available for filing. Your source tasks stay here.</p>}
    {filing && <form onSubmit={event => {
      event.preventDefault();
      void change({ op: "outline-file", id: filing.task.id, parent: filing.parent, revision: filing.revision }, filing.date).then(saved => {
        if (saved?.outlineId) { setFiling(null); onFiled(saved.outlineId); }
      });
    }}>
      <h3>File {filing.task.title}</h3>
      {pendingMissing && <p role="status">The latest snapshot no longer lists this unfiled item. Your pending confirmation is kept; retry to confirm its saved location.</p>}
      <DestinationPicker label="File Balance parent" value={filing.parent} options={parents} disabled={busy} onChange={parent => { setFiling({ ...filing, parent }); }} />
      <button className="desk-btn pri" disabled={busy || !parents.some(parent => parent.id === filing.parent)}>Confirm filing</button>
      <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => { setFiling(null); }}>Close</button>
      {pendingMissing && savedTask && <button type="button" className="desk-btn ghost" disabled={busy} onClick={() => { onFiled(savedTask.id); }}>Inspect current saved task</button>}
    </form>}
  </section>;
}
