import type { DeskCalendar } from "./calendars";
import { calendarKey, calendarSetting } from "./calendars";
import type { SourceReading, DeskSourceConfig } from "./sources/command";
import type { EventAvailability } from "./calendar-contract";

export type CalendarSourceState =
  | { id: string; kind: "attention" }
  | { id: string; kind: "unknown"; reason: string }
  | { id: string; kind: "calendar"; from: number; to: number; readAt: number; calendars: string[]; provenance: string };
export interface CalendarInterval {
  key: string;
  source: string;
  calendar: string;
  calendarId: string;
  title: string;
  at: number;
  end?: number;
  availability: EventAvailability;
}
export interface CalendarAvailability {
  sources: CalendarSourceState[];
  events: CalendarInterval[];
}

export function calendarAvailability(args: { sources: DeskSourceConfig[]; readings: SourceReading[]; calendars: DeskCalendar[]; now: number }): CalendarAvailability {
  const settings = new Map(args.calendars.map(calendar => [calendarKey(calendar.source, calendar.name, calendar.calendarId), calendar]));
  const sources = args.sources.map((source): CalendarSourceState => {
    const reading = args.readings.find(value => value.id === source.id);
    const unknown = (reason: string): CalendarSourceState => ({ id: source.id, kind: "unknown", reason });
    if (!reading) return unknown("Calendar coverage has not been read.");
    if (reading.error) return unknown("The source could not be read.");
    if (args.now - reading.readAt >= source.everySeconds * 1000) return unknown("The source reading is stale; a refresh is pending.");
    if (!reading.capabilities) return unknown("This source does not declare its calendar capability.");
    if (reading.problems.length > 0) return unknown("The source output could not be read completely.");
    if (!reading.capabilities.includes("calendar")) return { id: source.id, kind: "attention" };
    const coverage = reading.calendarCoverage;
    if (!coverage) return unknown("This calendar reader does not report a coverage window.");
    if (coverage.status !== "complete" || reading.dropped > 0 || reading.problems.length > 0) return unknown("The calendar reading is incomplete.");
    if (reading.events.some(event => !event.calendarId || !coverage.calendars.some(calendar => calendar.id === event.calendarId && calendar.name === event.calendar))) return unknown("An event is outside the declared calendar coverage.");
    return { id: source.id, kind: "calendar", from: Date.parse(coverage.from), to: Date.parse(coverage.to), readAt: reading.readAt, calendars: coverage.calendars.filter(calendar => calendarSetting(settings, { sourceId: source.id, calendar: calendar.name, calendarId: calendar.id })?.enabled !== false).map(calendar => calendar.id), provenance: coverage.provenance };
  });
  const events = args.readings.flatMap(reading => reading.events.flatMap((event): CalendarInterval[] => {
    const calendar = event.calendar ?? reading.id;
    if (calendarSetting(settings, { sourceId: reading.id, calendar, calendarId: event.calendarId })?.enabled === false) return [];
    return [{ key: `cal:${reading.id}:${event.id}`, source: reading.id, calendar, calendarId: event.calendarId ?? calendar, title: event.title, at: Date.parse(event.start), ...(event.end ? { end: Date.parse(event.end) } : {}), availability: event.availability ?? { status: "unknown", provenance: "The reader did not report availability." } }];
  }));
  return { sources, events };
}

export type CalendarGap =
  | { kind: "busy"; until: number; event: CalendarInterval }
  | { kind: "unknown"; reasons: string[] }
  | { kind: "bounded"; until: number; minutes: number; event: CalendarInterval }
  | { kind: "open"; through: number; asOf: number };

export function currentGap(calendar: CalendarAvailability, now: number): CalendarGap {
  const qualified = new Map(calendar.sources.flatMap(source => source.kind === "calendar" && source.from <= now && source.to > now ? [[source.id, source]] : []));
  const busy = calendar.events.filter(event => qualified.get(event.source)?.calendars.includes(event.calendarId) && event.availability.status === "busy" && event.end !== undefined && event.end > now && event.end > event.at);
  const ordered = busy.sort((a, b) => a.at - b.at);
  const current = ordered.find(event => event.at <= now);
  if (current?.end !== undefined) {
    let until = current.end;
    for (const event of ordered) if (event.at <= until && event.end !== undefined) until = Math.max(until, event.end);
    return { kind: "busy", until, event: current };
  }
  const next = busy.filter(event => event.at > now).sort((a, b) => a.at - b.at)[0];
  const until = next?.at;
  const reasons = calendar.sources.flatMap(source => {
    if (source.kind === "attention") return [];
    if (source.kind === "unknown") return [`${source.id}: ${source.reason}`];
    return source.from > now || source.to <= now || (until !== undefined && source.to < until) ? [`${source.id}: the reading does not cover the requested interval.`] : [];
  });
  if (!calendar.sources.some(source => source.kind === "calendar")) reasons.push("No qualified calendar coverage is available.");
  const uncertain = calendar.events.some(event => {
    if (event.availability.status === "free" || (event.end !== undefined && event.end <= now)) return false;
    if (until !== undefined && event.at >= until) return false;
    return event.availability.status === "unknown" || event.end === undefined || event.end <= event.at;
  });
  if (uncertain) reasons.push("A visible event has unknown availability or an incomplete interval.");
  if (reasons.length) return { kind: "unknown", reasons };
  const through = Math.min(...calendar.sources.flatMap(source => source.kind === "calendar" ? [source.to] : []));
  const asOf = Math.min(...calendar.sources.flatMap(source => source.kind === "calendar" ? [source.readAt] : []));
  return next ? { kind: "bounded", until: next.at, minutes: Math.floor((next.at - now) / 60_000), event: next } : { kind: "open", through, asOf };
}
