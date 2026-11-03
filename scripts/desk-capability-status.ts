import { z } from "zod";
import { runCommand } from "../src/surface/mc/desk/spawn";
import type { BuildStatusSchema } from "../src/surface/mc/desk/routine-capability-contract";
import { splitNodeRef } from "../src/surface/mc/desk/routine-node-command";

const JOURNAL_TIMEOUT_MS = 10_000;

const WorkerSchema = z.looseObject({
  status: z.string(),
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

export function statusFromJournal(journal: unknown): BuildStatus {
  const worker = latest(JournalSchema.parse(journal).workers);
  if (!worker) return { state: "filed" };
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

export async function readStatus(ref: string, run: JournalRunner = rangerRunner()): Promise<BuildStatus> {
  const { repo, id } = parseNodeRef(ref);
  const result = await run(["journal", "--node", id, "--repo", repo]);
  if (result.code !== 0) throw new Error(result.stderr.replaceAll(/\s+/g, " ").trim() || `ranger journal exited with code ${result.code}`);
  let journal: unknown;
  try { journal = JSON.parse(result.stdout); }
  catch { throw new Error("ranger journal did not print JSON"); }
  return statusFromJournal(journal);
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
