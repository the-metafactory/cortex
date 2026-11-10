import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { changeMyDay } from "../desk/my-day";
import { readObservedMyDay, withSyncedBalance } from "../desk/studio-my-day";
import { MyDayRequestSchema } from "../desk/my-day-schema";
import { findListedMail } from "../desk/mail-actions";
import { logMailTodo } from "../desk/mail-log";

export async function handleDeskMyDay(req: Request, db: Database, runtime: DeskRuntime | undefined, vigil?: DeskVigilSource, now = Date.now()): Promise<Response> {
  const desk = runtime?.options;
  if (!desk?.enabled || !runtime) return Response.json({ error: "The Desk is turned off." }, { status: 409 });
  if (req.method === "GET") {
    const refresh = new URL(req.url).searchParams.get("observation") === "refresh";
    const day = runtime.adapterDay;
    const observe = day ? () => day()?.projection(refresh) ?? Promise.resolve(null) : undefined;
    const view = await readObservedMyDay(db, desk, now, observe);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const parsed = MyDayRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Provide a valid My day change, date and request id." }, { status: 400 });
  const input = parsed.data;
  const key = (input.command.op === "todo" || input.command.op === "source-plan") ? input.command.key : null;
  const source = key ? (await composeDesk(db, desk, vigil, { waitingTasks: runtime.waitingTasks, handled: runtime.ledger, sourceCache: runtime.sourceCache, now, ...(runtime.adapterDay ? { adapterDay: runtime.adapterDay } : {}) })).items.find(i => i.key === key) : undefined;
  try {
    const changed = await withSyncedBalance(db, desk, now, studio => changeMyDay({ db, desk, now, ...input, studio, ...(source ? { source } : {}) }));
    const mail = key && source?.kind === "mail" ? findListedMail(runtime.sourceCache?.cached() ?? [], key) : null;
    if (mail) logMailTodo(db, mail, "desk", now);
    return Response.json(changed, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not change My day." }, { status: 409 });
  }
}
