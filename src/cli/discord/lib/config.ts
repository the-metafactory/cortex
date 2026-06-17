/**
 * Discord CLI configuration — stored at ~/.config/cortex/cli.yaml.
 *
 * GV-1 (cortex#1076): the canonical location is `~/.config/cortex/cli.yaml`.
 * Reads are cortex-first with a `~/.config/grove/cli.yaml` fallback during the
 * transition window; the first write migrates the legacy grove copy to cortex
 * (mode-preserving) and persists cortex-side thereafter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import YAML from "yaml";
import { cortexConfigPath, migrateGroveConfigFile, resolveConfigFilePath } from "../../../common/config/config-path";

export interface ChannelConfig {
  /** Discord channel ID */
  id: string;
}

/**
 * A named server profile — a second (or third, …) guild the same bot is in.
 *
 * Only `guildId` is required: it is the value used for channel/thread NAME
 * resolution within that guild. `botToken`, `defaultChannel`, and `channels`
 * are optional overrides; when absent the top-level (grove) values are used.
 * This lets one token serve every guild the bot has joined while keeping each
 * guild's name→id resolution scoped to the right server.
 */
export interface ServerProfile {
  /** Discord guild/server ID for this profile (required) */
  guildId: string;
  /** Per-profile bot token; falls back to top-level botToken when absent */
  botToken?: string;
  /** Per-profile default channel; falls back to top-level defaultChannel */
  defaultChannel?: string;
  /** Per-profile cached channel name→id map */
  channels?: Record<string, ChannelConfig>;
}

export interface DiscordCliConfig {
  /** Discord bot token */
  botToken?: string;
  /** Discord guild/server ID */
  guildId?: string;
  /** Default channel name to post to */
  defaultChannel?: string;
  /** Named channel configs */
  channels?: Record<string, ChannelConfig>;
  /** Named server profiles for guilds other than the top-level (grove) one */
  servers?: Record<string, ServerProfile>;
}

const CONFIG_FILENAME = "cli.yaml";

export function loadConfig(): DiscordCliConfig {
  // cortex-first, grove-fallback (GV-1).
  const path = resolveConfigFilePath(CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  return (YAML.parse(text) as DiscordCliConfig | undefined) ?? {};
}

export function saveConfig(config: DiscordCliConfig): void {
  // On first write, migrate any legacy grove copy to cortex (mode-preserving),
  // then always persist to the canonical cortex path.
  migrateGroveConfigFile(CONFIG_FILENAME);
  const path = cortexConfigPath(CONFIG_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(config));
}

export function getConfigPath(): string {
  // The path a reader would resolve right now (cortex if present/default,
  // grove only as the legacy fallback).
  return resolveConfigFilePath(CONFIG_FILENAME);
}

/**
 * Resolve a channel name to its webhook URL.
 * Falls back to defaultChannel if no name given.
 */
export function resolveChannel(config: DiscordCliConfig, name?: string): { name: string; id?: string } | null {
  const channelName = name ?? config.defaultChannel;
  if (!channelName) return null;

  const ch = config.channels?.[channelName];
  return {
    name: channelName,
    id: ch?.id,
  };
}
