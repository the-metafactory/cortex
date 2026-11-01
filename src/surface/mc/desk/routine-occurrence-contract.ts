import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
function timezoneExists(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}
const timezone = z.string().min(1).max(100).refine(timezoneExists);
export const RoutineOccurrenceQuerySchema = z.object({
  start: instant, end: instant, timezone,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().min(1).max(2000).optional(),
}).strict().refine((q) => Date.parse(q.end) > Date.parse(q.start) && Date.parse(q.end) - Date.parse(q.start) <= 32 * 86400000, "Choose a positive range of at most 32 days");
export type RoutineOccurrenceQuery = z.infer<typeof RoutineOccurrenceQuerySchema>;
function occurrenceSchema(zone: typeof timezone) {
  return z.object({
    routineId: z.string().min(1), schedule: z.string().min(1), sourceTimezone: zone,
    lifecycle: z.enum(["active", "disabled", "paused"]), handlingPolicy: z.enum(["auto", "approval"]).nullable(),
    readOnly: z.boolean(), scheduledFor: instant,
    capabilities: z.object({ editParameters: z.boolean(), editSchedule: z.boolean(), pause: z.boolean(), delete: z.boolean(), setPolicy: z.boolean() }).strict(),
  }).strict();
}
function pageSchema(zone: typeof timezone) {
  return z.object({
    owner: z.literal("reflex"), principal: z.string().min(1), stack: z.string().min(1),
    start: instant, end: instant, timezone: zone, meaning: z.literal("planned-trigger"),
    occurrences: z.array(occurrenceSchema(zone)).max(1000), complete: z.boolean(), nextCursor: z.string().min(1).max(2000).nullable(),
    counts: z.object({ scope: z.literal("page"), total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), disabled: z.number().int().nonnegative() }).strict(),
  }).strict();
}
export const RoutineOccurrenceSchema = occurrenceSchema(timezone);
export const RoutineOccurrencePageSchema = pageSchema(timezone);
export type RoutineOccurrencePage = z.infer<typeof RoutineOccurrencePageSchema>;
export function createRoutineOccurrencePageSchema(validateTimezone = timezoneExists) {
  const checked = new Map<string, boolean>();
  const zone = z.string().min(1).max(100).refine((value) => {
    const previous = checked.get(value); if (previous !== undefined) return previous;
    const valid = validateTimezone(value); checked.set(value, valid); return valid;
  });
  return pageSchema(zone);
}
