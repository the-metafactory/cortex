import type { DeskEvent } from "./types";
import type { SourceEvent } from "./sources/command";

export type CalendarEvent = SourceEvent & { area: string | null; sourceId: string; color?: string };

export function calendarEvents(events: CalendarEvent[], from: number, to: number): DeskEvent[] {
  return events
    .filter((e) => { const at = Date.parse(e.start); return at < to && (e.end ? Date.parse(e.end) > from : at >= from); })
    .map((e): DeskEvent => ({
      key: `cal:${e.sourceId}:${e.id}`,
      at: Date.parse(e.start),
      ...(e.availability ? { availability: e.availability } : {}),
      ...(e.calendarId ? { calendarId: e.calendarId } : {}),
      ...(e.end ? { end: Date.parse(e.end) } : {}),
      title: e.title,
      ...(e.location && !e.online ? { note: e.location } : {}),
      area: e.area,
      kind: e.allDay ? "all-day" : "meeting",
      source: e.sourceId,
      ...(e.calendar ? { calendar: e.calendar } : {}),
      ...(e.color ? { color: e.color } : {}),
      ...(e.url ? { url: e.url } : {}),
      ...(e.online ? { online: true } : {}),
    }))
    .sort((a, b) => a.at - b.at);
}
