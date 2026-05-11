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
import { AgentSchema, type Agent } from "../types/cortex-config";

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
 * Load bot.yaml + networks/*.yaml, validate, merge.
 */
export function loadConfig(path: string): BotConfig {
  const expandedPath = path.replace(/^~/, process.env.HOME ?? "~");
  const configDir = dirname(expandedPath);

  const content = readFileSync(expandedPath, "utf-8");
  const raw = parseYaml(content) ?? {};

  const explicitNetworksDir = !!raw.networksDir;
  const networksDir = resolve(configDir, raw.networksDir ?? "./networks");
  const networks = loadNetworkFiles(networksDir, explicitNetworksDir);

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

  return BotConfigSchema.parse(merged);
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

    // Echo M3 — size guard before readFileSync.
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch (err) {
      // Race: file was in readdir's list but vanished before we statSync'd
      // (operator just deleted it, or arc is mid-uninstall). Skip silently
      // — the reload loop continues with the rest of the directory.
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
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
      // Same race window — between stat and read.
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw new FragmentLoadError(
        filePath,
        `read failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }

    // Echo N6 — warn if agent.id doesn't match filename stem. Filename is
    // operator/arc convention; mismatched id is a footgun for both. We log
    // rather than throw — operator may have legitimate reasons (e.g.
    // versioned fragment filenames like `echo.v2.yaml`).
    const filenameStem = basename(filename, filename.endsWith(".yml") ? ".yml" : ".yaml");

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

    if (seenIds.has(agent.id)) {
      throw new FragmentLoadError(
        filePath,
        `duplicate agent id "${agent.id}" — also defined in ${seenIds.get(agent.id)}`,
      );
    }
    seenIds.set(agent.id, filename);

    // Resolve persona path: ~ → $HOME, then relative → absolute against the
    // fragment file's directory. The Agent type stays in
    // shape-fully-resolved-path; downstream callers don't re-resolve.
    const personaPathExpanded = expandTilde(agent.persona);
    const personaPathResolved = isAbsolute(personaPathExpanded)
      ? personaPathExpanded
      : resolve(expandedDir, personaPathExpanded);

    if (!existsSync(personaPathResolved)) {
      throw new FragmentLoadError(
        filePath,
        `persona file does not exist: ${personaPathResolved}`,
      );
    }

    agents.push({ ...agent, persona: personaPathResolved });
  }

  return agents;
}

function loadNetworkFiles(networksDir: string, explicit: boolean): NetworkFile[] {
  if (!existsSync(networksDir)) {
    if (explicit) {
      console.warn(`config-loader: networksDir "${networksDir}" does not exist — no networks loaded`);
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
