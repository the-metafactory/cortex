import { z } from "zod";

export const RoutineOptionsSchema = z.object({
  composer: z.array(z.string().min(1)).min(1),
  reflex: z.array(z.string().min(1)).min(1),
  target: z.string().regex(/^@[\w.-]+\/pulse-flow$/),
  timeZone: z.string().refine((s) => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } }),
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
  readTimeoutSeconds: z.number().min(0.01).max(5).default(3),
});
export type RoutineOptions = z.infer<typeof RoutineOptionsSchema>;
