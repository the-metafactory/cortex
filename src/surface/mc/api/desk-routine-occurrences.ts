import { routineReadContext, routineReadHeaders as headers } from "./desk-routine-context";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { readRoutineOccurrences, RoutineOccurrenceQuerySchema } from "../desk/routine-occurrences";

export async function handleDeskRoutineOccurrences(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  const context = routineReadContext(req, runtime);
  if (context instanceof Response) return context;
  const { options, scope } = context;
  const input = RoutineOccurrenceQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return Response.json({ error: "Provide start, end, timezone and a page size from 1 to 1000 for a range of at most 32 days." }, { status: 400, headers });
  try { return Response.json(await readRoutineOccurrences(options, input.data, scope, run), { headers }); }
  catch { return Response.json({ error: "The routine owner could not confirm the calendar. Retry or check its configured sources." }, { status: 502, headers }); }
}
