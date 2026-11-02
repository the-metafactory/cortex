import type { Database } from "bun:sqlite";
import { z } from "zod";

export const CalendarSchema = z.object({
  source: z.string().min(1),
  name: z.string().min(1),
  calendarId: z.string().min(1).optional(),
  enabled: z.boolean(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, "color must be a six-digit hex colour"),
});

export const CalendarChangeSchema = CalendarSchema.partial({ enabled: true, color: true }).strict()
  .refine((v) => v.enabled !== undefined || v.color !== undefined, "set enabled or color");

export type DeskCalendar = z.infer<typeof CalendarSchema>;
export type CalendarChange = z.infer<typeof CalendarChangeSchema>;

type CalendarRow = Omit<DeskCalendar, "enabled"> & { enabled: number };
interface CalendarEvent { sourceId: string; calendar?: string; calendarId?: string }
type IdentityRow = CalendarRow & { calendarId: string; legacyName: string };

export const calendarKey = (source: string, name: string, calendarId?: string): string => JSON.stringify(calendarId === undefined ? [source, name] : [source, "id", calendarId]);
export const calendarName = (event: CalendarEvent): string => event.calendar ?? event.sourceId;

export function listCalendars(db: Database): DeskCalendar[] {
  const identities = db.query<IdentityRow, []>("SELECT source, calendar_id AS calendarId, name, legacy_name AS legacyName, enabled, color FROM desk_calendar_identities").all();
  const mapped = new Set(identities.flatMap(row => [calendarKey(row.source, row.legacyName), calendarKey(row.source, row.name)]));
  const legacy = db.query<CalendarRow, []>("SELECT source, name, enabled, color FROM desk_calendars ORDER BY name, source").all().filter(row => !mapped.has(calendarKey(row.source, row.name)));
  return [...legacy.map(row => ({ ...row, enabled: row.enabled === 1 })), ...identities.map(({ legacyName: _legacyName, ...row }) => ({ ...row, enabled: row.enabled === 1 }))].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

export function calendarSetting(settings: Map<string, DeskCalendar>, event: CalendarEvent): DeskCalendar | undefined {
  const name = calendarName(event);
  const exact = settings.get(calendarKey(event.sourceId, name, event.calendarId));
  if (exact) return exact;
  const legacy = settings.get(calendarKey(event.sourceId, name));
  if (legacy) return legacy;
  if (event.calendarId) return undefined;
  const matching = [...settings.values()].filter(row => row.source === event.sourceId && row.name === name);
  const first = matching[0];
  return first ? { source: event.sourceId, name, enabled: matching.every(row => row.enabled), color: first.color } : undefined;
}

export function discoverCalendars(db: Database, events: CalendarEvent[]): Map<string, DeskCalendar> {
  const insert = db.query("INSERT INTO desk_calendars (source, name, enabled, color) VALUES (?, ?, 1, '#2563eb') ON CONFLICT(source, name) DO NOTHING");
  const identity = db.query("INSERT INTO desk_calendar_identities (source, calendar_id, name, legacy_name, enabled, color) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, calendar_id) DO UPDATE SET name = excluded.name");
  const discovered = new Set<string>();
  for (const event of events) {
    const name = calendarName(event);
    const key = calendarKey(event.sourceId, name, event.calendarId);
    if (discovered.has(key)) continue;
    discovered.add(key);
    if (event.calendarId) {
      const legacy = db.query<CalendarRow, [string, string]>("SELECT source, name, enabled, color FROM desk_calendars WHERE source = ? AND name = ?").get(event.sourceId, name);
      identity.run(event.sourceId, event.calendarId, name, name, legacy?.enabled ?? 1, legacy?.color ?? "#2563eb");
    } else insert.run(event.sourceId, name);
  }
  return new Map(listCalendars(db).map((c) => [calendarKey(c.source, c.name, c.calendarId), c]));
}

export function changeCalendar(db: Database, change: CalendarChange): boolean {
  const enabled = change.enabled === undefined ? null : Number(change.enabled);
  if (change.calendarId) return db.query("UPDATE desk_calendar_identities SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND calendar_id = ?").run(enabled, change.color ?? null, change.source, change.calendarId).changes > 0;
  return db.transaction(() => {
    const current = db.query("UPDATE desk_calendar_identities SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND name = ?").run(enabled, change.color ?? null, change.source, change.name).changes;
    const hidden = db.query("SELECT 1 FROM desk_calendar_identities WHERE source = ? AND legacy_name = ?").get(change.source, change.name);
    if (!current && hidden) return false;
    const legacy = db.query("UPDATE desk_calendars SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND name = ?").run(enabled, change.color ?? null, change.source, change.name).changes;
    return current > 0 || legacy > 0;
  }).immediate();
}
