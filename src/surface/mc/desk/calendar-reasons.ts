import type { CalendarGapReason } from "../../../desk-api/wire/calendar";

export const calendarReasons: Record<CalendarGapReason["code"], string> = {
  "calendar.not-read": "Calendar coverage has not been read.",
  "calendar.read-failed": "The source could not be read.",
  "calendar.stale": "The source reading is stale; a refresh is pending.",
  "calendar.capability-unknown": "This source does not declare its calendar capability.",
  "calendar.output-incomplete": "The source output could not be read completely.",
  "calendar.coverage-missing": "This calendar reader does not report a coverage window.",
  "calendar.reading-incomplete": "The calendar reading is incomplete.",
  "calendar.event-outside-coverage": "An event is outside the declared calendar coverage.",
  "calendar.source-unavailable": "The calendar source is unavailable.",
  "calendar.interval-uncovered": "The reading does not cover the requested interval.",
  "calendar.no-coverage": "No qualified calendar coverage is available.",
  "calendar.event-unverified": "A visible event has unknown availability or an incomplete interval.",
};
