import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "./compose";
import { pushInterrupts, startInterruptLoop, type DeskTransport, type InterruptLoop } from "./interrupt";

export function startDeskPushes(
  db: Database,
  runtime: DeskRuntime,
  vigil: DeskVigilSource | undefined,
  transport: () => DeskTransport | null,
): InterruptLoop | null {
  const options = runtime.options;
  const rules = options?.interruptions;
  if (!options?.enabled || !rules || rules.transport === "none") return null;
  return startInterruptLoop(rules.everySeconds * 1000, async () => {
    const view = await composeDesk(db, options, vigil, {
      handled: runtime.ledger,
      ...(runtime.sourceCache ? { sourceCache: runtime.sourceCache } : {}),
      ...(runtime.recentWrites ? { recentWrites: runtime.recentWrites } : {}),
    });
    await pushInterrupts(db, view.items, rules.transport, transport(), view.generatedAt);
  });
}
