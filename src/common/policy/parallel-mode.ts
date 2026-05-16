/**
 * IAW Phase C.2b-242a (cortex#296) — adapter-side parallel-mode plumbing.
 *
 * Wires the legacy role-resolver and the new PolicyEngine side-by-
 * side on every inbound platform message, computes the most-restrictive
 * intersection of their decisions (§9.1 security default — NOT
 * new-system-wins), and surfaces disagreements as
 * `system.access.disagreement` envelopes for operator-visible
 * validation BEFORE cortex#297 retires the legacy gate.
 *
 * The module is deliberately platform-agnostic: Discord, Mattermost,
 * and Slack adapters all consume the same `PlatformPrincipalIndex`
 * lookup + `runParallelModeChecks` helper. The adapters supply the
 * platform name (`"discord"` / `"mattermost"` / `"slack"`) and the
 * legacy `AccessDecision` they already computed; this module performs
 * the per-capability AND-merge and returns the effective decision +
 * the list of disagreement envelopes to publish.
 *
 * Cross-references:
 *   - `docs/design-policy-cutover.md` §9.1 — intersection-wins
 *     conflict resolution + operator pre-flight contract.
 *   - `docs/iteration-policy-cutover.md` cortex#296 — slice scope.
 *   - {@link createSystemAccessDisagreementEvent} — the envelope this
 *     module emits.
 *
 * Retirement: cortex#297 (242b) deletes role-resolver.ts and removes
 * the only caller of this module — the file then retires alongside
 * the legacy gate.
 */

import type { Policy, PolicyPrincipal } from "../types/cortex-config";
import type { Intent, PolicyDenyReason } from "./types";
import type { PolicyEngine } from "./engine";

/**
 * `(platform_name, platform_id) → principal_id` lookup index built
 * from a parsed `policy.principals[]` array. The schema validates
 * tuple-uniqueness across all principals at parse time (cortex#243a
 * `PolicySchema.superRefine`), so the lookup is deterministic — at
 * most one principal claims any given platform identity.
 *
 * Built once at adapter construction time and re-built on hot-reload
 * (out of scope here; F-092 covers updateConfig). The index is read-
 * only at runtime so a `ReadonlyMap` is the natural representation.
 */
export class PlatformPrincipalIndex {
  private readonly map: ReadonlyMap<string, string>;

  constructor(principals: readonly PolicyPrincipal[]) {
    const m = new Map<string, string>();
    for (const p of principals) {
      for (const [platformName, ids] of Object.entries(p.platform_ids)) {
        for (const platformId of ids) {
          // Schema-side uniqueness guarantees no collision; if a
          // duplicate slips through (caller bypassed parse), prefer
          // the first-declared principal (the deterministic choice).
          const key = `${platformName}${platformId}`;
          if (!m.has(key)) m.set(key, p.id);
        }
      }
    }
    this.map = m;
  }

  /**
   * Resolve a `(platform, platformId)` tuple to a principal id.
   * Returns `undefined` when no principal claims that platform
   * identity — the new gate then surfaces `unknown_principal` in
   * the disagreement envelope's `new_reason`.
   */
  resolve(platform: string, platformId: string): string | undefined {
    return this.map.get(`${platform}${platformId}`);
  }

  /** Number of `(platform, id)` tuples in the index. Useful for boot logs. */
  get size(): number {
    return this.map.size;
  }
}

/**
 * Build a {@link PlatformPrincipalIndex} from the optional `policy:`
 * block on the parsed config. Returns `undefined` when no policy is
 * declared OR no principals are declared — adapters then never run
 * parallel mode regardless of the `parallel_mode_enabled` flag (no
 * principals to look up against).
 */
export function buildPlatformPrincipalIndex(
  policy: Policy | undefined,
): PlatformPrincipalIndex | undefined {
  if (policy === undefined) return undefined;
  if (policy.principals.length === 0) return undefined;
  return new PlatformPrincipalIndex(policy.principals);
}

/**
 * Per-capability gate decision. Both gates produce one of these for
 * each capability the adapter wants to check; the orchestrator
 * AND-merges them and emits a disagreement envelope when the pair
 * differs.
 */
export interface GateDecision {
  /** `true` when this gate authorised the capability. */
  allow: boolean;
  /**
   * Short human-readable reason. For the legacy gate, free-form
   * strings like `"role.user.allows"`, `"defaultRole.denied"`,
   * `"no_role_matched"`. For the new gate, typically the
   * `PolicyDenyReason.kind` value on deny, `"capability_granted"`
   * on allow. Used only for disagreement-envelope triage.
   */
  reason: string;
}

/**
 * Sovereignty shape this module needs from a caller. Mirrors
 * {@link Intent.sovereignty} structurally — adapters that synthesise
 * an intent for the new gate pass the same default sovereignty here
 * for the disagreement envelope.
 */
export interface ParallelModeSovereignty {
  classification: "local" | "federated" | "public";
  data_residency: string;
  max_hop: number;
  frontier_ok: boolean;
  model_class: "local-only" | "frontier" | "any";
}

/**
 * Default sovereignty for adapter-side parallel-mode intents.
 * `local-only` / NZ / max_hop=0 / frontier_ok=false / model_class=local-only.
 * Adapters override only when the inbound platform message carries
 * sovereignty context (none do today — that's a future surface).
 *
 * Mirrors `defaultSystemSovereignty` in `src/bus/system-events.ts` so
 * disagreement envelopes match sibling `system.access.*` envelopes
 * verbatim on the sovereignty axis.
 */
export function defaultParallelModeSovereignty(
  dataResidency = "NZ",
): ParallelModeSovereignty {
  return {
    classification: "local",
    data_residency: dataResidency,
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

/**
 * Translate a deny reason from the engine into the short string the
 * disagreement envelope's `new_reason` carries. Surfaces a single,
 * dotted, kind-prefixed token per kind so dashboard renderers can
 * branch on the prefix.
 */
function describeDenyReason(reason: PolicyDenyReason): string {
  switch (reason.kind) {
    case "unknown_principal":
      return "unknown_principal";
    case "insufficient_role":
      return `insufficient_role:${reason.missing_capability}`;
    case "sovereignty_mismatch":
      return "sovereignty_mismatch";
    case "unknown_network":
      return `unknown_network:${reason.source_network}`;
    case "stack_not_in_network":
      return `stack_not_in_network:${reason.source_network}`;
    case "unknown_federated_peer":
      return `unknown_federated_peer:${reason.source_network}`;
    /* istanbul ignore next — exhaustiveness guard */
    default:
      return "denied";
  }
}

/**
 * Ask the new gate (PolicyEngine) for a verdict on a single
 * capability for a resolved principal. Returns the gate decision +
 * the short reason string the disagreement envelope's `new_reason`
 * carries.
 *
 * Resolution failure is treated as a deny with kind
 * `"unknown_principal"` — the engine itself returns that kind when
 * the principal isn't in the registry; this helper mirrors the
 * behaviour for the pre-resolution case (no `platform_ids` match) so
 * adapter call-sites have one branch to handle.
 */
export function checkCapabilityViaEngine(
  engine: PolicyEngine,
  principalId: string | undefined,
  capability: string,
  sovereignty: ParallelModeSovereignty,
): GateDecision {
  if (principalId === undefined) {
    // No `platform_ids` entry matched — the new gate can't authorise
    // an actor it can't identify. Mirrors engine's
    // `unknown_principal` deny shape so the disagreement reason is
    // consistent across the resolution-miss vs. registry-miss cases.
    return { allow: false, reason: "unknown_principal" };
  }
  const intent: Intent = {
    capability,
    sovereignty,
  };
  const decision = engine.check(principalId, intent);
  if (decision.allow) {
    return { allow: true, reason: "capability_granted" };
  }
  return { allow: false, reason: describeDenyReason(decision.reason) };
}

/**
 * One capability the adapter wants both gates to weigh in on. The
 * `legacy` decision is the adapter's existing role-resolver verdict
 * for that capability; the orchestrator computes the new gate
 * verdict via the engine + emits a disagreement record when they
 * differ.
 */
export interface CapabilityCheck {
  /**
   * Capability id matching the new schema's namespace conventions
   * (`keyword.chat`, `tool.bash`, `operator`, etc.). The new gate
   * matches this literally against the principal's effective
   * capability set.
   */
  capability: string;
  /** The legacy role-resolver's verdict for this capability. */
  legacy: GateDecision;
}

/**
 * Result of merging legacy + new decisions for a single capability.
 * `effective` is the AND-merge (allow only if both gates allow).
 * `disagreement` is `undefined` when the gates agreed.
 */
export interface MergedCapabilityDecision {
  capability: string;
  legacy: GateDecision;
  /** The new gate's verdict — may be `undefined` if parallel mode is off. */
  new?: GateDecision;
  effective: GateDecision;
  /**
   * Populated only when legacy and new disagreed. When present,
   * carries the intersection verdict + the two reasons so adapter
   * call-sites can hand it to `createSystemAccessDisagreementEvent`
   * without re-merging.
   */
  disagreement?: {
    legacyDecision: "allow" | "deny";
    legacyReason: string;
    newDecision: "allow" | "deny";
    newReason: string;
    effectiveDecision: "allow" | "deny";
  };
}

/**
 * Merge a single capability's legacy + new gate decisions per §9.1
 * intersection-wins semantics. Returns the effective decision + a
 * disagreement record when the gates differ.
 */
export function mergeCapabilityDecision(
  capability: string,
  legacy: GateDecision,
  newGate: GateDecision,
): MergedCapabilityDecision {
  const effectiveAllow = legacy.allow && newGate.allow;
  const effective: GateDecision = {
    allow: effectiveAllow,
    reason: effectiveAllow
      ? "intersection_allow"
      : `intersection_deny:${legacy.allow ? "new" : "legacy"}_denied`,
  };
  if (legacy.allow === newGate.allow) {
    return { capability, legacy, new: newGate, effective };
  }
  return {
    capability,
    legacy,
    new: newGate,
    effective,
    disagreement: {
      legacyDecision: legacy.allow ? "allow" : "deny",
      legacyReason: legacy.reason,
      newDecision: newGate.allow ? "allow" : "deny",
      newReason: newGate.reason,
      effectiveDecision: effectiveAllow ? "allow" : "deny",
    },
  };
}

/**
 * Orchestrator entry point — runs the new gate for each
 * {@link CapabilityCheck} and merges with the supplied legacy
 * verdict. Returns one {@link MergedCapabilityDecision} per check,
 * in input order.
 *
 * The principal id is resolved once up-front via the
 * `PlatformPrincipalIndex` — every per-capability call to the engine
 * uses the same resolution. When no principal matches the
 * `(platform, platformId)` tuple, every check returns
 * `unknown_principal` from the new gate; the merge produces a
 * disagreement record per capability the legacy gate allowed
 * (because legacy-allow + new-deny = the dangerous direction the
 * envelope exists to surface).
 */
export function runParallelModeChecks(opts: {
  engine: PolicyEngine;
  index: PlatformPrincipalIndex;
  platform: string;
  platformAuthorId: string;
  sovereignty: ParallelModeSovereignty;
  checks: readonly CapabilityCheck[];
}): {
  principalId: string | undefined;
  decisions: MergedCapabilityDecision[];
} {
  const principalId = opts.index.resolve(opts.platform, opts.platformAuthorId);
  const decisions = opts.checks.map((check) => {
    const newGate = checkCapabilityViaEngine(
      opts.engine,
      principalId,
      check.capability,
      opts.sovereignty,
    );
    return mergeCapabilityDecision(check.capability, check.legacy, newGate);
  });
  return { principalId, decisions };
}

/**
 * Translate a legacy `AccessDecision`-shaped feature/tool bundle into
 * the {@link CapabilityCheck}[] the orchestrator consumes. Adapters
 * call this with the decision their existing role-resolver produced;
 * the helper emits one check per capability the legacy gate has an
 * opinion on:
 *
 *   - `keyword.chat` / `keyword.async` / `keyword.team` — one per
 *     `features.*` boolean
 *   - `operator` — one check, gated by `isOperator`
 *
 * NOT translated (per §5.3 + task spec): `allowedDirs`, `allowedSkills`,
 * `bashAllowlist`, `bashGuard` — these are session-construction
 * parameters, not authorisation capabilities. The orchestrator
 * deliberately doesn't gate on them; cortex#297 verifies they MATCH
 * between legacy + new but doesn't run them through the engine.
 *
 * Tool capability checks (`tool.<name>`) require the canonical Claude
 * tool inventory from cortex#294 (`src/common/policy/tool-inventory.ts`)
 * — for each tool in the inventory, the legacy gate's
 * `toolRestrictions` deny-list inverts to a per-tool capability check.
 * Adapters that want tool-level parallel-mode validation pass them
 * via {@link buildToolCapabilityChecks} as additional checks
 * alongside the keyword/operator checks built here.
 */
export function buildKeywordCapabilityChecks(legacy: {
  features: { chat: boolean; async: boolean; team: boolean };
  isOperator?: boolean;
}): CapabilityCheck[] {
  const out: CapabilityCheck[] = [
    {
      capability: "keyword.chat",
      legacy: {
        allow: legacy.features.chat,
        reason: legacy.features.chat ? "feature_chat_allowed" : "feature_chat_denied",
      },
    },
    {
      capability: "keyword.async",
      legacy: {
        allow: legacy.features.async,
        reason: legacy.features.async ? "feature_async_allowed" : "feature_async_denied",
      },
    },
    {
      capability: "keyword.team",
      legacy: {
        allow: legacy.features.team,
        reason: legacy.features.team ? "feature_team_allowed" : "feature_team_denied",
      },
    },
  ];
  if (legacy.isOperator !== undefined) {
    out.push({
      capability: "operator",
      legacy: {
        allow: legacy.isOperator,
        reason: legacy.isOperator ? "operator_short_circuit" : "non_operator",
      },
    });
  }
  return out;
}

/**
 * Build per-tool {@link CapabilityCheck}[] from the legacy gate's
 * `toolRestrictions` deny-list against the canonical Claude tool
 * inventory.
 *
 * Each inventory tool produces one check: `tool.<lowercase-name>`,
 * with the legacy verdict = `!toolRestrictions.includes(toolName)`.
 * The new gate evaluates the same capability literally against the
 * principal's role grants (per §5.2 — `tool.bash` granted means bash
 * is allowed; absent means denied).
 *
 * Passed as a separate helper so adapters can opt-in to tool-level
 * disagreement surfacing (chatty during the validation window — most
 * deployments will rely on the keyword checks alone until cortex#297
 * removes the parallel mode).
 */
export function buildToolCapabilityChecks(
  toolInventory: readonly string[],
  toolRestrictions: readonly string[] | undefined,
): CapabilityCheck[] {
  const denied = new Set(toolRestrictions ?? []);
  return toolInventory.map((toolName) => {
    const isAllowed = !denied.has(toolName);
    return {
      capability: `tool.${toolName.toLowerCase()}`,
      legacy: {
        allow: isAllowed,
        reason: isAllowed ? `tool_${toolName}_allowed` : `tool_${toolName}_restricted`,
      },
    };
  });
}
