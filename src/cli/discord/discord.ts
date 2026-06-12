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
import { cachedChannelId, resolveServerContext, registerServerProfile, ServerContextError } from "./lib/server-context";
import type { ResolvedServerContext, ServerContextOptions } from "./lib/server-context";
import type { DiscordCliConfig } from "./lib/config";
import { postMessage, postMessageWithFiles, createThreadFromMessage, resolveChannelByName, resolveThreadByName, readMessages, listChannels, listThreads, type AttachmentInput } from "./lib/discord";
import { basename } from "node:path";

// Per-command option shapes. Commander's typing is permissive; pinning each
// `.action((opts) => …)` to the concrete shape lets the typed-checked preset
// narrow .channel/.thread/.limit instead of falling through as `any`.
// `guild`/`server` carry the multi-server overrides (see lib/server-context).
interface PostOptions extends ServerContextOptions {
  channel?: string;
  thread?: string;
  createThread?: string;
  file?: string[];
}
interface ReadOptions extends ServerContextOptions {
  channel?: string;
  thread?: string;
  limit: string;
}

/**
 * Resolve the effective server context for a command, translating a
 * `ServerContextError` into a CLI error + exit. Returns a context whose
 * `guildId`/`botToken` are then validated by the caller exactly as before.
 */
function resolveContextOrExit(
  config: ReturnType<typeof loadConfig>,
  opts: ServerContextOptions
): ResolvedServerContext {
  try {
    return resolveServerContext(config, opts);
  } catch (err) {
    if (err instanceof ServerContextError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
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
  .argument("[message...]", "Message text (optional when --file is given)")
  .option("-c, --channel <name>", "Channel name (default: defaultChannel from config)")
  .option("-t, --thread <name-or-id>", "Thread name or ID to post into")
  .option("-T, --create-thread <name>", "Create a thread from the posted message and print its ID")
  .option("-f, --file <path>", "Attach a file (repeatable)", (v: string, acc: string[]) => [...acc, v], [])
  .option("-g, --guild <id>", "Guild ID to resolve channel/thread names against (overrides config)")
  .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
  .action(async (messageParts: string[], opts: PostOptions) => {
    const config = loadConfig();
    const ctx = resolveContextOrExit(config, opts);
    const message = messageParts.join(" ");
    const filePaths = opts.file ?? [];

    if (opts.thread && opts.createThread) {
      console.error("--thread and --create-thread are mutually exclusive (a thread cannot contain a thread).");
      process.exit(1);
    }

    // A post must carry SOMETHING — text or at least one file. An empty post
    // is rejected before any network call (no dangling empty message).
    if (message.length === 0 && filePaths.length === 0) {
      console.error("Nothing to post: provide a message, one or more --file, or both.");
      process.exit(1);
    }

    // Read + existence-check every attachment BEFORE resolving the channel or
    // hitting the API, so a bad path fails cleanly with nothing posted.
    const attachments: AttachmentInput[] = [];
    for (const path of filePaths) {
      const f = Bun.file(path);
      if (!(await f.exists())) {
        console.error(`Attachment not found: ${path}`);
        process.exit(1);
      }
      attachments.push({ filename: basename(path), bytes: new Uint8Array(await f.arrayBuffer()) });
    }

    if (!ctx.botToken) {
      console.error("Bot token required. Run: discord config set botToken <token>");
      process.exit(1);
    }
    if (!ctx.guildId) {
      console.error("Guild ID required. Run: discord config set guildId <id>");
      process.exit(1);
    }

    // Resolve thread by name if provided and not a numeric ID
    let threadId = opts.thread;
    if (threadId && !/^\d+$/.test(threadId)) {
      const resolved = await resolveThreadByName(ctx.botToken, ctx.guildId, threadId);
      if (!resolved) {
        console.error(`Thread "${threadId}" not found. Run: discord threads`);
        process.exit(1);
      }
      threadId = resolved.id;
    }

    const channelName = opts.channel ?? ctx.defaultChannel;
    if (!threadId && !channelName) {
      console.error("No channel or thread specified and no defaultChannel configured.");
      console.error("Run: discord config set defaultChannel <name>");
      process.exit(1);
    }

    // Resolve channel name → ID. Cached ids and raw ids are only trusted when
    // they belong to this command's effective guild.
    let channelId: string | undefined;
    if (channelName) {
      channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, channelName);
      if (!channelId && !threadId) {
        console.error(`Channel "#${channelName}" not found. Run: discord channels`);
        process.exit(1);
      }
    }

    const targetId = threadId ?? channelId;
    if (!targetId) {
      console.error("internal: no target id resolved");
      process.exit(1);
    }

    const result = attachments.length > 0
      ? await postMessageWithFiles(ctx.botToken, targetId, message, attachments)
      : await postMessage(ctx.botToken, targetId, message);
    if (!result.success) {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
    const attachNote = attachments.length > 0 ? ` (+${attachments.length} file${attachments.length === 1 ? "" : "s"})` : "";
    console.log(`Posted to #${channelName}${opts.thread ? ` (thread)` : ""}${attachNote}`);

    if (opts.createThread) {
      if (!result.messageId) {
        console.error("Cannot create thread: Discord did not return a message id.");
        process.exit(1);
      }
      const thread = await createThreadFromMessage(ctx.botToken, targetId, result.messageId, opts.createThread);
      if (!thread.success) {
        console.error(`Thread creation failed: ${thread.error}`);
        process.exit(1);
      }
      // Machine-readable last line — callers parse this id to post follow-ups via --thread
      console.log(`thread:${thread.threadId}`);
    }
  });

// ─── read ──────────────────────────────────────────────────────────────────

program
  .command("read")
  .description("Read recent messages from a channel or thread")
  .option("-c, --channel <name>", "Channel name (default: defaultChannel from config)")
  .option("-t, --thread <name-or-id>", "Thread name or ID to read from")
  .option("-n, --limit <n>", "Number of messages", "10")
  .option("-g, --guild <id>", "Guild ID to resolve channel/thread names against (overrides config)")
  .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
  .action(async (opts: ReadOptions) => {
    const config = loadConfig();
    const ctx = resolveContextOrExit(config, opts);

    if (!ctx.botToken) {
      console.error("Bot token required. Run: discord config set botToken <token>");
      process.exit(1);
    }
    if (!ctx.guildId) {
      console.error("Guild ID required. Run: discord config set guildId <id>");
      process.exit(1);
    }

    // Resolve thread by name if provided
    let threadId = opts.thread;
    if (threadId && !/^\d+$/.test(threadId)) {
      const resolved = await resolveThreadByName(ctx.botToken, ctx.guildId, threadId);
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
      const channelName = opts.channel ?? ctx.defaultChannel;
      if (!channelName) {
        console.error("No channel or thread specified and no defaultChannel configured.");
        process.exit(1);
      }

      const channelId = await resolveChannelId(config, ctx, ctx.botToken, ctx.guildId, channelName);
      if (!channelId) {
        console.error(`Channel "#${channelName}" not found.`);
        process.exit(1);
      }
      readTargetId = channelId;
    }

    const messages = await readMessages(ctx.botToken, readTargetId, parseInt(opts.limit));
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      console.log(`[${time}] ${msg.author}: ${msg.content}`);
    }
  });

// ─── channels ──────────────────────────────────────────────────────────────

program
  .command("channels")
  .description("List channels in the Discord server")
  .option("-g, --guild <id>", "Guild ID to list channels from (overrides config)")
  .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
  .action(async (opts: ServerContextOptions) => {
    const config = loadConfig();
    const ctx = resolveContextOrExit(config, opts);
    if (!ctx.botToken || !ctx.guildId) {
      console.error("botToken and guildId required. Run: discord config set botToken <token>");
      process.exit(1);
    }

    const channels = await listChannels(ctx.botToken, ctx.guildId);
    for (const ch of channels) {
      console.log(`  #${ch.name.padEnd(25)} ${ch.id}`);
    }
  });

// ─── threads ───────────────────────────────────────────────────────────────

program
  .command("threads")
  .description("List active threads in the Discord server")
  .option("-g, --guild <id>", "Guild ID to list threads from (overrides config)")
  .option("-s, --server <name>", "Named server profile from config (layers guildId + overrides)")
  .action(async (opts: ServerContextOptions) => {
    const config = loadConfig();
    const ctx = resolveContextOrExit(config, opts);
    if (!ctx.botToken || !ctx.guildId) {
      console.error("botToken and guildId required.");
      process.exit(1);
    }

    const threads = await listThreads(ctx.botToken, ctx.guildId);
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
  .command("set-server")
  .description("Register a named server profile (a second guild the bot is in)")
  .argument("<name>", "Profile name (e.g. halden)")
  .argument("<guildId>", "Discord guild/server ID for the profile")
  .argument("[defaultChannel]", "Optional default channel name for the profile")
  .action((name: string, guildId: string, defaultChannel?: string) => {
    const config = loadConfig();
    try {
      registerServerProfile(config, name, guildId, defaultChannel);
    } catch (err) {
      if (err instanceof ServerContextError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    saveConfig(config);
    console.log(
      `Registered server "${name}" → guild ${guildId}` +
        (defaultChannel ? ` (default channel #${defaultChannel})` : "")
    );
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

/**
 * Cache a freshly-resolved channel id back into config, writing to the active
 * server profile's `channels` map when a `--server` profile is in effect, else
 * to the top-level `channels`. Keeps each guild's name→id cache isolated so a
 * name that exists in two guilds never cross-contaminates.
 */
function cacheChannelId(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  channelName: string,
  channelId: string
): void {
  const profile = ctx.serverName ? config.servers?.[ctx.serverName] : undefined;
  if (profile) {
    profile.channels ??= {};
    profile.channels[channelName] = { id: channelId };
  } else {
    config.channels ??= {};
    config.channels[channelName] = { id: channelId };
  }
}

async function resolveChannelId(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  botToken: string,
  guildId: string,
  channelName: string
): Promise<string | undefined> {
  if (isDiscordId(channelName)) {
    const channels = await listChannels(botToken, guildId);
    return channels.some((channel) => channel.id === channelName) ? channelName : undefined;
  }

  const cached = cachedChannelId(ctx, channelName);
  if (cached) return cached;

  const resolved = await resolveChannelByName(botToken, guildId, channelName) ?? undefined;
  if (resolved) {
    cacheChannelId(config, ctx, channelName, resolved);
    saveConfig(config);
  }
  return resolved;
}

function isDiscordId(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

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
