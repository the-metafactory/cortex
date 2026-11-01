import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { EditorRequestSchema, RoutineInventorySchema, validateRoutinePatches } from "../desk/routine-editor-contract";
import { inspectRoutine, proposeRoutinePatches } from "../desk/routine-editor";
import { reflexCommand, type RoutineRunner } from "../desk/routine-command";
import { effectivePolicy } from "../desk/studio/view";

const headers = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers });
export async function handleDeskRoutineEditor(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner, db?: Database): Promise<Response> {
  const desk = runtime?.options;
  const options = desk?.enabled ? desk.routines : undefined;
  if (!options) return fail(409, "Routines are not set up on this stack.");
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      return Response.json(id ? await inspectRoutine(options, z.string().min(1).max(100).parse(id), run) : await reflexCommand(options, ["routine", "list"], RoutineInventorySchema, run), { headers });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
    const input = EditorRequestSchema.safeParse(await req.json().catch(() => null));
    if (!input.success) return fail(400, "Provide a routine, revision and valid parameter edits or request.");
    const request = input.data;
    if (request.action === "update" && db?.query("SELECT request_id FROM desk_routine_operations WHERE resource = ? AND result IS NULL LIMIT 1").get(request.id)) return fail(409, "Another routine change is awaiting confirmation. Check that pending change before applying parameters.");
    const detail = await inspectRoutine(options, request.id, run);
    if (detail.revision !== request.revision) return fail(409, "This routine changed since it was opened. Refresh before applying edits.");
    if (request.action === "propose") {
      const policy = effectivePolicy(request.area ? [request.area] : [], desk?.areas ?? []);
      if (policy.unknown.length || policy.policy === "local") return fail(409, "The configured routine composer cannot enforce this area's provider restriction.");
      return Response.json({ patches: await proposeRoutinePatches(options, detail, request.text, run), revision: detail.revision }, { headers });
    }
    validateRoutinePatches(detail, request.patches);
    await reflexCommand(options, ["routine", "update", request.id, "--revision", request.revision, "--patches", JSON.stringify(request.patches)], z.unknown(), run);
    const result = await inspectRoutine(options, request.id, run);
    return Response.json(result, { headers });
  } catch (error) { return fail(409, error instanceof Error ? error.message : "The routine owner did not confirm this request. Refresh before retrying."); }
}
