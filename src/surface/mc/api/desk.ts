import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "../desk/compose";

export async function handleGetDesk(db: Database, desk: DeskRuntime | undefined, vigil: DeskVigilSource | undefined): Promise<Response> {
  if (!desk?.options?.enabled) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const view = await composeDesk(db, desk.options, vigil, { waitingTasks: desk.waitingTasks, routineRead: desk.routineRead, handled: desk.ledger, goalChecks: desk.goalChecks, goalStatuses: desk.goalStatuses, ...(desk.mailClassifier ? { mailClassifier: desk.mailClassifier } : {}), ...(desk.rulingExplain ? { rulingExplain: desk.rulingExplain } : {}), ...(desk.sourceCache ? { sourceCache: desk.sourceCache } : {}), ...(desk.recentWrites ? { recentWrites: desk.recentWrites } : {}) });
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
