import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { inspectRoutineRemoval } from "../desk/routine-removal";
import { routineReadContext, routineReadHeaders } from "./desk-routine-context";
export async function handleDeskRoutineRemoval(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  const context = routineReadContext(req, runtime);
  if (context instanceof Response) return context;
  const query = new URL(req.url).searchParams;
  const id = query.get("id");
  if (!id || !/^[a-z0-9][a-z0-9-]{0,99}$/.exec(id) || [...query.keys()].some((key) => key !== "id") || query.getAll("id").length !== 1) return Response.json({ error: "Provide one routine id." }, { status: 400, headers: routineReadHeaders });
  try { return Response.json(await inspectRoutineRemoval(context.options, id, run), { headers: routineReadHeaders }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "The owner could not inspect deletion." }, { status: 409, headers: routineReadHeaders }); }
}
