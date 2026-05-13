/**
 * G-500: Config Loader
 *
 * Loads central bot.yaml + per-network files from networks/ directory.
 * Apache/nginx-style: shared settings in bot.yaml, per-network files for
 * platform instances, cloud endpoints, repos, and security overrides.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, resolve, isAbsolute, basename } from "path";
import { parse as parseYaml } from "yaml";
import { BotConfigSchema, NetworkFileSchema, type BotConfig, type NetworkFile } from "../types/config";
import {
  AgentSchema,
  CortexConfigSchema,
  type Agent,
  type CortexConfig,
  type DiscordPresence,
  type MattermostPresence,
  type StackConfig,
} from "../types/cortex-config";

/**
 * Hardening cap on a single fragment file's size. Echo M3 on cortex#62 —
 * unbounded readFileSync against an attacker- or accident-controlled file
 * in agents.d/ is a footgun. 1MB is ~4 orders of magnitude over a realistic
 * fragment (~1KB); the guard catches mistakes (operator drops the wrong
 * file) and worst-case-malicious drops alike before they consume memory or
 * stall the loader.
 */
const FRAGMENT_MAX_BYTES = 1_048_576; // 1 MiB

/**
 * Expand a leading `~` in a path to `$HOME`. Single source of truth for the
 * loader + watcher to avoid drift (Echo M1 on cortex#62).
 *
 * Throws when `$HOME` is unset and the path needs expansion (Echo N3 — was
 * silently returning literal `~` strings). A path that doesn't start with
 * `~` is returned verbatim regardless of `$HOME`.
 */
export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(`cannot expand "~" in path "${p}": $HOME is not set`);
    }
    return p === "~" ? home : join(home, p.slice(2));
  }
  // Bare `~foo` (no slash) is not expanded — that's user-name resolution
  // semantics we explicitly don't support here. Return verbatim.
  return p;
}

/**
 * Result of `loadConfigWithAgents`. `inlineAgents` is non-empty when the
 * loader detected cortex-shape config (architecture §9.1 — `operator:` +
 * `agents:[]` instead of legacy `agent:` + flat `discord:[]`). The `config`
 * field is always a BotConfig — for cortex-shape input it's a synthesized
 * legacy-compatible projection so downstream consumers stay unchanged
 * during MIG-7. Callers that need the rich cortex shape use `inlineAgents`.
 *
 * `stack` (IAW Phase A.5, cortex#113): the optional top-level `stack:` block
 * from cortex-shape input, surfaced raw so the boot path can call
 * `deriveStackId` without re-parsing the file. Undefined for legacy bot.yaml
 * input (the block lives on `CortexConfigSchema` only — `BotConfigSchema` has
 * no equivalent during the MIG-7.2 overlap window). When the operator
 * declares `stack: { id: andreas/research }`, this field carries the
 * validated object; when the block is omitted, the field stays undefined and
 * `deriveStackId` default-derives `${operator.id}/default`.
 */
export interface LoadedConfig {
  config: BotConfig;
  inlineAgents: Agent[];
  /**
   * Optional stack identity (IAW A.5.3, cortex#113). Populated only when the
   * input was cortex-shape AND the operator declared a `stack:` block.
   * Legacy bot.yaml input always yields `undefined`. See `deriveStackId` in
   * `src/common/types/stack.ts` for the boot-time resolver that consumes this.
   */
  stack?: StackConfig;
}

/**
 * Detect whether `raw` is a cortex-shape config (operator + agents[]) vs
 * the legacy grove-v2 `bot.yaml` shape (singular agent + flat discord[]).
 *
 * The check is structural — must have `operator:` (object) AND `agents:`
 * (non-empty array). Either field on its own keeps the legacy path so a
 * partially-migrated config surfaces the relevant zod errors via
 * BotConfigSchema (legacy) rather than CortexConfigSchema's anti-field
 * rejections.
 */
function isCortexShape(raw: Record<string, unknown>): boolean {
  return (
    raw.operator !== null &&
    typeof raw.operator === "object" &&
    Array.isArray(raw.agents) &&
    raw.agents.length > 0
  );
}

/**
 * Load bot.yaml + networks/*.yaml, validate, merge.
 *
 * Backwards-compatible wrapper that returns just the BotConfig — callers
 * that need cortex-shape `inlineAgents` should use `loadConfigWithAgents`.
 */
export function loadConfig(path: string): BotConfig {
  return loadConfigWithAgents(path).config;
}

/**
 * MIG-7.2e — config-schema flip.
 *
 * Loads either:
 *   - legacy grove-v2 `bot.yaml` (agent: + flat discord:[] + mattermost:[]),
 *   - or cortex-shape `cortex.yaml` (operator: + agents:[] with per-agent
 *     presence: blocks),
 *
 * and returns a `LoadedConfig` with:
 *   - `config`: a BotConfig (legacy shape, possibly synthesized from cortex
 *      shape for downstream-consumer parity),
 *   - `inlineAgents`: the cortex-shape `agents[]` when present; empty for
 *      legacy input.
 *
 * Detection is structural: presence of `operator:` (object) + `agents:`
 * (non-empty array) → cortex; anything else → legacy. The two anti-field
 * rejections in `CortexConfigSchema` (legacy `agent:` / `discord:` /
 * `mattermost:` / `trustedAgentBots:` at the top level) surface as zod
 * errors only when the detection trips the cortex branch.
 */
export function loadConfigWithAgents(path: string): LoadedConfig {
  const expandedPath = path.replace(/^~/, process.env.HOME ?? "~");
  const configDir = dirname(expandedPath);

  const content = readFileSync(expandedPath, "utf-8");
  const raw = (parseYaml(content) ?? {}) as Record<string, unknown>;

  // Networks load against the on-disk path regardless of legacy/cortex shape —
  // both shapes share the same networks/ contract (G-500).
  //
  // cortex#88 item 7: `explicitNetworksDir` was true whenever `networksDir`
  // appeared anywhere in raw yaml — but migrate-config emits the schema
  // default (`./networks`) verbatim, so every startup tripped the
  // `does not exist` warn. Treat the literal default value as "not
  // explicit" so the warning fires only when the operator pointed
  // networksDir at a non-default path that's actually missing.
  const explicitNetworksDir =
    typeof raw.networksDir === "string" && raw.networksDir !== "./networks";
  const networksDir = resolve(
    configDir,
    (typeof raw.networksDir === "string" ? raw.networksDir : "./networks"),
  );
  const networks = loadNetworkFiles(networksDir, explicitNetworksDir);

  if (isCortexShape(raw)) {
    return loadCortexShape(raw, networks);
  }

  // ---------------------------------------------------------------------
  // Legacy bot.yaml path — unchanged from pre-MIG-7.2e behaviour.
  // ---------------------------------------------------------------------

  // Legacy fallback: if no network files and legacy api.* fields exist, create default network
  let isLegacyMode = false;
  if (networks.length === 0 && !raw.networksDir && hasLegacyCloudConfig(raw)) {
    networks.push(buildLegacyNetwork(raw));
    isLegacyMode = true;
  }

  // Aggregate discord/mattermost from networks into top-level arrays
  const aggregatedDiscord = isLegacyMode
    ? networks.flatMap(n => n.discord)
    : [
        ...(raw.discord ? (Array.isArray(raw.discord) ? raw.discord : [raw.discord]) : []),
        ...networks.flatMap(n => n.discord),
      ];
  const aggregatedMattermost = isLegacyMode
    ? networks.flatMap(n => n.mattermost)
    : [
        ...(raw.mattermost ? (Array.isArray(raw.mattermost) ? raw.mattermost : [raw.mattermost]) : []),
        ...networks.flatMap(n => n.mattermost),
      ];

  const merged = {
    ...raw,
    discord: aggregatedDiscord,
    mattermost: aggregatedMattermost,
    networks,
    networksDir: raw.networksDir ?? "./networks",
  };

  return {
    config: BotConfigSchema.parse(merged),
    inlineAgents: [],
  };
}

/**
 * Convert a cortex-shape `cortex.yaml` into a `LoadedConfig`.
 *
 * Strategy (MIG-7.2e):
 *   1. Parse via `CortexConfigSchema` — strict, rejects legacy top-level
 *      `agent:` / `discord:[]` / `mattermost:[]` / `trustedAgentBots:`
 *      blocks with operator-friendly migration errors.
 *   2. Flatten `agents[*].presence.{discord,mattermost}` into the legacy
 *      `BotConfig.{discord,mattermost}[]` arrays — each entry inherits
 *      the parent agent's id as a synthesized `instanceId` matching the
 *      MIG-7.2c convention (`${agent.id}-{platform}`).
 *   3. Synthesize a singular `agent:` block from the operator block plus
 *      the first agent — this keeps the legacy BotConfig contract intact
 *      while the multi-agent identity routing flows via `inlineAgents`
 *      through `startCortex`.
 *   4. Pass renderers/claude/attachments/execution/github/paths/nats
 *      through verbatim — they're identical in both schemas.
 *   5. Drop `trustedAgentBots:` (cortex expresses peer trust via per-agent
 *      `trust:` lists; legacy aggregation would lose the per-agent shape).
 */
function loadCortexShape(
  raw: Record<string, unknown>,
  networks: NetworkFile[],
): LoadedConfig {
  // Schema-strict parse. Any legacy field at the top level fails here with
  // the operator-friendly migration message baked into CortexConfigSchema.
  const cortexConfig: CortexConfig = CortexConfigSchema.parse(raw);

  const firstAgent = cortexConfig.agents[0]!;

  // Synthesize the BotConfig `agent:` singular from operator + first agent.
  // Downstream consumers that read `config.agent.name` get the first agent's
  // id; per-instance routing flows via `inlineAgents` so the multi-agent
  // case stays correct.
  const synthesizedAgent = {
    name: firstAgent.id,
    displayName: firstAgent.displayName,
    ...(cortexConfig.operator.id !== undefined && { operatorId: cortexConfig.operator.id }),
    ...(cortexConfig.operator.displayName !== undefined && {
      operatorName: cortexConfig.operator.displayName,
    }),
    ...(cortexConfig.operator.discordId !== undefined && {
      operatorDiscordId: cortexConfig.operator.discordId,
    }),
    ...(cortexConfig.operator.mattermostId !== undefined && {
      operatorMattermostId: cortexConfig.operator.mattermostId,
    }),
    ...(cortexConfig.operator.dataResidency !== undefined && {
      dataResidency: cortexConfig.operator.dataResidency,
    }),
    personaFile: firstAgent.persona,
  };

  // Flatten per-agent presence blocks into legacy flat arrays. Each entry
  // carries a synthesized `instanceId` matching MIG-7.2c's post-collapse
  // convention so `system.adapter.*` envelope ids stay stable.
  const discord = flattenDiscordPresences(cortexConfig.agents);
  const mattermost = flattenMattermostPresences(cortexConfig.agents);

  // Build the merged BotConfig-shaped object. Networks behave the same
  // way they do in the legacy path; renderers + nats + the *Config blocks
  // are passthrough.
  const merged: Record<string, unknown> = {
    agent: synthesizedAgent,
    discord,
    mattermost,
    networks,
    networksDir: cortexConfig.networksDir,
    renderers: cortexConfig.renderers,
    claude: cortexConfig.claude,
    attachments: cortexConfig.attachments,
    execution: cortexConfig.execution,
    github: cortexConfig.github,
    paths: cortexConfig.paths,
    ...(cortexConfig.nats !== undefined && { nats: cortexConfig.nats }),
  };

  return {
    config: BotConfigSchema.parse(merged),
    inlineAgents: [...cortexConfig.agents],
    // IAW A.5.3 — surface the validated `stack:` block to the boot path.
    // Always carry-through (even when undefined) keeps callers' destructuring
    // simple: `const { stack } = loadConfigWithAgents(path)` is safe whether
    // or not the operator declared the block.
    ...(cortexConfig.stack !== undefined && { stack: cortexConfig.stack }),
  };
}

/**
 * Convert each agent's optional Discord presence into a flat BotConfig
 * discord entry. Empty when no agent has Discord presence.
 *
 * The synthesized `instanceId` matches the MIG-7.2c default convention —
 * `${agent.id}-discord` with no guild suffix (one presence per agent in
 * cortex shape). This keeps `system.adapter.*` envelope ids stable across
 * the schema flip; operators who grep for the old `{agentName}-discord-{guildId}`
 * pattern will see the collapsed form once cortex.yaml is in effect.
 */
function flattenDiscordPresences(agents: ReadonlyArray<Agent>) {
  const out: Array<DiscordPresence & { instanceId: string }> = [];
  for (const a of agents) {
    const p = a.presence.discord;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-discord` });
  }
  return out;
}

function flattenMattermostPresences(agents: ReadonlyArray<Agent>) {
  const out: Array<MattermostPresence & { instanceId: string }> = [];
  for (const a of agents) {
    const p = a.presence.mattermost;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-mattermost` });
  }
  return out;
}

// =============================================================================
// F-2 — agents.d/ fragment loader
// =============================================================================

/**
 * Error raised when a fragment in `agents.d/` fails to load. Carries the
 * file path so the caller can name it in operator-facing error messages.
 *
 * Boot-time strict-failure rule (cortex#60 spec §FR-4): cortex must refuse
 * to start if any fragment fails. Mid-run rule (FR-5): caller catches and
 * keeps prior valid state alive.
 */
export class FragmentLoadError extends Error {
  public readonly file: string;
  public readonly reason: string;

  constructor(file: string, reason: string, cause?: Error) {
    super(`fragment ${file}: ${reason}`);
    this.name = "FragmentLoadError";
    this.file = file;
    this.reason = reason;
    if (cause) (this as { cause?: Error }).cause = cause;
  }
}

/**
 * Load all `*.yaml` / `*.yml` fragments from `dir` as Agent definitions.
 * Returns the agents in alphabetical filename order.
 *
 * Each fragment must parse as a single YAML document conforming to
 * `AgentSchema`. The `persona:` path is resolved relative to `dir` (or used
 * as-is if absolute); `~` is expanded to `$HOME`. The function checks the
 * persona file exists on disk and surfaces a `FragmentLoadError` if not.
 *
 * Returns `[]` if `dir` does not exist (operator hasn't created it yet).
 * Skips non-yaml files and dotfiles silently. Duplicate `id` across fragments
 * triggers `FragmentLoadError` naming both filenames + the conflicting id.
 *
 * This function does NOT resolve trust references — callers wrap the merged
 * Agent list in `AgentRegistry` (`src/common/agents/registry.ts`) which
 * throws `UnknownAgentReferenceError` on unresolved trust at construction.
 */
/**
 * Load and validate a single fragment file. Extracted from `loadAgentsDirectory`
 * (Echo M2 on cortex#63) so consumers like the CLI's `--fragment` mode get
 * the same hardening: 1 MiB size cap, ENOENT race handling, schema validation,
 * filename-stem warning, persona-path resolution + existence check.
 *
 * `personaBaseDir` is the directory relative paths in `agent.persona` resolve
 * against — typically the fragment's own directory.
 *
 * Returns `null` if the file vanished between caller's directory-listing and
 * this call (ENOENT race). The directory loader skips such files; single-file
 * callers translate `null` into a clear "file disappeared" error.
 */
export function loadAgentFromFile(filePath: string, personaBaseDir: string): Agent | null {
  // Echo M3 — size guard before readFileSync.
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new FragmentLoadError(
      filePath,
      `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
  if (size > FRAGMENT_MAX_BYTES) {
    throw new FragmentLoadError(
      filePath,
      `fragment exceeds ${FRAGMENT_MAX_BYTES} bytes (got ${size}); refusing to read`,
    );
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new FragmentLoadError(
      filePath,
      `read failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new FragmentLoadError(
      filePath,
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  // Echo N6 — operator-UX warn when id and filename stem disagree.
  const filename = basename(filePath);
  const filenameStem = basename(filename, filename.endsWith(".yml") ? ".yml" : ".yaml");
  if (raw && typeof raw === "object" && "id" in raw) {
    const declaredId = (raw as { id?: unknown }).id;
    if (typeof declaredId === "string" && declaredId !== filenameStem) {
      console.warn(
        `agents-loader: fragment ${filename} declares id "${declaredId}" which differs from its filename stem "${filenameStem}". Convention is to match — operator tooling (arc, cortex agents list) keys on the id, but mismatch obscures filesystem lookup.`,
      );
    }
  }

  let agent: Agent;
  try {
    agent = AgentSchema.parse(raw);
  } catch (err: unknown) {
    const issues = (err as { issues?: Array<{ path?: unknown[]; message: string }> }).issues ?? [];
    const details =
      issues.length > 0
        ? issues.map((i) => `  ${(i.path ?? []).join(".")}: ${i.message}`).join("\n")
        : err instanceof Error
          ? err.message
          : String(err);
    throw new FragmentLoadError(
      filePath,
      `schema validation failed:\n${details}`,
      err instanceof Error ? err : undefined,
    );
  }

  // Resolve persona path: ~ FIRST (so a `~/personas/foo.md` is fully
  // expanded before isAbsolute check), then relative → absolute against
  // the fragment's directory. Echo B1 fix: must expand BEFORE join.
  const personaPathExpanded = expandTilde(agent.persona);
  const personaPathResolved = isAbsolute(personaPathExpanded)
    ? personaPathExpanded
    : resolve(personaBaseDir, personaPathExpanded);

  if (!existsSync(personaPathResolved)) {
    throw new FragmentLoadError(
      filePath,
      `persona file does not exist: ${personaPathResolved}`,
    );
  }

  return { ...agent, persona: personaPathResolved };
}

export function loadAgentsDirectory(dir: string): Agent[] {
  const expandedDir = expandTilde(dir);

  if (!existsSync(expandedDir)) {
    return [];
  }

  const files = readdirSync(expandedDir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const agents: Agent[] = [];
  const seenIds = new Map<string, string>();

  for (const filename of files) {
    const filePath = join(expandedDir, filename);
    const agent = loadAgentFromFile(filePath, expandedDir);
    if (agent === null) {
      // File vanished between readdir and read — skip silently.
      continue;
    }

    if (seenIds.has(agent.id)) {
      throw new FragmentLoadError(
        filePath,
        `duplicate agent id "${agent.id}" — also defined in ${seenIds.get(agent.id)}`,
      );
    }
    seenIds.set(agent.id, filename);
    agents.push(agent);
  }

  return agents;
}

function loadNetworkFiles(networksDir: string, explicit: boolean): NetworkFile[] {
  if (!existsSync(networksDir)) {
    if (explicit) {
      // Operator pointed networksDir at a non-default path that doesn't
      // exist — surface loudly so they notice the typo / missing mount.
      console.warn(`config-loader: networksDir "${networksDir}" does not exist — no networks loaded`);
    } else {
      // cortex#88 item 7: the default path is absent. This is fine —
      // networks/ is optional today — but surface at info-level so
      // an operator who actually expected fragments to load can spot
      // the path mismatch.
      console.info(`config-loader: default networksDir "${networksDir}" not present — no networks loaded (this is fine if you haven't created any network fragments)`);
    }
    return [];
  }

  const files = readdirSync(networksDir)
    .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const networks: NetworkFile[] = [];
  const seenIds = new Map<string, string>();

  for (const filename of files) {
    const filePath = join(networksDir, filename);
    const content = readFileSync(filePath, "utf-8");

    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err) {
      throw new Error(`Failed to parse network file ${filename}: ${err instanceof Error ? err.message : err}`);
    }

    let network: NetworkFile;
    try {
      network = NetworkFileSchema.parse(raw);
    } catch (err: any) {
      const issues = err.issues ?? err.errors ?? [];
      const details = issues.map((i: any) => `  ${i.path?.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Validation error in ${filename}:\n${details || err.message}`);
    }

    if (seenIds.has(network.id)) {
      throw new Error(`Duplicate network ID "${network.id}" found in ${filename} and ${seenIds.get(network.id)}`);
    }
    seenIds.set(network.id, filename);
    networks.push(network);
  }

  return networks;
}

function hasLegacyCloudConfig(raw: Record<string, unknown>): boolean {
  const api = raw.api as Record<string, unknown> | undefined;
  return !!(api?.endpoint && api?.apiKey);
}

function buildLegacyNetwork(raw: Record<string, unknown>): NetworkFile {
  const api = raw.api as Record<string, unknown>;
  const agent = raw.agent as Record<string, unknown> | undefined;

  const operatorId = (api.operatorId || (agent ? agent.operatorId : undefined)) as string | undefined;
  if (!operatorId) {
    console.warn(
      "config-loader: no operatorId configured (api.operatorId or agent.operatorId). " +
      "Skipping cloud config for legacy default network to avoid phantom dashboard entries.",
    );
  }

  const cloud: Record<string, unknown> | undefined = operatorId ? {
    endpoint: api.endpoint as string,
    apiKey: api.apiKey as string,
    operatorId,
    ...(api.cfAccessClientId ? { cfAccessClientId: api.cfAccessClientId } : {}),
    ...(api.cfAccessClientSecret ? { cfAccessClientSecret: api.cfAccessClientSecret } : {}),
  } : undefined;
  const network: Record<string, unknown> = { id: "default" };
  if (cloud) network.cloud = cloud;

  if (raw.discord) network.discord = raw.discord;
  if (raw.mattermost) network.mattermost = raw.mattermost;
  if (raw.github) network.github = raw.github;

  const claude = raw.claude as Record<string, unknown> | undefined;
  if (claude) {
    const nc: Record<string, unknown> = {};
    if (claude.allowedDirs) nc.allowedDirs = claude.allowedDirs;
    if (claude.readOnlyDirs) nc.readOnlyDirs = claude.readOnlyDirs;
    if (claude.disallowedTools) nc.disallowedTools = claude.disallowedTools;
    if (claude.bashAllowlist) nc.bashAllowlist = claude.bashAllowlist;
    if (Object.keys(nc).length > 0) network.claude = nc;
  }

  if (agent) {
    const op: Record<string, unknown> = {};
    if (agent.operatorDiscordId) op.operatorDiscordId = agent.operatorDiscordId;
    if (agent.operatorMattermostId) op.operatorMattermostId = agent.operatorMattermostId;
    if (Object.keys(op).length > 0) network.operator = op;
  }

  return NetworkFileSchema.parse(network);
}
