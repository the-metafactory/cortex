import type { CreateRequest, CreateResult, OwnerReadback, OwnerWriter } from "../../../conversations/types";
import { WORKER_ACTIVE, repositoryOf } from "../../../conversations/tools/worker-handoff";
import type { DeskOptions } from "./compose";
import type { WorkerHandoffOptions } from "../../../common/types/desk-workers";
import { oneLine } from "./actions";
import { spawnWithStdin, type WriterRunner } from "./create";
import { ADD_TIMEOUT_MS, GRAPH_LABEL, graphAnswer, graphBody, graphMarker, graphReadbackById, recordGraphOperation, repositoryRefusal, withBodyFile } from "./graph-conversation-writer";
import { expandWorkerCommand } from "./worker-handoff-contract";
import { readWorkerRecord, recordWorkerRecord, recordWorkerState, readWorkerOperation, pendingWorkerStart, recordWorkerOperation, settleWorkerOperation, type WorkerOperation, type WorkerRecord } from "./worker-handoff-store";
import { readWorkerStatus } from "./worker-handoff-status";
import { splitNodeRef } from "./routine-node-command";

const NOTHING = "Nothing was started.";
const NOTHING_CANCELLED = "Nothing was cancelled.";
const NOT_RECORDED = "No implementation brief from this conversation is recorded for that node. Nothing was started.";
const UNCHANGED = "The node's autonomy was unchanged. Ranger did not confirm a worker start; check its status before retrying.";

export interface WorkerWriterDeps {
  db: Parameters<typeof readWorkerRecord>[0];
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

const parsed = (text: string): unknown => {
  try { return JSON.parse(text); }
  catch { return undefined; }
};

const lastObject = (text: string): Record<string, unknown> | null => {
  const whole = parsed(text.trim());
  if (whole && typeof whole === "object") return whole as Record<string, unknown>;
  const lines = text.trimEnd().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const found = parsed(lines.slice(index).join("\n"));
    if (found && typeof found === "object") return found as Record<string, unknown>;
  }
  return null;
};

const integer = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

export const canonicalNode = (map: string, id: string): string => `${repositoryOf(map)}#${id}`;

const recordedFor = (deps: WorkerWriterDeps, request: CreateRequest): WorkerRecord | null => {
  const typed = (request.fields.node ?? "").trim();
  const parts = splitNodeRef(typed);
  if (!parts) return null;
  const found = readWorkerRecord(deps.db, typed) ?? readWorkerRecord(deps.db, canonicalNode(repositoryOf(typed), parts.id));
  return found?.conversationId === request.provenance.conversationId ? found : null;
};

const failed = (sentence: string): CreateResult => ({ state: "failed", error: sentence });
const created = (found: WorkerRecord): CreateResult => ({ state: "created", canonicalId: found.node, ...(found.url ? { url: found.url } : {}) });

function readyWorker(deps: WorkerWriterDeps, request: CreateRequest, notSetUp: string, noRecord: string): { workers: WorkerHandoffOptions; found: WorkerRecord } | CreateResult {
  const workers = deps.desk()?.workers;
  if (!workers) return failed(notSetUp);
  const found = recordedFor(deps, request);
  if (found) {
    const refused = repositoryRefusal(deps.db, found.repository);
    if (refused) return refused;
    if (!workers.maps.includes(found.map) || repositoryOf(found.map) !== found.repository) return failed("The recorded map is no longer configured for implementation work.");
  }
  return found ? { workers, found } : failed(noRecord);
}

const workerReadback = (deps: WorkerWriterDeps, accepts: (state: WorkerRecord["state"]) => boolean): OwnerReadback => async operation => {
  const saved = readWorkerOperation(deps.db, operation.operationId);
  const found = readWorkerRecord(deps.db, saved?.node ?? operation.canonicalId ?? "");
  if (!found || (saved?.request.provenance.conversationId ?? found.conversationId) !== operation.conversationId) return null;
  if (!saved && found.operationId !== operation.operationId) return null;
  if (saved?.state === "refused") return null;
  if (saved && (saved.request.type !== operation.owner || saved.request.provenance.proposalId !== operation.proposalId || saved.request.provenance.revision !== operation.revision)) return null;
  const ready = () => !repositoryRefusal(deps.db, found.repository) && (deps.desk()?.workers?.maps.includes(found.map) ?? false);
  if (!ready()) return null;
  const status = await readWorkerStatus(deps, found);
  if (!status?.observed || !accepts(status.view.state) || !ready()) return null;
  const latest = readWorkerRecord(deps.db, found.node);
  if (latest?.conversationId !== operation.conversationId || latest.generation !== found.generation) return null;
  if (found.generation !== null && status.view.generation !== found.generation) return null;
  const expected = saved?.request.fields.generation;
  if (operation.owner === "work-start" && expected === undefined && (saved?.state === "starting" || found.generation === null)) return null;
  if (expected !== undefined && status.view.generation !== Number(expected)) return null;
  const current = recordWorkerState(deps.db, found.node, status.view, (deps.now ?? Date.now)());
  if (!current) return null;
  settleWorkerOperation(deps.db, operation.operationId, "complete");
  return { found: true, canonicalId: current.node, ...(current.url ? { url: current.url } : {}) };
};

function rememberBrief(deps: WorkerWriterDeps, saved: WorkerOperation, node: string, url?: string): void {
  if (readWorkerRecord(deps.db, node)) return;
  const { fields, provenance } = saved.request;
  const at = (deps.now ?? Date.now)();
  recordWorkerRecord(deps.db, {
    node, map: fields.map ?? "", repository: fields.repository ?? "", conversationId: provenance.conversationId, entryId: provenance.entryId,
    proposalId: provenance.proposalId, operationId: saved.operationId, generation: null, state: "prepared",
    reason: null, pr: null, result: null, url: url ?? null, prUrl: null, startedAt: at, updatedAt: at,
  });
  settleWorkerOperation(deps.db, saved.operationId, "complete");
}

async function runWorkerCommand(deps: WorkerWriterDeps, argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = deps.run ?? spawnWithStdin;
  return await run(argv, "", timeoutMs);
}

function briefArgs(brief: Record<string, string>, marker: string): { head: string[]; tail: string[] } | CreateResult {
  const { parent = "", repository = "", title = "", checkpoint = "", budgetTokens = "", budgetMinutes = "", budgetInvocations, probes, dependencies } = brief;
  if (!/^[1-9]\d*$/.test(budgetTokens) || !/^[1-9]\d*$/.test(budgetMinutes)) return failed("Write the budget as positive whole tokens and minutes. Nothing was filed.");
  const probeList = (probes ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const probe of probeList) {
    const value = parsed(probe);
    if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return failed("Each probe must be one JSON object. Nothing was filed.");
  }
  const blocked = (dependencies ?? "").split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  if ([parent, ...blocked].some(value => value.startsWith("-"))) return failed("The parent and dependencies must be node references, not options. Nothing was filed.");
  return {
    head: ["graph", "add", parent, "--repo", repository, "--title", title, "--autonomy", "approve", "--kind", "build", "--label", GRAPH_LABEL, "--checkpoint", checkpoint],
    tail: [
      "--budget-tokens", budgetTokens, "--budget-minutes", budgetMinutes,
      ...(budgetInvocations && /^[1-9]\d*$/.test(budgetInvocations) ? ["--budget-invocations", budgetInvocations] : []),
      ...probeList.flatMap(probe => ["--probe", probe]), ...blocked.flatMap(node => ["--blocked-by", node]),
      "--once", marker, "--json",
    ],
  };
}

export function workBriefWriter(deps: WorkerWriterDeps): OwnerWriter {
  const now = deps.now ?? Date.now;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const desk = deps.desk();
    const somaBin = desk?.somaBin;
    if (!somaBin) return failed("Soma is not set up on this stack. Nothing was filed.");
    const workers = desk.workers;
    if (!workers) return failed("Implementation handoff is not set up on this stack. Nothing was filed.");
    const repository = (request.fields.repository ?? "").trim();
    const refused = repositoryRefusal(deps.db, repository);
    if (refused) return refused;
    const map = (request.fields.map ?? "").trim();
    if (!workers.maps.includes(map)) return failed(`${map || "The map"} is not a configured registered map for implementation work. Nothing was filed.`);
    if (repositoryOf(map) !== repository) return failed("The configured map belongs to another repository than the one named. Nothing was filed.");
    const body = (request.fields.body ?? "").trim();
    if (!body) return failed("Write the brief's scope and acceptance checks. Nothing was filed.");
    const marker = graphMarker(request.operationId);
    const args = briefArgs(request.fields, marker);
    if ("state" in args) return args;
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before soma was called.");
    const run = deps.run ?? spawnWithStdin;
    recordWorkerOperation(deps.db, request, null, "filing");
    recordGraphOperation(deps.db, request.operationId, { repository, parent: request.fields.parent ?? null, args: [...args.head, ...args.tail] }, now());
    const result = await withBodyFile(graphBody(body, request.provenance), file => run([somaBin, ...args.head, "--body-file", file, ...args.tail], "", ADD_TIMEOUT_MS));
    const answer = graphAnswer(result, "add");
    if (answer.state === "failed") return answer;
    if (answer.state !== "created") return answer;
    const filed = splitNodeRef(answer.canonicalId);
    if (!filed) return failed("Soma answered without a node id. Check the map before retrying. Nothing is running.");
    const node = canonicalNode(map, filed.id);
    const saved = readWorkerOperation(deps.db, request.operationId);
    if (!saved) throw new Error("The implementation brief's origin could not be recovered.");
    rememberBrief(deps, saved, node, answer.url);
    return { state: "created", canonicalId: node, ...(answer.url ? { url: answer.url } : {}) };
  };
  const byId = graphReadbackById({ db: deps.db, desk: deps.desk, ...(deps.run ? { run: deps.run } : {}) });
  return { create, readback: async operation => {
    const saved = readWorkerOperation(deps.db, operation.operationId);
    if (saved?.request.provenance.conversationId !== operation.conversationId) return null;
    const read = await byId(operation.operationId);
    if (read?.found) rememberBrief(deps, saved, read.canonicalId, read.url);
    return read;
  } };
}

export function workStartWriter(deps: WorkerWriterDeps): OwnerWriter {
  const now = deps.now ?? Date.now;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const ready = readyWorker(deps, request, `Starting implementation work is not set up on this stack. ${NOTHING}`, NOT_RECORDED);
    if ("state" in ready) return ready;
    const { workers, found } = ready;
    if (!workers.maps.includes(found.map)) return failed(`The recorded map ${found.map} is not configured for implementation work. ${NOTHING}`);
    if (WORKER_ACTIVE.has(found.state)) return created(found);
    if (found.state !== "prepared") return failed("This node already has a completed or failed handoff. Review it in Ranger before authorizing another worker.");
    const pending = pendingWorkerStart(deps.db, found.node);
    if (pending) return { state: "accepted", receipt: "A start request for this node is already recorded. Its outcome is uncertain; check the original request before retrying." };
    const argv = expandWorkerCommand(workers.start, { ref: found.node, map: found.map });
    if (!argv) return failed(`The recorded node ${found.node} cannot be passed to the start command. ${NOTHING}`);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Ranger was called.");
    const baseline = await readWorkerStatus(deps, found);
    if (pendingWorkerStart(deps.db, found.node)) return { state: "accepted", receipt: "A start request for this node is already recorded. Check the original request before retrying." };
    const latest = recordedFor(deps, request);
    if (latest?.state !== "prepared" || repositoryRefusal(deps.db, latest.repository) || !(deps.desk()?.workers?.maps.includes(latest.map) ?? false)) return failed("The recorded node or its permissions changed before the start request. Nothing was started.");
    request.signal.throwIfAborted();
    const expected = baseline?.observed ? (baseline.view.generation ?? 0) + 1 : null;
    recordWorkerOperation(deps.db, { ...request, fields: { ...request.fields, ...(expected === null ? {} : { generation: String(expected) }) } }, found.node, "starting");
    const result = await runWorkerCommand(deps, argv, workers.timeoutSeconds * 1000);
    const answer = lastObject(result.stdout);
    const parts = splitNodeRef(found.node);
    if (answer && (answer.nodeId !== undefined && answer.nodeId !== parts?.id && answer.nodeId !== Number(parts?.id) || answer.repo !== undefined && answer.repo !== parts?.repo || answer.root !== undefined && answer.root !== splitNodeRef(found.map)?.id && answer.root !== Number(splitNodeRef(found.map)?.id))) throw new Error("Ranger answered for another node or map. Check the original request before retrying.");
    const pid = integer(answer?.pid);
    if (result.code !== 0 || pid === null) {
      const refusalPrefix = `ranger build-now: #${parts?.id} on ${found.map}: `;
      const beforeDispatch = result.code === 1 && !result.stdout.trim() && result.stderr.trim().startsWith(refusalPrefix);
      if (result.code === 3 && answer?.pid === null || beforeDispatch) settleWorkerOperation(deps.db, request.operationId, "refused");
      else throw new Error("Ranger did not confirm whether work started. Check this request before retrying.");
      const reason = oneLine(result.stderr || result.stdout, "Ranger did not confirm a started worker.");
      return failed(`${reason.replace(/[.\s]+$/, "")}. ${UNCHANGED}`);
    }
    const generation = integer(answer?.generation);
    const current = recordedFor(deps, request);
    if (current?.generation !== found.generation || current.state !== found.state) return { state: "accepted", receipt: "Ranger answered the start request, but the recorded worker changed while it waited. Check the original request before retrying." };
    const state = answer?.state === "running" ? "running" : "queued";
    const started = recordWorkerState(deps.db, found.node, { state, reason: null, pr: found.pr, result: null, generation }, now());
    if (started) recordWorkerRecord(deps.db, { ...started, proposalId: request.provenance.proposalId, operationId: request.operationId, updatedAt: now() });
    settleWorkerOperation(deps.db, request.operationId, "complete");
    return created(found);
  };
  return { create, readback: workerReadback(deps, state => state !== "prepared") };
}

export function workCancelWriter(deps: WorkerWriterDeps): OwnerWriter {
  const now = deps.now ?? Date.now;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const ready = readyWorker(deps, request, `Cancelling implementation work is not set up on this stack. ${NOTHING_CANCELLED}`, `No implementation worker from this conversation is recorded for that node. ${NOTHING_CANCELLED}`);
    if ("state" in ready) return ready;
    const { workers, found } = ready;
    const expected = Number(request.fields.generation);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected !== found.generation) return failed(`The recorded worker generation changed or was not confirmed. Review the current worker before requesting cancellation. ${NOTHING_CANCELLED}`);
    if (!WORKER_ACTIVE.has(found.state)) return failed(`The recorded worker is ${found.state} and no longer active. ${NOTHING_CANCELLED}`);
    const argv = expandWorkerCommand(workers.stop, { ref: found.node, map: found.map, generation: found.generation });
    if (!argv) return failed(`The recorded generation cannot be passed to the stop command. ${NOTHING_CANCELLED}`);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Ranger was called.");
    recordWorkerOperation(deps.db, request, found.node, "stopping");
    const result = await runWorkerCommand(deps, argv, workers.timeoutSeconds * 1000);
    const answer = lastObject(result.stdout);
    const state = typeof answer?.state === "string" ? answer.state : null;
    const reason = typeof answer?.reason === "string" && answer.reason.trim() ? answer.reason.trim() : null;
    const latest = recordedFor(deps, request);
    if (latest?.generation !== expected) return failed("The recorded worker changed while Ranger was stopping the earlier generation. The earlier stop may have completed; check its status before retrying.");
    const parts = splitNodeRef(found.node);
    if (answer && (answer.nodeId !== undefined && answer.nodeId !== parts?.id && answer.nodeId !== Number(parts?.id) || answer.repo !== undefined && answer.repo !== parts?.repo || answer.map !== undefined && answer.map !== found.map)) return failed(`Ranger answered for another node or map. ${NOTHING_CANCELLED}`);
    if (result.code === 0 && integer(answer?.generation) === expected && (state === "stopped" || state === "already-stopped")) {
      const stopped = recordWorkerState(deps.db, found.node, { state: "cancelled", reason: reason ?? `Generation ${found.generation} stopped.`, pr: found.pr, result: found.result, generation: found.generation }, now());
      if (stopped) recordWorkerRecord(deps.db, { ...stopped, proposalId: request.provenance.proposalId, operationId: request.operationId, updatedAt: now() });
      settleWorkerOperation(deps.db, request.operationId, "complete");
      return created(found);
    }
    if (state === "stopping" || state === "unknown") {
      return { state: "accepted", receipt: `Ranger acknowledged the stop of generation ${found.generation} and has not confirmed it yet. Check again before retrying.` };
    }
    return failed(`${reason ?? oneLine(result.stderr || result.stdout, `Ranger refused to stop generation ${found.generation}.`).replace(/[.\s]+$/, "")}. ${NOTHING_CANCELLED}`);
  };
  return { create, readback: workerReadback(deps, state => state === "cancelled") };
}
