import { z } from "zod";
import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";

const instant = z.iso.datetime({ offset: true });
const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
});
export const RoutineOccurrenceQuerySchema = z.object({
  start: instant, end: instant, timezone,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().min(1).max(2000).optional(),
}).strict().refine((q) => Date.parse(q.end) > Date.parse(q.start) && Date.parse(q.end) - Date.parse(q.start) <= 32 * 86400000, "Choose a positive range of at most 32 days");
export type RoutineOccurrenceQuery = z.infer<typeof RoutineOccurrenceQuerySchema>;
export const RoutineOccurrenceSchema = z.object({
  routineId: z.string().min(1), schedule: z.string().min(1), sourceTimezone: timezone,
  lifecycle: z.enum(["active", "disabled", "paused"]), handlingPolicy: z.enum(["auto", "approval"]).nullable(),
  readOnly: z.boolean(), scheduledFor: instant,
  capabilities: z.object({ editParameters: z.boolean(), editSchedule: z.boolean(), pause: z.boolean(), delete: z.boolean(), setPolicy: z.boolean() }).strict(),
}).strict();
export const RoutineOccurrencePageSchema = z.object({
  owner: z.literal("reflex"), principal: z.string().min(1), stack: z.string().min(1),
  start: instant, end: instant, timezone, meaning: z.literal("planned-trigger"),
  occurrences: z.array(RoutineOccurrenceSchema).max(1000), complete: z.boolean(), nextCursor: z.string().min(1).max(2000).nullable(),
  counts: z.object({ scope: z.literal("page"), total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), disabled: z.number().int().nonnegative() }).strict(),
}).strict();
export type RoutineOccurrencePage = z.infer<typeof RoutineOccurrencePageSchema>;

export async function readRoutineOccurrences(options: RoutineOptions, input: RoutineOccurrenceQuery, scope: { principal: string; stack: string }, run?: RoutineRunner): Promise<RoutineOccurrencePage> {
  const query = RoutineOccurrenceQuerySchema.parse(input);
  const page = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, [
    "routine", "occurrences", "--principal", scope.principal, "--stack", scope.stack, "--start", query.start, "--end", query.end, "--timezone", query.timezone,
    "--limit", String(query.limit), ...(query.cursor ? ["--cursor", query.cursor] : []),
  ], RoutineOccurrencePageSchema, run);
  const records = page.occurrences;
  const active = records.filter((r) => r.lifecycle === "active").length;
  const disabled = records.filter((r) => r.lifecycle !== "active").length;
  if (page.principal !== scope.principal || page.stack !== scope.stack || page.start !== query.start || page.end !== query.end || page.timezone !== query.timezone || records.length > query.limit || page.complete !== (page.nextCursor === null) || (!page.complete && !records.length) || page.counts.total !== records.length || page.counts.active !== active || page.counts.disabled !== disabled) throw new Error("The routine owner returned an inconsistent calendar page.");
  const seen = new Set<string>();
  let previous = "";
  for (const record of records) {
    const time = Date.parse(record.scheduledFor);
    const key = `${new Date(time).toISOString()}\0${record.routineId}`;
    if (time < Date.parse(query.start) || time >= Date.parse(query.end) || seen.has(key) || key < previous || (record.readOnly && Object.values(record.capabilities).some(Boolean))) throw new Error("The routine owner returned an invalid calendar occurrence.");
    seen.add(key);
    previous = key;
  }
  return page;
}
