import { z } from "zod";
import { CalendarSchema, type CalendarChange, type DeskCalendar } from "../../desk/calendars";

const CalendarAnswer = z.object({ calendars: z.array(CalendarSchema) });
export type CalendarFetch = (input: string, init: RequestInit) => Promise<Response>;
type CalendarResult = { ok: true; calendars: DeskCalendar[] } | { ok: false; error: string };

export async function requestCalendars(change?: CalendarChange, fetchImpl: CalendarFetch = fetch): Promise<CalendarResult> {
  try {
    const res = await fetchImpl("/api/desk/calendars", change
      ? { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }
      : { method: "GET" });
    const answer: unknown = await res.json();
    const parsed = CalendarAnswer.safeParse(answer);
    if (res.ok && parsed.success) return { ok: true, calendars: parsed.data.calendars };
    const error = z.object({ error: z.string() }).safeParse(answer);
    return { ok: false, error: error.success ? error.data.error : `Mission Control answered HTTP ${res.status} without a calendar list.` };
  } catch (err) {
    return { ok: false, error: `The calendar settings could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
