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
import { AgentConfigSchema, NetworkFileSchema, type AgentConfig, type NetworkFile } from "../types/config";
import {
  AgentSchema,
  CortexConfigSchema,
  type Agent,
  type BusConfig,
  type CortexConfig,
  type DiscordPresence,
  type MattermostPresence,
  type Policy,
  type SlackPresence,
  type StackConfig,
} from "../types/cortex-config";

/**
 * Hardening cap on a single fragment file's size. Echo M3 on cortex#62 —
 * unbounded readFileSync against an attacker- or accident-controlled file
 * in agents.d/ is a footgun. 1MB is ~4 orders of magnitude over a realistic
 * fragment (~1KB); the guard catches mistakes (principal drops the wrong
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
 * loader detected cortex-shape config (architecture §9.1 — `principal:` +
 * `agents:[]` instead of legacy `agent:` + flat `discord:[]`). The `config`
 * field is always an AgentConfig — for cortex-shape input it's a synthesized
 * legacy-compatible projection so downstream consumers stay unchanged
 * during MIG-7. Callers that need the rich cortex shape use `inlineAgents`.
 *
 * `stack` (IAW Phase A.5, cortex#113): the optional top-level `stack:` block
 * from cortex-shape input, surfaced raw so the boot path can call
 * `deriveStackId` without re-parsing the file. Undefined for legacy bot.yaml
 * input (the block lives on `CortexConfigSchema` only — `AgentConfigSchema` has
 * no equivalent during the MIG-7.2 overlap window). When the principal
 * declares `stack: { id: andreas/research }`, this field carries the
 * validated object; when the block is omitted, the field stays undefined and
 * `deriveStackId` default-derives `${principal.id}/default`.
 */
export interface LoadedConfig {
  config: AgentConfig;
  inlineAgents: Agent[];
  /**
   * v2.0.0 (cortex#297) — principal's platform-side ids surfaced through the
   * loader after `agent.operatorDiscordId/Mattermost/Slack` retired from
   * AgentConfig. Populated only for cortex-shape configs (legacy bot.yaml
   * input always yields `undefined`). The boot path reads these to wire
   * `DiscordAdapterInfra.principal.discordId` etc.
   */
  principal?: {
    id: string;
    /**
     * cortex#429 PR-C — surface the principal's display name onto the
     * loaded boot-time view so dashboard wiring no longer has to dip
     * back into the removed `AgentConfig.agent.operatorName` legacy
     * field. Optional — principals can omit `principal.displayName` on
     * cortex.yaml and the boot path falls back to `principal.id`.
     */
    displayName?: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
  };
  /**
   * Optional stack identity (IAW A.5.3, cortex#113). Populated only when the
   * input was cortex-shape AND the principal declared a `stack:` block.
   * Legacy bot.yaml input always yields `undefined`. See `deriveStackId` in
   * `src/common/types/stack.ts` for the boot-time resolver that consumes this.
   */
  stack?: StackConfig;
  /**
   * Optional policy block (IAW C.3.1, cortex#115). Populated only when
   * the input was cortex-shape AND the principal declared a `policy:`
   * block. Legacy bot.yaml input always yields `undefined`. The boot
   * path passes this through to `policyEngineFromConfig` which returns
   * `undefined` when the block is absent OR has no principals — in
   * which case the dispatch-listener falls back to the legacy
   * unauthenticated path until C.2b removes it.
   */
  policy?: Policy;
  /**
   * Optional bus provisioning block from cortex-shape input. Defaults are
   * already applied by CortexConfigSchema. Legacy bot.yaml input yields
   * undefined and the boot path uses hardcoded defaults.
   */
  bus?: BusConfig;
}

/**
 * Detect whether `raw` is a cortex-shape config (principal/operator + agents[])
 * vs the legacy grove-v2 `bot.yaml` shape (singular agent + flat discord[]).
 *
 * The check is structural — must have a principal block (`principal:` or the
 * legacy `operator:`, object) AND `agents:` (non-empty array). Either field on
 * its own keeps the legacy path so a partially-migrated config surfaces the
 * relevant zod errors via AgentConfigSchema (legacy) rather than
 * CortexConfigSchema's anti-field rejections.
 */
interface ZodLikeIssue {
  path?: (string | number)[];
  message: string;
}
interface ZodLikeError {
  issues?: ZodLikeIssue[];
  errors?: ZodLikeIssue[];
}

/**
 * Runtime check for a Zod-shaped error. Zod v3 exposes `.errors`, Zod v4
 * exposes `.issues`. Cortex's schemas straddle both — accept either.
 */
function isZodLikeError(err: unknown): err is ZodLikeError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { issues?: unknown; errors?: unknown };
  return Array.isArray(e.issues) || Array.isArray(e.errors);
}

/**
 * R3 vocabulary migration (cortex#388) v3.0.0 BREAKING — typed error
 * raised when a single `cortex.yaml` carries BOTH a legacy `operator:`
 * block AND the canonical `principal:` block.
 *
 * The trust-boundary contract from v2.x is preserved at v3: a config
 * declaring two principal blocks is ambiguous and MUST be rejected
 * before any membership / capability decision. v3 drops the
 * legacy-only acceptance path (principals upgrading from v2.x run
 * `cortex migrate-config <config.yaml>` to delete the old block), but
 * the dual-block rejection stays — a hand-edited config that kept the
 * old block while adding the new one must surface the conflict
 * loudly rather than be silently resolved.
 */
export class DualBlockConflictError extends Error {
  /** Stable discriminator for programmatic handling by callers / tests. */
  public readonly code = "dual_field_conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "DualBlockConflictError";
  }
}

/**
 * R3 vocabulary migration (cortex#388) v3.0.0 BREAKING — resolve the
 * principal block from a cortex-shape config. cortex.yaml now requires
 * the canonical `principal:` key; the legacy `operator:`-only path was
 * removed at v3.0.0 (manifest PR-11). Principals upgrading from v2.x run
 * `cortex migrate-config <config.yaml>` to rewrite their config — the
 * migrate-config CLI continues to read legacy `operator:`-shaped input
 * (historical record per cortex#388 completion-signal allow-list).
 *
 * Trust-boundary rule: if BOTH `principal:` and `operator:` keys are
 * present (a hand-edited config mid-migration that kept the old block
 * while adding the new one), raise `DualBlockConflictError` — the
 * ambiguous config must surface rather than silently resolve to one
 * block before any membership / capability decision.
 */
function resolvePrincipalBlock(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const hasPrincipal =
    raw.principal !== null && typeof raw.principal === "object";
  const hasOperator =
    raw.operator !== null && typeof raw.operator === "object";

  if (hasPrincipal && hasOperator) {
    throw new DualBlockConflictError(
      "cortex.yaml declares BOTH a `principal:` block and a legacy " +
        "`operator:` block. v3.0.0 BREAKING (manifest PR-11) — the " +
        "`operator:` block is no longer a valid cortex.yaml key, but a " +
        "config declaring both is a deployment-config trust boundary and " +
        "is rejected before any membership / capability decision is made. " +
        "Delete the legacy `operator:` block (run `cortex migrate-config " +
        "<your-config.yaml>` to regenerate a clean `principal:`-shaped " +
        "config).",
    );
  }

  if (hasPrincipal) return raw.principal as Record<string, unknown>;
  return undefined;
}

function isCortexShape(raw: Record<string, unknown>): boolean {
  // v3.0.0 BREAKING — cortex.yaml requires the canonical `principal:`
  // key. A config still carrying the legacy `operator:` block falls
  // through to the bot.yaml-shape detection path, where it is loaded
  // by the migrate-config-compatible legacy reader and the principal
  // is steered toward `cortex migrate-config`.
  return (
    resolvePrincipalBlock(raw) !== undefined &&
    Array.isArray(raw.agents) &&
    raw.agents.length > 0
  );
}

/**
 * Load bot.yaml + networks/*.yaml, validate, merge.
 *
 * Backwards-compatible wrapper that returns just the AgentConfig — callers
 * that need cortex-shape `inlineAgents` should use `loadConfigWithAgents`.
 */
export function loadConfig(path: string): AgentConfig {
  return loadConfigWithAgents(path).config;
}

/**
 * MIG-7.2e — config-schema flip.
 *
 * Loads either:
 *   - legacy grove-v2 `bot.yaml` (agent: + flat discord:[] + mattermost:[]),
 *   - or cortex-shape `cortex.yaml` (principal: + agents:[] with per-agent
 *     presence: blocks),
 *
 * and returns a `LoadedConfig` with:
 *   - `config`: an AgentConfig (legacy shape, possibly synthesized from cortex
 *      shape for downstream-consumer parity),
 *   - `inlineAgents`: the cortex-shape `agents[]` when present; empty for
 *      legacy input.
 *
 * Detection is structural: presence of `principal:` (object) + `agents:`
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
  // explicit" so the warning fires only when the principal pointed
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

  // Aggregate discord/mattermost from networks into top-level arrays.
  // Top-level `raw.discord` / `raw.mattermost` may be either a single
  // object or an array — normalize to array, ignore everything else.
  const rawDiscord = raw.discord;
  const rawMattermost = raw.mattermost;
  const topDiscord: unknown[] = Array.isArray(rawDiscord)
    ? rawDiscord
    : rawDiscord !== undefined && rawDiscord !== null
      ? [rawDiscord]
      : [];
  const topMattermost: unknown[] = Array.isArray(rawMattermost)
    ? rawMattermost
    : rawMattermost !== undefined && rawMattermost !== null
      ? [rawMattermost]
      : [];
  const aggregatedDiscord = isLegacyMode
    ? networks.flatMap((n) => n.discord)
    : [...topDiscord, ...networks.flatMap((n) => n.discord)];
  const aggregatedMattermost = isLegacyMode
    ? networks.flatMap((n) => n.mattermost)
    : [...topMattermost, ...networks.flatMap((n) => n.mattermost)];

  const merged = {
    ...raw,
    discord: aggregatedDiscord,
    mattermost: aggregatedMattermost,
    networks,
    networksDir: raw.networksDir ?? "./networks",
  };

  return {
    config: AgentConfigSchema.parse(merged),
    inlineAgents: [],
  };
}

/**
 * Convert a cortex-shape `cortex.yaml` into a `LoadedConfig`.
 *
 * Strategy (MIG-7.2e):
 *   1. Parse via `CortexConfigSchema` — strict, rejects legacy top-level
 *      `agent:` / `discord:[]` / `mattermost:[]` / `trustedAgentBots:`
 *      blocks with principal-friendly migration errors.
 *   2. Flatten `agents[*].presence.{discord,mattermost}` into the legacy
 *      `AgentConfig.{discord,mattermost}[]` arrays — each entry inherits
 *      the parent agent's id as a synthesized `instanceId` matching the
 *      MIG-7.2c convention (`${agent.id}-{platform}`).
 *   3. Synthesize a singular `agent:` block from the principal block plus
 *      the first agent — this keeps the legacy AgentConfig contract intact
 *      while the multi-agent identity routing flows via `inlineAgents`
 *      through `startCortex`.
 *   4. Pass renderers/claude/attachments/execution/github/paths/nats
 *      through verbatim — they're identical in both schemas.
 *   5. Drop `trustedAgentBots:` (cortex expresses peer trust via per-agent
 *      `trust:` lists; legacy aggregation would lose the per-agent shape).
 */
/**
 * v2.0.0 cutover (cortex#297) — reject legacy `presence.<platform>.roles[]`,
 * `presence.discord.dm`, and `agents[].roles[]` fields with a principal-
 * actionable error pointing at `migrate-config`. Zod's default-strip
 * behaviour would silently drop these fields post-cutover; legacy principals
 * upgrading without running `migrate-config` first would see their auth
 * configuration vanish without warning. Detection happens BEFORE Zod parse
 * so the error message carries the exact field path principals see in their
 * own cortex.yaml.
 */
function detectLegacyAuthorisationFields(raw: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  const agents = raw.agents;
  if (!Array.isArray(agents)) return offenders;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i] as Record<string, unknown> | undefined;
    if (!agent || typeof agent !== "object") continue;
    if (Array.isArray(agent.roles) && agent.roles.length > 0) {
      offenders.push(`agents[${i}].roles[]`);
    }
    const presence = agent.presence as Record<string, unknown> | undefined;
    if (!presence || typeof presence !== "object") continue;
    for (const platform of ["discord", "mattermost", "slack"] as const) {
      const block = presence[platform] as Record<string, unknown> | undefined;
      if (!block || typeof block !== "object") continue;
      if (Array.isArray(block.roles) && block.roles.length > 0) {
        offenders.push(`agents[${i}].presence.${platform}.roles[]`);
      }
      if (block.defaultRole !== undefined) {
        offenders.push(`agents[${i}].presence.${platform}.defaultRole`);
      }
      if (platform === "discord" && block.dm !== undefined) {
        offenders.push(`agents[${i}].presence.discord.dm`);
      }
    }
  }
  // Top-level policy.parallel_mode_enabled retired with the parallel-mode
  // plumbing in cortex#297; surface a clear error for any leftover flag.
  const policy = raw.policy as Record<string, unknown> | undefined;
  if (policy && typeof policy === "object" && "parallel_mode_enabled" in policy) {
    offenders.push("policy.parallel_mode_enabled");
  }
  return offenders;
}

function loadCortexShape(
  raw: Record<string, unknown>,
  networks: NetworkFile[],
): LoadedConfig {
  // v3.0.0 BREAKING (manifest PR-11) — cortex.yaml requires the canonical
  // `principal:` key. Pass the raw config straight to the schema; the
  // schema rejects a legacy `operator:`-shaped file with the
  // strip-by-default → "Invalid input: expected object" error at the
  // `principal:` slot. Principals upgrading from v2.x run
  // `cortex migrate-config <config.yaml>` to convert.
  const normalised: Record<string, unknown> = raw;

  // v2.0.0 cutover (cortex#297) — reject legacy authorisation fields with a
  // clear pointer at the migrate-config CLI BEFORE Zod's strip-by-default
  // semantics silently drop them.
  const legacyOffenders = detectLegacyAuthorisationFields(normalised);
  if (legacyOffenders.length > 0) {
    throw new Error(
      `cortex.yaml carries legacy v1.x authorisation fields no longer supported in v2.0.0:\n` +
        legacyOffenders.map((f) => `  - ${f}`).join("\n") +
        `\n\nRun \`bun src/cli/cortex/commands/migrate-config.ts <your-config.yaml>\` first to ` +
        `synthesise the new top-level \`policy:\` block (principals[] + roles[]), then re-launch cortex. ` +
        `See docs/design-policy-cutover.md §16 for the schema delta.`,
    );
  }
  // Schema-strict parse. Any legacy field at the top level fails here with
  // the principal-friendly migration message baked into CortexConfigSchema.
  const cortexConfig: CortexConfig = CortexConfigSchema.parse(normalised);

  // CortexConfigSchema guarantees `agents.min(1)`, so [0] is always defined
  // at runtime; noUncheckedIndexedAccess still types it as possibly undefined.
  const firstAgent = cortexConfig.agents[0];
  if (firstAgent === undefined) {
    throw new Error("invariant: agents schema enforced .min(1) but [0] missing");
  }

  // Synthesize the AgentConfig `agent:` singular from principal + first agent.
  // Downstream consumers that read `config.agent.name` get the first agent's
  // id; per-instance routing flows via `inlineAgents` so the multi-agent
  // case stays correct.
  //
  // cortex#429 PR-C — `operatorId` and `operatorName` synthesis retired
  // alongside the schema fields. Downstream consumers (cortex.ts,
  // myelin runtime) now read the principal identity directly from
  // `LoadedConfig.principal.id` (returned below) and the helpers that
  // accept it as a parameter.
  //
  // `principal.id` and `principal.dataResidency` are non-optional after parse
  // (required + default respectively), so prior `!== undefined` guards
  // were dead conditions.
  const synthesizedAgent = {
    name: firstAgent.id,
    displayName: firstAgent.displayName,
    // v2.0.0 cutover (cortex#297) — `operator*Id` fields retired from
    // AgentConfig.agent. Principal's platform-side ids surface through
    // `LoadedConfig.principal` (see return value below); the boot path in
    // cortex.ts reads them from there.
    dataResidency: cortexConfig.principal.dataResidency,
    personaFile: firstAgent.persona,
  };

  // Flatten per-agent presence blocks into legacy flat arrays. Each entry
  // carries a synthesized `instanceId` matching MIG-7.2c's post-collapse
  // convention so `system.adapter.*` envelope ids stay stable.
  const discord = flattenDiscordPresences(cortexConfig.agents);
  const mattermost = flattenMattermostPresences(cortexConfig.agents);
  const slack = flattenSlackPresences(cortexConfig.agents);

  // Build the merged AgentConfig-shaped object. Networks behave the same
  // way they do in the legacy path; renderers + nats + the *Config blocks
  // are passthrough.
  const merged: Record<string, unknown> = {
    agent: synthesizedAgent,
    discord,
    mattermost,
    slack,
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
    config: AgentConfigSchema.parse(merged),
    inlineAgents: [...cortexConfig.agents],
    // v2.0.0 (cortex#297) — surface principal platform ids for the boot path.
    principal: {
      id: cortexConfig.principal.id,
      ...(cortexConfig.principal.displayName !== undefined && {
        displayName: cortexConfig.principal.displayName,
      }),
      ...(cortexConfig.principal.discordId !== undefined && {
        discordId: cortexConfig.principal.discordId,
      }),
      ...(cortexConfig.principal.mattermostId !== undefined && {
        mattermostId: cortexConfig.principal.mattermostId,
      }),
      ...(cortexConfig.principal.slackId !== undefined && {
        slackId: cortexConfig.principal.slackId,
      }),
    },
    // IAW A.5.3 — surface the validated `stack:` block to the boot path.
    // Always carry-through (even when undefined) keeps callers' destructuring
    // simple: `const { stack } = loadConfigWithAgents(path)` is safe whether
    // or not the principal declared the block.
    ...(cortexConfig.stack !== undefined && { stack: cortexConfig.stack }),
    // IAW C.3.1 — same pattern for the `policy:` block. Surfaced raw so
    // the boot path passes it to `policyEngineFromConfig` once. The
    // schema layer (PolicySchema.superRefine) has already enforced
    // cross-references + uniqueness, so this is a pure carry-through.
    ...(cortexConfig.policy !== undefined && { policy: cortexConfig.policy }),
    bus: cortexConfig.bus,
  };
}

/**
 * Convert each agent's optional Discord presence into a flat AgentConfig
 * discord entry. Empty when no agent has Discord presence.
 *
 * The synthesized `instanceId` matches the MIG-7.2c default convention —
 * `${agent.id}-discord` with no guild suffix (one presence per agent in
 * cortex shape). This keeps `system.adapter.*` envelope ids stable across
 * the schema flip; principals who grep for the old `{agentName}-discord-{guildId}`
 * pattern will see the collapsed form once cortex.yaml is in effect.
 */
function flattenDiscordPresences(agents: readonly Agent[]) {
  const out: (DiscordPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.discord;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-discord` });
  }
  return out;
}

function flattenMattermostPresences(agents: readonly Agent[]) {
  const out: (MattermostPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.mattermost;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-mattermost` });
  }
  return out;
}

/**
 * Convert each agent's optional Slack presence into a flat AgentConfig
 * slack entry. Mirror of `flattenDiscordPresences` /
 * `flattenMattermostPresences` — empty when no agent declares a
 * `presence.slack` block.
 */
function flattenSlackPresences(agents: readonly Agent[]) {
  const out: (SlackPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.slack;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-slack` });
  }
  return out;
}

// =============================================================================
// F-2 — agents.d/ fragment loader
// =============================================================================

/**
 * Error raised when a fragment in `agents.d/` fails to load. Carries the
 * file path so the caller can name it in principal-facing error messages.
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
 * Returns `[]` if `dir` does not exist (principal hasn't created it yet).
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

  // Echo N6 — principal-UX warn when id and filename stem disagree.
  const filename = basename(filePath);
  const filenameStem = basename(filename, filename.endsWith(".yml") ? ".yml" : ".yaml");
  if (raw && typeof raw === "object" && "id" in raw) {
    const declaredId = (raw as { id?: unknown }).id;
    if (typeof declaredId === "string" && declaredId !== filenameStem) {
      console.warn(
        `agents-loader: fragment ${filename} declares id "${declaredId}" which differs from its filename stem "${filenameStem}". Convention is to match — principal tooling (arc, cortex agents list) keys on the id, but mismatch obscures filesystem lookup.`,
      );
    }
  }

  let agent: Agent;
  try {
    agent = AgentSchema.parse(raw);
  } catch (err: unknown) {
    const issues = (err as { issues?: { path?: unknown[]; message: string }[] }).issues ?? [];
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
      // Principal pointed networksDir at a non-default path that doesn't
      // exist — surface loudly so they notice the typo / missing mount.
      console.warn(`config-loader: networksDir "${networksDir}" does not exist — no networks loaded`);
    } else {
      // cortex#88 item 7: the default path is absent. This is fine —
      // networks/ is optional today — but surface at info-level so
      // a principal who actually expected fragments to load can spot
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
      throw new Error(
        `Failed to parse network file ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let network: NetworkFile;
    try {
      network = NetworkFileSchema.parse(raw);
    } catch (err) {
      // Zod errors expose either `.issues` (v4) or `.errors` (v3) — narrow
      // via runtime feature-detection without `any`.
      const zodIssues = isZodLikeError(err) ? (err.issues ?? err.errors ?? []) : [];
      const details = zodIssues
        .map((i) => `  ${i.path?.join(".") ?? "?"}: ${i.message}`)
        .join("\n");
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Validation error in ${filename}:\n${details !== "" ? details : message}`,
        { cause: err },
      );
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
  return !!(api?.endpoint && api.apiKey);
}

function buildLegacyNetwork(raw: Record<string, unknown>): NetworkFile {
  const api = raw.api as Record<string, unknown>;
  const agent = raw.agent as Record<string, unknown> | undefined;

  const operatorId = (api.operatorId ?? (agent ? agent.operatorId : undefined)) as string | undefined;
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
