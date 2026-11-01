import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { readRoutineOccurrences, RoutineOccurrenceQuerySchema } from "../desk/routine-occurrences";

const headers = { "Cache-Control": "no-store" };
export async function handleDeskRoutineOccurrences(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  const options = runtime?.options?.enabled ? runtime.options.routines : undefined;
  const scope = runtime?.options?.routineScope;
  if (!options || !scope) return Response.json({ error: "Routines are not set up on this stack." }, { status: 409, headers });
  const input = RoutineOccurrenceQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return Response.json({ error: "Provide start, end, timezone and a page size from 1 to 1000 for a range of at most 32 days." }, { status: 400, headers });
  try { return Response.json(await readRoutineOccurrences(options, input.data, scope, run), { headers }); }
  catch { return Response.json({ error: "The routine owner could not confirm the calendar. Retry or check its configured sources." }, { status: 502, headers }); }
}
