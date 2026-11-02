import { z } from "zod";

export const ROUTINE_BACKGROUND_THRESHOLD = 6;
export const ROUTINE_FREQUENCY_WINDOW_MS = 86400000;
export const ROUTINE_FREQUENCY_LOOKAHEAD_MS = 7 * 86400000;
export const RoutineDisplayModeSchema = z.enum(["scheduled", "background"]);
export type RoutineDisplayMode = z.infer<typeof RoutineDisplayModeSchema>;
export const RoutineDisplayChoiceSchema = z.enum(["automatic", "scheduled", "background"]);
export type RoutineDisplayChoice = z.infer<typeof RoutineDisplayChoiceSchema>;
export const RoutineDisplaySourceSchema = z.enum(["stored", "frequency", "unknown"]);
export type RoutineDisplaySource = z.infer<typeof RoutineDisplaySourceSchema>;
const routineId = z.string().min(1).max(100);
const instant = z.iso.datetime({ offset: true });
const scope = { owner: z.literal("reflex"), principal: z.string().min(1).max(200), stack: z.string().min(1).max(200) };

export function maxStartsInWindow(starts: readonly number[], windowMs = ROUTINE_FREQUENCY_WINDOW_MS): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let best = 0; let first = 0;
  for (let last = 0; last < sorted.length; last++) {
    while ((sorted[last] ?? 0) - (sorted[first] ?? 0) >= windowMs) first++;
    best = Math.max(best, last - first + 1);
  }
  return best;
}
export const automaticMode = (maxDailyStarts: number): RoutineDisplayMode => maxDailyStarts > ROUTINE_BACKGROUND_THRESHOLD ? "background" : "scheduled";
export function resolveDisplay(stored: RoutineDisplayMode | null, automatic: RoutineDisplayMode | null): { mode: RoutineDisplayMode; source: RoutineDisplaySource } {
  if (stored) return { mode: stored, source: "stored" };
  if (automatic) return { mode: automatic, source: "frequency" };
  return { mode: "scheduled", source: "unknown" };
}

export const RoutineDisplayEntrySchema = z.object({
  routineId, stored: RoutineDisplayModeSchema.nullable(), automatic: RoutineDisplayModeSchema.nullable(), maxDailyStarts: z.number().int().nonnegative().nullable(),
  mode: RoutineDisplayModeSchema, source: RoutineDisplaySourceSchema,
}).strict().refine((entry) => {
  const resolved = resolveDisplay(entry.stored, entry.automatic);
  const automaticMatches = entry.maxDailyStarts === null ? entry.automatic === null : entry.automatic === automaticMode(entry.maxDailyStarts);
  return automaticMatches && resolved.mode === entry.mode && resolved.source === entry.source;
}, "The effective display does not follow the stored choice and frequency");
export type RoutineDisplayEntry = z.infer<typeof RoutineDisplayEntrySchema>;
export const RoutineFrequencySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), start: instant, end: instant }).strict(),
  z.object({ status: z.literal("unknown"), start: instant, end: instant, reason: z.string().min(1).max(300) }).strict(),
]);
export type RoutineFrequency = z.infer<typeof RoutineFrequencySchema>;
export const RoutineDisplayPageSchema = z.object({
  ...scope,
  threshold: z.literal(ROUTINE_BACKGROUND_THRESHOLD),
  frequency: RoutineFrequencySchema,
  routines: z.array(RoutineDisplayEntrySchema).max(2000),
}).strict().refine((page) => new Set(page.routines.map((entry) => entry.routineId)).size === page.routines.length, "Each routine appears at most once")
  .refine((page) => page.frequency.status === "known" || page.routines.every((entry) => entry.automatic === null), "Unknown frequency cannot resolve an automatic display");
export type RoutineDisplayPage = z.infer<typeof RoutineDisplayPageSchema>;
export const RoutineDisplayChangeSchema = z.object({ principal: scope.principal, stack: scope.stack, routineId, mode: RoutineDisplayChoiceSchema }).strict();
export type RoutineDisplayChange = z.infer<typeof RoutineDisplayChangeSchema>;
export const RoutineDisplayResultSchema = z.object({ ...scope, routineId, mode: RoutineDisplayChoiceSchema }).strict();
export type RoutineDisplayResult = z.infer<typeof RoutineDisplayResultSchema>;

export function buildDisplayEntry(routineId: string, stored: RoutineDisplayMode | null, maxDailyStarts: number | null): RoutineDisplayEntry {
  const automatic = maxDailyStarts === null ? null : automaticMode(maxDailyStarts);
  return { routineId, stored, automatic, maxDailyStarts, ...resolveDisplay(stored, automatic) };
}
export function displayEntry(page: Pick<RoutineDisplayPage, "frequency" | "routines">, id: string): RoutineDisplayEntry {
  return page.routines.find((entry) => entry.routineId === id) ?? buildDisplayEntry(id, null, page.frequency.status === "known" ? 0 : null);
}
