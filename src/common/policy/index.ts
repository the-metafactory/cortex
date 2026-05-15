/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine surface.
 *
 * Public re-exports for the policy module. Callers import from
 * `src/common/policy` (this index) rather than from `./types` or
 * `./engine` directly — the module's external shape is fixed at the
 * index and the internal split is free to evolve (C.2 will likely
 * add a `./schema.ts` for the Zod schema of the new `policy:` block).
 */

export { PolicyEngine, type PolicyEngineOptions } from "./engine";
export type {
  Intent,
  IntentSovereignty,
  PolicyDecision,
  PolicyDenyReason,
  Principal,
  RoleDefinition,
} from "./types";
export { policyEngineFromConfig } from "./factory";
