import type { Database } from "bun:sqlite";
import { CalendarChangeSchema, changeCalendar, listCalendars } from "../desk/calendars";

export async function handleDeskCalendars(req: Request, db: Database): Promise<Response> {
  const rows = (): Response => Response.json({ calendars: listCalendars(db) }, { headers: { "Cache-Control": "no-store" } });
  if (req.method === "GET") return rows();
  if (req.method !== "PATCH") return new Response(null, { status: 405, headers: { Allow: "GET, PATCH" } });
  const parsed = CalendarChangeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  if (!changeCalendar(db, parsed.data)) return Response.json({ error: "This calendar has not been reported by a source." }, { status: 404 });
  return rows();
}
