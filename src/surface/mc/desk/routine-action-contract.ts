import { z } from "zod";
import { LifecycleActionSchema } from "./routine-lifecycle-contract";
import { ScheduleActionSchema } from "./routine-schedule-contract";

export const LegacyRoutineActionSchema = z.object({
  requestId: z.string().regex(/^[\w-]{8,64}$/),
  action: z.enum(["install", "remove", "auto", "stop", "approve", "deny"]),
  target: z.string().min(1).max(128),
}).strict();
export type LegacyRoutineAction = z.infer<typeof LegacyRoutineActionSchema>;
export const RoutineActionSchema = z.union([LegacyRoutineActionSchema, ScheduleActionSchema, LifecycleActionSchema]);
export type RoutineAction = z.infer<typeof RoutineActionSchema>;
export const RoutineResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), uncertain: z.literal(true).optional() }),
]);
export type RoutineResult = z.infer<typeof RoutineResultSchema>;
