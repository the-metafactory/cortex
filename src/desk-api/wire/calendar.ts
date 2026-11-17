export type CalendarGapReason =
  | { code: "calendar.not-read" | "calendar.read-failed" | "calendar.stale" | "calendar.capability-unknown" | "calendar.output-incomplete" | "calendar.coverage-missing" | "calendar.reading-incomplete" | "calendar.event-outside-coverage" | "calendar.source-unavailable" | "calendar.interval-uncovered"; params: { source: string } }
  | { code: "calendar.no-coverage" | "calendar.event-unverified" };

export type CalendarSourceState =
  | { id: string; kind: "attention" }
  | { id: string; kind: "unknown"; reason: string; reasonPhrase?: CalendarGapReason }
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

export type CalendarGap =
  | { kind: "busy"; until: number; event: CalendarInterval; overlaps: CalendarInterval[] }
  | { kind: "unknown"; reasons: CalendarGapReason[] }
  | { kind: "bounded"; until: number; minutes: number; event: CalendarInterval }
  | { kind: "open"; through: number; asOf: number };

export interface EventAvailability {
  status: "busy" | "free" | "unknown";
  provenance: string;
}

export interface DeskCalendar {
  source: string;
  name: string;
  calendarId?: string;
  enabled: boolean;
  color: string;
}
