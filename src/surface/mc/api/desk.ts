import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import type { DeskView } from "../desk/types";
import { noStore } from "./desk-mail";

async function composeDeskView(db: Database, desk: DeskRuntime | undefined, vigil: DeskVigilSource | undefined): Promise<DeskView> {
  if (!desk?.options) throw new Error("The Desk is not set up on this stack.");
  return composeDesk(db, desk.options, vigil, { ...(desk.now ? { now: desk.now() } : {}), conversations: desk.conversations?.() === true, ...(desk.adapterDay ? { adapterDay: desk.adapterDay } : {}), ...(desk.adapterAttention ? { adapterAttention: desk.adapterAttention } : {}), waitingTasks: desk.waitingTasks, escalationRulings: desk.escalationRulings, routineRead: desk.routineRead, handled: desk.ledger, goalChecks: desk.goalChecks, goalStatuses: desk.goalStatuses, ...(desk.mailClassifier ? { mailClassifier: desk.mailClassifier } : {}), ...(desk.localMailClassifier ? { localMailClassifier: desk.localMailClassifier } : {}), ...(desk.rulingExplain ? { rulingExplain: desk.rulingExplain } : {}), ...(desk.digestFlagger ? { digestFlagger: desk.digestFlagger } : {}), ...(desk.waitingClassifier ? { waitingClassifier: desk.waitingClassifier } : {}), ...(desk.mailHandoff ? { mailHandoff: desk.mailHandoff } : {}), ...(desk.sourceCache ? { sourceCache: desk.sourceCache } : {}), ...(desk.recentWrites ? { recentWrites: desk.recentWrites } : {}) });
}

export async function handleGetDesk(db: Database, desk: DeskRuntime | undefined, vigil: DeskVigilSource | undefined): Promise<Response> {
  if (!desk?.options?.enabled) return Response.json({ enabled: false }, { headers: noStore });
  return Response.json(await composeDeskView(db, desk, vigil), { headers: noStore });
}
