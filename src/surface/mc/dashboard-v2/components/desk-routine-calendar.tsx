import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RoutineInventory } from "../../desk/routine-editor-contract";
import type { RoutinesLocation } from "../hooks/use-routines-location";
import { calendarDays, moveCalendar, readCalendar, zonedDate, type CalendarOccurrence, type CalendarRead } from "../lib/routine-calendar";

const dateLabel = (date: string, options: Intl.DateTimeFormatOptions): string => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
const timeLabel = (at: string, timezone: string): string => new Date(at).toLocaleTimeString(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const failed = (error: unknown): string => error instanceof Error ? error.message : "The routine owner could not confirm the calendar.";
type CalendarState = { key: string } & ({ kind: "loading" } | { kind: "error"; message: string } | ({ kind: "ready" } & CalendarRead));

const emptyOccurrences: CalendarOccurrence[] = [];

type CellRenderer = (day: string, hour: number | null, limit: number) => ReactNode;
function MonthGrid({ days, month, cell, onDay }: { days: string[]; month: string; cell: CellRenderer; onDay: (day: string) => void }) {
  return <div className="routine-month-grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div className="routine-month-heading" key={day}>{day}</div>)}{days.map((day) => <div className={`routine-month-day ${day.slice(0, 7) !== month ? "routine-outside" : ""}`} key={day}><button type="button" className="routine-day-label" onClick={() => { onDay(day); }} aria-label={`Open ${day} in Day view`}>{Number(day.slice(-2))}</button>{cell(day, null, 1)}</div>)}</div>;
}
function TimeGrid({ days, single, cell, onDay }: { days: string[]; single: boolean; cell: CellRenderer; onDay: (day: string) => void }) {
  return <div className={`routine-time-grid ${single ? "routine-one-day" : ""}`}><div className="routine-time-corner" />{days.map((day) => <div className="routine-time-heading" key={day}><button type="button" className="routine-day-label" onClick={() => { onDay(day); }}>{dateLabel(day, { weekday: "short", day: "numeric" })}</button></div>)}{Array.from({ length: 24 }, (_, hour) => <div className="routine-time-row" key={hour}><time className="routine-hour">{String(hour).padStart(2, "0")}:00</time>{days.map((day) => <div className="routine-hour-cell" key={day}>{cell(day, hour, 1)}</div>)}</div>)}</div>;
}

export function DeskRoutineCalendar({ location, onLocation, inventory, revision, onSelect }: { location: RoutinesLocation; onLocation: (location: RoutinesLocation) => void; inventory: RoutineInventory | null; revision: number; onSelect: (id: string) => void }) {
  const days = useMemo(() => calendarDays(location.date, location.view), [location.date, location.view]);
  const [snapshot, setState] = useState<CalendarState>({ key: "", kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [drill, setDrill] = useState<{ date: string; hour: number | null; page: number } | null>(null);
  const drillRef = useRef<HTMLElement>(null);
  const drillOrigin = useRef<HTMLButtonElement>(null);
  const queryKey = JSON.stringify([days, location.timezone, revision, retry]);
  const state: CalendarState = snapshot.key === queryKey ? snapshot : { key: queryKey, kind: "loading" };
  useEffect(() => {
    const controller = new AbortController(); setState({ key: queryKey, kind: "loading" }); setDrill(null);
    void readCalendar({ days, timezone: location.timezone, signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setState({ key: queryKey, kind: "ready", ...result }); }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ key: queryKey, kind: "error", message: failed(error) }); });
    return () => { controller.abort(); };
  }, [days, location.timezone, revision, retry, queryKey]);
  useEffect(() => { if (drill) drillRef.current?.focus(); }, [drill?.date, drill?.hour]);
  const names = useMemo(() => new Map(inventory?.map((r) => [r.id, r.name ?? r.id])), [inventory]);
  const all = state.kind === "ready" ? state.occurrences : emptyOccurrences;
  const visible = useMemo(() => all.filter((r) => (location.showPaused || r.lifecycle === "active" || r.lifecycle === "unconfirmed") && (location.policy === "all" || r.handlingPolicy === location.policy)), [all, location.showPaused, location.policy]);
  const { grouped, hourly, activeCount, inactiveCount, unconfirmedCount } = useMemo(() => {
    const grouped = new Map<string, CalendarOccurrence[]>(); const hourly = new Map<string, CalendarOccurrence[]>(); let activeCount = 0;
    const dayFormatter = new Intl.DateTimeFormat("en", { timeZone: location.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const hourFormatter = new Intl.DateTimeFormat("en", { timeZone: location.timezone, hour: "2-digit", hourCycle: "h23" });
    for (const entry of visible) {
      const at = new Date(entry.scheduledFor); const parts = dayFormatter.formatToParts(at);
      const day = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)?.value ?? "").join("-");
      const list = grouped.get(day) ?? []; list.push(entry); grouped.set(day, list);
      const key = `${day}/${Number(hourFormatter.format(at))}`; const hour = hourly.get(key) ?? []; hour.push(entry); hourly.set(key, hour);
      if (entry.lifecycle === "active") activeCount++;
    }
    return { grouped, hourly, activeCount, inactiveCount: visible.filter((entry) => entry.lifecycle === "paused" || entry.lifecycle === "disabled").length, unconfirmedCount: visible.filter((entry) => entry.lifecycle === "unconfirmed").length };
  }, [visible, location.timezone]);
  const change = (next: Partial<RoutinesLocation>): void => { onLocation({ ...location, ...next }); };
  const renderOccurrence = (entry: CalendarOccurrence) => <button type="button" className={`routine-occurrence ${entry.lifecycle !== "active" ? "routine-inactive" : ""}`} key={`${entry.routineId}:${entry.scheduledFor}`} onClick={() => { onSelect(entry.routineId); }} title={`${names.get(entry.routineId) ?? entry.routineId} · ${entry.sourceTimezone} · ${entry.lifecycle} · ${entry.handlingPolicy ?? "Handling policy unknown"}`}>
    <time dateTime={entry.scheduledFor}>{timeLabel(entry.scheduledFor, location.timezone)}</time><span>{names.get(entry.routineId) ?? entry.routineId}</span><small className="routine-source-zone">{entry.sourceTimezone}</small>{entry.lifecycle !== "active" && <small>{entry.lifecycle === "unconfirmed" ? "Scheduling state unconfirmed" : entry.lifecycle === "paused" ? "Paused" : "Disabled"}</small>}
  </button>;
  const cell = (day: string, hour: number | null, limit: number) => {
    const list = (hour === null ? grouped.get(day) : hourly.get(`${day}/${hour}`)) ?? [];
    return <>{list.slice(0, limit).map(renderOccurrence)}{list.length > limit && <button className="routine-more" type="button" onClick={(event) => { drillOrigin.current = event.currentTarget; setDrill({ date: day, hour, page: 0 }); }}>+{list.length - limit} more<span className="routine-sr"> planned occurrences on {day}{hour === null ? "" : ` at hour ${hour}`}</span></button>}</>;
  };
  const drillEntries = drill ? ((drill.hour === null ? grouped.get(drill.date) : hourly.get(`${drill.date}/${drill.hour}`)) ?? []) : [];
  const first = days[0] ?? location.date; const last = days.at(-1) ?? location.date;
  const title = location.view === "month" ? dateLabel(location.date, { month: "long", year: "numeric" }) : location.view === "day" ? dateLabel(location.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : `${dateLabel(first, { day: "numeric", month: "short" })} – ${dateLabel(last, { day: "numeric", month: "short", year: "numeric" })}`;
  return <section aria-label="Routine schedule" className="routine-schedule">
    <div className="routine-calendar-toolbar"><div className="desk-acts"><button className="desk-btn" type="button" aria-label="Previous period" onClick={() => { change({ date: moveCalendar(location.date, location.view, -1) }); }}>‹</button><button className="desk-btn" type="button" aria-label="Next period" onClick={() => { change({ date: moveCalendar(location.date, location.view, 1) }); }}>›</button><h2>{title}</h2><button className="desk-btn" type="button" onClick={() => { change({ date: zonedDate(Date.now(), location.timezone) }); }}>Today</button></div>
      <div className="desk-acts"><label>Display timezone <select aria-label="Display timezone" value={location.timezone} onChange={(event) => { change({ timezone: event.target.value }); }}>{[...new Set([location.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, ...(inventory?.flatMap((r) => r.timezone ? [r.timezone] : []) ?? [])])].sort().map((zone) => <option key={zone}>{zone}</option>)}</select></label><div role="group" aria-label="Calendar range">{(["day", "week", "month"] as const).map((view) => <button className="routine-range-button" type="button" key={view} aria-pressed={location.view === view} onClick={() => { change({ view }); }}>{view[0]?.toUpperCase()}{view.slice(1)}</button>)}</div></div>
    </div>
    <div className="routine-calendar-filters"><label>Handling policy <select value={location.policy} onChange={(event) => { const policy = event.target.value; if (policy === "all" || policy === "approval" || policy === "auto") change({ policy }); }}><option value="all">All routines</option><option value="approval">Approval required</option><option value="auto">Automatic</option></select></label><label><input type="checkbox" checked={location.showPaused} onChange={(event) => { change({ showPaused: event.target.checked }); }} /> Show paused or disabled</label><span className="soft">Select an occurrence to open its routine workspace.</span></div>
    <p className="routine-calendar-meaning">Planned triggers, not execution results. Times shown in {location.timezone}; each routine retains its source timezone.</p>
    {state.kind === "loading" && <p role="status">Reading scheduled occurrences from the configured owner…</p>}
    {state.kind === "error" && <div role="alert"><p>{state.message} The calendar is unavailable.</p><button type="button" className="desk-btn" onClick={() => { setRetry((n) => n + 1); }}>Retry calendar</button></div>}
    {state.kind === "ready" && <><p role="status">{state.complete ? `${activeCount} active planned occurrences` : `At least ${activeCount} active planned occurrences`}{inactiveCount > 0 ? ` · ${inactiveCount} paused or disabled` : ""}{unconfirmedCount > 0 ? ` · ${unconfirmedCount} scheduling state unconfirmed` : ""}{location.policy !== "all" ? " in this filter" : ""}. Counts cover the visible calendar window.</p>{!state.complete && <p role="alert">This dense window reached the read limit. Counts and days are incomplete. Choose Day or a narrower window to inspect more.</p>}{visible.length === 0 && <p>No scheduled occurrences were returned for this window and these filters.</p>}
      <div className="routine-calendar-scroll" tabIndex={0} aria-label={`${location.view} calendar, scroll horizontally on a narrow screen`}>
        {location.view === "month" ? <MonthGrid days={days} month={location.date.slice(0, 7)} cell={cell} onDay={(date) => { change({ date, view: "day" }); }} /> : <TimeGrid days={days} single={location.view === "day"} cell={cell} onDay={(date) => { change({ date, view: "day" }); }} />}
      </div>
      {drill && <section className="routine-calendar-drill desk-set-card" aria-label="Scheduled occurrence details" tabIndex={-1} ref={drillRef}><div className="routine-calendar-toolbar"><h3>{dateLabel(drill.date, { weekday: "long", month: "long", day: "numeric" })}{drill.hour === null ? "" : ` · ${String(drill.hour).padStart(2, "0")}:00`}</h3><button className="desk-btn" type="button" onClick={() => { setDrill(null); drillOrigin.current?.focus(); }}>Close occurrence details</button></div><p>{drillEntries.length} planned occurrences{state.complete ? "." : " in the incomplete result."}</p><div className="routine-drill-list">{drillEntries.slice(drill.page * 30, (drill.page + 1) * 30).map(renderOccurrence)}</div><div className="desk-acts"><button className="desk-btn" type="button" disabled={drill.page === 0} onClick={() => { setDrill({ ...drill, page: drill.page - 1 }); }}>Previous occurrences</button><span>Page {drill.page + 1} of {Math.max(1, Math.ceil(drillEntries.length / 30))}</span><button className="desk-btn" type="button" disabled={(drill.page + 1) * 30 >= drillEntries.length} onClick={() => { setDrill({ ...drill, page: drill.page + 1 }); }}>Next occurrences</button></div></section>}
    </>}
  </section>;
}
