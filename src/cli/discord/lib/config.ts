/**
 * Discord CLI configuration — stored at ~/.config/grove/cli.yaml.
 *
 * Path is intentionally `~/.config/grove/` for byte-identical parity with
 * grove-v2 (plan §1.3 non-goal: behaviour parity). The rename to
 * `~/.config/cortex/cli.yaml` lands at MIG-7 alongside the broader
 * bot.yaml → cortex.yaml move; doing it now would create an intermediate
 * config-fork state for the operator. Tracked at plan §4 MIG-7.
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
