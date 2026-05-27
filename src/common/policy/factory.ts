/**
 * IAW Phase C.2a (cortex#115) — PolicyEngine factory from CortexConfig.
 * IAW Phase D.3 (cortex#116) — passes the federation slice through.
 *
 * Builds a `PolicyEngine` from the optional `policy:` block on
 * `CortexConfig`. Returns `undefined` when the block is absent OR
 * empty (no principals declared) so callers can branch on engine
 * presence without parsing the config shape themselves.
 *
 * Phase C.3 wires this factory into the cortex.ts boot path. C.2b
 * (later) removes the per-adapter `roles[]` legacy shape and makes
 * `policy:` the authoritative source — at which point this factory
 * always returns an engine for cortex.yaml configs (AgentConfig stays
 * as legacy without a policy block, mapping to `undefined` here).
 * Phase D.3 threads the `policy.federated` slice into the engine so
 * federated dispatches (`intent.source_network` set) get the
 * per-network membership check.
 *
 * Cross-references:
 *   - `src/common/policy/engine.ts` — the engine this factory builds.
 *   - `src/common/types/cortex-config.ts` — `PolicySchema` /
 *     `Policy` / `PolicyPrincipal` / `PolicyRole` /
 *     `PolicyFederated`.
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107.
 *   - `docs/plan-internet-of-agentic-work.md` §D.3.
 */

import { PolicyEngine, type FederatedPolicy } from "./engine";
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
  // IAW Phase D.3 — narrow the parsed federated block to the engine's
  // slim `FederatedPolicy` shape. The engine only reads `id` +
  // `peers[].stack_id`; other fields (`accept_subjects`,
  // `deny_subjects`, `max_hop`, `announce_capabilities`,
  // `operator_pubkey`, `operator_id`, `leaf_node`) are consumed
  // elsewhere (surface-router D.2, verifier, registry D.4).
  const federated: FederatedPolicy | undefined = policy.federated
    ? {
        networks: policy.federated.networks.map((n) => ({
          id: n.id,
          peers: n.peers.map((p) => ({ stack_id: p.stack_id })),
        })),
      }
    : undefined;
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
    ...(federated !== undefined && { federated }),
  });
}
