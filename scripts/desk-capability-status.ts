import { z } from "zod";
import { runCommand } from "../src/surface/mc/common/spawn";
import type { BuildStatusSchema } from "../src/surface/mc/desk/routine-capability-contract";
import { splitNodeRef } from "../src/surface/mc/desk/routine-node-command";

const JOURNAL_TIMEOUT_MS = 10_000;

const WorkerSchema = z.looseObject({
  status: z.string(),
  nodeId: z.string().optional(),
  repo: z.string().optional(),
  pid: z.number().int().positive().nullish(),
  workerPgid: z.number().int().positive().nullish(),
  phase: z.string().nullish(),
  prNumber: z.number().nullish(),
  outcome: z.string().nullish(),
  generation: z.number().nullish(),
  startedAt: z.string().nullish(),
});
const JournalSchema = z.looseObject({ workers: z.array(WorkerSchema) });
type Worker = z.infer<typeof WorkerSchema>;

export type BuildStatus = z.input<typeof BuildStatusSchema>;
export type JournalRunner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const rangerRunner = (bin = process.env.RANGER_BIN ?? "ranger"): JournalRunner => async (argv) => {
  const { code, stdout, stderr } = await runCommand([bin, ...argv], JOURNAL_TIMEOUT_MS);
  return { code, stdout, stderr };
};

export function parseNodeRef(ref: string): { repo: string; id: string } {
  const parts = splitNodeRef(ref);
  if (!parts) throw new Error(`${JSON.stringify(ref)} is not a node reference like owner/repo#123`);
  return parts;
}

const latest = (workers: Worker[]): Worker | undefined =>
  [...workers].sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0) || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];

const prFrom = (worker: Worker): number | undefined => {
  if (worker.prNumber) return worker.prNumber;
  const match = /\bPR #(\d+)/.exec(worker.outcome ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
};

const withPr = (status: BuildStatus, worker: Worker): BuildStatus => {
  const pr = prFrom(worker);
  return pr === undefined ? status : { ...status, pr };
};

const REVIEW_PHASES = new Set(["review", "awaiting-review", "awaiting-merge"]);

function workerStatus(worker: Worker): BuildStatus {
  const reason = worker.outcome ?? undefined;
  switch (worker.status) {
    case "claimed":
      return { state: "building" };
    case "running":
      return withPr({ state: worker.prNumber || REVIEW_PHASES.has(worker.phase ?? "") ? "in-review" : "building" }, worker);
    case "awaiting-merge":
      return withPr({ state: "in-review" }, worker);
    case "success":
      if (worker.phase === "close") return withPr({ state: "merged" }, worker);
      throw new Error(`ranger reports success in phase ${worker.phase ?? "none"}, which does not mean merged`);
    case "released":
      return withPr({ state: "failed", reason: reason ?? "the claim was released without a merged build" }, worker);
    case "failed":
    case "parked":
      return withPr({ state: "failed", reason: reason ?? `the worker ${worker.status}` }, worker);
    default:
      throw new Error(`ranger reports a worker status the adapter does not map: ${worker.status}`);
  }
}

export function statusFromJournal(journal: unknown): BuildStatus {
  const worker = latest(JournalSchema.parse(journal).workers);
  return worker ? workerStatus(worker) : { state: "filed" };
}

async function readJournal(ref: string, run: JournalRunner): Promise<unknown> {
  const { repo, id } = parseNodeRef(ref);
  const result = await run(["journal", "--node", id, "--repo", repo]);
  if (result.code !== 0) throw new Error(result.stderr.replaceAll(/\s+/g, " ").trim() || `ranger journal exited with code ${result.code}`);
  try {
    const journal = JournalSchema.parse(JSON.parse(result.stdout));
    if (journal.workers.some(worker => worker.nodeId !== undefined && worker.nodeId !== id || worker.repo !== undefined && worker.repo !== repo)) throw new Error("ranger journal returned another node's worker");
    return journal;
  }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("ranger journal did not print JSON");
    throw error;
  }
}

export async function readStatus(ref: string, run: JournalRunner = rangerRunner()): Promise<BuildStatus> {
  return statusFromJournal(await readJournal(ref, run));
}

export interface WorkerReport { state: string; reason?: string; pr?: string | number; generation: number | null }

export async function readWorkerReport(ref: string, run: JournalRunner = rangerRunner()): Promise<WorkerReport> {
  const journal = JournalSchema.parse(await readJournal(ref, run));
  const worker = latest(journal.workers);
  const status: Omit<WorkerReport, "generation"> = worker?.status === "stop-requested"
    ? { state: worker.pid === null && worker.workerPgid === null ? "cancelled" : "stopping", reason: worker.outcome ?? "The worker stop has been requested." }
    : worker ? workerStatus(worker) : { state: "filed" };
  return { state: status.state, ...(status.reason === undefined ? {} : { reason: status.reason }), ...(status.pr === undefined ? {} : { pr: status.pr }), generation: worker?.generation ?? null };
}

if (import.meta.main) {
  try {
    const ref = process.argv[2];
    if (!ref || process.argv.length > 3) throw new Error("usage: desk-capability-status.ts <owner/repo#node>");
    process.stdout.write(`${JSON.stringify(await readStatus(ref))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
