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
