import { z } from "zod";

export const RoutineDisplayModeSchema = z.enum(["scheduled", "background"]);
export type RoutineDisplayMode = z.infer<typeof RoutineDisplayModeSchema>;
const routineId = z.string().min(1).max(100);
const scope = { owner: z.literal("reflex"), principal: z.string().min(1).max(200), stack: z.string().min(1).max(200) };
export const RoutineDisplayPageSchema = z.object({
  ...scope,
  preferences: z.array(z.object({ routineId, mode: z.literal("background"), updatedAt: z.iso.datetime({ offset: true }) }).strict()).max(1000),
}).strict().refine((page) => new Set(page.preferences.map((entry) => entry.routineId)).size === page.preferences.length, "Each routine has at most one display preference");
export type RoutineDisplayPage = z.infer<typeof RoutineDisplayPageSchema>;
export const RoutineDisplayChangeSchema = z.object({ principal: scope.principal, stack: scope.stack, routineId, mode: RoutineDisplayModeSchema }).strict();
export type RoutineDisplayChange = z.infer<typeof RoutineDisplayChangeSchema>;
export const RoutineDisplayResultSchema = z.object({ ...scope, routineId, mode: RoutineDisplayModeSchema }).strict();
export type RoutineDisplayResult = z.infer<typeof RoutineDisplayResultSchema>;
