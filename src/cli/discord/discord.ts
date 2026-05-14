#!/usr/bin/env bun
/**
 * discord — Discord CLI (like gh for GitHub)
 *
 * Post messages, read channels, list threads from the terminal.
 * Uses bot token for all operations via Discord REST API.
 */

import { Command } from "commander";
import YAML from "yaml";
import { loadConfig, saveConfig, getConfigPath } from "./lib/config";
import { postMessage, resolveChannelByName, resolveThreadByName, readMessages, listChannels, listThreads } from "./lib/discord";

// Per-command option shapes. Commander's typing is permissive; pinning each
// `.action((opts) => …)` to the concrete shape lets the typed-checked preset
// narrow .channel/.thread/.limit instead of falling through as `any`.
interface PostOptions {
  channel?: string;
  thread?: string;
}
interface ReadOptions {
  channel?: string;
  thread?: string;
  limit: string;
}

// `setNestedValue`/`getNestedValue` walk an arbitrarily-nested config tree.
// `JsonObject` is the recursive shape: every leaf is a string (the only
// value type the CLI's `discord config set <key> <value>` ever writes) or
// another nested object. The cortex.yaml shape (DiscordCliConfig) satisfies
// this constraint structurally, so the helpers don't need to reach for any.
type ConfigValue = string | ConfigObject | undefined;
interface ConfigObject {
  [key: string]: ConfigValue;
}

const program = new Command()
  .name("discord")
  .description("Discord CLI — post messages, read channels, manage threads")
  .version("0.1.0");

// ─── post ──────────────────────────────────────────────────────────────────

program
  .command("post")
  .description("Post a message to a Discord channel")
  .argument("<message...>", "Message text (multiple words joined)")
  .option("-c, --channel <name>", "Channel name (default: defaultChannel from config)")
  .option("-t, --thread <name-or-id>", "Thread name or ID to post into")
  .action(async (messageParts: string[], opts: PostOptions) => {
    const config = loadConfig();
    const message = messageParts.join(" ");

    if (!config.botToken) {
      console.error("Bot token required. Run: discord config set botToken <token>");
      process.exit(1);
    }
    if (!config.guildId) {
      console.error("Guild ID required. Run: discord config set guildId <id>");
      process.exit(1);
    }

    // Resolve thread by name if provided and not a numeric ID
    let threadId = opts.thread;
    if (threadId && !/^\d+$/.test(threadId)) {
      const resolved = await resolveThreadByName(config.botToken, config.guildId, threadId);
      if (!resolved) {
        console.error(`Thread "${threadId}" not found. Run: discord threads`);
        process.exit(1);
      }
      threadId = resolved.id;
    }

    const channelName = opts.channel ?? config.defaultChannel;
    if (!threadId && !channelName) {
      console.error("No channel or thread specified and no defaultChannel configured.");
      console.error("Run: discord config set defaultChannel <name>");
      process.exit(1);
    }

    // Resolve channel name → ID (cached in config, or looked up via API)
    let channelId: string | undefined;
    if (channelName) {
      channelId = config.channels?.[channelName]?.id;
      if (!channelId) {
        channelId = await resolveChannelByName(config.botToken, config.guildId, channelName) ?? undefined;
        if (!channelId && !threadId) {
          console.error(`Channel "#${channelName}" not found. Run: discord channels`);
          process.exit(1);
        }
        if (channelId) {
          // Cache the resolved ID
          config.channels ??= {};
          config.channels[channelName] = { id: channelId };
          saveConfig(config);
        }
      }
    }

    const targetId = threadId ?? channelId;
    if (!targetId) {
      console.error("internal: no target id resolved");
      process.exit(1);
    }

    const result = await postMessage(config.botToken, targetId, message);
    if (result.success) {
      console.log(`Posted to #${channelName}${opts.thread ? ` (thread)` : ""}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

// ─── read ──────────────────────────────────────────────────────────────────

program
  .command("read")
  .description("Read recent messages from a channel or thread")
  .option("-c, --channel <name>", "Channel name (default: defaultChannel from config)")
  .option("-t, --thread <name-or-id>", "Thread name or ID to read from")
  .option("-n, --limit <n>", "Number of messages", "10")
  .action(async (opts: ReadOptions) => {
    const config = loadConfig();

    if (!config.botToken) {
      console.error("Bot token required. Run: discord config set botToken <token>");
      process.exit(1);
    }
    if (!config.guildId) {
      console.error("Guild ID required. Run: discord config set guildId <id>");
      process.exit(1);
    }

    // Resolve thread by name if provided
    let threadId = opts.thread;
    if (threadId && !/^\d+$/.test(threadId)) {
      const resolved = await resolveThreadByName(config.botToken, config.guildId, threadId);
      if (!resolved) {
        console.error(`Thread "${threadId}" not found. Run: discord threads`);
        process.exit(1);
      }
      threadId = resolved.id;
    }

    let readTargetId: string;

    if (threadId) {
      readTargetId = threadId;
    } else {
      const channelName = opts.channel ?? config.defaultChannel;
      if (!channelName) {
        console.error("No channel or thread specified and no defaultChannel configured.");
        process.exit(1);
      }

      let channelId = config.channels?.[channelName]?.id;
      if (!channelId) {
        channelId = await resolveChannelByName(config.botToken, config.guildId, channelName) ?? undefined;
        if (!channelId) {
          console.error(`Channel "#${channelName}" not found.`);
          process.exit(1);
        }
        config.channels ??= {};
        config.channels[channelName] = { id: channelId };
        saveConfig(config);
      }
      readTargetId = channelId;
    }

    const messages = await readMessages(config.botToken, readTargetId, parseInt(opts.limit));
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      console.log(`[${time}] ${msg.author}: ${msg.content}`);
    }
  });

// ─── channels ──────────────────────────────────────────────────────────────

program
  .command("channels")
  .description("List channels in the Discord server")
  .action(async () => {
    const config = loadConfig();
    if (!config.botToken || !config.guildId) {
      console.error("botToken and guildId required. Run: discord config set botToken <token>");
      process.exit(1);
    }

    const channels = await listChannels(config.botToken, config.guildId);
    for (const ch of channels) {
      console.log(`  #${ch.name.padEnd(25)} ${ch.id}`);
    }
  });

// ─── threads ───────────────────────────────────────────────────────────────

program
  .command("threads")
  .description("List active threads in the Discord server")
  .action(async () => {
    const config = loadConfig();
    if (!config.botToken || !config.guildId) {
      console.error("botToken and guildId required.");
      process.exit(1);
    }

    const threads = await listThreads(config.botToken, config.guildId);
    if (threads.length === 0) {
      console.log("No active threads.");
      return;
    }
    for (const t of threads) {
      console.log(`  ${t.name.padEnd(35)} ${t.id}  (${t.messageCount} msgs${t.archived ? ", archived" : ""})`);
    }
  });

// ─── config ────────────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage discord CLI configuration");

configCmd
  .command("set")
  .description("Set a config value (dot-notation: channels.collab.id)")
  .argument("<key>", "Config key (dot notation)")
  .argument("<value>", "Config value")
  .action((key: string, value: string) => {
    const config = loadConfig();
    setNestedValue(config as unknown as ConfigObject, key, value);
    saveConfig(config);
    console.log(`Set ${key} = ${value.length > 50 ? value.slice(0, 50) + "..." : value}`);
  });

configCmd
  .command("get")
  .description("Get a config value")
  .argument("<key>", "Config key (dot notation)")
  .action((key: string) => {
    const config = loadConfig();
    const value = getNestedValue(config as unknown as ConfigObject, key);
    if (value === undefined) {
      console.error(`Key "${key}" not found.`);
      process.exit(1);
    }
    console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : value);
  });

configCmd
  .command("show")
  .description("Show full configuration")
  .action(() => {
    const config = loadConfig();
    console.log(`# ${getConfigPath()}\n`);
    console.log(YAML.stringify(config));
  });

configCmd
  .command("path")
  .description("Print config file path")
  .action(() => {
    console.log(getConfigPath());
  });

// ─── helpers ───────────────────────────────────────────────────────────────

function setNestedValue(obj: ConfigObject, key: string, value: string): void {
  const parts = key.split(".");
  if (parts.length === 0) return;
  let current: ConfigObject = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    const next = current[part];
    if (next === undefined || typeof next !== "object") {
      current[part] = {};
    }
    current = current[part] as ConfigObject;
  }
  const leaf = parts[parts.length - 1] ?? "";
  current[leaf] = value;
}

function getNestedValue(obj: ConfigObject, key: string): ConfigValue {
  const parts = key.split(".");
  let current: ConfigValue = obj;
  for (const part of parts) {
    if (current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

program.parse(process.argv);
