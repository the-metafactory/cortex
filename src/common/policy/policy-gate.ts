/**
 * v2.0.0 cutover (cortex#297) — policy-gate primitives for adapters.
 *
 * Replaces the parallel-mode plumbing introduced in cortex#296. The legacy
 * role-resolver is gone; PolicyEngine is the sole authorisation gate. This
 * module provides the primitives each adapter (Discord, Mattermost, Slack,
 * future) consumes:
 *
 *   - {@link PlatformPrincipalIndex} — `(platform_name, platform_id) →
 *     principal_id` lookup built from `policy.principals[].platform_ids`.
 *     Adapters resolve inbound `message.author.id` to a principal id via
 *     this index before calling the engine.
 *
 *   - {@link buildPlatformPrincipalIndex} / {@link buildPrincipalRegistry} —
 *     factories that materialise the index + a `principal_id → principal`
 *     lookup from the parsed `policy:` block.
 *
 *   - {@link defaultPolicySovereignty} — the default sovereignty constraints
 *     adapter-side intents carry. Mirrors `defaultSystemSovereignty` in
 *     `src/bus/system-events.ts` so audit envelopes line up.
 *
 * Cross-references:
 *   - `docs/design-policy-cutover.md` §5 — capability/principal model.
 *   - `docs/iteration-policy-cutover.md` cortex#297 — slice scope.
 *   - `src/common/policy/engine.ts` — the PolicyEngine adapters consult.
 */

import type { Policy, PolicyPrincipal } from "../types/cortex-config";

/**
 * `(platform_name, platform_id) → principal_id` lookup index built from a
 * parsed `policy.principals[]` array. Schema validates tuple-uniqueness
 * across all principals at parse time
 * (`PolicySchema.superRefine` in `cortex-config.ts`), so the lookup is
 * deterministic — at most one principal claims any given platform identity.
 *
 * Built once at adapter construction time. Read-only at runtime; backed
 * by an internal `Map`.
 *
 * **Duplication note (PR #483 — keep in sync with the engine-side
 * reverse index `principalIdByPlatformId` in
 * `src/common/policy/engine.ts`).** Both indexes are built from
 * the same `policy.principals[].platform_ids` shape but serve
 * different boundaries (adapter-side pre-publish vs runner-side
 * post-verify). Schema changes (case-folding, platform-name
 * canonicalisation, deprecation) must land in BOTH places or the
 * boundaries drift. See `PolicyEngine.principalIdByPlatformId`
 * JSDoc for the full justification.
 */
export class PlatformPrincipalIndex {
  private readonly map: ReadonlyMap<string, string>;

  constructor(principals: readonly PolicyPrincipal[]) {
    const m = new Map<string, string>();
    for (const p of principals) {
      for (const [platformName, ids] of Object.entries(p.platform_ids)) {
        for (const platformId of ids) {
          // Schema-side uniqueness guarantees no collision; if a duplicate
          // slips through (caller bypassed parse), prefer the first-declared
          // principal as the deterministic choice.
          // PR #310 r1 N-1 fix — use `:` separator so a future platform
          // whose name is a prefix of another doesn't alias keys.
          const key = `${platformName}:${platformId}`;
          if (!m.has(key)) m.set(key, p.id);
        }
      }
    }
    this.map = m;
  }

  /**
   * Resolve a `(platform, platformId)` tuple to a principal id. Returns
   * `undefined` when no principal claims that platform identity — adapter
   * denies the inbound message at the resolve-access path.
   */
  resolve(platform: string, platformId: string): string | undefined {
    return this.map.get(`${platform}:${platformId}`);
  }

  /** Number of `(platform, id)` tuples in the index. Useful for boot logs. */
  get size(): number {
    return this.map.size;
  }
}

/**
 * Build a {@link PlatformPrincipalIndex} from the optional `policy:` block.
 * Returns `undefined` when no policy is declared OR no principals are
 * declared — adapters then deny every inbound message at the resolve-access
 * path (no principal registry to authorise against).
 */
export function buildPlatformPrincipalIndex(
  policy: Policy | undefined,
): PlatformPrincipalIndex | undefined {
  if (policy === undefined) return undefined;
  if (policy.principals.length === 0) return undefined;
  return new PlatformPrincipalIndex(policy.principals);
}

/**
 * `principal_id → PolicyPrincipal` registry. Adapters consult this for
 * `session_config` (CC session-construction parameters) after the engine
 * has authorised a capability. PolicyEngine itself doesn't expose the
 * principal record — the engine's job is yes/no on a capability claim;
 * session config is a separate concern that lives on the principal.
 */
export type PrincipalRegistry = ReadonlyMap<string, PolicyPrincipal>;

/**
 * Build a {@link PrincipalRegistry} from the optional `policy:` block.
 * Returns `undefined` when no policy / no principals (mirrors the
 * `buildPlatformPrincipalIndex` contract so adapters branch on engine
 * presence once).
 */
export function buildPrincipalRegistry(
  policy: Policy | undefined,
): PrincipalRegistry | undefined {
  if (policy === undefined) return undefined;
  if (policy.principals.length === 0) return undefined;
  return new Map(policy.principals.map((p) => [p.id, p]));
}

/**
 * Sovereignty shape the policy gate carries on synthesised intents.
 * Mirrors `Intent.sovereignty` structurally.
 */
export interface PolicyGateSovereignty {
  classification: "local" | "federated" | "public";
  data_residency: string;
  max_hop: number;
  frontier_ok: boolean;
  model_class: "local-only" | "frontier" | "any";
}

/**
 * Default sovereignty for adapter-side intents (`local-only` / NZ /
 * `max_hop=0` / `frontier_ok=false` / `model_class=local-only`). Adapters
 * override only when the inbound platform message carries sovereignty
 * context (none do today — future surface).
 *
 * Mirrors `defaultSystemSovereignty` in `src/bus/system-events.ts` so
 * audit envelopes match adapter-side intents verbatim on the
 * sovereignty axis.
 */
export function defaultPolicySovereignty(
  dataResidency = "NZ",
): PolicyGateSovereignty {
  return {
    classification: "local",
    data_residency: dataResidency,
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}
