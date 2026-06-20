/**
 * v2.0.0 cutover (cortex#297) — shared adapter-side policy resolution.
 *
 * Single entry point each adapter (Discord, Mattermost, Slack, …) consumes
 * to turn an inbound platform message into an `AccessDecision`. Replaces
 * the deleted role-resolver + the parallel-mode plumbing from cortex#296.
 *
 * The flow:
 *
 *   1. Resolve `(platform, message.author.id)` to a principal id via the
 *      `PlatformPrincipalIndex`. Unknown principals → deny with a clear
 *      operator-facing pointer at `policy.principals[].platform_ids`.
 *   2. Ask the PolicyEngine for the three keyword capabilities
 *      (`keyword.chat`, `keyword.async`, `keyword.team`) and the
 *      `operator` short-circuit capability.
 *   3. Look up the principal's `session_config` (default vs dm based on
 *      `isDM`) to populate `dirRestrictions`, `allowedSkills`,
 *      `bashGuard`, `bashAllowlist`.
 *   4. Invert the principal's tool grants against the canonical Claude
 *      tool inventory to produce the legacy `toolRestrictions` array
 *      (a tool is "restricted" when its `tool.<name>` capability is NOT
 *      in the principal's effective set).
 *   5. Update `msg.dmType` semantics: an operator is a principal whose
 *      effective capability set contains `operator` (the reserved
 *      short-circuit capability — see `docs/design-policy-cutover.md` §5.5).
 *
 * The adapter call-site stays minimal: pass the engine + index + registry
 * pulled from `infra`, plus `msg`. The result is the same `AccessDecision`
 * shape downstream `MessageRouter` already consumes.
 */

import type { AccessDecision, InboundMessage } from "../../adapters/types";
import { CLAUDE_TOOL_INVENTORY } from "./tool-inventory";
import { PUBLIC_PRINCIPAL_ID } from "./factory";
import type { PolicyEngine } from "./engine";
import {
  defaultPolicySovereignty,
  type PlatformPrincipalIndex,
  type PrincipalRegistry,
} from "./policy-gate";

/**
 * Inputs the adapter passes to {@link resolvePolicyAccess}. The engine +
 * index + registry are populated from the parsed `policy:` block; when the
 * deployment hasn't declared a policy (or declares one with no
 * principals), all three are `undefined` and the helper denies every
 * inbound message with a clear operator-facing reason.
 */
export interface ResolvePolicyAccessInput {
  msg: InboundMessage;
  engine: PolicyEngine | undefined;
  index: PlatformPrincipalIndex | undefined;
  registry: PrincipalRegistry | undefined;
}

const DENY_NO_POLICY: AccessDecision = {
  allowed: false,
  features: { chat: false, async: false, team: false },
  denyCode: "no_policy",
  denyReason:
    "cortex.yaml has no policy.principals[] declared; v2.0.0 requires a policy block. " +
    "Run `bun src/cli/cortex/commands/migrate-config.ts <your-config.yaml>` to synthesise one from legacy fields.",
};

/**
 * cortex#1167 — the originator DID stamped on an open-onboarding chat envelope:
 * the single, registered, minimal-privilege public-domain principal
 * (`did:mf:public`). Because it is a REAL engine entry holding exactly
 * `dispatch.<flaggedAgentId>`, the dispatch-listener's
 * `engine.check("public", "dispatch.pier")` PASSES — the round-trip is
 * functional end-to-end — while every other capability check on `public`
 * (operator, tool.*, keyword.*, dispatch to a non-flagged agent, admit, bus)
 * fails closed. No per-layer carve-out, no lossy per-sender DID.
 */
export const PUBLIC_ORIGINATOR_DID = `did:mf:${PUBLIC_PRINCIPAL_ID}`;

/**
 * cortex#1165 / #1167 — mint the `AccessDecision` for an inbound sender who maps
 * to NO principal, used ONLY when the target agent declares
 * `openOnboarding: true` (the Pier concierge gate). The dispatch handler
 * substitutes this for the `unmapped_sender` deny so the agent's chat session
 * can run and greet a stranger.
 *
 * AUTHORITY lives in the single registered `public` principal (see
 * `buildPublicPrincipalEntries` in `factory.ts`), NOT in a per-sender identity.
 * This decision merely tells the adapter/handler "allow chat, Read-only" and
 * carries the per-sender id as an AUDIT LABEL (`anonPrincipalId`). The wire
 * originator is `did:mf:public` (stamped by the handler), so the listener's
 * engine check resolves to `public` and passes the one granted capability.
 *
 * Security contract:
 *   - `features`: only `chat`. `async`/`team` are FALSE — a stranger cannot
 *     spawn background tasks or agent teams.
 *   - `trusted: false` — the inbound prompt-injection filter stays FULLY armed.
 *   - `allowedTools` (review MAJOR): an EXPLICIT ALLOWLIST equal to the agent's
 *     persona allowedTools (Pier → `["Read"]`). CC tool confinement is
 *     allow-by-default on an EMPTY list, so a deny-list alone would leave
 *     `mcp__*` and future tools open. With a non-empty allowlist anything not
 *     listed is denied. This rides EVERY path (bus + direct fallback).
 *   - `toolRestrictions`: the full known inventory ALSO denied as backstop.
 *   - NO `allowedSkills`, NO `dirRestrictions`; `bashGuard` ON.
 *   - The `public` principal holds EXACTLY `dispatch.<flaggedAgentId>` — no
 *     operator, no tool.*, no keyword.*, no dispatch to a non-flagged agent,
 *     no admit, no bus.
 *
 * @param allowedTools the persona allowlist to confine the session to. Defaults
 *   to the most-restrictive safe floor `["Read"]` when the caller passes
 *   nothing (or an empty list — coerced up so a stranger never gets
 *   allow-by-default).
 */
export function anonOnboardingAccess(
  msg: InboundMessage,
  allowedTools?: readonly string[],
): AccessDecision {
  const allowlist =
    allowedTools !== undefined && allowedTools.length > 0
      ? [...allowedTools]
      : ["Read"];
  return {
    allowed: true,
    features: { chat: true, async: false, team: false },
    // Explicit ALLOWLIST — the real confinement. Anything not here (incl.
    // every `mcp__*`) is denied.
    allowedTools: allowlist,
    // Belt-and-braces deny-list backstop: the full known inventory.
    toolRestrictions: [...CLAUDE_TOOL_INVENTORY],
    bashGuard: true,
    trusted: false,
    anonPrincipal: true,
    // AUDIT LABEL only — the AUTHORITY is the `public` principal. Kept so logs
    // and the audit trail can see which individual stranger this was.
    anonPrincipalId: `anon:${msg.platform}:${msg.authorId}`,
    ...(msg.isDM === true && { isDM: true }),
  };
}

/**
 * Authorise an inbound platform message via the PolicyEngine. Returns an
 * `AccessDecision` the adapter passes back to MessageRouter.
 *
 * Decision flow:
 *   - No engine / index / registry → deny with pointer at migrate-config.
 *   - No principal claims `(platform, message.author.id)` → deny with
 *     pointer at `policy.principals[].platform_ids`.
 *   - Engine consulted per-capability for `keyword.chat|async|team` +
 *     `operator`. Allow when at least one keyword is granted (the legacy
 *     shape's "allowed" was always true when a role matched — we mirror
 *     that here by requiring at least one keyword to surface allowed=true).
 *   - Session config picks `dm` when `msg.isDM === true` and the principal
 *     declares `session_config.dm`; otherwise `session_config.default`.
 *   - Tool inversion: any `CLAUDE_TOOL_INVENTORY` tool not granted to the
 *     principal lands in `toolRestrictions`.
 */
export function resolvePolicyAccess(input: ResolvePolicyAccessInput): AccessDecision {
  const { msg, engine, index, registry } = input;
  if (engine === undefined || index === undefined || registry === undefined) {
    return msg.isDM === true ? { ...DENY_NO_POLICY, isDM: true } : DENY_NO_POLICY;
  }

  const principalId = index.resolve(msg.platform, msg.authorId);
  if (principalId === undefined) {
    return {
      allowed: false,
      features: { chat: false, async: false, team: false },
      // cortex#1165 — the one deny category an `openOnboarding` agent may
      // convert into a zero-authority anon ALLOW. The dispatch handler keys
      // off this code (not the prose) so the conversion is precise.
      denyCode: "unmapped_sender",
      denyReason:
        `Sorry, I'm not set up to respond to you. Ask the operator to map your ${msg.platform} id ` +
        `"${msg.authorId}" into policy.principals[].platform_ids.${msg.platform}[] in cortex.yaml.`,
      ...(msg.isDM === true && { isDM: true }),
    };
  }

  const principal = registry.get(principalId);
  // `index` and `registry` are built from the same `policy.principals[]`
  // array, so a resolved id must round-trip. Belt-and-braces: deny if
  // the registry somehow drifted out of sync (only reachable if a
  // caller bypasses the buildPrincipal* factories).
  if (principal === undefined) {
    return {
      allowed: false,
      features: { chat: false, async: false, team: false },
      denyCode: "registry_drift",
      denyReason: `policy.principals[] is missing an entry for resolved principal "${principalId}" — registry/index drift; re-run migrate-config and restart cortex.`,
      ...(msg.isDM === true && { isDM: true }),
    };
  }

  const sovereignty = defaultPolicySovereignty();
  const allow = (capability: string): boolean =>
    engine.check(principalId, { capability, sovereignty }).allow;

  const features = {
    chat: allow("keyword.chat"),
    async: allow("keyword.async"),
    team: allow("keyword.team"),
  };
  const isOperator = allow("operator");

  // Build the effective tool capability set so we can invert against the
  // canonical inventory. One `engine.check` per tool is straightforward
  // and matches the legacy semantic (the role-resolver also walked tools
  // per-role).
  const toolRestrictions: string[] = [];
  for (const toolName of CLAUDE_TOOL_INVENTORY) {
    if (!allow(`tool.${toolName.toLowerCase()}`)) {
      toolRestrictions.push(toolName);
    }
  }

  // Session config — DM override when present and the message arrived
  // via DM context, else `default`. The PolicyPrincipal.session_config
  // shape is optional; when absent (or when `default` is absent), the
  // adapter falls back to global `claude.*` config downstream.
  const sessionConfig = principal.session_config;
  const block =
    msg.isDM === true && sessionConfig?.dm !== undefined
      ? sessionConfig.dm
      : sessionConfig?.default;

  const allowedDirs = block?.allowed_dirs;
  const allowedSkills = block?.allowed_skills;
  const bashGuard = block?.bash_guard ?? true;
  const bashAllowlist = block?.bash_allowlist;

  // Lockout case: principal has zero keyword capabilities. Mirror the
  // legacy role-resolver's "denied" branch with a denyReason that points
  // operators at the right policy-block field.
  const anyFeature = features.chat || features.async || features.team;
  if (!anyFeature && !isOperator) {
    return {
      allowed: false,
      features,
      denyCode: "lockout",
      denyReason: `Principal "${principalId}" has no keyword capabilities — add 'keyword.chat' (or .async/.team) to a role they hold in policy.roles[].capabilities[].`,
      ...(msg.isDM === true && { isDM: true }),
    };
  }

  return {
    allowed: true,
    features: isOperator
      ? { chat: true, async: true, team: true }
      : features,
    ...(toolRestrictions.length > 0 && { toolRestrictions }),
    ...(allowedDirs !== undefined && { dirRestrictions: allowedDirs }),
    ...(allowedSkills !== undefined && { allowedSkills }),
    bashGuard,
    ...(bashAllowlist !== undefined && { bashAllowlist }),
    ...(msg.isDM === true && { isDM: true }),
    // cortex#741 — exemption boundary: TRUST only the operator role. A principal
    // holding the `operator` capability is the stack's home principal / operator;
    // their *direct* chat command to their own agent is not adversarial content,
    // so the inbound prompt-injection filter must not hard-block it (the match is
    // still audited downstream). Non-operator/peer principals get `trusted` unset
    // (falsy) and keep the existing hard block. Keyed off `operator` — NOT "any
    // recognized principal" — to stay conservative: this is a security control.
    ...(isOperator && { trusted: true }),
  };
}

/**
 * Test whether the `(platform, platformId)` tuple maps to a principal
 * whose effective capabilities include `operator`. Used by adapters to
 * classify `msg.dmType` post-cutover (legacy `infra.principal.discordId`
 * comparison retired in favour of the policy-driven check).
 */
export function isOperatorPrincipal(
  platform: string,
  platformId: string,
  engine: PolicyEngine | undefined,
  index: PlatformPrincipalIndex | undefined,
): boolean {
  if (engine === undefined || index === undefined) return false;
  const principalId = index.resolve(platform, platformId);
  if (principalId === undefined) return false;
  return engine.check(principalId, {
    capability: "operator",
    sovereignty: defaultPolicySovereignty(),
  }).allow;
}
