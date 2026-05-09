/**
 * Discord CLI configuration — stored at ~/.config/grove/cli.yaml
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";

export interface ChannelConfig {
  /** Discord channel ID */
  id: string;
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
}

const CONFIG_PATH = join(process.env.HOME ?? "~", ".config", "grove", "cli.yaml");

export function loadConfig(): DiscordCliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  const text = readFileSync(CONFIG_PATH, "utf-8");
  return YAML.parse(text) ?? {};
}

export function saveConfig(config: DiscordCliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, YAML.stringify(config));
}

export function getConfigPath(): string {
  return CONFIG_PATH;
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
