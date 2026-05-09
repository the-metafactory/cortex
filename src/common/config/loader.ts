/**
 * G-500: Config Loader
 *
 * Loads central bot.yaml + per-network files from networks/ directory.
 * Apache/nginx-style: shared settings in bot.yaml, per-network files for
 * platform instances, cloud endpoints, repos, and security overrides.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { BotConfigSchema, NetworkFileSchema, type BotConfig, type NetworkFile } from "../types/config";

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

function loadNetworkFiles(networksDir: string, explicit: boolean): NetworkFile[] {
  if (!existsSync(networksDir)) {
    if (explicit) {
      console.warn(`grove-bot: networksDir "${networksDir}" does not exist — no networks loaded`);
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
      "grove-bot: no operatorId configured (api.operatorId or agent.operatorId). " +
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
