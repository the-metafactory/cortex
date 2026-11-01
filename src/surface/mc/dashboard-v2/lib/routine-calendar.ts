import { RoutineOccurrencePageSchema, type RoutineOccurrencePage } from "../../desk/routine-occurrence-contract";
import type { CalendarView } from "../hooks/use-routines-location";
import { getJson } from "./api";

export type CalendarOccurrence = RoutineOccurrencePage["occurrences"][number];
const dayMs = 86400000;
export const addCalendarDays = (date: string, amount: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + amount * dayMs).toISOString().slice(0, 10);
export function zonedDate(at: number | string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)?.value ?? "").join("-");
}
export function calendarDayStart(date: string, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const key = (at: number): string => {
    const parts = formatter.formatToParts(new Date(at));
    return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)?.value ?? "").join("-");
  };
  const noon = Date.parse(`${date}T12:00:00Z`);
  let lo = noon - 2 * dayMs; let hi = noon + 2 * dayMs;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (key(mid) < date) lo = mid + 1; else hi = mid; }
  return lo;
}
export function calendarDays(date: string, view: CalendarView): string[] {
  let start = date; let count = 1;
  if (view !== "day") {
    start = view === "month" ? `${date.slice(0, 7)}-01` : date;
    const weekday = new Date(`${start}T12:00:00Z`).getUTCDay();
    start = addCalendarDays(start, -((weekday + 6) % 7)); count = view === "month" ? 42 : 7;
  }
  return Array.from({ length: count }, (_, i) => addCalendarDays(start, i));
}
export function moveCalendar(date: string, view: CalendarView, direction: number): string {
  if (view !== "month") return addCalendarDays(date, direction * (view === "week" ? 7 : 1));
  const d = new Date(`${date.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + direction); return d.toISOString().slice(0, 10);
}
export function calendarWindows(days: string[], timezone: string): { start: string; end: string }[] {
  const windows = [];
  for (let i = 0; i < days.length; i += 21) {
    const first = days[i]; const last = days[Math.min(i + 20, days.length - 1)];
    if (!first || !last) continue;
    const start = calendarDayStart(first, timezone); const end = calendarDayStart(addCalendarDays(last, 1), timezone);
    if (end <= start) throw new Error("This calendar date does not occur in the selected timezone.");
    windows.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return windows;
}
export interface CalendarRead { occurrences: CalendarOccurrence[]; complete: boolean }
export async function readCalendar(options: { days: string[]; timezone: string; signal: AbortSignal; read?: typeof getJson }): Promise<CalendarRead> {
  const occurrences: CalendarOccurrence[] = []; const seen = new Set<string>();
  let scope: string | null = null;
  for (const window of calendarWindows(options.days, options.timezone)) {
    let cursor: string | null = null; const cursors = new Set<string>(); let complete = false;
    for (let pageNumber = 0; pageNumber < 20 && occurrences.length < 20000; pageNumber++) {
      const query = new URLSearchParams({ ...window, timezone: options.timezone, limit: "1000", ...(cursor ? { cursor } : {}) });
      const page = RoutineOccurrencePageSchema.parse(await (options.read ?? getJson)(`/api/desk/routine-occurrences?${query}`, { signal: options.signal }));
      const pageScope = JSON.stringify([page.owner, page.principal, page.stack]);
      if ((scope !== null && scope !== pageScope) || page.start !== window.start || page.end !== window.end || page.timezone !== options.timezone || page.complete !== (page.nextCursor === null) || (!page.complete && !page.occurrences.length)) throw new Error("The routine owner returned inconsistent calendar pages. Refresh the calendar.");
      scope = pageScope;
      for (const occurrence of page.occurrences) {
        const at = Date.parse(occurrence.scheduledFor); const key = `${occurrence.routineId}\0${occurrence.scheduledFor}`;
        if (at < Date.parse(window.start) || at >= Date.parse(window.end) || seen.has(key)) throw new Error("The routine owner returned overlapping calendar pages. Refresh the calendar.");
        seen.add(key); occurrences.push(occurrence);
      }
      if (page.complete) { complete = true; break; }
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("The routine owner repeated a calendar cursor. Refresh the calendar.");
      cursor = page.nextCursor; cursors.add(cursor);
    }
    if (!complete) return { occurrences, complete: false };
  }
  return { occurrences, complete: true };
}
