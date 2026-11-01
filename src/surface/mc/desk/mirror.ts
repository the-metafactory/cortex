import type { AppState } from "../../../balance";
import { completionReview, type CompletionReview } from "../../../balance";
import { localDay } from "./my-day";
import type { DeskOptions } from "./compose";
import type { SourceEvent, SourceReading } from "./sources/command";
import type { StudioView, StudioThreadView } from "./studio/view";
import type { DmarcWeek } from "./mail-dmarc";

export const MIRROR_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export interface MirrorSchedule { day: typeof MIRROR_DAYS[number]; time: string }
export interface MirrorWeek { timeZone: string; from: string; through: string; start: number; end: number }
export function mirrorWeek(now: number): MirrorWeek {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, from: localDay(start.getTime()), through: localDay(end.getTime() - 1), start: start.getTime(), end: end.getTime() };
}
export function mirrorOffered(now: number, schedule: MirrorSchedule | undefined): boolean {
  if (!schedule) return false;
  const date = new Date(now);
  const day = (date.getDay() + 6) % 7;
  const configured = (MIRROR_DAYS.indexOf(schedule.day) + 6) % 7;
  const [hours = 0, minutes = 0] = schedule.time.split(":").map(Number);
  return day > configured || (day === configured && date.getHours() * 60 + date.getMinutes() >= hours * 60 + minutes);
}
export interface MirrorCalendarEvent extends SourceEvent { area: string | null; sourceId: string }
export interface MirrorCalendar {
  sources: { id: string; readAt: number | null; status: "snapshot" | "stale" | "failed" | "missing"; problems: number }[];
  areas: { id: string | null; hours: number }[];
  withoutDuration: number;
  allDay: number;
  available: boolean;
}
export type MirrorThread = Pick<StudioThreadView, "slug" | "question" | "outcome" | "outcomeText" | "expect" | "reviewOn">;
const threadSummary = ({ slug, question, outcome, outcomeText, expect, reviewOn }: StudioThreadView): MirrorThread => ({ slug, question, outcome, outcomeText, expect, reviewOn });
export interface WeeklyMirror {
  generatedAt: number;
  week: MirrorWeek;
  offered: boolean;
  balance: CompletionReview | null;
  recordedEffort: number;
  studioEffortShare: number | null;
  unallocatedEffortShare: number | null;
  calendar: MirrorCalendar;
  threads: { available: boolean; partial: boolean; opened: MirrorThread[]; parked: MirrorThread[]; closed: MirrorThread[]; reviews: MirrorThread[] };
  dmarc: DmarcWeek | null;
}
function unionDuration(intervals: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}
function calendarReview(args: { now: number; week: MirrorWeek; events: MirrorCalendarEvent[]; readings: SourceReading[]; sources: DeskOptions["sources"]; calendarSources: string[] }): MirrorCalendar {
  const { now, week, events, readings, sources } = args;
  const byArea = new Map<string | null, [number, number][]>();
  let withoutDuration = 0;
  let allDay = 0;
  for (const event of events) {
    const start = Date.parse(event.start);
    const end = event.end ? Date.parse(event.end) : NaN;
    if (!Number.isFinite(start)) { withoutDuration += 1; continue; }
    if (start >= Math.min(now, week.end) || (Number.isFinite(end) ? end <= week.start : start < week.start)) continue;
    if (event.allDay) { allDay += 1; continue; }
    if (!Number.isFinite(end) || end <= start) { withoutDuration += 1; continue; }
    const area = byArea.get(event.area) ?? [];
    area.push([Math.max(week.start, start), Math.min(now, week.end, end)]);
    byArea.set(event.area, area);
  }
  const ids = new Set([...args.calendarSources, ...readings.filter(r => r.events.length > 0).map(r => r.id)]);
  const snapshots: MirrorCalendar["sources"] = [...ids].map(id => {
    const reading = readings.find(r => r.id === id);
    const source = sources.find(s => s.id === id);
    if (!reading || !source) return { id, readAt: null, status: "missing", problems: 0 };
    return { id, readAt: reading.readAt, status: reading.error ? "failed" : now - reading.readAt >= source.everySeconds * 1000 ? "stale" : "snapshot", problems: reading.problems.length };
  });
  return { sources: snapshots, areas: [...byArea].map(([id, intervals]) => ({ id, hours: unionDuration(intervals) / 3_600_000 })), withoutDuration, allDay, available: snapshots.some(s => s.status === "snapshot" || s.status === "stale") };
}
export function buildWeeklyMirror(args: { now: number; desk: DeskOptions; state: AppState | null; studio: StudioView | null; readings: SourceReading[]; events: MirrorCalendarEvent[]; calendarSources?: string[]; dmarc?: DmarcWeek | null }): WeeklyMirror {
  const { now, desk, state, studio } = args;
  const week = mirrorWeek(now);
  const configured = new Set(desk.areas.map(a => `area:${a.id}`));
  const scoped = state ? { ...state, outline: { ...state.outline, children: state.outline.children.filter(a => configured.has(a.id)) } } : null;
  const events = scoped?.log.filter(e => e.date >= week.from && e.date <= localDay(now)) ?? [];
  const balance = scoped ? completionReview(scoped, events, localDay(now).slice(0, 7)) : null;
  const effort = events.reduce((sum, e) => sum + e.effort, 0);
  const studioEffort = events.filter(e => e.taskId.startsWith("studio-response:")).reduce((sum, e) => sum + e.effort, 0);
  const threads = studio ? [...studio.active, ...studio.parked, ...studio.closed] : [];
  const thisWeek = (date: string | undefined): boolean => date !== undefined && date >= week.from && date <= localDay(now);
  return {
    generatedAt: now, week, offered: mirrorOffered(now, desk.mirror), balance,
    recordedEffort: effort,
    studioEffortShare: effort > 0 ? studioEffort / effort : null,
    unallocatedEffortShare: effort > 0 ? events.filter(e => !scoped?.outline.children.some(a => a.id === e.areaId && a.weight > 0)).reduce((sum, e) => sum + e.effort, 0) / effort : null,
    calendar: calendarReview({ now, week, readings: args.readings, events: args.events, sources: desk.sources, calendarSources: args.calendarSources ?? [] }),
    threads: {
      available: studio !== null, partial: (studio?.problems.length ?? 0) > 0,
      opened: threads.filter(t => thisWeek(t.opened)).map(threadSummary),
      parked: threads.filter(t => t.log.some(e => thisWeek(e.at?.slice(0, 10)) && (e.text === "Parked" || e.text.startsWith("Parked to make room for ")))).map(threadSummary),
      closed: threads.filter(t => thisWeek(t.closed)).map(threadSummary),
      reviews: threads.filter(t => t.outcome === "decided" && t.reviewOn !== undefined && t.reviewOn <= week.through).map(threadSummary),
    },
    dmarc: args.dmarc ?? null,
  };
}
