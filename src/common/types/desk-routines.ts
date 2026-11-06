import { z } from "zod";

const CapabilityMapRef = /^(?:(?:github|gitlab):[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)+#[1-9]\d*$/;
const BudgetCount = z.number().int().min(1).max(1_000_000_000);
const NodeCommand = z.array(z.string().min(1)).min(1).refine((argv) => argv.some((arg) => arg.includes("{ref}") || arg.includes("{id}")), "must pass the node with {ref} or {id}");

const BundleCommand = z.array(z.string().min(1)).min(1).refine((argv) => argv.some((arg) => arg.includes("{bundle}")), "must pass the bundle with {bundle}");

export const CapabilityBuildSchema = z.object({
  writer: z.array(z.string().min(1)).min(1),
  map: z.string().regex(CapabilityMapRef),
  template: z.string().min(1).optional(),
  start: NodeCommand.optional(),
  status: NodeCommand.optional(),
  bundle: z.string().regex(/^[\w.-]+(?::[\w.-]+)?$/).optional(),
  install: BundleCommand.optional(),
  uninstall: BundleCommand.optional(),
  budget: z.object({ tokens: BudgetCount, invocations: BudgetCount, minutes: BudgetCount }),
}).refine((build) => !build.install && !build.uninstall && !build.bundle || Boolean(build.install && build.uninstall && build.bundle && build.status), "bundle, install, uninstall and status must be configured together");
export type CapabilityBuildOptions = z.infer<typeof CapabilityBuildSchema>;

export const ROUTINE_COMPOSE_TIMEOUT_SECONDS = 900;

export const RoutineOptionsSchema = z.object({
  composer: z.array(z.string().min(1)).min(1),
  reflex: z.array(z.string().min(1)).min(1),
  target: z.string().regex(/^@[\w.-]+\/pulse-flow$/),
  timeZone: z.string().refine((s) => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } }),
  timeoutSeconds: z.number().int().min(1).max(300).default(120),
  composeTimeoutSeconds: z.number().int().min(1).max(1800).default(ROUTINE_COMPOSE_TIMEOUT_SECONDS),
  readTimeoutSeconds: z.number().min(0.01).max(5).default(3),
  capabilityBuild: CapabilityBuildSchema.optional(),
});
export type RoutineOptions = z.infer<typeof RoutineOptionsSchema>;
