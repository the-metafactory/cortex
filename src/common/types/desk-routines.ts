import { z } from "zod";

const CapabilityMapRef = /^(?:(?:github|gitlab):[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)+#[1-9]\d*$/;
const BudgetCount = z.number().int().min(1).max(1_000_000_000);

export const CapabilityBuildSchema = z.object({
  writer: z.array(z.string().min(1)).min(1),
  map: z.string().regex(CapabilityMapRef),
  template: z.string().min(1).optional(),
  budget: z.object({ tokens: BudgetCount, invocations: BudgetCount, minutes: BudgetCount }),
});
export type CapabilityBuildOptions = z.infer<typeof CapabilityBuildSchema>;

export const RoutineOptionsSchema = z.object({
  composer: z.array(z.string().min(1)).min(1),
  reflex: z.array(z.string().min(1)).min(1),
  target: z.string().regex(/^@[\w.-]+\/pulse-flow$/),
  timeZone: z.string().refine((s) => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } }),
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
  readTimeoutSeconds: z.number().min(0.01).max(5).default(3),
  capabilityBuild: CapabilityBuildSchema.optional(),
});
export type RoutineOptions = z.infer<typeof RoutineOptionsSchema>;
