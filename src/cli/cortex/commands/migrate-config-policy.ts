/**
 * v2.0.0 policy cutover — slice I-243C (cortex#295).
 *
 * Synthesise a top-level `policy: { principals[], roles[] }` block from
 * legacy per-adapter `presence.<platform>.roles[]` + `dm.*` blocks. This is
 * the migration the v2.0.0 cutover (cortex#242) needs operators to run
 * BEFORE the legacy schema is removed.
 *
 * Mechanically:
 *   1. Walk every agent's discord/mattermost/slack presence and collect
 *      all `roles[]` + `defaultRole` + `dm.*` blocks.
 *   2. For each legacy role, emit a `PolicyRole` with namespaced
 *      capabilities (`keyword.*`, `tool.*`, `dispatch.*`, `operator`).
 *   3. For each user appearing in any role's `users[]`, emit ONE
 *      `PolicyPrincipal` (unified across the three adapters — same
 *      platform id mapped via three agents' role lists collapses to one
 *      principal). `platform_ids.<platform> = [user_id]` populates the
 *      reverse-lookup table the new dispatch path consults.
 *   4. For each adapter instance with a `defaultRole`, emit a synthetic
 *      `anonymous-<platform>-<agent_id>` principal that carries whatever
 *      role the legacy fallback referenced.
 *   5. If `operator.discordId` / `mattermostId` / `slackId` is set on the
 *      operator block, emit a single `operator-<operator_id>` principal
 *      carrying the operator's platform ids in `platform_ids` and any
 *      `dm.operatorRole` overrides in `session_config.dm`.
 *   6. Same-named role across different adapters with DIFFERENT field
 *      bundles → warn + take the conservative UNION (preserves access;
 *      operator must tighten manually if they want to).
 *   7. External-peer principals (an `agent-<X>` role where `<X>` isn't a
 *      declared agent in this config) emit with `home_principal: "unknown"`
 *      and `home_stack: "unknown/unknown"` + a warning so operators see
 *      the gap.
 *
 * Output is deterministically sorted (principals + roles by id, role[]
 * + platform_ids[platform] arrays sorted in place) so running migrate-
 * config twice produces byte-identical YAML. Idempotency is a hard
 * requirement of the design — operators may re-run after manually
 * labelling principals via `--labels labels.yaml`.
 *
 * See `docs/design-policy-cutover.md` §6 (algorithm) + §9.1 (--check
 * pre-flight requirement) + §11 (reality-check against operator's real
 * config) + §12-§14 (resolved questions) + §16 (locked schema delta).
 */

import type {
  PolicyPrincipal,
  PolicyRole,
} from "../../../common/types/cortex-config";
import { LETTER_PREFIX_ID_REGEX } from "../../../common/types/id";
import { invertDisallowedTools } from "../../../common/policy/tool-inventory";

import type { ConversionWarning } from "./migrate-config-lib";

// =============================================================================
// Legacy shape — the loose `roles[]` items we read out of the input
// =============================================================================

/**
 * Loose decoding of a legacy presence `roles[]` entry. Schema lives in
 * `src/common/types/config.ts` (`RoleSchema`) but we accept this shape from
 * either a parsed grove-v2 `bot.yaml` (`discord[i].roles[]`) or a parsed
 * cortex.yaml (`agents[].presence.discord.roles[]`); the cortex schema's
 * Zod validation has already coerced types on the cortex path, but the
 * bot.yaml path may carry raw YAML.
 */
export interface LegacyRoleEntry {
  name?: unknown;
  users?: unknown;
  features?: unknown;
  disallowedTools?: unknown;
  allowedDirs?: unknown;
  allowedSkills?: unknown;
}

/**
 * Loose decoding of a legacy `dm.userRoles[]` entry. Carries the same field
 * bundle as a channel role plus per-user identity and the DM-specific
 * `bashGuard`/`bashAllowlist`.
 */
export interface LegacyDMUserRoleEntry {
  users?: unknown;
  features?: unknown;
  disallowedTools?: unknown;
  allowedDirs?: unknown;
  allowedSkills?: unknown;
  bashGuard?: unknown;
  bashAllowlist?: unknown;
}

/**
 * Loose decoding of a legacy `dm.operatorRole` block. Same shape as a
 * `DMUserRoleEntry` minus the `users[]`.
 */
export interface LegacyDMOperatorRoleEntry {
  features?: unknown;
  disallowedTools?: unknown;
  allowedDirs?: unknown;
  allowedSkills?: unknown;
  bashGuard?: unknown;
  bashAllowlist?: unknown;
}

/**
 * Loose decoding of a legacy `dm:` block on a discord presence.
 */
export interface LegacyDMConfig {
  operatorRole?: LegacyDMOperatorRoleEntry;
  defaultRole?: unknown;
  userRoles?: LegacyDMUserRoleEntry[];
}

/**
 * One adapter "view" the policy builder iterates over. Each view is the
 * `roles[]` + `defaultRole` + `dm` block under one (agent_id, platform)
 * tuple. Both the legacy bot.yaml and the cortex.yaml shape collapse to
 * this view; the caller picks the right source.
 */
export interface PolicyAdapterView {
  agentId: string;
  platform: "discord" | "mattermost" | "slack";
  roles: LegacyRoleEntry[];
  defaultRole: string | undefined;
  dm: LegacyDMConfig | undefined;
}

/**
 * Input to the policy builder. Captures only what's needed — the rest of
 * the cortex.yaml is rebuilt by `convertBotYaml`.
 */
export interface PolicyBuilderInput {
  operatorId: string;
  homeStack: string;
  /** Local agent ids declared in this cortex.yaml (used to detect external peers). */
  declaredAgentIds: ReadonlySet<string>;
  /** Operator's platform ids (from `operator.discordId/mattermostId/slackId`). */
  operatorPlatformIds: Partial<Record<"discord" | "mattermost" | "slack", string>>;
  /** Per-(agent, platform) view of the legacy roles + dm config. */
  views: PolicyAdapterView[];
  /**
   * Optional pre-existing policy block. When present, its principals +
   * roles are preserved and the builder only ADDS new ones (idempotency).
   * Bare-string capabilities (`chat`, `async`, `team`) get rewritten to
   * `keyword.*` form in place.
   */
  existingPolicy?: {
    /**
     * Permissive shape — raw YAML hasn't been Zod-parsed yet, so any field
     * (including `platform_ids`) may be missing. `buildPolicy` defends with
     * `?? {}` / `?? []` and absorbs whatever's present.
     */
    principals?: (Omit<PolicyPrincipal, "platform_ids"> & {
      platform_ids?: PolicyPrincipal["platform_ids"];
    })[];
    roles?: PolicyRole[];
  };
  /**
   * Optional principal-label overrides — `{ "<platform>:<id>": "principal-id" }`
   * — supplied via `--labels labels.yaml`. The builder uses the labelled id
   * instead of the synthesised one (`user-d567890`).
   */
  labels?: Map<string, string>;
}

export interface PolicyBuilderOutput {
  policy: {
    principals: PolicyPrincipal[];
    roles: PolicyRole[];
  };
  warnings: ConversionWarning[];
}

// =============================================================================
// Capability namespace
// =============================================================================

const BARE_KEYWORD_REWRITES: ReadonlyMap<string, string> = new Map([
  ["chat", "keyword.chat"],
  ["async", "keyword.async"],
  ["team", "keyword.team"],
]);

/**
 * Rewrite a single capability string from legacy bare-keyword form to the
 * namespaced form (§12.1). Pass-through for anything that's already
 * namespaced or in another domain.
 */
function rewriteCapability(cap: string): string {
  return BARE_KEYWORD_REWRITES.get(cap) ?? cap;
}

// =============================================================================
// Loose-input coercion helpers
// =============================================================================

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function toBoolean(val: unknown, defaultVal: boolean): boolean {
  return typeof val === "boolean" ? val : defaultVal;
}

function asString(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

// =============================================================================
// Slugify principal ids
// =============================================================================

/**
 * Synthesise a principal id for a platform user when no `--labels` entry
 * exists for them. Platform user ids (Discord snowflakes, Mattermost UUIDs,
 * Slack `U…` ids) don't fit the letter-prefix grammar, so the builder
 * generates `user-<platform[0]><last-6-of-id>` per §6.1.
 *
 * Deterministic: same `(platform, id)` always produces the same principal
 * id. This is what makes the migration idempotent — re-running against a
 * partially-migrated config doesn't shuffle principal ids.
 */
function synthesisePrincipalId(platform: string, platformId: string): string {
  const trimmed = platformId.trim();
  const tail = trimmed.length >= 6 ? trimmed.slice(-6) : trimmed;
  // Lowercase + replace non-grammar chars; ensures Mattermost UUIDs (hex
  // with hyphens) still produce a valid id.
  const sanitised = tail.toLowerCase().replace(/[^a-z0-9-]+/g, "");
  // The platform letter prefix keeps cross-platform collisions visible at
  // a glance: `user-d567890` (Discord) vs `user-m567890` (Mattermost).
  return `user-${platform[0]}${sanitised}`;
}

/**
 * Slug a role name to fit the LETTER_PREFIX_ID_REGEX. Logs a warning when
 * the slug differs from the input so operators can see the rewrite in
 * the migration report.
 */
function slugifyRoleId(
  rawName: string,
  warnings: ConversionWarning[],
): string {
  if (LETTER_PREFIX_ID_REGEX.test(rawName)) return rawName;
  // Lowercase, replace any non-grammar char with `-`, collapse runs,
  // strip leading/trailing hyphens, ensure leading letter.
  let slug = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = `role-${slug}`;
  // Defensive: if still empty after slugifying (e.g. input was "!!!"),
  // synthesise a stable placeholder so the migration doesn't crash. The
  // warning surfaces the underlying input so the operator can hand-edit.
  if (slug.length === 0) slug = "role-unnamed";
  warnings.push({
    field: "policy.roles",
    message: `role name "${rawName}" doesn't match the policy id grammar — slugified to "${slug}". Hand-edit the generated cortex.yaml if you want a different id.`,
  });
  return slug;
}

// =============================================================================
// Role capability synthesis
// =============================================================================

/**
 * Compute the canonical capability list for a role given its legacy field
 * bundle. The dispatch-id list is folded in by the caller (it depends on
 * which agents are declared in the cortex.yaml, not on the role).
 */
function capsForRoleBundle(
  features: string[],
  disallowedTools: string[],
  warnings: ConversionWarning[],
  fieldPath: string,
): string[] {
  const caps = new Set<string>();
  for (const f of features) {
    const ns = BARE_KEYWORD_REWRITES.get(f);
    if (ns) caps.add(ns);
    else {
      warnings.push({
        field: fieldPath,
        message: `unknown feature "${f}" — expected one of chat/async/team. Dropping.`,
      });
    }
  }
  // Inversion of disallowedTools[] → positive tool.<lowercase> caps.
  for (const cap of invertDisallowedTools(disallowedTools)) {
    caps.add(cap);
  }
  return [...caps];
}

// =============================================================================
// Internal accumulators (mutable during build, frozen at end)
// =============================================================================

interface PrincipalAccumulator {
  id: string;
  home_principal: string;
  home_stack: string;
  platform_ids: Record<string, Set<string>>;
  roles: Set<string>;
  trust: Set<string>;
  /**
   * NATS stack signing key (NKey public key). Preserved verbatim from a
   * pre-existing principal block on round-trip — Echo PR #306 r1 blocker
   * caught that this field was dropped, silently losing the work-stack's
   * Phase D federation signing identity.
   */
  nkey_pub: string | undefined;
  /** session_config.default — the channel/group context baseline. */
  sessionDefault: SessionConfigAcc;
  /** session_config.dm — populated only when a DM override applies. */
  sessionDm: SessionConfigAcc | undefined;
  /** True for external-peer placeholders so the warning fires once. */
  external: boolean;
}

interface SessionConfigAcc {
  allowedDirs: string[] | undefined;
  allowedSkills: string[] | undefined;
  bashGuard: boolean;
  bashAllowlist:
    | {
        rules: { pattern: string; repos?: string[] }[];
        repos: string[];
      }
    | undefined;
}

interface RoleAccumulator {
  id: string;
  capabilities: Set<string>;
  /** Field bundles seen across adapters — used to surface cross-adapter conflicts. */
  bundleHashes: Set<string>;
}

function emptySessionConfig(): SessionConfigAcc {
  return {
    allowedDirs: undefined,
    allowedSkills: undefined,
    bashGuard: true,
    bashAllowlist: undefined,
  };
}

function serialiseSessionConfig(sc: SessionConfigAcc): {
  allowed_dirs?: string[];
  allowed_skills?: string[];
  bash_guard: boolean;
  bash_allowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] };
} {
  const out: ReturnType<typeof serialiseSessionConfig> = { bash_guard: sc.bashGuard };
  if (sc.allowedDirs !== undefined) out.allowed_dirs = [...sc.allowedDirs];
  if (sc.allowedSkills !== undefined) out.allowed_skills = [...sc.allowedSkills];
  if (sc.bashAllowlist !== undefined) out.bash_allowlist = sc.bashAllowlist;
  return out;
}

function isSessionConfigDefault(sc: SessionConfigAcc): boolean {
  return (
    sc.allowedDirs === undefined &&
    sc.allowedSkills === undefined &&
    sc.bashGuard &&
    sc.bashAllowlist === undefined
  );
}

/**
 * Stable hash of a role's effective field bundle. Used to detect when the
 * same role name appears across adapters with DIFFERENT bundles — those
 * surface as a warning before the union is taken.
 */
function hashRoleBundle(
  features: string[],
  disallowedTools: string[],
  allowedDirs: string[] | undefined,
  allowedSkills: string[] | undefined,
): string {
  const f = [...features].sort().join(",");
  const d = [...disallowedTools].sort().join(",");
  const ad = allowedDirs ? [...allowedDirs].sort().join(",") : "<unset>";
  const as = allowedSkills ? [...allowedSkills].sort().join(",") : "<unset>";
  return `${f}|${d}|${ad}|${as}`;
}

// =============================================================================
// Main entry — buildPolicy
// =============================================================================

/**
 * Translate a collection of (agent_id, platform, legacy-role-config) views
 * into a top-level `policy: { principals[], roles[] }` block.
 *
 * Pure: no IO. Returns the assembled policy + warnings; the CLI caller
 * stitches them onto its own warnings list and serialises the result.
 *
 * Idempotent — see module docstring + `serialisePolicy` for the sort
 * keys that guarantee byte-identical output on a re-run.
 */
export function buildPolicy(input: PolicyBuilderInput): PolicyBuilderOutput {
  const warnings: ConversionWarning[] = [];

  const principals = new Map<string, PrincipalAccumulator>();
  const roleAcc = new Map<string, RoleAccumulator>();

  // Pre-populate principals + roles from any existing policy block (idempotency).
  for (const p of input.existingPolicy?.principals ?? []) {
    const platformIds: Record<string, Set<string>> = {};
    for (const [platform, ids] of Object.entries(p.platform_ids ?? {})) {
      platformIds[platform] = new Set(ids);
    }
    const acc: PrincipalAccumulator = {
      id: p.id,
      home_principal: p.home_principal,
      home_stack: p.home_stack,
      platform_ids: platformIds,
      roles: new Set(p.role),
      trust: new Set(p.trust),
      // Preserve nkey_pub verbatim from the existing principal — federation
      // signing identity (Phase D). Echo PR #306 r1 blocker fix.
      nkey_pub: p.nkey_pub,
      sessionDefault: emptySessionConfig(),
      sessionDm: undefined,
      external: false,
    };
    if (p.session_config) {
      acc.sessionDefault = absorbSessionConfig(emptySessionConfig(), {
        allowedDirs: p.session_config.default.allowed_dirs,
        allowedSkills: p.session_config.default.allowed_skills,
        bashGuard: p.session_config.default.bash_guard,
        bashAllowlist: p.session_config.default.bash_allowlist,
      });
      if (p.session_config.dm) {
        acc.sessionDm = absorbSessionConfig(emptySessionConfig(), {
          allowedDirs: p.session_config.dm.allowed_dirs,
          allowedSkills: p.session_config.dm.allowed_skills,
          bashGuard: p.session_config.dm.bash_guard,
          bashAllowlist: p.session_config.dm.bash_allowlist,
        });
      }
    }
    principals.set(p.id, acc);
  }
  for (const r of input.existingPolicy?.roles ?? []) {
    const caps = new Set<string>();
    for (const c of r.capabilities) caps.add(rewriteCapability(c));
    // Also rewrite the original entry through the bare-keyword map so a
    // re-run on a partly-migrated file converges. If `r.capabilities`
    // carried `chat`, it's now `keyword.chat`.
    roleAcc.set(r.id, {
      id: r.id,
      capabilities: caps,
      bundleHashes: new Set(),
    });
  }

  // Per-(role-name, platform) bundle tracking — surfaces cross-adapter
  // conflicts when the SAME role name has DIFFERENT field bundles in
  // different presences.
  interface PerPlatformBundle {
    platform: "discord" | "mattermost" | "slack";
    hash: string;
  }
  const seenRoleBundles = new Map<string, PerPlatformBundle[]>();

  // Dispatch capabilities — folded in to every role's capability set so
  // the migration preserves the legacy "any role in this cortex.yaml can
  // dispatch to any local agent" behaviour. Operators tighten manually
  // after migration.
  const declaredAgentIds = [...input.declaredAgentIds].sort();
  const dispatchCaps = declaredAgentIds.map((id) => `dispatch.${id}`);

  // -------- Walk every adapter view --------
  for (const view of input.views) {
    for (const role of view.roles) {
      const rawName = asString(role.name);
      if (!rawName) continue;
      const roleId = slugifyRoleId(rawName, warnings);

      const features = toStringArray(role.features);
      const disallowedTools = toStringArray(role.disallowedTools);
      const allowedDirs = Array.isArray(role.allowedDirs) ? toStringArray(role.allowedDirs) : undefined;
      const allowedSkills = Array.isArray(role.allowedSkills) ? toStringArray(role.allowedSkills) : undefined;

      const caps = capsForRoleBundle(
        features,
        disallowedTools,
        warnings,
        `agents[${view.agentId}].presence.${view.platform}.roles[${rawName}]`,
      );

      // Track cross-adapter bundle drift for this role name.
      const hash = hashRoleBundle(features, disallowedTools, allowedDirs, allowedSkills);
      const bundles = seenRoleBundles.get(roleId) ?? [];
      bundles.push({ platform: view.platform, hash });
      seenRoleBundles.set(roleId, bundles);

      // Accumulate into the role's capability set. Conservative-union
      // semantics (§13 Q4): same role name across adapters with different
      // bundles → union of caps + warning.
      let acc = roleAcc.get(roleId);
      if (acc === undefined) {
        acc = { id: roleId, capabilities: new Set(caps), bundleHashes: new Set([hash]) };
        roleAcc.set(roleId, acc);
      } else {
        for (const c of caps) acc.capabilities.add(c);
        acc.bundleHashes.add(hash);
      }
      // Fold dispatch caps in for every role.
      for (const dc of dispatchCaps) acc.capabilities.add(dc);
      // Reserved `operator` capability — §5.5 / §12.1 — any role literally
      // named `operator` carries the privilege-class capability. The DM
      // adapter short-circuits gating when this cap is present.
      if (roleId === "operator") acc.capabilities.add("operator");

      // Per-user principal synthesis.
      const users = toStringArray(role.users);
      for (const u of users) {
        // External-peer detection: role names like `agent-<X>` where <X>
        // is NOT one of our declared agents → emit a placeholder
        // principal for that peer (§12.3).
        let principalId: string;
        let isExternal = false;
        const labelKey = `${view.platform}:${u}`;
        const labelled = input.labels?.get(labelKey);
        // Operator-platform-id detection: if this user-id matches the
        // operator's platform-side id for this platform, the user IS the
        // operator — fold into the single `operator` principal so the
        // operator role's session_config + DM-context overrides land on
        // one identity, not three. Without this collapse we'd emit BOTH
        // a synthesised `user-d987522` AND an `operator` principal each
        // claiming the same Discord id, which the policy schema's
        // uniqueness refine rejects.
        const isOperatorUser =
          input.operatorPlatformIds[view.platform] === u;
        if (labelled !== undefined) {
          principalId = labelled;
        } else if (isOperatorUser) {
          principalId = "operator";
        } else if (rawName.startsWith("agent-")) {
          const peerName = rawName.slice("agent-".length);
          if (input.declaredAgentIds.has(peerName)) {
            principalId = peerName;
          } else {
            principalId = peerName;
            isExternal = true;
          }
        } else {
          principalId = synthesisePrincipalId(view.platform, u);
        }

        let principal = principals.get(principalId);
        if (principal === undefined) {
          principal = {
            id: principalId,
            home_principal: isExternal ? "unknown" : input.operatorId,
            home_stack: isExternal ? "unknown/unknown" : input.homeStack,
            platform_ids: {},
            roles: new Set(),
            trust: new Set(),
            nkey_pub: undefined,
            sessionDefault: emptySessionConfig(),
            sessionDm: undefined,
            external: isExternal,
          };
          if (isExternal) {
            warnings.push({
              field: `policy.principals[${principalId}]`,
              message:
                `external peer "${principalId}" found in agents[${view.agentId}].presence.${view.platform}.roles[].agent-${principalId}; ` +
                `please set home_principal + home_stack manually in policy.principals[${principalId}] (currently "unknown"/"unknown/unknown")`,
            });
          }
          principals.set(principalId, principal);
        }
        addPlatformId(principal, view.platform, u);
        principal.roles.add(roleId);

        // Channel-context session config — merge with the legacy bundle.
        principal.sessionDefault = absorbSessionConfig(principal.sessionDefault, {
          allowedDirs,
          allowedSkills,
          bashGuard: principal.sessionDefault.bashGuard, // channel role has no bashGuard field
          bashAllowlist: principal.sessionDefault.bashAllowlist,
        });
      }
    }

    // defaultRole → synthetic anonymous principal per (agent, platform).
    const defaultRole = view.defaultRole;
    if (defaultRole !== undefined && defaultRole !== "allow-all") {
      const anonId = `anonymous-${view.platform}-${view.agentId}`;
      const acc: PrincipalAccumulator = {
        id: anonId,
        home_principal: input.operatorId,
        home_stack: input.homeStack,
        platform_ids: {},
        roles: new Set(),
        trust: new Set(),
        nkey_pub: undefined,
        sessionDefault: emptySessionConfig(),
        sessionDm: undefined,
        external: false,
      };
      if (defaultRole === "denied") {
        // empty roles → no caps → blocked at the engine
      } else {
        const roleId = slugifyRoleId(defaultRole, warnings);
        acc.roles.add(roleId);
      }
      // Idempotency — if the principal already exists from an earlier
      // pass, merge rather than overwrite.
      const existing = principals.get(anonId);
      if (existing) {
        for (const r of acc.roles) existing.roles.add(r);
      } else {
        principals.set(anonId, acc);
      }
    }
    if (defaultRole === "allow-all") {
      const anonId = `anonymous-${view.platform}-${view.agentId}`;
      // Synthesise an "allow-all" role with every namespaced capability.
      const allowAllRoleId = "allow-all";
      let role = roleAcc.get(allowAllRoleId);
      if (role === undefined) {
        const caps = new Set<string>();
        caps.add("keyword.chat");
        caps.add("keyword.async");
        caps.add("keyword.team");
        for (const c of invertDisallowedTools([])) caps.add(c);
        for (const dc of dispatchCaps) caps.add(dc);
        role = { id: allowAllRoleId, capabilities: caps, bundleHashes: new Set() };
        roleAcc.set(allowAllRoleId, role);
      }
      const existing = principals.get(anonId);
      if (existing) {
        existing.roles.add(allowAllRoleId);
      } else {
        principals.set(anonId, {
          id: anonId,
          home_principal: input.operatorId,
          home_stack: input.homeStack,
          platform_ids: {},
          roles: new Set([allowAllRoleId]),
          trust: new Set(),
          nkey_pub: undefined,
          sessionDefault: emptySessionConfig(),
          sessionDm: undefined,
          external: false,
        });
      }
    }

    // dm.operatorRole → operator principal session_config.dm.
    const dm = view.dm;
    if (dm?.operatorRole) {
      const opPlatformId = input.operatorPlatformIds[view.platform];
      const operatorPrincipalId = "operator";
      let opPrincipal = principals.get(operatorPrincipalId);
      if (opPrincipal === undefined) {
        opPrincipal = {
          id: operatorPrincipalId,
          home_principal: input.operatorId,
          home_stack: input.homeStack,
          platform_ids: {},
          roles: new Set(["operator"]),
          trust: new Set(),
          nkey_pub: undefined,
          sessionDefault: emptySessionConfig(),
          sessionDm: undefined,
          external: false,
        };
        principals.set(operatorPrincipalId, opPrincipal);
        // Ensure an operator role exists so the cross-ref refine passes.
        if (!roleAcc.has("operator")) {
          const caps = new Set<string>([
            "keyword.chat",
            "keyword.async",
            "keyword.team",
            "operator",
            ...dispatchCaps,
            ...invertDisallowedTools([]),
          ]);
          roleAcc.set("operator", {
            id: "operator",
            capabilities: caps,
            bundleHashes: new Set(),
          });
        }
      }
      if (opPlatformId !== undefined) {
        addPlatformId(opPrincipal, view.platform, opPlatformId);
      }
      // Build the DM session config from this dm.operatorRole bundle.
      const dmAllowedDirs = Array.isArray(dm.operatorRole.allowedDirs)
        ? toStringArray(dm.operatorRole.allowedDirs)
        : undefined;
      const dmAllowedSkills = Array.isArray(dm.operatorRole.allowedSkills)
        ? toStringArray(dm.operatorRole.allowedSkills)
        : undefined;
      const dmBashGuard = toBoolean(dm.operatorRole.bashGuard, true);
      const dmBashAllowlist = isBashAllowlist(dm.operatorRole.bashAllowlist);
      opPrincipal.sessionDm = absorbSessionConfig(opPrincipal.sessionDm ?? emptySessionConfig(), {
        allowedDirs: dmAllowedDirs,
        allowedSkills: dmAllowedSkills,
        bashGuard: dmBashGuard,
        bashAllowlist: dmBashAllowlist,
      });
      // Fold the operator's keyword features into the operator role too,
      // so a legacy `dm.operatorRole.features = [chat, async, team]`
      // survives.
      const dmFeatures = toStringArray(dm.operatorRole.features);
      const operatorRole = roleAcc.get("operator");
      if (operatorRole) {
        for (const f of dmFeatures) {
          const ns = BARE_KEYWORD_REWRITES.get(f);
          if (ns) operatorRole.capabilities.add(ns);
        }
      }
    }

    // dm.userRoles[] → augment the existing per-user principal's session_config.dm.
    for (const ur of dm?.userRoles ?? []) {
      const users = toStringArray(ur.users);
      for (const u of users) {
        const labelKey = `${view.platform}:${u}`;
        const principalId = input.labels?.get(labelKey) ?? synthesisePrincipalId(view.platform, u);
        let principal = principals.get(principalId);
        if (principal === undefined) {
          // The user is in a DM userRoles[] but not in any channel role —
          // synthesise a principal so their DM session_config has somewhere
          // to land. Their channel-context session config stays empty.
          principal = {
            id: principalId,
            home_principal: input.operatorId,
            home_stack: input.homeStack,
            platform_ids: {},
            roles: new Set(),
            trust: new Set(),
            nkey_pub: undefined,
            sessionDefault: emptySessionConfig(),
            sessionDm: undefined,
            external: false,
          };
          principals.set(principalId, principal);
        }
        addPlatformId(principal, view.platform, u);
        const urAllowedDirs = Array.isArray(ur.allowedDirs) ? toStringArray(ur.allowedDirs) : undefined;
        const urAllowedSkills = Array.isArray(ur.allowedSkills) ? toStringArray(ur.allowedSkills) : undefined;
        const urBashGuard = toBoolean(ur.bashGuard, true);
        const urBashAllowlist = isBashAllowlist(ur.bashAllowlist);
        principal.sessionDm = absorbSessionConfig(principal.sessionDm ?? emptySessionConfig(), {
          allowedDirs: urAllowedDirs,
          allowedSkills: urAllowedSkills,
          bashGuard: urBashGuard,
          bashAllowlist: urBashAllowlist,
        });
        // Per-user DM features (chat etc.) → fold into the principal's
        // roles[] via a dm-derived role. Simpler: skip the role
        // expansion and let dispatch enforce keyword.* via the principal's
        // existing channel roles. Anything in `ur.disallowedTools` is
        // captured in the inverted tool list — but we model that as a
        // DM-only constraint, not a role. The session_config carries it
        // implicitly via `bash_allowlist` (the only DM-specific gate);
        // tool denies don't migrate to session_config (they live on
        // capabilities). For semantic preservation we emit a warning so
        // the operator sees the gap.
        const urDisallowed = toStringArray(ur.disallowedTools);
        if (urDisallowed.length > 0) {
          warnings.push({
            field: `policy.principals[${principalId}].session_config.dm`,
            message:
              `legacy dm.userRoles[].disallowedTools=[${urDisallowed.join(", ")}] is not representable in the new schema's session_config; ` +
              `tool denies are role-level capabilities. The principal's channel-context role already encodes the same denies; ` +
              `if their DM context needs a different deny set, create a DM-specific role and reference it.`,
          });
        }
      }
    }
  }

  // Cross-adapter conflict warnings — emit one warning per role that has
  // >1 distinct bundle hash across platforms.
  for (const [roleId, bundles] of seenRoleBundles) {
    const hashes = new Set(bundles.map((b) => b.hash));
    if (hashes.size > 1) {
      const platforms = bundles.map((b) => b.platform);
      const distinctPlatforms = [...new Set(platforms)];
      warnings.push({
        field: `policy.roles[${roleId}]`,
        message:
          `role "${roleId}" declared with different field bundles across platforms [${distinctPlatforms.join(", ")}] — ` +
          `migration emits the conservative UNION of capabilities. ` +
          `Operator-tighten manually post-migration if a narrower grant is intended.`,
      });
    }
  }

  // Serialise + sort.
  const policy = serialisePolicy(principals, roleAcc);

  return { policy, warnings };
}

// =============================================================================
// Helpers — platform-id add, session_config merge, bash_allowlist coercion
// =============================================================================

function addPlatformId(p: PrincipalAccumulator, platform: string, id: string): void {
  let set = p.platform_ids[platform];
  if (set === undefined) {
    set = new Set();
    p.platform_ids[platform] = set;
  }
  set.add(id);
}

/**
 * Merge an incoming session-config bundle into an existing accumulator.
 * Conservative — UNION for allowedDirs/Skills, AND for bashGuard
 * (any false → false; matches the most-permissive bash semantic), and
 * union-merge for bashAllowlist rules + repos.
 */
function absorbSessionConfig(
  acc: SessionConfigAcc,
  incoming: {
    allowedDirs: string[] | undefined;
    allowedSkills: string[] | undefined;
    bashGuard: boolean;
    bashAllowlist: SessionConfigAcc["bashAllowlist"];
  },
): SessionConfigAcc {
  const next: SessionConfigAcc = {
    allowedDirs: acc.allowedDirs,
    allowedSkills: acc.allowedSkills,
    bashGuard: acc.bashGuard && incoming.bashGuard,
    bashAllowlist: acc.bashAllowlist,
  };
  if (incoming.allowedDirs !== undefined) {
    next.allowedDirs = unionSorted(acc.allowedDirs ?? [], incoming.allowedDirs);
  }
  if (incoming.allowedSkills !== undefined) {
    next.allowedSkills = unionSorted(acc.allowedSkills ?? [], incoming.allowedSkills);
  }
  if (incoming.bashAllowlist !== undefined) {
    if (acc.bashAllowlist === undefined) {
      next.bashAllowlist = {
        rules: [...incoming.bashAllowlist.rules].sort((a, b) =>
          a.pattern.localeCompare(b.pattern),
        ),
        repos: [...incoming.bashAllowlist.repos].sort(),
      };
    } else {
      // Union rules by pattern, repos by string equality.
      const ruleMap = new Map<string, { pattern: string; repos?: string[] }>();
      for (const r of acc.bashAllowlist.rules) ruleMap.set(r.pattern, r);
      for (const r of incoming.bashAllowlist.rules) {
        const prior = ruleMap.get(r.pattern);
        if (prior === undefined) ruleMap.set(r.pattern, r);
        else if (r.repos && prior.repos) {
          ruleMap.set(r.pattern, {
            pattern: r.pattern,
            repos: unionSorted(prior.repos, r.repos),
          });
        }
      }
      next.bashAllowlist = {
        rules: [...ruleMap.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
        repos: unionSorted(acc.bashAllowlist.repos, incoming.bashAllowlist.repos),
      };
    }
  }
  return next;
}

function unionSorted(a: string[], b: string[]): string[] {
  const set = new Set<string>([...a, ...b]);
  return [...set].sort();
}

function isBashAllowlist(val: unknown): SessionConfigAcc["bashAllowlist"] {
  if (!val || typeof val !== "object") return undefined;
  const v = val as { rules?: unknown; repos?: unknown };
  const rules: { pattern: string; repos?: string[] }[] = [];
  if (Array.isArray(v.rules)) {
    for (const r of v.rules) {
      if (!r || typeof r !== "object") continue;
      const rr = r as { pattern?: unknown; repos?: unknown };
      if (typeof rr.pattern !== "string") continue;
      const out: { pattern: string; repos?: string[] } = { pattern: rr.pattern };
      const reposArr = Array.isArray(rr.repos) ? toStringArray(rr.repos) : undefined;
      if (reposArr !== undefined) out.repos = reposArr;
      rules.push(out);
    }
  }
  const repos = Array.isArray(v.repos) ? toStringArray(v.repos) : [];
  return { rules, repos };
}

// =============================================================================
// Serialise + sort for deterministic output
// =============================================================================

function serialisePolicy(
  principals: Map<string, PrincipalAccumulator>,
  roles: Map<string, RoleAccumulator>,
): { principals: PolicyPrincipal[]; roles: PolicyRole[] } {
  const principalsOut: PolicyPrincipal[] = [];
  const sortedPrincipals = [...principals.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const acc of sortedPrincipals) {
    const platformIds: Record<string, string[]> = {};
    const platformNames = [...Object.keys(acc.platform_ids)].sort();
    for (const platform of platformNames) {
      const set = acc.platform_ids[platform];
      if (set !== undefined) platformIds[platform] = [...set].sort();
    }
    const p: PolicyPrincipal = {
      id: acc.id,
      home_principal: acc.home_principal,
      home_stack: acc.home_stack,
      role: [...acc.roles].sort(),
      trust: [...acc.trust].sort(),
      platform_ids: platformIds,
    };
    // Preserve nkey_pub if present (Echo PR #306 r1 blocker fix — work-stack
    // luna principal carries its NATS signing key; must round-trip verbatim).
    if (acc.nkey_pub !== undefined) {
      p.nkey_pub = acc.nkey_pub;
    }
    const hasSessionDefault = !isSessionConfigDefault(acc.sessionDefault);
    if (hasSessionDefault || acc.sessionDm !== undefined) {
      p.session_config = {
        default: serialiseSessionConfig(acc.sessionDefault),
      };
      if (acc.sessionDm !== undefined) {
        p.session_config.dm = serialiseSessionConfig(acc.sessionDm);
      }
    }
    principalsOut.push(p);
  }
  const rolesOut: PolicyRole[] = [];
  const sortedRoles = [...roles.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const acc of sortedRoles) {
    rolesOut.push({
      id: acc.id,
      capabilities: [...acc.capabilities].sort(),
    });
  }
  return { principals: principalsOut, roles: rolesOut };
}

// =============================================================================
// --check pre-flight semantic-preservation report (§9.1)
// =============================================================================

export interface PolicyPreflightGap {
  kind:
    | "principal-missing-for-platform-user"
    | "role-missing-for-default-role"
    | "principal-missing-for-dm-user";
  /** Platform-side identity the gap refers to (e.g. Discord snowflake). */
  platform?: string;
  platformId?: string;
  /** Role name referenced by a legacy `defaultRole` that has no policy.roles entry. */
  roleName?: string;
  agentId?: string;
  /** Free-form human-readable hint. */
  hint: string;
}

export interface PolicyPreflightInput {
  views: PolicyAdapterView[];
  policy: {
    /**
     * Permissive shape — pre-flight may run against pre-Zod-parsed input
     * (operator pre-cutover with hand-edited cortex.yaml lacking some fields).
     */
    principals: (Omit<PolicyPrincipal, "platform_ids"> & {
      platform_ids?: PolicyPrincipal["platform_ids"];
    })[];
    roles: PolicyRole[];
  };
}

/**
 * Compute the gap set for the cortex#296 parallel-mode pre-flight. The
 * gates are:
 *
 *   1. Every user-id in any legacy `presence.<platform>.roles[].users[]`
 *      MUST have a principal whose `platform_ids.<platform>` lists it.
 *   2. Every user-id in any legacy `dm.userRoles[].users[]` MUST have a
 *      principal whose `platform_ids.<platform>` lists it.
 *   3. Every role-name referenced by any legacy `defaultRole` MUST have a
 *      matching `policy.roles[].id`. The synthetic `denied`/`allow-all`
 *      sentinel values are exempt — they don't reference a real role.
 */
export function policyPreflight(input: PolicyPreflightInput): PolicyPreflightGap[] {
  const gaps: PolicyPreflightGap[] = [];

  // Build the (platform, id) → principal-id lookup the gates consult.
  const platformLookup = new Map<string, string>();
  for (const p of input.policy.principals) {
    for (const [platform, ids] of Object.entries(p.platform_ids ?? {})) {
      for (const id of ids) {
        platformLookup.set(`${platform}${id}`, p.id);
      }
    }
  }
  const knownRoleIds = new Set(input.policy.roles.map((r) => r.id));

  for (const view of input.views) {
    for (const role of view.roles) {
      const users = toStringArray(role.users);
      for (const u of users) {
        const key = `${view.platform}${u}`;
        if (!platformLookup.has(key)) {
          gaps.push({
            kind: "principal-missing-for-platform-user",
            platform: view.platform,
            platformId: u,
            agentId: view.agentId,
            hint:
              `legacy ${view.platform} user "${u}" (referenced by agent ${view.agentId}'s ` +
              `presence role "${asString(role.name) ?? "<unnamed>"}") has no principal claiming this id ` +
              `via platform_ids.${view.platform}[]. parallel-mode would silently deny authorisation for this user.`,
          });
        }
      }
    }
    const dr = view.defaultRole;
    if (dr !== undefined && dr !== "denied" && dr !== "allow-all") {
      if (!knownRoleIds.has(dr)) {
        gaps.push({
          kind: "role-missing-for-default-role",
          agentId: view.agentId,
          roleName: dr,
          hint:
            `legacy defaultRole "${dr}" on agent ${view.agentId}'s ${view.platform} presence ` +
            `does not appear in policy.roles[]. The anonymous-${view.platform}-${view.agentId} principal ` +
            `would resolve to no capabilities.`,
        });
      }
    }
    for (const ur of view.dm?.userRoles ?? []) {
      const users = toStringArray(ur.users);
      for (const u of users) {
        const key = `${view.platform}${u}`;
        if (!platformLookup.has(key)) {
          gaps.push({
            kind: "principal-missing-for-dm-user",
            platform: view.platform,
            platformId: u,
            agentId: view.agentId,
            hint:
              `legacy dm.userRoles ${view.platform} user "${u}" (referenced by agent ${view.agentId}) has no principal ` +
              `claiming this id via platform_ids.${view.platform}[]. parallel-mode would deny their DM messages.`,
          });
        }
      }
    }
  }
  return gaps;
}

export function formatPreflightReport(gaps: readonly PolicyPreflightGap[]): string {
  if (gaps.length === 0) {
    return "policy preflight: OK — every legacy user + defaultRole resolves through the new policy block.";
  }
  const lines = [`policy preflight: ${gaps.length} gap(s) — parallel-mode activation BLOCKED:`];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    if (!g) continue;
    lines.push(`  [${i + 1}/${gaps.length}] ${g.kind}: ${g.hint}`);
  }
  return lines.join("\n");
}
