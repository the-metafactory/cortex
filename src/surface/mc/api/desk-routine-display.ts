import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { reflexCommand, type RoutineRunner } from "../desk/routine-command";
import { RoutineInventorySchema } from "../desk/routine-editor-contract";
import { readRoutineDisplay, RoutineDisplayChangeSchema, writeRoutineDisplay } from "../desk/routine-display";
import { routineReadHeaders as headers } from "./desk-routine-context";

const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers });
export async function handleDeskRoutineDisplay(req: Request, db: Database, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
  const options = runtime?.options?.enabled ? runtime.options.routines : undefined;
  const scope = runtime?.options?.routineScope;
  if (!options || !scope) return fail(409, "Routines are not set up on this stack.");
  if (req.method === "GET") return Response.json(readRoutineDisplay(db, scope), { headers });
  const input = RoutineDisplayChangeSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return fail(400, "Choose a routine and a calendar display of Scheduled starts or Background for the configured principal and stack.");
  const change = input.data;
  if (change.principal !== scope.principal || change.stack !== scope.stack) return fail(409, "This display choice was made for a different principal or stack. Refresh the Routines page before choosing again.");
  let inventory;
  try { inventory = await reflexCommand(options, ["routine", "list"], RoutineInventorySchema, run); }
  catch { return fail(502, "The routine owner could not confirm this routine. The previous display is unchanged."); }
  if (!inventory.some((routine) => routine.id === change.routineId)) return fail(404, "This routine is no longer installed. The previous display is unchanged.");
  return Response.json(writeRoutineDisplay(db, change), { headers });
}
