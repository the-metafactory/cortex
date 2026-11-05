import type { Database } from "bun:sqlite";
import { composeDesk, type DeskRuntime, type DeskVigilSource } from "./compose";
import { rangerActionsReady } from "./actions";
import { runCapabilityInstalls } from "./routine-install";
import { runAutonomy } from "./autonomy";
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
      ...(runtime.mailClassifier ? { mailClassifier: runtime.mailClassifier } : {}),
      ...(runtime.sourceCache ? { sourceCache: runtime.sourceCache } : {}),
      ...(runtime.recentWrites ? { recentWrites: runtime.recentWrites } : {}),
      waitingTasks: runtime.waitingTasks,
      ...(runtime.rulingExplain ? { rulingExplain: runtime.rulingExplain } : {}),
    });
    await pushInterrupts(db, view.items, rules.transport, transport(), view.generatedAt);
  });
}

const AUTONOMY_EVERY_MS = 30_000;

export function startDeskAutonomy(db: Database, runtime: DeskRuntime, every = AUTONOMY_EVERY_MS): InterruptLoop | null {
  const options = runtime.options;
  if (!options?.enabled || !rangerActionsReady(options) && !options.routines?.capabilityBuild?.install) return null;
  return startInterruptLoop(every, async () => {
    if (rangerActionsReady(options)) await runAutonomy({ db, rangerUrl: options.rangerUrl, cli: options.rangerCli, ledger: runtime.ledger });
    if (options.routines) await runCapabilityInstalls(db, options.routines, runtime.routineCapabilities ?? (() => new Set()));
  });
}
