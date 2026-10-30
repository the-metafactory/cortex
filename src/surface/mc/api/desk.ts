import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions, type DeskVigilSource } from "../desk/compose";
import type { SourceCache } from "../desk/sources/command";

export async function handleGetDesk(
  db: Database,
  desk: DeskOptions | undefined,
  vigil: DeskVigilSource | undefined,
  sourceCache?: SourceCache,
): Promise<Response> {
  if (!desk?.enabled) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const view = await composeDesk(db, desk, vigil, sourceCache ? { sourceCache } : {});
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
