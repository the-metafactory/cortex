import type { Database } from "bun:sqlite";
import { repositoryOf, type WorkerHandoff, type WorkerOwner, type WorkerRead } from "../../../conversations/tools/worker-handoff";
import type { ToolSession } from "../../../conversations/tools/capabilities";
import type { DeskOptions } from "./compose";
import type { WriterRunner } from "./create";
import { readWorkerRecord, recordWorkerState, type WorkerRecord } from "./worker-handoff-store";
import { readWorkerStatus, workerPolicy } from "./worker-handoff-status";
import { repositoryRefusal } from "./graph-conversation-writer";
import { mayRelease } from "../../../conversations/tools/work-context";

export interface WorkerOwnerDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

const view = (deps: WorkerOwnerDeps, record: WorkerRecord): WorkerHandoff => ({
  node: record.node, map: record.map, policy: workerPolicy(deps.desk(), record.repository), state: record.state,
  reason: record.reason, generation: record.generation, pr: record.pr, result: record.result,
  ...(record.url ? { url: record.url } : {}), ...(record.prUrl ? { prUrl: record.prUrl } : {}), observedAt: record.updatedAt,
});

export function workerOwner(deps: WorkerOwnerDeps): WorkerOwner {
  const now = deps.now ?? Date.now;
  const allowed = (session: ToolSession, record: WorkerRecord): boolean =>
    record.conversationId === session.conversationId && !repositoryRefusal(deps.db, record.repository)
    && (deps.desk()?.workers?.maps.includes(record.map) ?? false) && repositoryOf(record.map) === record.repository
    && mayRelease(session, workerPolicy(deps.desk(), record.repository));
  const read = async (session: ToolSession, node: string): Promise<WorkerRead> => {
    const record = readWorkerRecord(deps.db, node);
    if (record?.conversationId !== session.conversationId) return { state: "unknown", reason: "No implementation handoff from this conversation is recorded for that node." };
    if (!allowed(session, record)) return { state: "unauthorized" };
    const status = await readWorkerStatus({ db: deps.db, desk: deps.desk, ...(deps.run ? { run: deps.run } : {}), now }, record);
    const latest = readWorkerRecord(deps.db, node);
    if (!latest || !allowed(session, latest)) return { state: "unauthorized" };
    const current = status?.observed ? recordWorkerState(deps.db, latest.node, status.view, now()) ?? latest : latest;
    const handoff = view(deps, current);
    return { state: "available", handoff: status && !status.observed && status.view.reason ? { ...handoff, reason: status.view.reason } : handoff };
  };
  return {
    maps: () => deps.desk()?.workers?.maps ?? [],
    read,
    recorded: (session, node) => {
      const record = readWorkerRecord(deps.db, node);
      return record && allowed(session, record) ? workerPolicy(deps.desk(), record.repository) : null;
    },
    remember: (session, handoff, signal) => {
      signal.throwIfAborted();
      const record = readWorkerRecord(deps.db, handoff.node);
      return Promise.resolve(record !== null && allowed(session, record) && record.map === handoff.map
        && workerPolicy(deps.desk(), record.repository) === handoff.policy && record.generation === handoff.generation
        && record.state === handoff.state && record.updatedAt === handoff.observedAt);
    },
    now,
  };
}
