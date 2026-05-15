/**
 * IAW Phase C.2a (cortex#115) — PolicyEngine factory from CortexConfig.
 *
 * Builds a `PolicyEngine` from the optional `policy:` block on
 * `CortexConfig`. Returns `undefined` when the block is absent OR
 * empty (no principals declared) so callers can branch on engine
 * presence without parsing the config shape themselves.
 *
 * Phase C.3 wires this factory into the cortex.ts boot path. C.2b
 * (later) removes the per-adapter `roles[]` legacy shape and makes
 * `policy:` the authoritative source — at which point this factory
 * always returns an engine for cortex.yaml configs (BotConfig stays
 * as legacy without a policy block, mapping to `undefined` here).
 *
 * Cross-references:
 *   - `src/common/policy/engine.ts` — the engine this factory builds.
 *   - `src/common/types/cortex-config.ts` — `PolicySchema` /
 *     `Policy` / `PolicyPrincipal` / `PolicyRole`.
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107.
 */

import { PolicyEngine } from "./engine";
import type { Policy } from "../types/cortex-config";

/**
 * Build a PolicyEngine from a parsed `policy:` block.
 *
 * - `undefined` policy → `undefined` engine (no policy declared in
 *   cortex.yaml; callers fall back to per-adapter roles until C.2b
 *   cuts that path).
 * - Empty principals → `undefined` engine (a policy block with
 *   only roles declared is structurally valid but has nothing to
 *   authorise; treat as "no engine wanted").
 * - Otherwise → engine with principals + roles bound.
 *
 * The Zod schema already validates cross-refs (every
 * `principal.role[]` resolves to a declared role; every
 * `principal.trust[]` resolves to a declared principal) — this
 * factory assumes a validated `Policy` value and does no
 * additional checking.
 */
export function policyEngineFromConfig(
  policy: Policy | undefined,
): PolicyEngine | undefined {
  if (policy === undefined) return undefined;
  if (policy.principals.length === 0) return undefined;
  return new PolicyEngine({
    principals: policy.principals.map((p) => ({
      id: p.id,
      home_operator: p.home_operator,
      home_stack: p.home_stack,
      role: p.role,
      trust: p.trust,
    })),
    roles: policy.roles.map((r) => ({
      id: r.id,
      capabilities: r.capabilities,
    })),
  });
}
