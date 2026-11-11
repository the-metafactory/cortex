import type { Policy } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { oneLine } from "./actions";
import { spawnWithStdin, type WriterRunner } from "./create";
import { repoIsCloud } from "./rank";
import { WorkerStatusSchema, expandWorkerCommand, lastWorkerJson, workerStateOf, UnknownBuildState, type WorkerStateView } from "./worker-handoff-contract";
import type { WorkerRecord } from "./worker-handoff-store";

export interface WorkerStatusDeps {
  db: unknown;
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

export const NOT_SET_UP = "Tracking implementation workers is not set up on this stack.";

export function statusCommand(desk: DeskOptions | undefined): string[] | null {
  return desk?.workers?.status ?? desk?.routines?.capabilityBuild?.status ?? null;
}

export interface WorkerStatusRead { view: WorkerStateView; observed: boolean }

export async function readWorkerStatus(deps: WorkerStatusDeps, record: WorkerRecord): Promise<WorkerStatusRead | null> {
  const command = statusCommand(deps.desk());
  if (!command) return null;
  const argv = expandWorkerCommand(command, { ref: record.node, map: record.map });
  if (!argv) return null;
  const run = deps.run ?? spawnWithStdin;
  const timeoutMs = (deps.desk()?.workers?.timeoutSeconds ?? 30) * 1000;
  let result;
  try { result = await run(argv, "", timeoutMs); }
  catch (error) {
    return { view: unchanged(record, `The status command did not finish: ${error instanceof Error ? error.message : String(error)}`), observed: false };
  }
  if (result.code !== 0) return { view: unchanged(record, oneLine(result.stderr || result.stdout, `the status command exited with code ${result.code}.`)), observed: false };
  const answer = WorkerStatusSchema.safeParse(lastWorkerJson(result.stdout));
  if (!answer.success) return { view: unchanged(record, "The status command answered in a form this build does not read."), observed: false };
  try {
    const view = workerStateOf(answer.data);
    if (view.state === "prepared" && view.generation === null && record.state !== "prepared") return { view: unchanged(record, "Ranger has not registered a worker row yet. The recorded handoff is unchanged."), observed: false };
    return { view, observed: true };
  } catch (error) {
    if (!(error instanceof UnknownBuildState)) throw error;
    return { view: unchanged(record, error.message), observed: false };
  }
}

const unchanged = (record: WorkerRecord, reason: string): WorkerStateView => ({ state: record.state, reason, pr: record.pr, result: record.result, generation: record.generation });

export function workerPolicy(desk: DeskOptions | undefined, repository: string): Policy {
  const bare = repository.replace(/^(?:github|gitlab):[^/]+\//, "");
  return desk && repoIsCloud(desk.areas, bare) ? "cloud" : "local";
}

export type { WorkerRecord };
