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
import type { Principal, RoleDefinition } from "./types";
import type { Policy } from "../types/cortex-config";

/**
 * cortex#1167 — the single, minimal-privilege PUBLIC-DOMAIN principal.
 *
 * Pier (and any agent flagged `openOnboarding`) is a public surface: it
 * answers questions and holds NOTHING. Both admissions (Tier-1 community-fleet
 * role, Tier-2 network admit) are HUMAN gates — Pier mints no credentials.
 *
 * Every unmapped inbound sender reaching a flagged agent's PUBLIC channel is
 * attributed to THIS ONE principal (the per-sender id is kept only as an audit
 * label). It is a REAL engine entry so `engine.check` PASSES at every gate
 * (adapter, publisher, dispatch-listener) instead of being denied as an
 * unknown principal — but it holds EXACTLY ONE kind of capability:
 * `dispatch.<agentId>` for each `openOnboarding` agent, and NOTHING else (no
 * operator, no `keyword.*`, no `tool.*`, no dispatch to non-onboarding agents,
 * no admit, no bus). Working WITH the engine, not carving the deny out at N
 * layers.
 */
export const PUBLIC_PRINCIPAL_ID = "public";
/** The synthetic role id the public principal holds. */
export const PUBLIC_ROLE_ID = "public-domain";

/**
 * Build the synthetic public principal + role for the engine, granting exactly
 * `dispatch.<agentId>` per flagged agent. Returns empty arrays when there are
 * no flagged agents (the public principal would have zero capability and is not
 * worth registering — and an unmapped sender to a non-flagged agent must stay
 * denied). Pure.
 *
 * @param openOnboardingAgentIds ids of agents flagged `openOnboarding`.
 * @param homePrincipal stack's home principal id (diagnostic / home_principal).
 * @param homeStack stack's `{principal}/{stack}` id (diagnostic / home_stack).
 */
export function buildPublicPrincipalEntries(
  openOnboardingAgentIds: readonly string[],
  homePrincipal: string,
  homeStack: string,
): { principals: Principal[]; roles: RoleDefinition[] } {
  const ids = [...new Set(openOnboardingAgentIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return { principals: [], roles: [] };
  const capabilities = ids.map((agentId) => `dispatch.${agentId}`);
  return {
    principals: [
      {
        id: PUBLIC_PRINCIPAL_ID,
        home_principal: homePrincipal,
        home_stack: homeStack,
        role: [PUBLIC_ROLE_ID],
        trust: [],
        // NO platform_ids — the public principal is not one person; it is
        // never resolved via the (platform, authorId) index. The dispatch
        // handler attributes unmapped senders to it explicitly.
      },
    ],
    roles: [
      {
        id: PUBLIC_ROLE_ID,
        // EXACTLY the dispatch-to-flagged-agent capabilities. Nothing else.
        capabilities,
      },
    ],
  };
}

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
  openOnboardingAgentIds: readonly string[] = [],
): PolicyEngine | undefined {
  if (policy === undefined) return undefined;
  const [first] = policy.principals;
  if (first === undefined) return undefined;
  // cortex#1167 — synthesise the single public-domain principal (one capability
  // per flagged agent: dispatch.<agentId>). Home principal/stack are diagnostic
  // only; borrow the first real principal's so the synthetic entry is
  // well-formed. No-op (empty) when no agent is flagged.
  const publicEntries = buildPublicPrincipalEntries(
    openOnboardingAgentIds,
    first.home_principal,
    first.home_stack,
  );
  // IAW Phase D.3 — narrow the parsed federated block to the engine's
  // slim `FederatedPolicy` shape. The engine only reads `id` +
  // `peers[].stack_id`; other fields (`accept_subjects`,
  // `deny_subjects`, `max_hop`, `announce_capabilities`,
  // `principal_pubkey`, `principal_id`, `leaf_node`) are consumed
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
    principals: [
      ...policy.principals.map((p) => ({
        id: p.id,
        home_principal: p.home_principal,
        home_stack: p.home_stack,
        role: p.role,
        trust: p.trust,
        // IAW cortex#482 — thread platform_ids onto the engine so it
        // can back-resolve adapter-originated `did:mf:<platform>-<authorId>`
        // DIDs to a principal id. The Zod schema defaults the map to `{}`
        // (per `PolicyPrincipalSchema.platform_ids`); forward as-is.
        platform_ids: p.platform_ids,
      })),
      // cortex#1167 — the synthetic public-domain principal (after the real
      // ones; no platform_ids so it never collides in the lookup index).
      ...publicEntries.principals,
    ],
    roles: [
      ...policy.roles.map((r) => ({
        id: r.id,
        capabilities: r.capabilities,
      })),
      ...publicEntries.roles,
    ],
    ...(federated !== undefined && { federated }),
  });
}
