import { routineReadContext, routineReadHeaders as headers } from "./desk-routine-context";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { RoutineHistoryQuerySchema, RoutineLogQuerySchema } from "../desk/routine-evidence-contract";
import { readRoutineEvidence, readRoutineLog, RoutineEvidenceRefusal } from "../desk/routine-evidence";

export async function handleDeskRoutineEvidence(req: Request, db: Database, runtime: DeskRuntime | undefined, log = false, run?: RoutineRunner): Promise<Response> {
  const context = routineReadContext(req, runtime);
  if (context instanceof Response) return context;
  const { options, scope } = context;
  const input = Object.fromEntries(new URL(req.url).searchParams);
  try {
    if (log) {
      const query = RoutineLogQuerySchema.safeParse(input);
      if (!query.success) return Response.json({ error: "Choose an exact routine, decision, execution and authorized file reference with bounded offset and limit." }, { status: 400, headers });
      const result = await readRoutineLog(db, options, query.data, scope, run);
      if (query.data.download === "1") return new Response(result.content, { status: result.complete ? 200 : 206, headers: {
        ...headers, "Content-Type": result.file.type, "Content-Disposition": `attachment; filename="${result.file.filename}"`,
        "X-Audit-Revision": result.revision, "X-Next-Offset": result.nextOffset === null ? "" : String(result.nextOffset),
        "X-Total-Bytes": String(result.totalBytes),
        ...(!result.complete ? { "Content-Range": `bytes ${result.offset}-${result.offset + Buffer.byteLength(result.content) - 1}/${result.totalBytes}` } : {}),
      } });
      return Response.json(result, { headers });
    }
    const query = RoutineHistoryQuerySchema.safeParse(input);
    if (!query.success) return Response.json({ error: "Choose a routine or stack activity with a page size from 1 to 100 and an optional continuation cursor." }, { status: 400, headers });
    return Response.json(await readRoutineEvidence(db, options, query.data, scope, run), { headers });
  } catch (error) {
    if (error instanceof RoutineEvidenceRefusal) return Response.json({ error: error.message }, { status: 409, headers });
    return Response.json({ error: "The configured owners could not confirm this execution evidence. Retry or check their availability." }, { status: 502, headers });
  }
}
