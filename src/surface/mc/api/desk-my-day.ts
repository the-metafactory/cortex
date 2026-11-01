import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { changeMyDay, readMyDay } from "../desk/my-day";
import { MyDayRequestSchema } from "../desk/my-day-schema";

export async function handleDeskMyDay(req: Request, db: Database, runtime: DeskRuntime | undefined, vigil?: DeskVigilSource, now = Date.now()): Promise<Response> {
  const desk = runtime?.options;
  if (!desk?.enabled || !runtime) return Response.json({ error: "The Desk is turned off." }, { status: 409 });
  if (req.method === "GET") return Response.json(readMyDay(db, desk, now), { headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const parsed = MyDayRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Provide a valid My day change, date and request id." }, { status: 400 });
  const input = parsed.data;
  const key = input.command.op === "todo" ? input.command.key : null;
  const source = key ? (await composeDesk(db, desk, vigil, { waitingTasks: runtime.waitingTasks, handled: runtime.ledger, sourceCache: runtime.sourceCache, now })).items.find(i => i.key === key) : undefined;
  try {
    return Response.json(changeMyDay({ db, desk, now, ...input, ...(source ? { source } : {}) }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not change My day." }, { status: 409 });
  }
}
