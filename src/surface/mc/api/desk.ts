import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions } from "../desk/compose";
import type { VigilSubjectsOptions } from "./vigil";

export async function handleGetDesk(
  db: Database,
  desk: DeskOptions | undefined,
  vigil: VigilSubjectsOptions | undefined,
): Promise<Response> {
  if (!desk?.enabled) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const view = await composeDesk(db, desk, vigil);
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
