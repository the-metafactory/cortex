/**
 * MIG-7.2e — Pure conversion logic for `bot.yaml` (grove-v2) → `cortex.yaml`.
 *
 * Side-effect-free: takes a parsed legacy object, returns the converted object
 * + a list of warnings + a mapping table for `--check` output. The CLI wrapper
 * in `migrate-config.ts` handles file IO and stdout formatting.
 *
 * Coupling boundary: this module imports the cortex-config Zod schema and
 * verifies its output round-trips through `.parse()`. It does NOT import the
 * legacy `BotConfigSchema` — the legacy file in the wild may carry fields
 * (`personaFile`, `trustedAgentBots`) that were dropped from the in-repo
 * schema, so we accept input permissively and validate output strictly.
 */

import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";

import {
  type CortexConfig,
  CortexConfigSchema,
  type DiscordPresence,
  DiscordPresenceSchema,
  type MattermostPresence,
  MattermostPresenceSchema,
  RendererSchema,
} from "../../../common/types/cortex-config";

// =============================================================================
// Legacy input shape — permissive
// =============================================================================

/**
 * Legacy `bot.yaml` fields we accept. Not a Zod schema: real grove-v2
 * deployments may carry historical fields (`personaFile`, `trustedAgentBots`)
 * that no longer exist in `BotConfigSchema`. Accepting them as `unknown` lets
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
  agent: LegacyAgent;
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

export interface ConversionResult {
  /** The cortex.yaml-shaped object, ready to YAML.stringify and write. */
  cortex: CortexConfig;
  /** Non-fatal warnings — surfaced to stderr by the CLI. */
  warnings: ConversionWarning[];
  /**
   * Per-instance mapping table — shown by `--check`. Validates that each
   * legacy `discord[].instanceId` / `mattermost[].instanceId` maps to exactly
   * one new agent presence (plan §4 7.2e validation criterion #1).
   */
  mappings: InstanceMapping[];
}

/**
 * Options controlling validation strictness. The CLI flips `strict: true` for
 * `--strict` mode (warnings → errors).
 */
export interface ConvertOptions {
  /**
   * Directory the input `bot.yaml` was loaded from. Used to resolve
   * `personaFile` paths for the file-exists validation. Optional — when
   * omitted, persona files are not checked on disk (e.g. when tests parse
   * fixtures via in-memory strings rather than file paths).
   */
  configDir?: string;
}

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
): CortexConfig["operator"] {
  const a = legacy.agent;

  const rawOperatorId = a.operatorId ?? a.name;
  const operatorId = deriveAgentId(rawOperatorId);
  if (operatorId !== rawOperatorId) {
    warnings.push({
      field: "operator.id",
      message: `operatorId "${rawOperatorId}" normalized to "${operatorId}" (cortex requires lowercase alphanumeric + hyphen)`,
    });
  }

  let dataResidency = a.dataResidency;
  if (dataResidency === undefined) {
    dataResidency = "NZ";
  } else if (!/^[A-Z]{2}$/.test(dataResidency)) {
    const fixed = dataResidency.toUpperCase();
    if (/^[A-Z]{2}$/.test(fixed)) {
      warnings.push({
        field: "operator.dataResidency",
        message: `dataResidency "${dataResidency}" upcased to "${fixed}"`,
      });
      dataResidency = fixed;
    } else {
      warnings.push({
        field: "operator.dataResidency",
        message: `dataResidency "${dataResidency}" not a 2-letter ISO-3166 code; defaulting to "NZ"`,
      });
      dataResidency = "NZ";
    }
  }

  const operator: CortexConfig["operator"] = { id: operatorId, dataResidency };
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
  if (inst.roles !== undefined) candidate.roles = inst.roles;
  if (inst.defaultRole !== undefined) candidate.defaultRole = inst.defaultRole;
  if (inst.dm !== undefined) candidate.dm = inst.dm;
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
  if (inst.roles !== undefined) candidate.roles = inst.roles;
  if (inst.defaultRole !== undefined) candidate.defaultRole = inst.defaultRole;
  return MattermostPresenceSchema.parse(candidate);
}

/**
 * Resolve the persona file path for a converted agent. Returns the path the
 * cortex.yaml should carry plus an optional warning when the file doesn't
 * exist on disk (only checked when `configDir` is supplied).
 *
 * Fallback when `personaFile` is unset: `./personas/${agentId}.md`. The
 * cortex schema requires a non-empty string here; the warning surfaces the
 * fact that the file may need to be created.
 */
function resolvePersona(
  legacyPersonaFile: string | undefined,
  agentId: string,
  configDir: string | undefined,
  warnings: ConversionWarning[],
): string {
  const personaPath = legacyPersonaFile?.trim() || `./personas/${agentId}.md`;

  if (configDir) {
    const abs = isAbsolute(personaPath) ? personaPath : resolve(configDir, personaPath);
    if (!existsSync(abs)) {
      warnings.push({
        field: `agents[${agentId}].persona`,
        message: `persona file not found at ${abs}${legacyPersonaFile ? "" : " (defaulted from agent name)"}`,
      });
    }
  } else if (!legacyPersonaFile) {
    warnings.push({
      field: `agents[${agentId}].persona`,
      message: `agent.personaFile not set; defaulted to ${personaPath}`,
    });
  }

  return personaPath;
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
    const t = legacyTrust[i]!;
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
 * Synthesize the cortex `agents[]` list from the singular legacy `agent` plus
 * the (possibly multi-entry) `discord[]` and `mattermost[]` arrays.
 *
 * Strategy (per RESUME §MIG-7.2e Agents synthesis):
 *   - Pair discord[i] with mattermost[i] under one agent.
 *   - Index 0 → base agent id (deriveAgentId(agent.name)).
 *   - Index ≥1 → `${base}-${i + 1}` (so `luna-2`, `luna-3`).
 *   - Trust list propagates to every variant.
 *   - Persona path propagates to every variant.
 */
function buildAgents(
  legacy: LegacyBotYaml,
  warnings: ConversionWarning[],
  mappings: InstanceMapping[],
  configDir: string | undefined,
): { agents: CortexConfig["agents"]; baseId: string } {
  const discordInstances = toArray(legacy.discord);
  const mattermostInstances = toArray(legacy.mattermost);
  const baseId = deriveAgentId(legacy.agent.name);

  if (!AGENT_ID_PATTERN.test(baseId)) {
    throw new Error(
      `agent.name "${legacy.agent.name}" cannot be derived to a valid agent id (^[a-z0-9-]+$)`,
    );
  }

  const trust = buildTrustList(legacy.trustedAgentBots ?? [], warnings);

  const persona = resolvePersona(legacy.agent.personaFile, baseId, configDir, warnings);
  const displayName = legacy.agent.displayName || legacy.agent.name;

  const variantCount = Math.max(discordInstances.length, mattermostInstances.length, 1);

  if (variantCount > 1) {
    warnings.push({
      field: "agents",
      message: `legacy bot.yaml carries ${discordInstances.length} discord + ${mattermostInstances.length} mattermost instance(s) under a single agent.name — emitting ${variantCount} agents (${baseId}, ${baseId}-2, …)`,
    });
  }

  const agents: CortexConfig["agents"] = [];
  for (let i = 0; i < variantCount; i++) {
    const variantId = i === 0 ? baseId : `${baseId}-${i + 1}`;
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
      roles: [],
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

  if (legacy.api && legacy.api.enabled === true) {
    const port = typeof legacy.api.port === "number" ? legacy.api.port : 8767;
    renderers.push(RendererSchema.parse({ kind: "dashboard", port }));
    warnings.push({
      field: "api",
      message: `legacy api.enabled=true synthesized as renderers[].kind=dashboard (port ${port}); cloud-mode api fields (endpoint, apiKey, …) are NOT carried — re-add via networks/`,
    });
  }

  return renderers;
}

/**
 * Convert a legacy bot.yaml-shaped object to cortex.yaml-shape. Pure: no IO
 * apart from optional `existsSync` for persona-file validation.
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
  if (!legacy || typeof legacy !== "object") {
    throw new Error("input is not an object");
  }
  if (!legacy.agent || typeof legacy.agent !== "object") {
    throw new Error("bot.yaml missing required `agent:` block");
  }
  if (!legacy.agent.name || typeof legacy.agent.name !== "string") {
    throw new Error("bot.yaml missing required `agent.name`");
  }
  if (!legacy.agent.displayName || typeof legacy.agent.displayName !== "string") {
    throw new Error("bot.yaml missing required `agent.displayName`");
  }

  const warnings: ConversionWarning[] = [];
  const mappings: InstanceMapping[] = [];

  const operator = buildOperator(legacy, warnings);
  const { agents } = buildAgents(legacy, warnings, mappings, opts.configDir);
  const renderers = buildRenderers(legacy, warnings);

  if (legacy.grove !== undefined) {
    warnings.push({
      field: "grove",
      message: "legacy `grove:` block (F-11 notification toggles) is dropped — re-implement via renderers when needed",
    });
  }

  const cortex: Record<string, unknown> = {
    operator,
    agents,
    renderers,
  };

  if (legacy.claude !== undefined) cortex.claude = legacy.claude;
  else cortex.claude = {};

  if (legacy.attachments !== undefined) cortex.attachments = legacy.attachments;
  if (legacy.execution !== undefined) cortex.execution = legacy.execution;
  if (legacy.github !== undefined) cortex.github = legacy.github;
  if (legacy.paths !== undefined) cortex.paths = rewritePaths(legacy.paths, warnings);
  if (legacy.networksDir !== undefined) cortex.networksDir = legacy.networksDir;
  if (legacy.networks !== undefined) cortex.networks = legacy.networks;
  if (legacy.nats !== undefined) cortex.nats = convertNats(legacy.nats, warnings);

  const parsed = CortexConfigSchema.parse(cortex);
  return { cortex: parsed, warnings, mappings };
}

/**
 * Rewrite grove-era path strings (`~/.config/grove/...`) under the legacy
 * `paths:` block to their cortex equivalents (`~/.config/cortex/...`).
 *
 * cortex#88 item 1: legacy `bot.yaml` carries `paths.logDir:
 * ~/.config/grove/logs` (the BotConfigSchema default in production grove-v2).
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
  lines.push(`operator: ${result.cortex.operator.id} (dataResidency=${result.cortex.operator.dataResidency})`);
  lines.push(`agents:   ${result.cortex.agents.length}`);
  for (const a of result.cortex.agents) {
    const platforms = [
      a.presence.discord ? "discord" : null,
      a.presence.mattermost ? "mattermost" : null,
    ].filter(Boolean).join(", ");
    lines.push(`  - ${a.id} (${platforms}) persona=${a.persona} trust=[${a.trust.join(", ")}]`);
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
