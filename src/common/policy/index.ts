/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine surface.
 * v2.0.0 cutover (cortex#297) — parallel-mode plumbing retired; policy-gate
 * primitives replace it.
 *
 * Public re-exports for the policy module. Callers import from
 * `src/common/policy` (this index) rather than from `./types` or
 * `./engine` directly — the module's external shape is fixed at the
 * index and the internal split is free to evolve.
 */

export {
  PolicyEngine,
  type PolicyEngineOptions,
  type FederatedPolicy,
  type FederatedNetwork,
} from "./engine";
export type {
  Intent,
  IntentSovereignty,
  PolicyDecision,
  PolicyDenyReason,
  Principal,
  RoleDefinition,
} from "./types";
export { policyEngineFromConfig } from "./factory";
export {
  PlatformPrincipalIndex,
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
  defaultPolicySovereignty,
  type PolicyGateSovereignty,
  type PrincipalRegistry,
} from "./policy-gate";
export { resolvePolicyAccess, isOperatorPrincipal } from "./resolve-access";
export { CLAUDE_TOOL_INVENTORY } from "./tool-inventory";
