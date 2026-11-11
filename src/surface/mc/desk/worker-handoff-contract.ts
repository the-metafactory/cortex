import { z } from "zod";
import type { WorkerState } from "../../../conversations/tools/worker-handoff";
import { WorkerHandoffOptionsSchema, type WorkerHandoffOptions } from "../../../common/types/desk-workers";
import { splitNodeRef } from "./routine-node-command";

export { WorkerHandoffOptionsSchema, type WorkerHandoffOptions };

const WORKER_OUTPUT_TAIL_LIMIT = 65_536;

export function parseWorkerJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return undefined; }
}

export function lastWorkerJson(text: string): unknown {
  const tail = text.slice(-WORKER_OUTPUT_TAIL_LIMIT).trimEnd();
  const candidates = new Set([tail, tail.slice(tail.lastIndexOf("\n") + 1), tail.slice(tail.lastIndexOf("\n{") + 1)]);
  for (const candidate of candidates) {
    const value = parseWorkerJson(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function workerAnswerMatches(answer: Record<string, unknown>, node: string, map: string): boolean {
  const parts = splitNodeRef(node);
  const root = splitNodeRef(map);
  return parts !== null && root !== null
    && (answer.nodeId === undefined || answer.nodeId === parts.id || answer.nodeId === Number(parts.id))
    && (answer.repo === undefined || answer.repo === parts.repo)
    && (answer.root === undefined || answer.root === root.id || answer.root === Number(root.id))
    && (answer.map === undefined || answer.map === map);
}

export const BUILD_STATE_TO_WORKER: Record<string, WorkerState> = {
  prepared: "prepared",
  filed: "prepared",
  queued: "queued",
  claimed: "queued",
  building: "running",
  running: "running",
  stopping: "stopping",
  waiting: "waiting",
  "in-review": "review",
  review: "review",
  merged: "merged",
  failed: "failed",
  cancelled: "cancelled",
};

export const WorkerStatusSchema = z.object({
  state: z.string().min(1).max(40),
  reason: z.string().max(2_000).nullish(),
  pr: z.union([z.string(), z.number()]).nullish(),
  result: z.string().max(20_000).nullish(),
  generation: z.number().int().positive().nullish(),
  url: z.string().max(2_000).nullish(),
  prUrl: z.string().max(2_000).nullish(),
});
export type WorkerStatusAnswer = z.infer<typeof WorkerStatusSchema>;

export interface WorkerStateView { state: WorkerState; reason: string | null; pr: string | null; result: string | null; generation: number | null; url?: string; prUrl?: string }

const httpUrl = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch { return undefined; }
};

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length ? trimmed : null;
};

export class UnknownBuildState extends Error {}

export function workerStateOf(answer: WorkerStatusAnswer): WorkerStateView {
  const state = BUILD_STATE_TO_WORKER[answer.state.toLowerCase()];
  if (!state) throw new UnknownBuildState(`The status command reported a state this build does not map: ${answer.state}`);
  return {
    state, reason: text(answer.reason), pr: answer.pr === null || answer.pr === undefined ? null : text(String(answer.pr)), result: text(answer.result),
    generation: answer.generation ?? null, ...(httpUrl(answer.url) ? { url: httpUrl(answer.url) } : {}), ...(httpUrl(answer.prUrl) ? { prUrl: httpUrl(answer.prUrl) } : {}),
  };
}

export interface WorkerCommandValues { ref: string; map: string; generation?: number }

export function expandWorkerCommand(argv: string[], values: WorkerCommandValues): string[] | null {
  const parts = splitNodeRef(values.ref);
  if (!parts) return null;
  const table: Record<string, string> = { ref: values.ref, repo: parts.repo, id: parts.id, map: values.map, generation: values.generation === undefined ? "" : String(values.generation) };
  if (argv.some(arg => arg.includes("{generation}") && values.generation === undefined)) return null;
  return argv.map(arg => arg.replaceAll(/\{(ref|repo|id|map|generation)\}/g, (_match, key: string) => table[key] ?? ""));
}
