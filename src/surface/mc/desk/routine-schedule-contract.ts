import { z } from "zod";

export const ScheduleValueSchema = z.object({ schedule: z.string().min(1).max(1000), timezone: z.string().min(1).max(100).nullable() }).strict();
export type ScheduleValue = z.infer<typeof ScheduleValueSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
const timezone = z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const projection = ScheduleValueSchema.extend({ effectiveTimezone: timezone, occurrences: z.array(z.iso.datetime({ offset: true })).max(3) }).strict().superRefine((value, context) => {
  if (value.timezone !== null && value.timezone !== value.effectiveTimezone) context.addIssue({ code: "custom", message: "The effective timezone differs from the stored timezone" });
  if (value.occurrences.some((at, index) => index > 0 && Date.parse(at) <= Date.parse(value.occurrences[index - 1] ?? at))) context.addIssue({ code: "custom", message: "Schedule occurrences are not increasing" });
});
export const ScheduleDetailSchema = z.object({ id, revision, at: z.iso.datetime({ offset: true }), writable: z.boolean(), reason: z.string(), current: projection }).strict().superRefine((value, context) => {
  if (value.current.occurrences.some((at) => Date.parse(at) <= Date.parse(value.at))) context.addIssue({ code: "custom", message: "Schedule occurrences precede their owner reference time" });
});
export type ScheduleDetail = z.infer<typeof ScheduleDetailSchema>;
export const SchedulePreviewRequestSchema = ScheduleValueSchema.extend({ id, revision }).strict();
export type SchedulePreviewRequest = z.infer<typeof SchedulePreviewRequestSchema>;
export const SchedulePreviewSchema = z.object({ id, revision, proposedRevision: revision, at: z.iso.datetime({ offset: true }), current: projection, proposed: projection }).strict().superRefine((value, context) => {
  if ([...value.current.occurrences, ...value.proposed.occurrences].some((at) => Date.parse(at) <= Date.parse(value.at))) context.addIssue({ code: "custom", message: "Schedule occurrences precede their owner reference time" });
});
export type SchedulePreview = z.infer<typeof SchedulePreviewSchema>;
export const ScheduleActionSchema = ScheduleValueSchema.extend({ requestId: z.string().regex(/^[\w-]{8,64}$/), action: z.literal("schedule"), target: id, revision, proposedRevision: revision }).strict();
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;
