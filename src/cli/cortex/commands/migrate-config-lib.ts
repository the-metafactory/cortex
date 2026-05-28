/**
 * MIG-7.2e — Pure conversion logic for `bot.yaml` (grove-v2) → `cortex.yaml`.
 *
 * Side-effect-free: takes a parsed legacy object, returns the converted object
 * + a list of warnings + a mapping table for `--check` output. The CLI wrapper
 * in `migrate-config.ts` handles file IO and stdout formatting.
 *
 * Coupling boundary: this module imports the cortex-config Zod schema and
 * verifies its output round-trips through `.parse()`. It does NOT import the
 * legacy `AgentConfigSchema` — the legacy file in the wild may carry fields
 * (`personaFile`, `trustedAgentBots`) that were dropped from the in-repo
 * schema, so we accept input permissively and validate output strictly.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

import {
  type CortexConfig,
  CortexConfigSchema,
  type DiscordPresence,
  DiscordPresenceSchema,
  type MattermostPresence,
  MattermostPresenceSchema,
  type PolicyPrincipal,
  type PolicyRole,
  RendererSchema,
  deriveStackId,
} from "../../../common/types/cortex-config";
import {
  buildPolicy,
  policyPreflight,
  type LegacyDMConfig,
  type LegacyRoleEntry,
  type PolicyAdapterView,
  type PolicyBuilderInput,
  type PolicyPreflightGap,
} from "./migrate-config-policy";

// =============================================================================
// Legacy input shape — permissive
// =============================================================================

/**
 * Legacy `bot.yaml` fields we accept. Not a Zod schema: real grove-v2
 * deployments may carry historical fields (`personaFile`, `trustedAgentBots`)
 * that no longer exist in `AgentConfigSchema`. Accepting them as `unknown` lets
 * the converter translate them rather than fail at the input gate.
 */
export interface LegacyAgent {
  name: string;
  displayName: string;
  operatorId?: string;
  operatorName?: string;
  operatorDiscordId?: string;
  operatorMattermostId?: string;
  dataResidency?: string;
  personaFile?: string;
}

export interface LegacyDiscordInstance {
  instanceId?: string;
  enabled?: boolean;
  token: string;
  guildId: string | number;
  agentChannelId: string | number;
  logChannelId: string | number;
  worklogChannelId?: string | number;
  contextDepth?: number;
  enableAgentLog?: boolean;
  roles?: unknown[];
  defaultRole?: string;
  dm?: unknown;
  operatorRoleId?: string | number;
}

export interface LegacyMattermostInstance {
  instanceId?: string;
  enabled?: boolean;
  callbackPort?: number;
  triggerWord?: string;
  webhookUrl?: string;
  apiUrl?: string;
  apiToken?: string;
  webhookToken?: string;
  channels?: string[];
  pollIntervalMs?: number;
  allowedUsers?: string[];
  roles?: unknown[];
  defaultRole?: string;
}

export interface LegacyTrustedAgentBot {
  /** Discord user id of the peer bot. Used only for human reference today. */
  discordId?: string;
  /** Alias for `discordId` — production grove-v2 configs frequently use this
   *  bare field name (no symbolic agent name alongside it). The migrator
   *  treats `id` and `discordId` as interchangeable. */
  id?: string;
  /** Mattermost user id of the peer bot. Used only for human reference today. */
  mattermostId?: string;
  /** Discord role binding (`agent-restricted`, etc.). Surfaced in warnings
   *  on entries that get skipped so the operator can hand-map them. */
  role?: string;
  /**
   * Agent id of the peer bot — this is what migrates into `trust:`.
   *
   * Historically required, but production grove-v2 deployments often ship
   * entries with only a Discord id and no symbolic name (see
   * clawbox:~/.config/grove/bot.yaml). The migrator now tolerates a missing
   * `name`: entries without a derivable agent id are skipped with a warning
   * that surfaces the raw platform id so the operator can hand-edit the
   * generated cortex.yaml `agents[].trust` list post-migration.
   */
  name?: string;
}

export interface LegacyBotYaml {
  /** grove-v2 singular `agent:` block. Required for grove-v2-shape input. */
  agent?: LegacyAgent;
  /**
   * Cortex-shape principal block. Used when the input is already a
   * cortex.yaml (e.g. Andreas's `~/.config/cortex/cortex.yaml`) that has
   * agents under `agents[]` instead of the singular legacy `agent:`.
   *
   * R3 vocabulary migration (cortex#388) — the canonical key is now
   * `principal:`; the legacy `operator:` key is still accepted on input so
   * the migrator can round-trip a pre-R3 cortex.yaml. The two share an
   * identical inner shape. A config carrying BOTH keys is a deployment-config
   * trust boundary — `convertBotYaml` rejects it (see the dual-block guard).
   */
  principal?: {
    id?: string;
    displayName?: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
    dataResidency?: string;
  };
  /**
   * Legacy pre-R3 alias for `principal` (cortex#388 vocabulary migration).
   * Still accepted on input so the migrator can round-trip a pre-R3
   * cortex.yaml; the migrator always EMITS the `principal:` key. Deliberately
   * NOT `@deprecated`-tagged — reading the legacy key is this migrator's whole
   * job, so the tag would only fight `no-deprecated`; the rename nudge belongs
   * on the canonical config types, not on this legacy-input shape.
   */
  operator?: {
    id?: string;
    displayName?: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
    dataResidency?: string;
  };
  /**
   * Cortex-shape `stack:` block — gives the policy builder the
   * `home_stack` value for synthesised principals. Defaults to
   * `<operator_id>/default` per `deriveStackId`.
   */
  stack?: { id?: string; displayName?: string };
  /**
   * Cortex-shape `agents[]` array. When set, the migrator reads
   * presence-side role declarations out of `agents[].presence.<platform>.roles[]`
   * for policy synthesis (cortex#295). The shape mirrors the cortex.yaml
   * `agents[]` schema; we accept it loosely here because input may carry
   * malformed entries that the migrator should warn about rather than
   * reject.
   */
  agents?: {
    id?: string;
    displayName?: string;
    persona?: string;
    roles?: unknown[];
    trust?: string[];
    /**
     * cortex#428 (PR-B) — pass-through for the agent's `runtime` block on
     * cortex.yaml-shape input. The Zod schema validates the shape at the
     * final `CortexConfigSchema.parse`; we accept it loosely on input so
     * the migrator round-trips a v3.0.x cortex.yaml's runtime declarations
     * (substrate, mode, capabilities, sovereignty, maxConcurrent) instead
     * of silently stripping them on the cortex-shape conversion branch.
     */
    runtime?: Record<string, unknown>;
    presence?: {
      discord?: Record<string, unknown>;
      mattermost?: Record<string, unknown>;
      slack?: Record<string, unknown>;
    };
  }[];
  /** Cortex-shape pre-existing `policy:` block — preserved + normalised. */
  policy?: { principals?: PolicyPrincipal[]; roles?: PolicyRole[] };
  discord?: LegacyDiscordInstance[] | LegacyDiscordInstance;
  mattermost?: LegacyMattermostInstance[] | LegacyMattermostInstance;
  trustedAgentBots?: LegacyTrustedAgentBot[];
  claude?: unknown;
  attachments?: unknown;
  execution?: unknown;
  github?: unknown;
  api?: { enabled?: boolean; port?: number; corsOrigin?: string; mode?: string };
  paths?: unknown;
  grove?: unknown;
  networksDir?: string;
  networks?: unknown[];
  nats?: unknown;
  renderers?: unknown[];
  capabilities?: unknown[];
  [key: string]: unknown;
}

// =============================================================================
// Conversion output
// =============================================================================

export interface ConversionWarning {
  field: string;
  message: string;
}

export interface InstanceMapping {
  legacyKind: "discord" | "mattermost";
  legacyIndex: number;
  legacyInstanceId: string | undefined;
  newAgentId: string;
  newPresence: "discord" | "mattermost";
}

/**
 * R3 vocabulary migration (cortex#388) — the emitted `cortex.yaml` shape.
 *
 * Identical to `CortexConfig` except the principal block is keyed `principal:`
 * (the new canonical key) rather than the legacy `operator:`. The block's
 * inner shape is unchanged — only the top-level key is renamed.
 *
 * `convertBotYaml` validates its output through `CortexConfigSchema` (which
 * still keys the block `operator:` during the transition release — the
 * breaking schema flip is manifest PR-11 / v3.0.0), then re-keys the
 * validated result to `principal:` for emission. The cortex loader's
 * `resolvePrincipalBlock` accepts both keys, so a `principal:`-shaped file
 * loads cleanly.
 */
export type MigratedCortexConfig = Omit<CortexConfig, "operator"> & {
  principal: CortexConfig["principal"];
};

export interface ConversionResult {
  /** The cortex.yaml-shaped object, ready to YAML.stringify and write. */
  cortex: MigratedCortexConfig;
  /** Non-fatal warnings — surfaced to stderr by the CLI. */
  warnings: ConversionWarning[];
  /**
   * Per-instance mapping table — shown by `--check`. Validates that each
   * legacy `discord[].instanceId` / `mattermost[].instanceId` maps to exactly
   * one new agent presence (plan §4 7.2e validation criterion #1).
   */
  mappings: InstanceMapping[];
  /**
   * Adapter views that drove the policy synthesis. Retained on the result
   * so the CLI's `--check` mode can run `policyPreflight` without
   * re-walking the input. Empty when the input had no `roles[]` blocks.
   */
  adapterViews: PolicyAdapterView[];
  /**
   * Gaps detected by `policyPreflight` against the synthesised policy
   * block. Empty (length 0) means parallel-mode activation is safe.
   * Populated when at least one legacy user-id or defaultRole reference
   * doesn't resolve through the new policy block — see cortex#296.
   */
  preflightGaps: PolicyPreflightGap[];
}

/**
 * Options controlling validation strictness. The CLI flips `strict: true` for
 * `--strict` mode (warnings → errors).
 */
export interface ConvertOptions {
  /**
   * Directory the input `bot.yaml` was loaded from. Used to resolve
   * `personaFile` paths for the file-exists validation. Optional — when
   * omitted, assistant prompt files are not checked on disk (e.g. when
   * tests parse fixtures via in-memory strings rather than file paths).
   */
  configDir?: string;
  /**
   * Optional principal-label overrides — `{ "<platform>:<id>" → "principal-id" }`.
   * Loaded by the CLI from `--labels labels.yaml` and forwarded verbatim
   * to the policy builder. Lets operators replace synthesised principal
   * ids (`user-d567890`) with friendlier names (`mike`) without losing
   * idempotency (the same label map produces the same output on every run).
   */
  labels?: Map<string, string>;
  /**
   * cortex#324 (v2.0.3) — when `true`, the migrator auto-populates
   * `stack.nkey_seed_path` (and `stack.nkey_pub` when derivable) from
   * the legacy `nats.identity` block, on the theory that the operator
   * is already using one NKey for NATS auth and is happy to reuse it
   * for stack-envelope signing too. Idempotent: if the input already
   * declared `stack.nkey_seed_path`, no-op.
   *
   * Off by default. The CLI flag is `--auto-stack-key`; without it,
   * the migrator emits a warning suggesting the operator add the field
   * (or re-run with the flag).
   */
  autoStackKey?: boolean;
}

// Re-export policy types so CLI callers and external consumers can hold
// onto them without importing the policy submodule directly. Mirrors the
// pattern existing convertBotYaml callers use for ConversionWarning.
export type {
  PolicyAdapterView,
  PolicyPreflightGap,
} from "./migrate-config-policy";
export { policyPreflight, formatPreflightReport } from "./migrate-config-policy";

// =============================================================================
// Conversion
// =============================================================================

const AGENT_ID_PATTERN = /^[a-z0-9-]+$/;

function toArray<T>(val: T[] | T | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

function coerceString(val: string | number | undefined): string | undefined {
  if (val === undefined) return undefined;
  return String(val);
}

/**
 * Lift a legacy `agent.name` to a cortex agent id. The cortex schema enforces
 * `^[a-z0-9-]+$`; legacy `agent.name` historically allowed mixed case (Luna,
 * Echo, …) so we lowercase and replace any disallowed char with `-`.
 */
function deriveAgentId(legacyName: string): string {
  return legacyName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Lift the operator block out of the singular legacy `agent:` field. The
 * cortex `operator:` carries id / displayName / discordId / mattermostId /
 * dataResidency — all lifted from the legacy `agent.operator*` fields.
 *
 * Falls back to `agent.name` for the operator id when `operatorId` is unset,
 * since pre-cortex deployments often ran one bot per operator without a
 * distinct operatorId.
 */
function buildOperator(
  legacy: LegacyBotYaml,
  warnings: ConversionWarning[],
): CortexConfig["principal"] {
  // Caller (convertBotYaml) guards `legacy.agent` is set on the grove-v2
  // path before reaching here. Re-assert for the type narrowing.
  if (!legacy.agent) {
    throw new Error("internal: buildOperator called without legacy.agent");
  }
  const a = legacy.agent;

  // `a.operatorId` reads the legacy grove-v2 `bot.yaml` `agent.operatorId`
  // field — a historical input shape, intentionally NOT renamed (R2 covers
  // live cortex code; bot.yaml legacy-config paths are the migration
  // allow-list carve-out). The warning `field:` below names the OUTPUT
  // cortex.yaml key, which is `principal:` after R3.
  const rawPrincipalId = a.operatorId ?? a.name;
  const principalId = deriveAgentId(rawPrincipalId);
  if (principalId !== rawPrincipalId) {
    warnings.push({
      field: "principal.id",
      message: `principal id "${rawPrincipalId}" normalized to "${principalId}" (cortex requires lowercase alphanumeric + hyphen)`,
    });
  }

  let dataResidency = a.dataResidency;
  if (dataResidency === undefined) {
    dataResidency = "NZ";
  } else if (!/^[A-Z]{2}$/.test(dataResidency)) {
    const fixed = dataResidency.toUpperCase();
    if (/^[A-Z]{2}$/.test(fixed)) {
      warnings.push({
        field: "principal.dataResidency",
        message: `dataResidency "${dataResidency}" upcased to "${fixed}"`,
      });
      dataResidency = fixed;
    } else {
      warnings.push({
        field: "principal.dataResidency",
        message: `dataResidency "${dataResidency}" not a 2-letter ISO-3166 code; defaulting to "NZ"`,
      });
      dataResidency = "NZ";
    }
  }

  // The local variable name `operator` is preserved here because this
  // builder reads LEGACY `agent.operator*` fields off bot.yaml input;
  // the variable holds the converted block en-route to the cortex.yaml
  // output. `convertBotYaml` emits it under the canonical `principal:`
  // key per v3.0.0 (cortex#388 manifest PR-11).
  const operator: CortexConfig["principal"] = { id: principalId, dataResidency };
  if (a.operatorName) operator.displayName = a.operatorName;
  if (a.operatorDiscordId) operator.discordId = a.operatorDiscordId;
  if (a.operatorMattermostId) operator.mattermostId = a.operatorMattermostId;
  return operator;
}

/**
 * Convert a single legacy discord instance to a cortex DiscordPresence block.
 * Drops `instanceId` — cortex computes it at runtime from
 * `${agent.id}-discord` (per RESUME §Decisions §1).
 *
 * Delegates default-application to `DiscordPresenceSchema.parse()` rather than
 * hand-coding `?? value` fallbacks, so the source-of-truth for defaults stays
 * in `cortex-config.ts`. Holly W2-1 (cortex#51 round 1) flagged that
 * duplicating those defaults silently diverges if the schema evolves; parsing
 * through the schema removes both the duplication and the trailing `as
 * DiscordPresence` cast that suppressed type-checking on the manually built
 * object.
 */
function convertDiscordPresence(inst: LegacyDiscordInstance): DiscordPresence {
  const candidate: Record<string, unknown> = {
    token: inst.token,
    guildId: String(inst.guildId),
    agentChannelId: String(inst.agentChannelId),
    logChannelId: String(inst.logChannelId),
  };
  if (inst.enabled !== undefined) candidate.enabled = inst.enabled;
  if (inst.contextDepth !== undefined) candidate.contextDepth = inst.contextDepth;
  if (inst.enableAgentLog !== undefined) candidate.enableAgentLog = inst.enableAgentLog;
  // v2.0.0 (cortex#297) — `roles[]` / `defaultRole` / `dm` retired from
  // DiscordPresenceSchema. The legacy values are still READ from the raw
  // input by `collectAdapterViews` upstream to drive the policy synthesis;
  // we deliberately don't pass them through to the new presence shape.
  const worklog = coerceString(inst.worklogChannelId);
  if (worklog) candidate.worklogChannelId = worklog;
  const role = coerceString(inst.operatorRoleId);
  if (role) candidate.operatorRoleId = role;
  return DiscordPresenceSchema.parse(candidate);
}

/**
 * Convert a single legacy mattermost instance. Same field-for-field lift as
 * discord; `instanceId` dropped. Same Zod-parse-vs-hand-cast tradeoff as
 * `convertDiscordPresence` (see Holly round-1 finding).
 */
function convertMattermostPresence(inst: LegacyMattermostInstance): MattermostPresence {
  const candidate: Record<string, unknown> = {};
  if (inst.enabled !== undefined) candidate.enabled = inst.enabled;
  if (inst.callbackPort !== undefined) candidate.callbackPort = inst.callbackPort;
  if (inst.triggerWord !== undefined) candidate.triggerWord = inst.triggerWord;
  if (inst.webhookUrl !== undefined) candidate.webhookUrl = inst.webhookUrl;
  if (inst.apiUrl !== undefined) candidate.apiUrl = inst.apiUrl;
  if (inst.apiToken !== undefined) candidate.apiToken = inst.apiToken;
  if (inst.webhookToken !== undefined) candidate.webhookToken = inst.webhookToken;
  if (inst.channels !== undefined) candidate.channels = inst.channels;
  if (inst.pollIntervalMs !== undefined) candidate.pollIntervalMs = inst.pollIntervalMs;
  if (inst.allowedUsers !== undefined) candidate.allowedUsers = inst.allowedUsers;
  // v2.0.0 (cortex#297) — `roles[]` / `defaultRole` retired.
  return MattermostPresenceSchema.parse(candidate);
}

/**
 * Resolve the assistant prompt file path for a converted agent. Returns the
 * path the cortex.yaml should carry plus an optional warning when the file
 * doesn't exist on disk (only checked when `configDir` is supplied).
 *
 * Fallback when `personaFile` is unset: `./personas/${agentId}.md`. The
 * cortex schema requires a non-empty string here; the warning surfaces the
 * fact that the file may need to be created.
 */
function resolveAssistantPath(
  legacyPersonaFile: string | undefined,
  agentId: string,
  configDir: string | undefined,
  warnings: ConversionWarning[],
): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const assistantPath = legacyPersonaFile?.trim() || `./personas/${agentId}.md`;

  if (configDir) {
    const abs = isAbsolute(assistantPath) ? assistantPath : resolve(configDir, assistantPath);
    if (!existsSync(abs)) {
      warnings.push({
        field: `agents[${agentId}].persona`,
        message: `assistant prompt file not found at ${abs}${legacyPersonaFile ? "" : " (defaulted from agent name)"}`,
      });
    }
  } else if (!legacyPersonaFile) {
    warnings.push({
      field: `agents[${agentId}].persona`,
      message: `agent.personaFile not set; defaulted to ${assistantPath}`,
    });
  }

  return assistantPath;
}

/**
 * Map legacy `trustedAgentBots[].name` entries onto cortex agent ids. Each
 * name is normalized through `deriveAgentId` (lowercase + hyphen) so legacy
 * "Echo Bot" → "echo-bot". A name that normalizes to the empty string (e.g.
 * "!!!") throws — silently dropping it would produce an agent with a wrong
 * trust list. (Holly cortex#51 round 1 architecture suggestion: extract for
 * readability + isolated testability.)
 */
function buildTrustList(
  legacyTrust: LegacyTrustedAgentBot[],
  warnings: ConversionWarning[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < legacyTrust.length; i++) {
    const t = legacyTrust[i];
    if (!t) continue;
    // Production grove-v2 carries trustedAgentBots entries with only a
    // Discord/Mattermost id and no symbolic agent name. Surface those as
    // warnings (operator hand-maps post-migration) rather than crashing.
    if (typeof t.name !== "string" || t.name.trim().length === 0) {
      const rawPlatformId = t.id ?? t.discordId ?? t.mattermostId ?? "(no id)";
      const roleHint = t.role ? ` role="${t.role}"` : "";
      warnings.push({
        field: "trustedAgentBots",
        message:
          `trustedAgentBots[${i}] missing symbolic \`name\` (platform id: ${rawPlatformId}${roleHint}) — ` +
          `skipping. Hand-map this entry in cortex.yaml under the relevant agent's \`trust:\` list ` +
          `once you know which agent id corresponds to ${rawPlatformId}.`,
      });
      continue;
    }
    const id = deriveAgentId(t.name);
    if (!AGENT_ID_PATTERN.test(id)) {
      // Non-empty `name` that doesn't derive to a valid agent id is still
      // an operator error worth surfacing loudly.
      throw new Error(
        `trustedAgentBots[].name "${t.name}" cannot be derived to a valid agent id (^[a-z0-9-]+$)`,
      );
    }
    if (id !== t.name) {
      warnings.push({
        field: "trustedAgentBots",
        message: `trusted bot name "${t.name}" normalized to "${id}"`,
      });
    }
    out.push(id);
  }
  return out;
}

/**
 * cortex#88 item 3 — detect the bot identity for a single legacy
 * `bot.yaml.discord[i]` block by scanning its `roles[]` for the legacy
 * "this-is-the-bot-identity" hint.
 *
 * Grove's role-resolver historically carries one role per Discord identity
 * (`agent-luna`, `agent-echo`, `agent-forge`, …). The role's `users[]` array
 * lists the bot's own Discord user id — that is the operator's existing
 * mapping from "Discord adapter block N" to "the agent whose bot token sits
 * here". Without this signal, migrate-config falls through to numeric
 * suffixing (`luna-2`, `luna-3`) regardless of which Discord identity each
 * adapter actually represents — bug surfaced in production at the v1 cutover
 * (cortex#88 item 3).
 *
 * Rules:
 *   - `roles[]` is `unknown[]` on the legacy schema; iterate defensively
 *     (objects only, ignore strings / nulls).
 *   - Match the FIRST entry whose `name` starts with `agent-` AND whose
 *     `users[]` carries at least one non-empty string (the bot's id).
 *     "First wins" is deterministic and matches operator expectation: if
 *     someone hand-edits bot.yaml with multiple `agent-*` hints they meant
 *     the top one.
 *   - The returned id is the `name` minus the `agent-` prefix, normalized
 *     through `deriveAgentId` so the cortex schema's `^[a-z0-9-]+$`
 *     constraint holds (a hypothetical `agent-Echo` becomes `echo`).
 *   - When no hint matches: return undefined and let the caller fall back
 *     to legacy numeric suffixing.
 */
function detectAgentIdFromRoleHints(inst: LegacyDiscordInstance): string | undefined {
  const roles = inst.roles;
  if (!Array.isArray(roles)) return undefined;
  for (const raw of roles) {
    if (!raw || typeof raw !== "object") continue;
    const role = raw as Record<string, unknown>;
    const name = role.name;
    if (typeof name !== "string" || !name.startsWith("agent-")) continue;
    const users = role.users;
    if (!Array.isArray(users)) continue;
    const hasUser = users.some((u) => typeof u === "string" && u.trim().length > 0);
    if (!hasUser) continue;
    const stripped = name.slice("agent-".length);
    if (stripped.length === 0) continue;
    const id = deriveAgentId(stripped);
    if (!AGENT_ID_PATTERN.test(id)) continue;
    return id;
  }
  return undefined;
}

/**
 * cortex#88 item 4 — flag when 2+ agents share the same
 * `presence.discord.agentChannelId` after conversion.
 *
 * Grove's `bot.yaml` predates multi-agent — each Discord adapter block
 * carries one `agentChannelId` per adapter, but in production the same
 * id is repeated across all 3 adapters (the monobot legacy: agent events
 * for Luna / Echo / Forge all land in the same channel). After
 * migrate-config, all 3 cortex agents end up with an identical
 * `agentChannelId` and per-agent log routing silently no-ops — every
 * bot still posts into the shared channel.
 *
 * We don't blank the field: an operator may genuinely WANT a shared
 * log channel for cross-agent context. The warning surfaces the
 * situation so the operator decides — set distinct ids in cortex.yaml
 * or accept the shared default.
 *
 * Fires at most ONCE per distinct shared id (so a 4-agent legacy config
 * sharing one id produces one warning, not three).
 */
function detectSharedAgentChannelId(
  agents: CortexConfig["agents"],
  warnings: ConversionWarning[],
): void {
  const byChannel = new Map<string, string[]>();
  for (const a of agents) {
    const cid = a.presence.discord?.agentChannelId;
    if (!cid) continue;
    const existing = byChannel.get(cid) ?? [];
    existing.push(a.id);
    byChannel.set(cid, existing);
  }
  for (const [cid, ids] of byChannel) {
    if (ids.length < 2) continue;
    warnings.push({
      field: "agents.agentChannelId",
      message:
        `WARN: migrate-config: agents [${ids.join(",")}] share agentChannelId ${cid} ` +
        `— set distinct channels in cortex.yaml for per-agent log routing`,
    });
  }
}

/**
 * Synthesize the cortex `agents[]` list from the singular legacy `agent` plus
 * the (possibly multi-entry) `discord[]` and `mattermost[]` arrays.
 *
 * Strategy (per RESUME §MIG-7.2e Agents synthesis, refined by cortex#88
 * item 3):
 *   - Pair discord[i] with mattermost[i] under one agent.
 *   - PRIMARY id source: scan each discord adapter's `roles[]` for the
 *     legacy `agent-<name>` role-resolver hint with a non-empty `users[]`
 *     (the bot's own Discord id). When found, that's the agent id.
 *   - SECONDARY fallback: `deriveAgentId(agent.name)` (the singular legacy
 *     field, what migrate-config used unconditionally before cortex#88
 *     item 3 landed).
 *   - LAST-RESORT fallback: numeric variant (`luna-2`, `luna-3`) when
 *     neither hint nor agent.name produces a distinct id and the operator
 *     has multiple adapters. Matches pre-#88 behaviour for parity.
 *   - Trust list and assistant prompt path propagate to every variant.
 */
function buildAgents(
  legacy: LegacyBotYaml,
  warnings: ConversionWarning[],
  mappings: InstanceMapping[],
  configDir: string | undefined,
): { agents: CortexConfig["agents"]; baseId: string } {
  // Caller (convertBotYaml) guards `legacy.agent` on the grove-v2 path.
  if (!legacy.agent) {
    throw new Error("internal: buildAgents called without legacy.agent");
  }
  const legacyAgent = legacy.agent;
  const discordInstances = toArray(legacy.discord);
  const mattermostInstances = toArray(legacy.mattermost);
  const baseId = deriveAgentId(legacyAgent.name);

  if (!AGENT_ID_PATTERN.test(baseId)) {
    throw new Error(
      `agent.name "${legacyAgent.name}" cannot be derived to a valid agent id (^[a-z0-9-]+$)`,
    );
  }

  const trust = buildTrustList(legacy.trustedAgentBots ?? [], warnings);

  const persona = resolveAssistantPath(legacyAgent.personaFile, baseId, configDir, warnings);
  const displayName = legacyAgent.displayName || legacyAgent.name;

  const variantCount = Math.max(discordInstances.length, mattermostInstances.length, 1);

  if (variantCount > 1) {
    warnings.push({
      field: "agents",
      message: `legacy bot.yaml carries ${discordInstances.length} discord + ${mattermostInstances.length} mattermost instance(s) under a single agent.name — emitting ${variantCount} agents (${baseId}, ${baseId}-2, …)`,
    });
  }

  // First pass: compute each variant's id using the cortex#88-item-3
  // detection ladder (role-hint → agent.name → numeric). We need every id
  // resolved before constructing presence blocks so collision-avoidance
  // for the numeric fallback can see the IDs that the hint path already
  // claimed.
  const claimedIds = new Set<string>();
  // cortex#106 item 2: track which agent id first claimed each `agent-<X>`
  // hint so a second adapter declaring the same hint surfaces a WARN
  // instead of silently falling through to numeric numbering.
  const hintFirstClaimer = new Map<string, string>();
  const variantIds: string[] = [];
  for (let i = 0; i < variantCount; i++) {
    const d = discordInstances[i];
    let hintId: string | undefined;
    let id: string | undefined;
    if (d) {
      hintId = detectAgentIdFromRoleHints(d);
      if (hintId) {
        id = hintId;
        warnings.push({
          field: `agents[${i}].id`,
          message:
            `discord[${i}] agent id "${id}" inferred from role-resolver hint ` +
            `(role name starting with "agent-" carrying a non-empty users[])`,
        });
      }
    }
    // Fallback: agent.name (only safe for the first variant — subsequent
    // variants need a distinct id, hence the numeric suffix at index ≥1).
    id ??= i === 0 ? baseId : `${baseId}-${i + 1}`;
    // Last-resort: a role-hint produced an id that collides with one
    // already claimed by an earlier adapter. Fall through to numeric.
    // cortex#106 item 1: drop the off-by-one — `variantIds.length` is the
    // index of the variant being assigned, so `+1` yields the right suffix
    // (`luna-2` at i=1, `luna-3` at i=2), not `luna-3`/`luna-4`.
    //
    // cortex#119 fix: advance the counter inside the loop. The pre-fix
    // body re-computed `${baseId}-${variantIds.length + 1}` on every
    // iteration without advancing the counter, so if that candidate was
    // also already claimed (e.g. an earlier adapter's hint claimed
    // `luna-2`, then this adapter's numeric-fallback also picks `luna-2`),
    // the loop spun forever. Using a local counter that advances guarantees
    // termination — the candidate space is strictly monotonic in `n` and
    // `claimedIds` is finite.
    let n = variantIds.length + 1;
    while (claimedIds.has(id)) {
      id = `${baseId}-${n++}`;
    }
    // cortex#106 item 2: duplicate `agent-<X>` hint across adapters —
    // operator misconfigured two adapters to both claim the same identity.
    // Emit once per duplicated hint (the second adapter's appearance) so
    // the operator sees both adapter ids and the resolved numeric fallback.
    if (hintId !== undefined) {
      const firstClaimer = hintFirstClaimer.get(hintId);
      if (firstClaimer !== undefined) {
        warnings.push({
          field: `agents[${i}].id`,
          message:
            `WARN: migrate-config: agents [${firstClaimer},${id}] both claim ` +
            `agent-${hintId} hint — first wins; second falls back to numeric`,
        });
      } else {
        hintFirstClaimer.set(hintId, id);
      }
    }
    claimedIds.add(id);
    variantIds.push(id);
  }

  const agents: CortexConfig["agents"] = [];
  for (let i = 0; i < variantCount; i++) {
    const variantId = variantIds[i];
    if (!variantId) continue;
    const presence: CortexConfig["agents"][number]["presence"] = {};
    const d = discordInstances[i];
    const m = mattermostInstances[i];
    if (d) {
      presence.discord = convertDiscordPresence(d);
      mappings.push({
        legacyKind: "discord",
        legacyIndex: i,
        legacyInstanceId: d.instanceId,
        newAgentId: variantId,
        newPresence: "discord",
      });
    }
    if (m) {
      presence.mattermost = convertMattermostPresence(m);
      mappings.push({
        legacyKind: "mattermost",
        legacyIndex: i,
        legacyInstanceId: m.instanceId,
        newAgentId: variantId,
        newPresence: "mattermost",
      });
    }
    agents.push({
      id: variantId,
      // Keep the first variant's displayName bare so the operator's existing
      // single-instance deployment doesn't gain a `(1)` suffix when they
      // later add a second guild. Only index ≥1 carries an enumeration tag.
      // (Holly cortex#51 round 1 nit-1.)
      displayName: i === 0 ? displayName : `${displayName} (${i + 1})`,
      persona,
      // v2.0.0 (cortex#297) — `AgentSchema.roles[]` retired.
      trust,
      presence,
    });
  }

  return { agents, baseId };
}

/**
 * Synthesize a dashboard renderer entry from the legacy `api:` block when
 * `api.enabled` is true. Pre-existing top-level `renderers[]` in the legacy
 * input passes through unchanged.
 */
function buildRenderers(legacy: LegacyBotYaml, warnings: ConversionWarning[]): CortexConfig["renderers"] {
  const renderers: CortexConfig["renderers"] = [];

  if (Array.isArray(legacy.renderers)) {
    for (const r of legacy.renderers) {
      // Parse each entry through the discriminated-union schema rather than
      // an `as` cast — a typo (`kind: "dashbord"`) surfaces here with field
      // path "renderers[i].kind" instead of the opaque top-level Zod error
      // emitted by CortexConfigSchema.parse() at the end of conversion.
      renderers.push(RendererSchema.parse(r));
    }
  }

  if (legacy.api?.enabled === true) {
    const port = typeof legacy.api.port === "number" ? legacy.api.port : 8767;
    renderers.push(RendererSchema.parse({ kind: "dashboard", port }));
    warnings.push({
      field: "api",
      message: `legacy api.enabled=true synthesized as renderers[].kind=dashboard (port ${port}); cloud-mode api fields (endpoint, apiKey, …) are NOT carried — re-add via networks/`,
    });
  }

  return renderers;
}

// =============================================================================
// cortex#428 — v3-complete synthesis (Stage 4-A wiring)
// =============================================================================
//
// Stage 4/5 of the v3 dispatch path needs three fields on the migrated
// config that PR-A (cortex#427) did NOT add to its `principal:` rename:
//
//   1. `agent.runtime.capabilities[]` — at minimum `["chat"]` per myelin#181
//      (canonical conversational capability). Without this, the dispatch
//      consumer does not register the agent on any task subject and the
//      adapter never receives the `dispatch.task.*` lifecycle envelopes
//      it expects under v3.0.x.
//   2. `presence.<platform>.surfaceSubjects[]` — `local.{principal}.{stack}.
//      dispatch.task.*` derived from the parent config. Without this the
//      surface-router never matches the adapter and dispatch envelopes drop
//      silently on the floor.
//   3. Transient `agent.operatorId: <principal.id>` — Andreas's deployments
//      on v3.0.0–v3.0.3 (pre-PR-A) still read `agent.operatorId` from the
//      cortex.yaml. PR-A's merge on main means the field is unread on
//      tip-of-main, but the migrator's output must boot cleanly on the
//      currently-deployed v3.0.x release too. PR-C (cortex#429) drops this
//      synthesis once the v3.0.0–v3.0.3 window closes.
//
// Each synthesis function is idempotent: re-running the migrator on a
// config that already declares these fields preserves them verbatim. The
// catalog merge in `synthesizeRuntimeCapabilities` is the only non-trivial
// case — see its docstring for the merge invariant.

const CHAT_CAPABILITY_ID = "chat";
const CODE_REVIEW_CAPABILITY_ID = "code-review.typescript";
/**
 * Heuristic: match agents whose assistant prompt content suggests
 * code-review work. Conservative — false negatives are safer than false
 * positives, since a synthesised `code-review.typescript` capability that
 * the agent doesn't actually fulfil would surface a dispatch.task.failed
 * reason later.
 *
 * Threshold: ≥2 occurrences of the pattern in the assistant prompt body.
 * Single mentions are common in non-reviewer assistants that DEFLECT review
 * work to a reviewer agent ("Code review — that's Echo's job, redirect
 * there"). The two-occurrence floor cleanly separates Echo (actual
 * reviewer, mentions review multiple times) from Forge (deflector, mentions
 * review once while pointing at Echo) on Andreas's production deployment.
 * The pattern itself is intentionally loose — the count gate does the
 * specificity work.
 */
const CODE_REVIEW_ASSISTANT_PATTERN = /code[- ]review|reviewer|reviewing/gi;
const CODE_REVIEW_OCCURRENCE_FLOOR = 2;

/**
 * Defence-in-depth size cap on assistant prompt file reads. Assistant
 * prompt markdown files are operator-authored under their own config dir
 * (no untrusted input), but a stray symlink to `/dev/zero` or a multi-GB
 * markdown file in a bad fixture dir would OOM the migrator. 1 MiB is two
 * orders of magnitude above any reasonable assistant prompt (real prompts
 * in andreas's deployment run <10 KiB). Files above the cap skip the
 * heuristic, default to ["chat"], and emit a ConversionWarning so the
 * operator notices.
 */
const ASSISTANT_PROMPT_MAX_BYTES = 1 * 1024 * 1024;

interface CortexAgentMutable {
  id: string;
  displayName: string;
  persona: string;
  trust: string[];
  presence: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CortexCapabilityMutable {
  id: string;
  description?: string;
  provided_by?: string[];
  [key: string]: unknown;
}

/**
 * Read an assistant prompt file (if it exists on disk) and return a hint
 * set: which of the heuristic capability ids it suggests the agent
 * provides. Off-disk or unreadable assistant prompt files yield an empty
 * set — the migrator falls back to the safe default (`["chat"]`) without
 * crashing on a missing assistant prompt path.
 *
 * The assistant prompt path on the migrated agent block is resolved
 * relative to the config dir at `resolveAssistantPath` time; we apply the
 * same convention here so a relative `./personas/echo.md` reads off the
 * same directory the operator pointed the migrator at via `--out`.
 */
function detectCapabilityHintsFromAssistantPrompt(
  assistantPath: string,
  configDir: string | undefined,
  agentId: string,
  warnings: ConversionWarning[],
): Set<string> {
  const hints = new Set<string>();
  // The assistant prompt path is required by `AgentSchema.persona`
  // (`min(1)`), but a freshly-migrated config may carry a default-derived
  // path (`./personas/{id}.md`) where the file has not yet been created.
  // Treat missing files as "no hint" — the default `chat` capability still
  // gets synthesised; we just don't speculatively add `code-review.typescript`.
  if (!configDir) return hints;
  const abs = isAbsolute(assistantPath) ? assistantPath : resolve(configDir, assistantPath);
  if (!existsSync(abs)) return hints;
  // Defence-in-depth size cap. statSync is cheap (one inode lookup); the
  // gate keeps a stray symlink (`persona: /dev/zero`) or an accidentally-
  // checked-in giant markdown file from OOM'ing the migrator. Oversized
  // files are treated as "no hint" — same fall-through behaviour as a
  // missing or unreadable file — plus an explicit warning so the
  // operator notices the skip rather than silently losing the heuristic.
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    // stat failed (race between existsSync and statSync, permissions, …) —
    // soft-skip just like the readFileSync catch below.
    return hints;
  }
  if (size > ASSISTANT_PROMPT_MAX_BYTES) {
    warnings.push({
      field: `agents[${agentId}].persona`,
      message:
        `assistant prompt file at ${assistantPath} is ${size} bytes (> ${ASSISTANT_PROMPT_MAX_BYTES} byte cap); ` +
        `skipping assistant-prompt-driven capability heuristic. If the file is legitimately this large, ` +
        `declare runtime.capabilities explicitly on the agent in cortex.yaml.`,
    });
    return hints;
  }
  let body: string;
  try {
    body = readFileSync(abs, "utf-8");
  } catch {
    // Assistant prompt file exists but is unreadable (permissions, …). The
    // migrator already warns about file-existence elsewhere; treat the read
    // failure as a soft skip rather than a fatal error.
    return hints;
  }
  const matches = body.match(CODE_REVIEW_ASSISTANT_PATTERN);
  if (matches && matches.length >= CODE_REVIEW_OCCURRENCE_FLOOR) {
    hints.add(CODE_REVIEW_CAPABILITY_ID);
  }
  return hints;
}

/**
 * Synthesize an `agent.runtime` block with sensible defaults for any agent
 * missing one, AND ensure every claimed capability id (including pre-existing
 * `runtime.capabilities[]` entries) appears in the top-level `capabilities[]`
 * catalog. Both halves are required for the migrated config to parse cleanly
 * against the cortex#314 cross-validator (runtime.capabilities ⊆ catalog ids).
 *
 * Defaults applied when synthesising a fresh `runtime` block:
 *   - `substrate: claude-code` — matches the cortex inline-agent assumption
 *     documented on `AgentRuntimeSchema` (the in-cortex default).
 *   - `mode: in-process`       — same.
 *   - `capabilities: ["chat"]` — myelin#181 canonical conversational
 *     capability. Assistant-prompt-driven heuristic may add `code-review.typescript`
 *     when the assistant prompt body matches `CODE_REVIEW_ASSISTANT_PATTERN`.
 *
 * Catalog merge invariant: an existing `capabilities[]` entry with the same
 * id is preserved verbatim (description, rate, cost — operators may have
 * customised the catalog). The `provided_by` list is unioned with the
 * synthesising agent's id so the cross-field provider-existence check (also
 * a cortex#314 refine) passes. When the id has no pre-existing catalog entry,
 * a minimal one is created with a default description that the operator can
 * refine later.
 *
 * Idempotent: re-running on a config that already has `["chat"]` declared
 * on every agent (and matching catalog entries) produces zero new synthesised
 * caps and zero new catalog entries; the `provided_by` union is a no-op when
 * the agent is already listed.
 */
function synthesizeRuntimeCapabilities(
  cortex: Record<string, unknown>,
  configDir: string | undefined,
  warnings: ConversionWarning[],
): void {
  const agents = cortex.agents;
  if (!Array.isArray(agents)) return;
  const rawCatalog = Array.isArray(cortex.capabilities) ? cortex.capabilities : [];
  const catalog: CortexCapabilityMutable[] = rawCatalog.map((c) =>
    c && typeof c === "object" ? { ...(c as CortexCapabilityMutable) } : { id: "" },
  );
  const catalogById = new Map<string, CortexCapabilityMutable>();
  for (const entry of catalog) {
    if (typeof entry.id === "string" && entry.id.length > 0) {
      catalogById.set(entry.id, entry);
    }
  }

  const ensureCatalogEntry = (capId: string, agentId: string): void => {
    let entry = catalogById.get(capId);
    if (entry === undefined) {
      entry = {
        id: capId,
        description: defaultCapabilityDescription(capId),
        provided_by: [agentId],
      };
      catalog.push(entry);
      catalogById.set(capId, entry);
      return;
    }
    const providers = Array.isArray(entry.provided_by) ? entry.provided_by : [];
    if (!providers.includes(agentId)) {
      entry.provided_by = [...providers, agentId];
    }
  };

  for (const rawAgent of agents) {
    if (!rawAgent || typeof rawAgent !== "object") continue;
    const agent = rawAgent as CortexAgentMutable;
    const existingRuntime =
      agent.runtime && typeof agent.runtime === "object" ? agent.runtime : undefined;
    const existingCaps = Array.isArray(existingRuntime?.capabilities)
      ? (existingRuntime.capabilities as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.length > 0,
        )
      : [];

    // Decide the synthesised capability set. When an agent already declares
    // any capability, we ADD `chat` only if missing (so the dispatcher can
    // route conversational envelopes alongside whatever specialised work
    // the agent already advertises) — we never remove or rewrite the
    // operator's existing claims.
    const synthesised = new Set<string>(existingCaps);
    const addedByMigrator: string[] = [];
    if (!synthesised.has(CHAT_CAPABILITY_ID)) {
      synthesised.add(CHAT_CAPABILITY_ID);
      addedByMigrator.push(CHAT_CAPABILITY_ID);
    }
    if (existingCaps.length === 0) {
      // Only run the assistant-prompt heuristic when the agent had no caps
      // declared. An operator that already declared `["chat"]` explicitly
      // opted into a minimal capability surface — adding `code-review.typescript`
      // behind their back would be presumptuous.
      const hints = detectCapabilityHintsFromAssistantPrompt(agent.persona, configDir, agent.id, warnings);
      for (const hint of hints) {
        if (!synthesised.has(hint)) {
          synthesised.add(hint);
          addedByMigrator.push(hint);
        }
      }
    }

    // Build the runtime block. Preserve any pre-existing fields on
    // `agent.runtime` (sovereignty, maxConcurrent, …) by spreading the
    // existing block over the defaults.
    const runtimeOut: Record<string, unknown> = {
      substrate: "claude-code",
      mode: "in-process",
      ...(existingRuntime ?? {}),
      capabilities: [...synthesised],
    };
    agent.runtime = runtimeOut;

    // Mirror every claimed cap onto the catalog so the cortex#314
    // cross-validator passes. This also pulls existing-but-uncataloged
    // claims into the catalog — a real safety net beyond the v3-complete
    // brief, since pre-PR-B migrate-config outputs could leave dangling
    // claims when the legacy input had `capabilities[]` entries but the
    // agent's existing runtime.capabilities[] claimed an id not in that
    // catalog (a latent cortex#314 schema-rejection trap).
    for (const capId of synthesised) {
      ensureCatalogEntry(capId, agent.id);
    }

    if (addedByMigrator.length > 0) {
      warnings.push({
        field: `agents[${agent.id}].runtime.capabilities`,
        message:
          existingCaps.length === 0
            ? `synthesised agent.runtime.capabilities = [${addedByMigrator.join(", ")}] ` +
              `(default: chat per myelin#181; assistant-prompt heuristic adds code-review.typescript when ` +
              `the assistant prompt body matches /code[- ]review|reviewer|reviewing/i 2+ times). ` +
              `Edit cortex.yaml to refine.`
            : `appended [${addedByMigrator.join(", ")}] to agent.runtime.capabilities ` +
              `(pre-existing claims preserved). Edit cortex.yaml to refine.`,
      });
    }
  }

  // Re-attach the (possibly mutated) catalog. Always write the array back
  // even when no caps were synthesised — keeps the YAML shape consistent
  // across runs (operator sees the catalog block whether or not it was
  // touched). Skip only when there's nothing to write AND nothing was there
  // before, to avoid emitting `capabilities: []` on a bot.yaml input that
  // declared nothing.
  if (catalog.length > 0 || rawCatalog.length > 0) {
    cortex.capabilities = catalog;
  }
}

/**
 * Default-description text for an auto-synthesised catalog entry. Kept
 * minimal so the operator's hand-edit later isn't fighting against a wall
 * of generated prose — the description is required to be non-empty by
 * `CapabilitySchema.description`, but it's also the first thing an operator
 * will rewrite. We keep it short and label it `[auto]` so a grep over a
 * migrated cortex.yaml surfaces every machine-generated description.
 */
function defaultCapabilityDescription(capId: string): string {
  if (capId === CHAT_CAPABILITY_ID) {
    return "[auto] Canonical conversational capability (myelin#181).";
  }
  if (capId === CODE_REVIEW_CAPABILITY_ID) {
    return "[auto] TypeScript code review (correctness, types, idioms).";
  }
  return `[auto] ${capId} — refine this description.`;
}

/**
 * Synthesize `presence.<platform>.surfaceSubjects[]` for every adapter
 * instance whose presence block carries an empty / missing subjects list.
 *
 * Default value: `local.{principal}.{stack-segment}.dispatch.task.*` —
 * the canonical Stage-4 dispatch-sink subscription per
 * `docs/design-platform-adapter-dispatch-publishing.md` §5. The
 * `{stack-segment}` comes from `deriveStackId(cortex).stack` (the second
 * half of `{operator}/{stack}` — `default` when no `stack:` block
 * declared, matching cortex's boot resolver).
 *
 * Platform coverage: only `discord` and `slack` — both schemas declare
 * `surfaceSubjects` and round-trip the synthesised value through
 * `CortexConfigSchema.parse`. `mattermost` is intentionally excluded
 * pending cortex#205-followup: `MattermostPresenceSchema` does NOT
 * declare `surfaceSubjects` (see TODO at cortex-config.ts:252), so Zod
 * default-strips the field on parse — emitting a "synthesised" warning
 * for a key that disappears would mislead operators inspecting the
 * migrated YAML. The MattermostAdapter infra type accepts the field
 * (adapters/mattermost/index.ts:57); plumbing it through the schema is
 * tracked separately. Once that lands, add `"mattermost"` to the loop
 * below.
 *
 * Idempotent: an existing non-empty `surfaceSubjects[]` is preserved
 * verbatim. The migrator only fills in defaults when the operator left
 * the field unset (or empty), which is the v3.0.x default shape that
 * leaves dispatch envelopes unmatched in the surface-router.
 */
function synthesizeSurfaceSubjects(
  cortex: Record<string, unknown>,
  warnings: ConversionWarning[],
): void {
  const agents = cortex.agents;
  if (!Array.isArray(agents)) return;
  const principal = cortex.principal as Record<string, unknown> | undefined;
  const principalId = typeof principal?.id === "string" ? principal.id : undefined;
  if (!principalId) return;

  // Mirror cortex's own boot-time resolver. `deriveStackId` accepts either a
  // `stack: { id: string }` block or falls back to `<principal.id>/default`.
  const stackBlock =
    cortex.stack && typeof cortex.stack === "object"
      ? (cortex.stack as Record<string, unknown>)
      : undefined;
  const stackId = typeof stackBlock?.id === "string" ? stackBlock.id : undefined;
  const derived = deriveStackId({
    principal: { id: principalId },
    stack: stackId ? { id: stackId } : undefined,
  });
  const defaultSubject = `local.${derived.operator}.${derived.stack}.dispatch.task.*`;

  for (const rawAgent of agents) {
    if (!rawAgent || typeof rawAgent !== "object") continue;
    const agent = rawAgent as CortexAgentMutable;
    const presence = agent.presence;
    // mattermost intentionally omitted — MattermostPresenceSchema does not
    // declare surfaceSubjects yet (cortex#205-followup). Adding mattermost
    // here without the schema field produces a misleading warning because
    // Zod strips the synthesised value on parse. See doc-comment above.
    for (const platform of ["discord", "slack"] as const) {
      const block = presence[platform];
      if (!block || typeof block !== "object") continue;
      const adapterBlock = block as Record<string, unknown>;
      const existing = adapterBlock.surfaceSubjects;
      const existingNonEmpty =
        Array.isArray(existing) && existing.length > 0 && existing.every((v) => typeof v === "string");
      if (existingNonEmpty) continue;
      adapterBlock.surfaceSubjects = [defaultSubject];
      warnings.push({
        field: `agents[${agent.id}].presence.${platform}.surfaceSubjects`,
        message:
          `synthesised surfaceSubjects = ["${defaultSubject}"] (default ` +
          `local.{principal}.{stack}.dispatch.task.* per docs/design-platform-adapter-dispatch-publishing.md §5). ` +
          `Edit cortex.yaml to refine.`,
      });
    }
  }
}

/**
 * Synthesize `agent.operatorId: <principal.id>` on every agent as a
 * deprecation aid for v3.0.0–v3.0.3 deployments that still read the field
 * directly (pre-PR-A behaviour). The `CortexConfigSchema` strips unknown
 * keys, so this synthesis MUST run AFTER the schema parse — we mutate the
 * already-validated object before returning it to the caller.
 *
 * PR-C (cortex#429) drops this synthesis when the schema field itself is
 * removed; the field is intentionally NOT added to `AgentSchema` here —
 * it's a transient compatibility surface, not a v3 contract.
 */
function synthesizeOperatorIdBackCompat(
  cortex: MigratedCortexConfig,
  warnings: ConversionWarning[],
): void {
  const principalId = cortex.principal.id;
  // The `MigratedCortexConfig.agents` type does NOT carry `operatorId` —
  // attaching it is a deliberate type-laundering past the schema. The cast
  // is narrow (`Record<string, unknown>`) so the migrator's emitted YAML
  // round-trips on v3.0.0–v3.0.3 loaders. PR-C removes this branch.
  for (const agent of cortex.agents) {
    (agent as unknown as Record<string, unknown>).operatorId = principalId;
  }
  warnings.push({
    field: "agents[].operatorId",
    message:
      `synthesised transient agent.operatorId="${principalId}" on every agent ` +
      `for v3.0.0–v3.0.3 back-compat (cortex#427's principal.id read landed on ` +
      `tip-of-main but is not in the v3.0.x deployed window). PR-C / cortex#429 ` +
      `drops this synthesis once the v3.0.x window closes.`,
  });
}

/**
 * Convert a legacy bot.yaml-shaped object to cortex.yaml-shape. Pure: no IO
 * apart from optional `existsSync` for assistant-prompt-file validation.
 *
 * Throws on structurally invalid input (e.g. missing `agent.name`). Returns
 * the converted object plus warnings + mappings. The caller (CLI) decides
 * whether warnings are fatal (`--strict`) or advisory.
 *
 * The output is validated against `CortexConfigSchema` so the helper never
 * emits a YAML that cortex itself would reject at load. If schema parse
 * fails, the error is re-thrown verbatim so the operator sees the field
 * path Zod identified.
 */
export function convertBotYaml(
  legacy: LegacyBotYaml,
  opts: ConvertOptions = {},
): ConversionResult {
  // TS narrows `legacy: LegacyBotYaml` to non-null, but the function is a
  // public API surface and callers may hand in raw YAML parse output;
  // runtime defence is load-bearing.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (!legacy || typeof legacy !== "object") {
    throw new Error("input is not an object");
  }
  // R3 vocabulary migration (cortex#388) — a cortex.yaml that carries BOTH a
  // `principal:` block and a legacy `operator:` block is a deployment-config
  // trust boundary. Reject it BEFORE any conversion work; the migrator must
  // never silently pick one. Mirrors the loader's `dual_field_conflict`.
  if (legacy.principal !== undefined && legacy.operator !== undefined) {
    throw new Error(
      "input declares BOTH a `principal:` block and a legacy `operator:` " +
        "block — ambiguous. Keep `principal:` (the canonical key) and delete " +
        "the legacy `operator:` block, then re-run migrate-config.",
    );
  }
  // cortex#295 — accept BOTH legacy bot.yaml (singular `agent:`) and
  // cortex.yaml (plural `agents[]` + principal block + `stack:`) shapes.
  // Legacy bot.yaml requires `agent.name` + `agent.displayName`.
  // cortex-shape requires `agents[]` + a principal block (`principal:` or
  // the legacy `operator:`) and bypasses `buildAgents`/`buildOperator`.
  const cortexPrincipalBlock = legacy.principal ?? legacy.operator;
  const isCortexShape =
    !legacy.agent &&
    Array.isArray(legacy.agents) &&
    legacy.agents.length > 0 &&
    cortexPrincipalBlock !== undefined;
  if (!isCortexShape) {
    if (!legacy.agent || typeof legacy.agent !== "object") {
      throw new Error("bot.yaml missing required `agent:` block");
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    if (!legacy.agent.name || typeof legacy.agent.name !== "string") {
      throw new Error("bot.yaml missing required `agent.name`");
    }
    if (!legacy.agent.displayName || typeof legacy.agent.displayName !== "string") {
      throw new Error("bot.yaml missing required `agent.displayName`");
    }
  }

  const warnings: ConversionWarning[] = [];
  const mappings: InstanceMapping[] = [];

  let operator: CortexConfig["principal"];
  let agents: CortexConfig["agents"];
  if (isCortexShape) {
    operator = buildOperatorFromCortexShape(legacy, warnings);
    agents = buildAgentsFromCortexShape(legacy, warnings, mappings);
  } else {
    operator = buildOperator(legacy, warnings);
    agents = buildAgents(legacy, warnings, mappings, opts.configDir).agents;
  }
  detectSharedAgentChannelId(agents, warnings);
  const renderers = buildRenderers(legacy, warnings);

  if (legacy.grove !== undefined) {
    warnings.push({
      field: "grove",
      message: "legacy `grove:` block (F-11 notification toggles) is dropped — re-implement via renderers when needed",
    });
  }

  // v3.0.0 BREAKING (manifest PR-11) — `CortexConfigSchema` now uses
  // `principal:` as the canonical top-level key. The conversion object
  // emits that key directly. The local `operator` variable still holds
  // the converted block — see `buildOperator` /
  // `buildOperatorFromCortexShape` above; only the wire key flips here.
  const cortex: Record<string, unknown> = {
    principal: operator,
    agents,
    renderers,
  };

  if (legacy.stack !== undefined) cortex.stack = legacy.stack;
  // cortex#324 (v2.0.3) — walk-the-talk: stack signing should be ON by
  // default. Surface a warning when the migrated config lacks
  // `stack.nkey_seed_path`. With `--auto-stack-key`, reuse the legacy
  // `nats.identity.seedPath` + `nats.identity.publicKey` for the stack
  // signing identity (single-NKey deployment — same key signs envelopes
  // it already authenticates with). Idempotent: skipped if the input
  // already declared `stack.nkey_seed_path`.
  cortex.stack = annotateStackSigning(
    cortex.stack as Record<string, unknown> | undefined,
    legacy,
    opts.autoStackKey ?? false,
    warnings,
  );
  if (legacy.capabilities !== undefined) cortex.capabilities = legacy.capabilities;

  if (legacy.claude !== undefined) cortex.claude = legacy.claude;
  else cortex.claude = {};

  if (legacy.attachments !== undefined) cortex.attachments = legacy.attachments;
  if (legacy.execution !== undefined) cortex.execution = legacy.execution;
  if (legacy.github !== undefined) cortex.github = legacy.github;
  if (legacy.paths !== undefined) cortex.paths = rewritePaths(legacy.paths, warnings);
  if (legacy.networksDir !== undefined) cortex.networksDir = legacy.networksDir;
  if (legacy.networks !== undefined) cortex.networks = legacy.networks;
  if (legacy.nats !== undefined) cortex.nats = convertNats(legacy.nats, warnings);

  // cortex#295 — synthesise policy block from legacy roles[] declarations.
  // Sources:
  //   - bot.yaml input → `legacy.discord[i].roles[]` + `legacy.mattermost[i].roles[]`
  //   - cortex.yaml input → `legacy.agents[].presence.<platform>.roles[]`
  // Both collapse into PolicyAdapterView[] which the builder consumes.
  const adapterViews = collectAdapterViews(legacy, agents);
  const homeStack = resolveHomeStack(legacy, operator.id);
  const declaredAgentIds = new Set(agents.map((a) => a.id));
  const operatorPlatformIds: PolicyBuilderInput["operatorPlatformIds"] = {};
  if (operator.discordId) operatorPlatformIds.discord = operator.discordId;
  if (operator.mattermostId) operatorPlatformIds.mattermost = operator.mattermostId;
  if (operator.slackId) operatorPlatformIds.slack = operator.slackId;

  const existingPolicy =
    legacy.policy && (legacy.policy.principals !== undefined || legacy.policy.roles !== undefined)
      ? legacy.policy
      : undefined;

  const policyBuild = buildPolicy({
    operatorId: operator.id,
    homeStack,
    declaredAgentIds,
    operatorPlatformIds,
    views: adapterViews,
    existingPolicy: existingPolicy
      ? { principals: existingPolicy.principals, roles: existingPolicy.roles }
      : undefined,
    labels: opts.labels,
  });
  warnings.push(...policyBuild.warnings);

  // Only emit policy block when there's something to say (avoid silent
  // empty-block churn on grove-v2 inputs that don't declare any roles).
  if (
    policyBuild.policy.principals.length > 0 ||
    policyBuild.policy.roles.length > 0 ||
    existingPolicy !== undefined
  ) {
    cortex.policy = policyBuild.policy;
  }

  // cortex#428 (PR-B) — v3-complete synthesis: ensure the output runs
  // Stage 4-A end-to-end without manual editing. Each function is
  // idempotent (re-running on its own output is a no-op).
  //
  // Order matters: runtime/capabilities synthesis MUST run before the
  // schema parse below — the cortex#314 cross-validator rejects any
  // `runtime.capabilities[]` entry missing from the top-level
  // `capabilities[]` catalog, so the catalog augmentation must precede
  // the parse. surfaceSubjects synthesis mutates presence blocks under
  // `agents[]`; running it pre-parse keeps everything in one validation
  // pass and lets `DiscordPresenceSchema.surfaceSubjects` validate the
  // defaulted values.
  synthesizeRuntimeCapabilities(cortex, opts.configDir, warnings);
  synthesizeSurfaceSubjects(cortex, warnings);

  const parsed = CortexConfigSchema.parse(cortex);

  // v3.0.0 BREAKING (manifest PR-11) — `CortexConfig.principal` is the
  // canonical key, so the parsed cortex config IS the MigratedCortexConfig
  // (no key re-mapping needed). The migrate-config CLI still reads legacy
  // `operator:`-shaped input (see buildOperator / buildOperatorFromCortexShape
  // above) — it just emits the post-v3 `principal:`-shaped output.
  const migrated: MigratedCortexConfig = parsed;

  // cortex#428 (PR-B) — transient `agent.operatorId` back-compat MUST run
  // post-parse: the schema strips unknown keys, so any pre-parse mutation
  // would be silently dropped. PR-C / cortex#429 retires this branch.
  synthesizeOperatorIdBackCompat(migrated, warnings);

  // Compute parallel-mode pre-flight gaps against the FINAL policy block.
  const preflightGaps = policyPreflight({
    views: adapterViews,
    policy: parsed.policy ?? { principals: [], roles: [] },
  });

  return { cortex: migrated, warnings, mappings, adapterViews, preflightGaps };
}

// =============================================================================
// cortex#295 — view collection + cortex-shape input helpers
// =============================================================================

/**
 * Walk the input legacy or cortex-shape config and project every adapter
 * presence carrying a `roles[]` block onto a single uniform list. The
 * policy builder consumes this directly.
 *
 * For grove-v2 inputs the roles live under `legacy.discord[i].roles[]`
 * and `legacy.mattermost[i].roles[]`; the `agents[]` array we synthesised
 * carries the cortex-shape agent ids. We zip `i` against `agents[i].id`
 * so the resulting view's `agentId` is the same cortex-shape id the
 * principal will reference.
 *
 * For cortex-shape inputs the roles live under
 * `legacy.agents[i].presence.<platform>.roles[]` directly.
 */
function collectAdapterViews(
  legacy: LegacyBotYaml,
  agents: CortexConfig["agents"],
): PolicyAdapterView[] {
  const views: PolicyAdapterView[] = [];
  // v2.0.0 (cortex#297) — read legacy `roles[]` + `defaultRole` + `dm`
  // declarations from the RAW input (`legacy.agents[].presence`),
  // typed as `Record<string, unknown>` on `LegacyBotYaml`. The schema-
  // parsed `agents` arg no longer carries these fields (they retired
  // from `DiscordPresenceSchema` / `MattermostPresenceSchema` /
  // `SlackPresenceSchema` in this slice), so the only place they
  // survive is the raw YAML the operator handed the migrator.
  //
  // Idempotency: when the operator re-runs the migrator on a config
  // they already migrated, `legacy.agents[*].presence.<platform>` has
  // no `roles[]`/`defaultRole`/`dm` keys at all → this loop emits no
  // views → the existing `policy:` block carried forward via
  // `existingPolicy` is preserved verbatim (re-emitting the same
  // synthesis output).
  const parsedById = new Map(agents.map((a) => [a.id, a]));
  const rawAgents = Array.isArray(legacy.agents) ? legacy.agents : [];
  for (const rawAgent of rawAgents) {
    if (typeof rawAgent.id !== "string") continue;
    const parsed = parsedById.get(rawAgent.id);
    if (parsed === undefined) continue;
    const presence = rawAgent.presence;
    if (!presence || typeof presence !== "object") continue;

    const visit = (
      platform: "discord" | "mattermost" | "slack",
      includeDm: boolean,
    ): void => {
      const block = presence[platform];
      if (!block || typeof block !== "object") return;
      if (block.enabled === false) return;
      const rawRoles = Array.isArray(block.roles) ? (block.roles as LegacyRoleEntry[]) : [];
      const defaultRole = typeof block.defaultRole === "string" ? block.defaultRole : "allow-all";
      const dm = includeDm
        ? (block.dm as LegacyDMConfig | undefined)
        : undefined;
      if (rawRoles.length > 0 || dm !== undefined) {
        views.push({
          agentId: parsed.id,
          platform,
          roles: rawRoles,
          defaultRole,
          dm,
        });
      }
    };
    visit("discord", true);
    visit("mattermost", false);
    visit("slack", false);
  }

  // cortex#297 r1 B-1 fix — bot.yaml (grove-v2 legacy) shape carries roles
  // at top-level `legacy.discord[i].roles[]` + `legacy.mattermost[i].roles[]`,
  // not under `legacy.agents[].presence`. Without this branch the policy
  // synthesis silently dropped every authorization declaration in every
  // grove-v2 upgrade — the dominant install shape pre-MIG-7.9.
  //
  // Zip top-level platform arrays against the synthesised `agents[]` by
  // index: `legacy.discord[i]` maps to `agents[i]` (which `buildAgents`
  // synthesised in the same order).
  const isBotYamlShape = !Array.isArray(legacy.agents) || rawAgents.length === 0;
  if (isBotYamlShape) {
    const visitTopLevel = (
      platform: "discord" | "mattermost" | "slack",
      raw: unknown,
      includeDm: boolean,
    ): void => {
      const instances = toArray<unknown>(raw);
      if (instances.length === 0) return;
      for (let i = 0; i < instances.length; i++) {
        const block = instances[i] as Record<string, unknown> | undefined;
        if (!block || typeof block !== "object") continue;
        if (block.enabled === false) continue;
        const agent = agents[i];
        if (agent === undefined) continue;
        const rawRoles = Array.isArray(block.roles)
          ? (block.roles as LegacyRoleEntry[])
          : [];
        const defaultRole =
          typeof block.defaultRole === "string" ? block.defaultRole : "allow-all";
        const dm = includeDm
          ? (block.dm as LegacyDMConfig | undefined)
          : undefined;
        if (rawRoles.length > 0 || dm !== undefined) {
          views.push({
            agentId: agent.id,
            platform,
            roles: rawRoles,
            defaultRole,
            dm,
          });
        }
      }
    };
    visitTopLevel("discord", legacy.discord, true);
    visitTopLevel("mattermost", legacy.mattermost, false);
    // bot.yaml has no top-level `slack[]` (Slack was post-MIG-7 only) — no third visit.
  }

  return views;
}

/**
 * Resolve the `home_stack` value for synthesised principals. Cortex-shape
 * input carries it under `stack.id`; legacy bot.yaml has no equivalent
 * so we default to `<operator_id>/default` (matches `deriveStackId`).
 */
function resolveHomeStack(legacy: LegacyBotYaml, operatorId: string): string {
  const stackId = legacy.stack?.id;
  if (typeof stackId === "string" && stackId.length > 0) return stackId;
  return `${operatorId}/default`;
}

/**
 * Lift the cortex-shape principal block straight through, with the
 * same normalisations `buildOperator` applies (lowercase id, ISO-3166
 * residency).
 *
 * R3 vocabulary migration (cortex#388) — reads either the new `principal:`
 * key or the legacy `operator:` key (the caller has already rejected configs
 * carrying both). The returned object is keyed `operator:` because the
 * `CortexConfig` type still uses that key during the transition release;
 * `convertBotYaml` re-keys it to `principal:` for emission.
 */
function buildOperatorFromCortexShape(
  legacy: LegacyBotYaml,
  warnings: ConversionWarning[],
): CortexConfig["principal"] {
  const op = legacy.principal ?? legacy.operator ?? {};
  if (typeof op.id !== "string" || op.id.length === 0) {
    throw new Error("cortex.yaml-shape input requires `principal.id`");
  }
  const operatorId = deriveAgentId(op.id);
  if (operatorId !== op.id) {
    warnings.push({
      field: "principal.id",
      message: `principal.id "${op.id}" normalized to "${operatorId}" (cortex requires lowercase alphanumeric + hyphen)`,
    });
  }
  let dataResidency = op.dataResidency;
  if (dataResidency === undefined) dataResidency = "NZ";
  else if (!/^[A-Z]{2}$/.test(dataResidency)) {
    const fixed = dataResidency.toUpperCase();
    if (/^[A-Z]{2}$/.test(fixed)) {
      warnings.push({
        field: "principal.dataResidency",
        message: `dataResidency "${dataResidency}" upcased to "${fixed}"`,
      });
      dataResidency = fixed;
    } else {
      warnings.push({
        field: "principal.dataResidency",
        message: `dataResidency "${dataResidency}" not a 2-letter ISO-3166 code; defaulting to "NZ"`,
      });
      dataResidency = "NZ";
    }
  }
  const operator: CortexConfig["principal"] = { id: operatorId, dataResidency };
  if (op.displayName) operator.displayName = op.displayName;
  if (op.discordId) operator.discordId = op.discordId;
  if (op.mattermostId) operator.mattermostId = op.mattermostId;
  if (op.slackId) operator.slackId = op.slackId;
  return operator;
}

/**
 * Lift cortex-shape `agents[]` to the validated CortexConfig.agents[]. The
 * presence blocks pass through the per-platform Zod schemas so each
 * agent's id and presence land normalised. Mappings get a synthetic entry
 * per (agent, platform) so `--check` output reflects the cortex-shape
 * path symmetrically with the legacy path.
 */
function buildAgentsFromCortexShape(
  legacy: LegacyBotYaml,
  warnings: ConversionWarning[],
  mappings: InstanceMapping[],
): CortexConfig["agents"] {
  const out: CortexConfig["agents"] = [];
  const sourceAgents = legacy.agents ?? [];
  for (let i = 0; i < sourceAgents.length; i++) {
    const a = sourceAgents[i];
    if (!a) continue;
    const rawId = a.id;
    if (typeof rawId !== "string" || rawId.length === 0) {
      throw new Error(`agents[${i}].id is required`);
    }
    const id = deriveAgentId(rawId);
    if (id !== rawId) {
      warnings.push({
        field: `agents[${i}].id`,
        message: `agent id "${rawId}" normalized to "${id}"`,
      });
    }
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new Error(`agents[${i}].id "${rawId}" cannot be derived to a valid agent id (^[a-z0-9-]+$)`);
    }
    const displayName = a.displayName ?? rawId;
    const persona = typeof a.persona === "string" && a.persona.length > 0
      ? a.persona
      : `./personas/${id}.md`;
    const trust = Array.isArray(a.trust) ? a.trust.filter((t): t is string => typeof t === "string") : [];
    const presence: CortexConfig["agents"][number]["presence"] = {};
    if (a.presence?.discord) {
      presence.discord = DiscordPresenceSchema.parse(a.presence.discord);
      mappings.push({
        legacyKind: "discord",
        legacyIndex: i,
        legacyInstanceId: undefined,
        newAgentId: id,
        newPresence: "discord",
      });
    }
    if (a.presence?.mattermost) {
      presence.mattermost = MattermostPresenceSchema.parse(a.presence.mattermost);
      mappings.push({
        legacyKind: "mattermost",
        legacyIndex: i,
        legacyInstanceId: undefined,
        newAgentId: id,
        newPresence: "mattermost",
      });
    }
    // Note: slack pass-through goes through PresenceSchema validation
    // when CortexConfigSchema.parse runs at the end of convertBotYaml.
    // We don't gate it here.
    // v2.0.0 (cortex#297) — `AgentSchema.roles[]` retired. Any legacy
    // `roles:` field on the input is ignored; capability declarations
    // flow into the top-level `policy:` block now.
    const agentOut: CortexConfig["agents"][number] = {
      id,
      displayName,
      persona,
      trust,
      presence,
    };
    if (a.presence?.slack) {
      // Pass-through: let the top-level CortexConfigSchema.parse validate
      // it. Cast keeps the assignment shape.
      (agentOut.presence as Record<string, unknown>).slack = a.presence.slack;
    }
    // cortex#428 (PR-B) — pass the `runtime` block through verbatim so
    // operators handing a v3.0.x cortex.yaml back to migrate-config keep
    // their substrate / mode / capabilities / sovereignty / maxConcurrent
    // declarations. `synthesizeRuntimeCapabilities` runs later and folds
    // in any missing `chat` default on top of the operator's existing
    // claims. Cast keeps the assignment shape — runtime is not in the
    // narrow `CortexConfig["agents"][number]` slot at this layer (Agent
    // schema has it but we're treating the build as additive).
    if (a.runtime && typeof a.runtime === "object") {
      (agentOut as Record<string, unknown>).runtime = a.runtime;
    }
    out.push(agentOut);
  }
  return out;
}

/**
 * Rewrite grove-era path strings (`~/.config/grove/...`) under the legacy
 * `paths:` block to their cortex equivalents (`~/.config/cortex/...`).
 *
 * cortex#88 item 1: legacy `bot.yaml` carries `paths.logDir:
 * ~/.config/grove/logs` (the AgentConfigSchema default in production grove-v2).
 * Without rewriting, the emitted cortex.yaml ships a stale grove path that
 * any consumer of `config.paths.logDir` will then write to — even though
 * the launchd plist's `StandardOutPath` already points at
 * `~/.config/cortex/logs` (per scripts/postinstall.sh). The two diverge,
 * and operators chasing missing logs get sent on a wild grove chase.
 *
 * Strategy: shallow substring rewrite over string-valued fields. Non-string
 * fields (rare, but `unknown` shape leaves the door open) pass through
 * unchanged. A warning surfaces whenever any rewrite fired so the operator
 * sees the substitution in the migrate-config report.
 */
function rewritePaths(legacyPaths: unknown, warnings: ConversionWarning[]): unknown {
  if (!legacyPaths || typeof legacyPaths !== "object") return legacyPaths;
  const paths = { ...(legacyPaths as Record<string, unknown>) };
  const rewrites: string[] = [];
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value !== "string") continue;
    if (value.includes("/.config/grove/")) {
      const next = value.replace("/.config/grove/", "/.config/cortex/");
      paths[key] = next;
      rewrites.push(`paths.${key}: "${value}" → "${next}"`);
    }
  }
  if (rewrites.length > 0) {
    warnings.push({
      field: "paths",
      message: `rewrote grove path(s) to cortex equivalents: ${rewrites.join("; ")}`,
    });
  }
  return paths;
}

/**
 * Translate `legacy.nats` onto the cortex `NatsConfigSchema` shape.
 *
 * Real production grove-v2 bot.yaml carries `nats.identity` in a legacy
 * `{ did, keyPath }` shape — DID + raw NKey seed path. Cortex's
 * `NatsIdentitySchema` requires `{ seedPath, publicKey }` (NKey seed path
 * plus a 56-char `U…` user pubkey) for envelope signing.
 *
 * The shapes can't be auto-translated — cortex needs the U-prefixed public
 * key derived from the seed, which we don't have at migration time.
 * Stripping the block with a warning is the right move: identity is
 * optional in cortex, the operator can run `nkeys -inkey ~/.nkey/foo.nk
 * -pubout` once post-migration and hand-add `seedPath` + `publicKey` to
 * the new cortex.yaml.
 *
 * Any other unknown fields under `nats` pass through; only the
 * shape-mismatched identity block is stripped.
 */
/**
 * cortex#324 (v2.0.3) — annotate the migrated `stack:` block with signing
 * material so cortex defaults to publishing signed envelopes.
 *
 * Three branches:
 *   1. `stack.nkey_seed_path` already set on the input → no-op (idempotent).
 *      The operator hand-managed signing; the migrator preserves it.
 *   2. `autoStackKey=true` AND legacy `nats.identity.seedPath` is set →
 *      reuse the NATS auth NKey for stack signing. Cortex's NKey loader
 *      enforces a `SU` (user-class) prefix gate (see
 *      `src/common/config/stack-signing-key.ts`); operators running NATS
 *      with a user-class NKey for auth pass that gate automatically.
 *      `nats.identity.publicKey` (when present) carries forward as
 *      `stack.nkey_pub` for the consistency pin.
 *   3. Neither — emit a warning telling the operator to set
 *      `stack.nkey_seed_path` (or re-run with `--auto-stack-key` when the
 *      legacy config already has a NATS NKey).
 *
 * Returns the (possibly updated) stack block, or `undefined` when the
 * input had no stack block AND no auto-population was performed. The
 * caller stores the return value back onto `cortex.stack`.
 */
function annotateStackSigning(
  existingStack: Record<string, unknown> | undefined,
  legacy: LegacyBotYaml,
  autoStackKey: boolean,
  warnings: ConversionWarning[],
): Record<string, unknown> | undefined {
  // Branch 1: nkey_seed_path already declared — idempotent no-op.
  if (
    existingStack !== undefined &&
    typeof existingStack.nkey_seed_path === "string" &&
    existingStack.nkey_seed_path.length > 0
  ) {
    return existingStack;
  }

  // Extract the NATS-side identity (used by branches 2 + 3 messaging).
  const natsIdentity =
    legacy.nats && typeof legacy.nats === "object"
      ? (legacy.nats as Record<string, unknown>).identity
      : undefined;
  const natsSeedPath =
    natsIdentity && typeof natsIdentity === "object"
      ? typeof (natsIdentity as Record<string, unknown>).seedPath === "string"
        ? ((natsIdentity as Record<string, unknown>).seedPath as string)
        : undefined
      : undefined;
  const natsPublicKey =
    natsIdentity && typeof natsIdentity === "object"
      ? typeof (natsIdentity as Record<string, unknown>).publicKey === "string"
        ? ((natsIdentity as Record<string, unknown>).publicKey as string)
        : undefined
      : undefined;

  // Branch 2: --auto-stack-key + NATS NKey available → reuse it.
  if (autoStackKey && natsSeedPath !== undefined) {
    const next: Record<string, unknown> = { ...(existingStack ?? {}) };
    next.nkey_seed_path = natsSeedPath;
    if (natsPublicKey !== undefined) next.nkey_pub = natsPublicKey;
    warnings.push({
      field: "stack.nkey_seed_path",
      message:
        `auto-populated stack.nkey_seed_path from nats.identity.seedPath (${natsSeedPath}) — ` +
        `cortex will sign outbound envelopes with the NATS auth NKey. ` +
        `Verify the seed is user-class (SU-prefixed) — operator/account NKeys (SO/SA) will fail at boot.`,
    });
    return next;
  }

  // Branch 3: warn — stack signing will stay off until the operator
  // declares the field. Wording mirrors the cortex.ts boot WARNING so
  // operators see consistent fix-paths across migrate-config + boot.
  const hint = natsSeedPath
    ? ` Re-run with \`--auto-stack-key\` to reuse \`${natsSeedPath}\` (NATS auth NKey) for stack signing.`
    : " Generate one via `nsc generate nkey -u > ~/.config/nats/cortex.nk && chmod 600 ~/.config/nats/cortex.nk` and add the path to cortex.yaml.";
  warnings.push({
    field: "stack.nkey_seed_path",
    message:
      "stack.nkey_seed_path is not set — cortex will publish UNSIGNED envelopes (peers running " +
      "verifySignedByChain will reject them). See docs/sop-stack-identity.md." +
      hint,
  });
  return existingStack;
}

function convertNats(legacyNats: unknown, warnings: ConversionWarning[]): unknown {
  if (!legacyNats || typeof legacyNats !== "object") return legacyNats;
  const nats = { ...(legacyNats as Record<string, unknown>) };
  const identity = nats.identity;
  if (identity && typeof identity === "object") {
    const id = identity as Record<string, unknown>;
    const hasCortexShape = typeof id.seedPath === "string" && typeof id.publicKey === "string";
    if (!hasCortexShape) {
      // Legacy `{did, keyPath}` or any other partial shape — strip + warn.
      const legacyKeys = Object.keys(id).join(", ");
      const keyPath = typeof id.keyPath === "string" ? id.keyPath : undefined;
      const did = typeof id.did === "string" ? id.did : undefined;
      const hint = keyPath
        ? ` Derive the U-prefixed pubkey via \`nkeys -inkey ${keyPath} -pubout\` and add` +
          ` \`nats.identity.seedPath: ${keyPath}\` + \`nats.identity.publicKey: U…\` to cortex.yaml.`
        : " Add `nats.identity.seedPath` + `nats.identity.publicKey` to cortex.yaml once you have an NKey seed.";
      warnings.push({
        field: "nats.identity",
        message:
          `legacy nats.identity shape (keys: ${legacyKeys}${did ? `; did=${did}` : ""}) does not match` +
          ` cortex schema {seedPath, publicKey} — stripping block.${hint}`,
      });
      delete nats.identity;
    }
  }
  // R4 (vocabulary migration 2026-05, myelin#185 + cortex#453) — the
  // legacy bot.yaml `{org}` placeholder retired. Rewrite any `{org}`
  // tokens in `nats.subjects` to the canonical `{principal}` so the
  // emitted cortex.yaml is consumable by post-#185 myelin runtimes.
  const subjects = nats.subjects;
  if (Array.isArray(subjects)) {
    const didRewrite = subjects.some(
      (s: unknown) => typeof s === "string" && s.includes("{org}"),
    );
    const rewritten: unknown[] = subjects.map((s: unknown): unknown => {
      if (typeof s !== "string" || !s.includes("{org}")) return s;
      return s.replaceAll("{org}", "{principal}");
    });
    nats.subjects = rewritten;
    if (didRewrite) {
      warnings.push({
        field: "nats.subjects",
        message:
          "rewrote legacy `{org}` placeholder to `{principal}` (R4 vocabulary " +
          "migration; myelin#185 dropped the `{org}` token from the subject grammar).",
      });
    }
  }
  return nats;
}

/**
 * Render a `--check` summary table. Returns a multi-line string suitable for
 * stdout. Pure — no console.log inside.
 */
export function formatCheckReport(result: ConversionResult): string {
  const lines: string[] = [];
  lines.push("cortex migrate-config — dry-run report");
  lines.push("");
  lines.push(`principal: ${result.cortex.principal.id} (dataResidency=${result.cortex.principal.dataResidency})`);
  lines.push(`agents:   ${result.cortex.agents.length}`);
  for (const a of result.cortex.agents) {
    const platforms = [
      a.presence.discord ? "discord" : null,
      a.presence.mattermost ? "mattermost" : null,
    ].filter(Boolean).join(", ");
    lines.push(`  - ${a.id} (${platforms}) persona=${a.persona} trust=[${a.trust.join(", ")}]`);
    // cortex#428 — surface the synthesised Stage-4 wiring on each agent so
    // `--check` output documents the runtime + surfaceSubjects defaults the
    // migrator applied. Agents missing a `runtime` block in the output (e.g.
    // legacy paths that bypass synthesis) silently skip these lines rather
    // than printing an empty marker.
    if (a.runtime) {
      lines.push(
        `      runtime: substrate=${a.runtime.substrate} mode=${a.runtime.mode} ` +
        `capabilities=[${a.runtime.capabilities.join(", ")}]`,
      );
    }
    const ds = a.presence.discord?.surfaceSubjects;
    if (ds && ds.length > 0) {
      lines.push(`      discord.surfaceSubjects: [${ds.join(", ")}]`);
    }
    // Mattermost: `surfaceSubjects` is not currently in MattermostPresenceSchema
    // (TODO at cortex-config.ts:252). Slack mirrors discord — print when set.
    const ss = (a.presence as Record<string, unknown>).slack as
      | { surfaceSubjects?: string[] }
      | undefined;
    if (ss?.surfaceSubjects && ss.surfaceSubjects.length > 0) {
      lines.push(`      slack.surfaceSubjects:   [${ss.surfaceSubjects.join(", ")}]`);
    }
  }
  // cortex#428 — show the (possibly synthesised) top-level capability catalog
  // so operators reviewing `--check` output see the catalog augmentation.
  if (result.cortex.capabilities.length > 0) {
    lines.push(`capabilities: ${result.cortex.capabilities.length}`);
    for (const c of result.cortex.capabilities) {
      lines.push(`  - ${c.id} provided_by=[${c.provided_by.join(", ")}]`);
    }
  }
  lines.push(`renderers: ${result.cortex.renderers.length}`);
  for (const r of result.cortex.renderers) {
    lines.push(`  - ${r.kind}`);
  }
  lines.push("");
  if (result.mappings.length > 0) {
    lines.push("instance mappings:");
    for (const m of result.mappings) {
      const label = m.legacyInstanceId ?? `<auto-${m.legacyIndex}>`;
      lines.push(`  ${m.legacyKind}[${m.legacyIndex}] ${label}  →  agents[${m.newAgentId}].presence.${m.newPresence}`);
    }
    lines.push("");
  }
  const policy = result.cortex.policy;
  if (policy && (policy.principals.length > 0 || policy.roles.length > 0)) {
    lines.push("");
    lines.push(`policy.principals: ${policy.principals.length}`);
    for (const p of policy.principals) {
      const platforms = Object.entries(p.platform_ids)
        .map(([plat, ids]) => `${plat}=${ids.length}`)
        .join(", ");
      const dm = p.session_config?.dm ? " +dm" : "";
      lines.push(`  - ${p.id} (home_operator=${p.home_operator}, home_stack=${p.home_stack}) roles=[${p.role.join(", ")}] platforms=[${platforms}]${dm}`);
    }
    lines.push(`policy.roles: ${policy.roles.length}`);
    for (const r of policy.roles) {
      lines.push(`  - ${r.id} (${r.capabilities.length} caps)`);
    }
    lines.push("");
    lines.push(`policy preflight: ${result.preflightGaps.length === 0 ? "OK" : `${result.preflightGaps.length} gap(s)`}`);
    for (const g of result.preflightGaps) {
      lines.push(`  [${g.kind}] ${g.hint}`);
    }
  }
  lines.push("");
  if (result.warnings.length > 0) {
    lines.push(`warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      lines.push(`  [${w.field}] ${w.message}`);
    }
  } else {
    lines.push("warnings: none");
  }
  return lines.join("\n");
}
