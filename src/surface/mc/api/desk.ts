import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions, type DeskVigilSource } from "../desk/compose";

export async function handleGetDesk(
  db: Database,
  desk: DeskOptions | undefined,
  vigil: DeskVigilSource | undefined,
): Promise<Response> {
  if (!desk?.enabled) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const view = await composeDesk(db, desk, vigil);
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
