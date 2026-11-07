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
type IdentityRow = CalendarRow & { calendarId: string; legacyName: string; retiredAt: number | null };
type SavedPreference = Pick<CalendarRow, "enabled" | "color">;

/** Every calendar one source's complete reading returned. Only such a reading can retire a row. */
export interface ReturnedCalendars { source: string; calendarIds: string[] }

export const calendarKey = (source: string, name: string, calendarId?: string): string => JSON.stringify(calendarId === undefined ? [source, name] : [source, "id", calendarId]);
export const calendarName = (event: CalendarEvent): string => event.calendar ?? event.sourceId;

export function listCalendars(db: Database): DeskCalendar[] {
  const identities = db.query<IdentityRow, []>("SELECT source, calendar_id AS calendarId, name, legacy_name AS legacyName, enabled, color, retired_at AS retiredAt FROM desk_calendar_identities").all();
  const mapped = new Set(identities.flatMap(row => [calendarKey(row.source, row.legacyName), calendarKey(row.source, row.name)]));
  const legacy = db.query<CalendarRow, []>("SELECT source, name, enabled, color FROM desk_calendars ORDER BY name, source").all().filter(row => !mapped.has(calendarKey(row.source, row.name)));
  return [...legacy.map(row => ({ ...row, enabled: row.enabled === 1 })), ...identities.filter(row => row.retiredAt === null).map(({ legacyName: _legacyName, retiredAt: _retiredAt, ...row }) => ({ ...row, enabled: row.enabled === 1 }))].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
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

function retireUnreturned(db: Database, returned: ReturnedCalendars, now: number): void {
  db.query("UPDATE desk_calendar_identities SET retired_at = ? WHERE source = ? AND retired_at IS NULL AND calendar_id NOT IN (SELECT value FROM json_each(?))").run(now, returned.source, JSON.stringify(returned.calendarIds));
}

export function discoverCalendars(db: Database, events: CalendarEvent[], returned: ReturnedCalendars[] = [], now = Date.now()): Map<string, DeskCalendar> {
  const insert = db.query("INSERT INTO desk_calendars (source, name, enabled, color) VALUES (?, ?, 1, '#2563eb') ON CONFLICT(source, name) DO NOTHING");
  const identity = db.query("INSERT INTO desk_calendar_identities (source, calendar_id, name, legacy_name, enabled, color) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, calendar_id) DO UPDATE SET name = excluded.name, retired_at = NULL");
  const newestSameName = db.query<SavedPreference, [string, string]>("SELECT enabled, color FROM desk_calendar_identities WHERE source = ? AND name = ? ORDER BY rowid DESC LIMIT 1");
  const discovered = new Set<string>();
  for (const event of events) {
    const name = calendarName(event);
    const key = calendarKey(event.sourceId, name, event.calendarId);
    if (discovered.has(key)) continue;
    discovered.add(key);
    if (event.calendarId) {
      const saved = newestSameName.get(event.sourceId, name) ?? db.query<SavedPreference, [string, string]>("SELECT enabled, color FROM desk_calendars WHERE source = ? AND name = ?").get(event.sourceId, name);
      identity.run(event.sourceId, event.calendarId, name, name, saved?.enabled ?? 1, saved?.color ?? "#2563eb");
    } else insert.run(event.sourceId, name);
  }
  for (const reading of returned) retireUnreturned(db, reading, now);
  return new Map(listCalendars(db).map((c) => [calendarKey(c.source, c.name, c.calendarId), c]));
}

export function changeCalendar(db: Database, change: CalendarChange): boolean {
  const enabled = change.enabled === undefined ? null : Number(change.enabled);
  if (change.calendarId) return db.query("UPDATE desk_calendar_identities SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND calendar_id = ? AND retired_at IS NULL").run(enabled, change.color ?? null, change.source, change.calendarId).changes > 0;
  return db.transaction(() => {
    const matching = db.query<{ calendarId: string }, [string, string]>("SELECT calendar_id AS calendarId FROM desk_calendar_identities WHERE source = ? AND name = ? AND retired_at IS NULL").all(change.source, change.name);
    if (matching.length > 1) return false;
    const selected = matching[0];
    if (selected) return db.query("UPDATE desk_calendar_identities SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND calendar_id = ?").run(enabled, change.color ?? null, change.source, selected.calendarId).changes > 0;
    const hidden = db.query("SELECT 1 FROM desk_calendar_identities WHERE source = ? AND legacy_name = ?").get(change.source, change.name);
    if (hidden) return false;
    const legacy = db.query("UPDATE desk_calendars SET enabled = COALESCE(?, enabled), color = COALESCE(?, color) WHERE source = ? AND name = ?").run(enabled, change.color ?? null, change.source, change.name).changes;
    return legacy > 0;
  }).immediate();
}
