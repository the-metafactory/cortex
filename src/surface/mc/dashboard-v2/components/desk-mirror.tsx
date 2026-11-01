import type { WeeklyMirror, MirrorThread } from "../../desk/mirror";
import type { DeskArea } from "../../desk/types";
import { foregroundForWeek, type ForegroundReading } from "../lib/studio-foreground";
import "./desk-mirror.css";

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const when = (at: number): string => new Date(at).toLocaleString();

export function DeskMirror({ mirror, areas, foreground, onThread }: { mirror: WeeklyMirror; areas: DeskArea[]; foreground: ForegroundReading; onThread: (slug: string) => void }) {
  const areaLabel = (id: string | null): string => areas.find(a => a.id === id)?.label ?? (id ? "Unavailable area" : "Unassigned");
  const minutes = foregroundForWeek(foreground, mirror.week);
  return (
    <main className="dmr" aria-label="Weekly mirror">
      <header className="dmr-header">
        <p className="dmr-eyebrow">A little perspective</p>
        <h1>Your weekly mirror</h1>
        <p>{mirror.week.from} – {mirror.week.through} · So far this week · {mirror.week.timeZone}</p>
        <p className="dmr-quiet">A snapshot from {when(mirror.generatedAt)}. Refresh the Desk to update its sources.</p>
      </header>
      <section className="dmr-card dmr-wins" aria-labelledby="dmr-wins">
        <h2 id="dmr-wins">Wins first</h2>
        {mirror.balance === null ? <p>Your completion ledger is unavailable.</p>
          : mirror.balance.wins.length === 0 ? <p>No wins are recorded for this week yet. That is a gap in this record, not a judgment about your week.</p>
            : <ul>{mirror.balance.wins.map((win, index) => <li key={`${win.date}:${index}`}><strong>{win.title}</strong><span>{win.areaTitle} · {win.date}</span></li>)}</ul>}
      </section>
      <div className="dmr-columns">
        <section className="dmr-card" aria-labelledby="dmr-intention">
          <h2 id="dmr-intention">Attention against intention</h2>
          <p className="dmr-quiet">Recorded completion effort, compared with your current area targets. Effort credits are not hours.</p>
          {mirror.balance === null ? <p>The effort ledger is unavailable.</p> : mirror.balance.areas.length === 0 ? <p>No active area targets are configured.</p> : (
            <div className="dmr-table" role="table" aria-label="Recorded effort by area">
              <div className="dmr-row dmr-labels" role="row"><span role="columnheader">Area</span><span role="columnheader">Intended</span><span role="columnheader">Recorded</span></div>
              {mirror.balance.areas.map(area => <div className="dmr-row" role="row" key={area.areaId}><strong role="cell">{area.areaTitle}</strong><span role="cell">{percent(area.targetShare)}</span><span role="cell">{mirror.recordedEffort > 0 ? percent(area.actualShare) : "Unknown"}</span></div>)}
            </div>
          )}
          {(mirror.unallocatedEffortShare ?? 0) > 0 && <p>{percent(mirror.unallocatedEffortShare ?? 0)} of recorded effort belongs to paused or unavailable areas.</p>}
          <p className="dmr-reassurance">No judgment: the scheduler is already correcting.</p>
        </section>
        <section className="dmr-card" aria-labelledby="dmr-studio-time">
          <h2 id="dmr-studio-time">Room for thinking</h2>
          <p className="dmr-stat">{minutes === null ? "Unavailable" : `${(minutes / 60_000).toFixed(1)} min`}<span>Measured foreground Studio time in this browser</span></p>
          {foreground.kind === "recorded"
            ? <p className="dmr-quiet">Measurement began {when(foreground.measurement.startedAt)}. Only visible, focused Studio time is measured. Earlier time, long sampling gaps and other browsers are unavailable. Last saved {when(foreground.measurement.updatedAt)}.</p>
            : <p className="dmr-quiet">{foreground.reason} Measurement begins when you use Studio here; earlier time is unavailable.</p>}
          <p><strong>{mirror.studioEffortShare === null ? "Unknown" : percent(mirror.studioEffortShare)}</strong> of recorded effort came from Studio response completions.</p>
          <p className="dmr-quiet">An elapsed-time share is unavailable: total work time is not measured. No content or keystrokes are recorded.</p>
        </section>
      </div>
      <section className="dmr-card" aria-labelledby="dmr-meetings">
        <h2 id="dmr-meetings">Time in meetings</h2>
        <p className="dmr-quiet">Elapsed reported calendar intervals this week, merged where they overlap within an area. This is a partial source snapshot, not complete meeting history or proof of attendance.</p>
        {!mirror.calendar.available ? <p>Calendar evidence is unavailable. Missing history is not zero hours.</p>
          : mirror.calendar.areas.length === 0 ? <p>No elapsed meeting intervals appear in the available snapshot. Earlier-week coverage is unknown.</p>
            : <ul className="dmr-hours">{mirror.calendar.areas.map(area => <li key={area.id ?? "unassigned"}><strong>{areaLabel(area.id)}</strong><span>{area.hours.toFixed(1)} h reported</span></li>)}</ul>}
        {mirror.calendar.sources.map(source => <p className="dmr-quiet" key={source.id}>{source.id}: {source.status}{source.readAt === null ? "" : `, read ${when(source.readAt)}`}{source.problems ? `; ${source.problems} source problems` : ""}.</p>)}
        {(mirror.calendar.withoutDuration > 0 || mirror.calendar.allDay > 0) && <p className="dmr-quiet">Not counted as meeting hours: {mirror.calendar.withoutDuration} events without a valid duration; {mirror.calendar.allDay} all-day entries.</p>}
      </section>
      {mirror.dmarc && <section className="dmr-card" aria-labelledby="dmr-dmarc">
        <h2 id="dmr-dmarc">Mail sent as your domains</h2>
        <p>{mirror.dmarc.line}</p>
        {mirror.dmarc.domains.length > 0 && <ul className="dmr-hours">{mirror.dmarc.domains.map(d => <li key={d.domain}><strong>{d.domain}</strong><span>{d.owned ? `${d.messages} messages, ${d.failures} failing` : `${d.reports} reports, not your domain`}</span></li>)}</ul>}
        {mirror.dmarc.refused.map((r, index) => <p className="dmr-quiet" key={`${r.subject}:${index}`}>Not read: {r.subject}. {r.reason}</p>)}
      </section>}
      <section className="dmr-card" aria-labelledby="dmr-threads">
        <h2 id="dmr-threads">What moved in Studio</h2>
        {!mirror.threads.available ? <p>The Studio source is unavailable.</p> : <>
          {mirror.threads.partial && <p role="status">Some Studio files could not be read. These outcomes are a partial snapshot.</p>}
          <div className="dmr-columns">
            <ThreadGroup title="Opened this week" items={mirror.threads.opened} onThread={onThread} />
            <ThreadGroup title="Parked this week" items={mirror.threads.parked} onThread={onThread} />
            <ThreadGroup title="Closed this week" items={mirror.threads.closed} onThread={onThread} outcome />
            <ThreadGroup title="Decisions to review" items={mirror.threads.reviews} onThread={onThread} outcome review />
          </div>
        </>}
      </section>
    </main>
  );
}
function ThreadGroup({ title, items, onThread, outcome = false, review = false }: { title: string; items: MirrorThread[]; onThread: (slug: string) => void; outcome?: boolean; review?: boolean }) {
  return <div><h3>{title} <span className="dmr-quiet">{items.length}</span></h3>{items.length === 0 ? <p className="dmr-quiet">None recorded.</p> : <ul>{items.map(item => <li key={item.slug}><button type="button" className="dst-link" onClick={() => onThread(item.slug)}>{item.question}</button>{outcome && <span>{item.outcome}{item.outcomeText ? `: ${item.outcomeText}` : ""}{item.expect ? `. Expected: ${item.expect}` : ""}{review && item.reviewOn ? `. Review on ${item.reviewOn}` : ""}</span>}</li>)}</ul>}</div>;
}
