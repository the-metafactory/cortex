import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { CapabilityBuildRequestSchema } from "../desk/routine-capability-contract";
import { buildRoutineCapabilities } from "../desk/routine-capability";
import type { RoutineRunner } from "../desk/routine-command";

export async function handleDeskRoutineCapability(req: Request, db: Database, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
  const routines = runtime?.options?.enabled ? runtime.options.routines : undefined;
  if (!runtime || !routines) return Response.json({ ok: false, message: "Routines are not set up on this stack.", built: [], failed: [] }, { status: 409, headers });
  const input = CapabilityBuildRequestSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ ok: false, message: "Provide a request id and a routine proposal.", built: [], failed: [] }, { status: 400, headers });
  const result = await buildRoutineCapabilities(db, routines, runtime.ledger, input.data, run);
  return Response.json(result, { status: result.ok ? 200 : 409, headers });
}
