import { z } from "zod";
import { spawnWithStdin, type WriterRunner } from "./create";

import type { RoutineOptions } from "../../../common/types/desk-routines";
import type { RoutineAction } from "./routine-store";
export type { RoutineOptions } from "../../../common/types/desk-routines";
export type RoutineRunner = WriterRunner;
const id = z.string().min(1);
export const RoutineSchema = z.object({
  id, schedule: z.string(), timezone: z.string(), policy: z.enum(["approval", "auto"]), target: z.string(), file: z.string(),
  lastDecision: z.object({ id, outcome: z.string(), at: z.string(), reason: z.string().nullable() }).nullable(),
});
export const PendingRoutineSchema = z.object({ decisionId: id, blueprintId: id, matchedAt: z.string(), expiresAt: z.string(), impulseSummary: z.string() });
export const RoutineHistorySchema = z.object({ decisionId: id, blueprintId: id, outcome: z.string(), reason: z.string().nullable(), resolutionOf: z.string().nullable(), at: z.string() });
export type InstalledRoutine = z.infer<typeof RoutineSchema>;
export type PendingRoutine = z.infer<typeof PendingRoutineSchema>;

const RefusalSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export class RoutineRefusal extends Error {}
export class RoutineWriteFailure extends Error {}

export async function runRoutineCommand(run: RoutineRunner, argv: string[], timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(argv, "", timeoutMs),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("Routine command timed out.")); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function reflexCommand<T>(options: RoutineOptions, args: string[], schema: z.ZodType<T>, run: RoutineRunner = spawnWithStdin): Promise<T> {
  const result = await runRoutineCommand(run, [...options.reflex, ...args, "--json"], options.timeoutSeconds * 1000);
  if (result.code === 1) {
    const refusal = RefusalSchema.safeParse(JSON.parse(result.stdout || "null"));
    if (refusal.success && ["invalid-input", "not-found", "conflict"].includes(refusal.data.error.code)) throw new RoutineRefusal(refusal.data.error.message);
    if (refusal.success && refusal.data.error.code === "write-uncertain") throw new RoutineWriteFailure(refusal.data.error.message);
  }
  if (result.code !== 0) throw new Error(`Reflex did not confirm ${args[0]} (${result.code}). Check its state before retrying.`);
  return schema.parse(JSON.parse(result.stdout));
}

export interface RoutineView {
  installed: (InstalledRoutine & { title: string; words: string })[];
  pending: PendingRoutine[];
  done: { routineId: string; title: string; decisionId: string; at: string }[];
  changes: RoutineAction[];
  error?: string;
}
