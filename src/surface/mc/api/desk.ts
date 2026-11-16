import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { noStore } from "./desk-mail";
import { typedJson } from "../desk/typed-response";
import type { DeskApiRouteTypes, TypedResponse } from "../../../desk-api";

export async function handleGetDesk(db: Database, desk: DeskRuntime | undefined, vigil: DeskVigilSource | undefined): Promise<TypedResponse<DeskApiRouteTypes["GET /api/desk"]["response"]>> {
  if (!desk?.options?.enabled) return typedJson({ enabled: false as const }, { headers: noStore });
  return typedJson(await composeDesk(db, desk.options, vigil, { ...(desk.now ? { now: desk.now() } : {}), conversations: desk.conversations?.() === true, ...(desk.adapterDay ? { adapterDay: desk.adapterDay } : {}), ...(desk.adapterAttention ? { adapterAttention: desk.adapterAttention } : {}), waitingTasks: desk.waitingTasks, escalationRulings: desk.escalationRulings, routineRead: desk.routineRead, handled: desk.ledger, goalChecks: desk.goalChecks, goalStatuses: desk.goalStatuses, ...(desk.mailClassifier ? { mailClassifier: desk.mailClassifier } : {}), ...(desk.localMailClassifier ? { localMailClassifier: desk.localMailClassifier } : {}), ...(desk.rulingExplain ? { rulingExplain: desk.rulingExplain } : {}), ...(desk.digestFlagger ? { digestFlagger: desk.digestFlagger } : {}), ...(desk.waitingClassifier ? { waitingClassifier: desk.waitingClassifier } : {}), ...(desk.mailHandoff ? { mailHandoff: desk.mailHandoff } : {}), ...(desk.sourceCache ? { sourceCache: desk.sourceCache } : {}), ...(desk.recentWrites ? { recentWrites: desk.recentWrites } : {}) }), { headers: noStore });
}
