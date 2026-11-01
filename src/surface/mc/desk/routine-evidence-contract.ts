import { z } from "zod";

export const RoutineEvidenceIdSchema = z.string().min(1).max(1000).regex(/^[a-z0-9][a-z0-9-]*$/);
const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
export const RoutineHistoryQuerySchema = z.object({
  routineId: RoutineEvidenceIdSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(2000).optional(),
}).strict();
export type RoutineHistoryQuery = z.infer<typeof RoutineHistoryQuerySchema>;
export const RoutineDecisionSchema = z.object({
  decisionId: uuid, routineId: RoutineEvidenceIdSchema, routineName: z.string().min(1).max(300), nameSource: z.enum(["recorded", "identifier"]),
  target: z.string().max(300).nullable(), definitionPresent: z.boolean(),
  decision: z.enum(["ignored", "matched", "blocked", "fired", "denied", "expired"]), at: instant, trigger: z.literal("schedule"),
  correlationId: uuid.nullable(), resolutionOf: uuid.nullable(),
  approval: z.object({ state: z.enum(["waiting", "approved", "denied", "expired"]), decidedAt: instant.nullable(), expiresAt: instant }).strict().nullable(),
}).strict();
export type RoutineDecision = z.infer<typeof RoutineDecisionSchema>;
export const RoutineDecisionPageSchema = z.object({
  owner: z.literal("reflex"), principal: z.string(), stack: z.string(), routineId: RoutineEvidenceIdSchema.nullable(),
  records: z.array(RoutineDecisionSchema).max(100), complete: z.boolean(), nextCursor: z.string().min(1).max(2000).nullable(),
}).strict();
export const RoutineLogFileSchema = z.object({
  ref: z.enum(["process-audit", "stdout", "stderr"]), filename: z.string(), type: z.string(),
  availability: z.enum(["available", "unavailable"]), reason: z.string().nullable(),
});
export type RoutineLogFile = z.infer<typeof RoutineLogFileSchema>;
export const RoutineExecutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-started"), reason: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.string(), evidence: z.enum(["missing-or-delayed", "unscoped", "conflicting", "incomplete"]) }),
  z.object({ kind: z.literal("observed"), owner: z.literal("cortex-process"), executionId: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["running", "succeeded", "failed"]), freshness: z.enum(["recorded", "stale"]), startedAt: instant,
    endedAt: instant.nullable(), durationMs: z.number().nonnegative().nullable(), files: z.array(RoutineLogFileSchema),
  }),
]);
export type RoutineExecution = z.infer<typeof RoutineExecutionSchema>;
export type RoutineEvidenceRecord = RoutineDecision & { execution: RoutineExecution };
export const RoutineLogQuerySchema = z.object({
  routineId: RoutineEvidenceIdSchema, decisionId: uuid, executionId: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.enum(["process-audit", "stdout", "stderr"]), offset: z.coerce.number().int().min(0).max(4000000).default(0),
  limit: z.coerce.number().int().min(1).max(65536).default(16384), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  download: z.enum(["0", "1"]).default("0"),
}).strict().refine((q) => q.offset === 0 || Boolean(q.revision), "Continuation requires the file revision");
export type RoutineLogQuery = z.infer<typeof RoutineLogQuerySchema>;
