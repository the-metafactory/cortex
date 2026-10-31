import type { Database } from "bun:sqlite";
import { z } from "zod";

export const CalendarSchema = z.object({
  source: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, "color must be a six-digit hex colour"),
});

export const CalendarChangeSchema = CalendarSchema.partial({ enabled: true, color: true }).strict()
  .refine((v) => v.enabled !== undefined || v.color !== undefined, "set enabled or color");

export type DeskCalendar = z.infer<typeof CalendarSchema>;
export type CalendarChange = z.infer<typeof CalendarChangeSchema>;

type CalendarRow = Omit<DeskCalendar, "enabled"> & { enabled: number };
interface CalendarEvent { sourceId: string; calendar?: string }

export const calendarKey = (source: string, name: string): string => JSON.stringify([source, name]);
export const calendarName = (event: CalendarEvent): string => event.calendar ?? event.sourceId;

export function listCalendars(db: Database): DeskCalendar[] {
  return db.query<CalendarRow, []>("SELECT source, name, enabled, color FROM desk_calendars ORDER BY name, source").all()
    .map((r) => ({ ...r, enabled: r.enabled === 1 }));
}

export function discoverCalendars(db: Database, events: CalendarEvent[]): Map<string, DeskCalendar> {
  const insert = db.query("INSERT INTO desk_calendars (source, name, enabled, color) VALUES (?, ?, 1, '#2563eb') ON CONFLICT(source, name) DO NOTHING");
  const discovered = new Set<string>();
  for (const event of events) {
    const name = calendarName(event);
    const key = calendarKey(event.sourceId, name);
    if (discovered.has(key)) continue;
    discovered.add(key);
    insert.run(event.sourceId, name);
  }
  return new Map(listCalendars(db).map((c) => [calendarKey(c.source, c.name), c]));
}

export function changeCalendar(db: Database, change: CalendarChange): boolean {
  return db.query("UPDATE desk_calendars SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND name = ?")
    .run(change.enabled === undefined ? null : Number(change.enabled), change.color ?? null, change.source, change.name).changes > 0;
}
