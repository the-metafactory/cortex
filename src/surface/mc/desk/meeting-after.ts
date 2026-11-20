import type { Database } from "bun:sqlite";
import { refuse, type ActResult } from "./act-result";
import { calendarEvents } from "./calendar-events";
import { calendarKey, calendarSetting, listCalendars } from "./calendars";
import type { SourceReading } from "./sources/command";
import { clock, DAY_MS, startOfDay } from "./time";
import type { DeskEvent, DeskItem } from "./types";

export const MEETING_AFTER_KIND = "meeting-after";
export const MEETING_DISMISS_ACTION = "meeting.dismiss";
const AFTER_MEETING_WINDOW_MS = 60 * 60 * 1000;
const DISMISS_KEEP_MS = DAY_MS;

export const MEETING_AFTER_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_meeting_dismissals (
    event_key TEXT PRIMARY KEY,
    item_key TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    keep_until INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_meeting_dismissals_keep ON desk_meeting_dismissals (keep_until)",
];

const occurrenceKey = (event: DeskEvent): string => `${event.key}@${event.at}`;
const meetingAfterKey = (event: DeskEvent): string => `${MEETING_AFTER_KIND}:${occurrenceKey(event)}`;

export function readMeetingDismissals(db: Database, now: number): Set<string> {
  return new Set(db.query<{ event_key: string }, [number]>("SELECT event_key FROM desk_meeting_dismissals WHERE keep_until >= ?").all(now).map((row) => row.event_key));
}

export function afterMeetingEvents(db: Database, readings: readonly SourceReading[], now: number): DeskEvent[] {
  const settings = new Map(listCalendars(db).map((calendar) => [calendarKey(calendar.source, calendar.name, calendar.calendarId), calendar]));
  const events = readings
    .flatMap((reading) => reading.events.map((event) => ({ ...event, area: reading.area, sourceId: reading.id })))
    .flatMap((event) => { const setting = calendarSetting(settings, event); return setting?.enabled ? [{ ...event, calendar: setting.name, color: setting.color }] : []; });
  const sod = startOfDay(now);
  return calendarEvents(events, sod, sod + DAY_MS);
}

interface AfterMeetingCandidate {
  item: DeskItem;
  eventKey: string;
  end: number;
}

function minutesLine(endedAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - endedAt) / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

function candidates(events: readonly DeskEvent[], now: number): AfterMeetingCandidate[] {
  const today = startOfDay(now);
  return events
    .flatMap((e): AfterMeetingCandidate[] => {
      if (e.kind !== "meeting" || e.end === undefined || e.end > now || e.end < today || now - e.end >= AFTER_MEETING_WINDOW_MS) return [];
      const eventKey = occurrenceKey(e);
      return [{
        eventKey,
        end: e.end,
        item: {
          key: meetingAfterKey(e),
          kind: MEETING_AFTER_KIND,
          source: e.source ?? "calendar",
          area: e.area,
          urgency: "today",
          title: `"${e.title}" ended at ${clock(e.end)}.`,
          why: `It ended ${minutesLine(e.end, now)}.`,
          whyPhrase: { code: "meeting.ended", params: { endedAt: new Date(e.end).toISOString() } },
          score: 95 - (now - e.end) / 60_000,
          actions: [{ id: MEETING_DISMISS_ACTION, role: "primary", wired: true }],
          detail: {
            summary: e.title,
            history: [`Ended ${clock(e.end)}${e.note ? `, ${e.note}` : ""}`],
            refs: [e.key],
            links: [],
          },
          eventKey: e.key,
          since: e.at,
        },
      }];
    })
    .sort((a, b) => b.end - a.end);
}

export function afterMeetingItems(events: readonly DeskEvent[], dismissed: ReadonlySet<string>, now: number): DeskItem[] {
  return candidates(events, now).filter((c) => !dismissed.has(c.eventKey)).map((c) => c.item);
}

export function dismissAfterMeeting(db: Database, events: readonly DeskEvent[], key: string, now: number): ActResult {
  const found = candidates(events, now).find((c) => c.item.key === key);
  if (!found) return refuse(400, "The Desk has no after-meeting card with this key.");
  db.run("DELETE FROM desk_meeting_dismissals WHERE keep_until < ?", [now]);
  db.run(
    `INSERT INTO desk_meeting_dismissals (event_key, item_key, dismissed_at, keep_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET item_key = excluded.item_key, dismissed_at = excluded.dismissed_at, keep_until = excluded.keep_until`,
    [found.eventKey, key, now, found.end + DISMISS_KEEP_MS],
  );
  return { ok: true, message: `"${found.item.detail.summary}" is dismissed from the Desk.`, messagePhrase: { code: "meeting.dismissed" } };
}
