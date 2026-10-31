import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { RoutineActionSchema } from "../desk/routine-store";
import { actOnRoutine } from "../desk/routines";
import type { RoutineRunner } from "../desk/routine-command";

export async function handleDeskRoutines(req: Request, db: Database, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
  const options = runtime?.options;
  if (!options?.enabled || !options.routines) return Response.json({ ok: false, error: "Routines are not set up on this stack." }, { status: 409, headers });
  const input = RoutineActionSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ ok: false, error: "Provide a routine action, target and request id." }, { status: 400, headers });
  const result = await actOnRoutine(db, options.routines, input.data, Date.now(), run);
  await runtime?.routineRead?.refresh(db, options.routines);
  return Response.json(result, { status: result.ok ? 200 : 409, headers });
}
