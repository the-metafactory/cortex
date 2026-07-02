/**
 * T-2.1: Discord Client Wrapper
 * Initializes discord.js client with required intents and event handlers.
 */

import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";

export interface ConnectionHealth {
  reconnectCount: number;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  currentlyConnected: boolean;
  /** True if shard has been disconnected longer than the degraded threshold. */
  degraded: boolean;
  /**
   * When the disconnect that led (or is leading) to the current degraded
   * period started. Set at `shardDisconnect` time, cleared on `shardReady`.
   * `degraded` becomes true only after `degradedThresholdMs` elapses without
   * recovery, but `degradedSince` already points at the disconnect timestamp
   * so `degradedForMs` reported on recovery measures total disconnect time,
   * not just time-since-threshold-crossed.
   */
  degradedSince: Date | null;
}

export interface DiscordClientOptions {
  /** Adapter instance ID, prefixed onto every log line so multi-adapter
   *  deployments can tell which client's shard is degraded. Recommended;
   *  defaults to "discord" when omitted. The 2026-05-09 outage burned 8.4h
   *  partly because `shard 0 reconnecting` was ambiguous across 3 adapters. */
  instanceId?: string;
  /** Mark connection degraded after this many ms disconnected (default 60s). */
  degradedThresholdMs?: number;
  /** Called when degraded state is entered (one-shot per degraded period). */
  onDegraded?: (info: { instanceId: string; thresholdMs: number; since: Date }) => void;
  /** Called when shardReady fires after a degraded period. */
  onRecovered?: (info: { instanceId: string; degradedForMs: number }) => void;
}

export interface DiscordClientResult {
  client: Client;
  health: ConnectionHealth;
}

/**
 * Display-only metadata stamped into the connection-ready log lines.
 *
 * MIG-7.2c-discord-cleanup: replaces the previous `AgentConfig` parameter so
 * `createDiscordClient` no longer reaches across the whole config tree to
 * print a `Agent: …` / `Guild(s): …` line. The cortex-config agent /
 * presence model is one Discord presence per agent, so `guildId` is a
 * single value (the legacy `config.discord.map(d => d.guildId).join(", ")`
 * was redundant — every adapter only ever ran one guild).
 */
export interface DiscordClientDisplayInfo {
  /** Parent agent's `displayName` — appears on the `Agent: …` log line. */
  displayName: string;
  /** This presence's `guildId` — appears on the `Guild: …` log line. */
  guildId: string;
}

function formatUptime(since: Date | null): string {
  if (!since) return "never";
  return `${((Date.now() - since.getTime()) / 1000).toFixed(0)}s`;
}

export function createDiscordClient(
  info: DiscordClientDisplayInfo,
  options: DiscordClientOptions = {},
): DiscordClientResult {
  const instanceId = options.instanceId ?? "discord";
  // Logs use the instanceId directly as the prefix component (e.g.
  // `discord-luna: shard 0 ready`). Multi-adapter deployments scope a unique
  // instanceId per discord.js client, so the prefix disambiguates without
  // needing a separate `grove-bot:`/`cortex:` umbrella.
  const tag = instanceId;
  const degradedThresholdMs = options.degradedThresholdMs ?? 60_000;
  const health: ConnectionHealth = {
    reconnectCount: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    currentlyConnected: false,
    degraded: false,
    degradedSince: null,
  };
  // Single-slot timer is intentional: we always construct discord.js Client
  // instances with shardCount=1 (no override anywhere in the codebase), and
  // multi-adapter deployments use multiple Client instances rather than
  // multi-shard ones. If we ever fan-shard a single Client, this needs to
  // become Map<shardId, ReturnType<typeof setTimeout>>.
  let degradedTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDegradedTimer = () => {
    if (degradedTimer) {
      clearTimeout(degradedTimer);
      degradedTimer = null;
    }
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
    failIfNotExists: false,
  });

  // discord.js v15 renamed `ready` → `clientReady` to disambiguate from the
  // gateway READY frame; `clientReady` is already emitted alongside `ready`
  // on v14, so the listener fires identically. See discord.js#10358.
  client.on("clientReady", () => {
    health.currentlyConnected = true;
    health.lastConnectedAt = new Date();
    console.log(`${tag}: connected as ${client.user?.tag}`);
    console.log(`  Agent: ${info.displayName}`);
    console.log(`  Guild: ${info.guildId}`);
  });

  // Shared connected-bookkeeping for shardReady (fresh IDENTIFY) and
  // shardResume (gateway session RESUME after a drop). Discord routinely
  // cycles gateway connections, and a successful RESUME emits shardResume
  // with NO shardReady — so a resume-only recovery must refresh the same
  // health state. Without this, `lastConnectedAt` (stamped only on READY)
  // goes stale across resumed sessions and the shardReconnecting log reads
  // like an hours-long outage ("last connected: 36336s ago") while the
  // shard is actually connected and delivering events.
  const markShardConnected = (shardId: number, via: string) => {
    health.currentlyConnected = true;
    health.lastConnectedAt = new Date();
    clearDegradedTimer();
    const wasDegraded = health.degraded;
    if (wasDegraded && health.degradedSince) {
      // degradedSince was set at shardDisconnect time, so this measures total
      // disconnect duration, not just "time since DEGRADED was declared".
      const degradedForMs = Date.now() - health.degradedSince.getTime();
      console.warn(
        `${tag}: shard ${shardId} RECOVERED after ${(degradedForMs / 1000).toFixed(0)}s disconnected (reconnects so far: ${health.reconnectCount})`
      );
      try {
        options.onRecovered?.({ instanceId, degradedForMs });
      } catch (err) {
        console.error(`${tag}: onRecovered callback threw:`, err instanceof Error ? err.message : err);
      }
    }
    health.degraded = false;
    health.degradedSince = null;
    if (!wasDegraded) {
      // Normal (re)connect within threshold — emit the routine log. When we
      // crossed the degraded threshold, RECOVERED above already conveys it.
      console.log(`${tag}: shard ${shardId} ${via} (reconnects so far: ${health.reconnectCount})`);
    }
  };

  client.on("shardReady", (shardId) => {
    markShardConnected(shardId, "ready");
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    markShardConnected(shardId, `resumed, ${replayedEvents} events replayed`);
  });

  client.on("shardDisconnect", (closeEvent, shardId) => {
    health.currentlyConnected = false;
    health.lastDisconnectedAt = new Date();
    console.error(`${tag}: shard ${shardId} disconnected (code: ${closeEvent.code}, uptime: ${formatUptime(health.lastConnectedAt)})`);
    clearDegradedTimer();
    // Stamp degradedSince at disconnect time — the moment outage minutes
    // started accruing — even though `degraded` only flips after the
    // threshold elapses. Reconnect within threshold clears this in shardReady.
    const disconnectAt = new Date();
    health.degradedSince = disconnectAt;
    degradedTimer = setTimeout(() => {
      health.degraded = true;
      console.error(
        `${tag}: shard ${shardId} DEGRADED — disconnected > ${(degradedThresholdMs / 1000).toFixed(0)}s without recovery`
      );
      try {
        options.onDegraded?.({ instanceId, thresholdMs: degradedThresholdMs, since: disconnectAt });
      } catch (err) {
        console.error(`${tag}: onDegraded callback threw:`, err instanceof Error ? err.message : err);
      }
    }, degradedThresholdMs);
  });

  client.on("shardReconnecting", (shardId) => {
    health.reconnectCount++;
    console.log(`${tag}: shard ${shardId} reconnecting (#${health.reconnectCount}, last connected: ${formatUptime(health.lastConnectedAt)} ago)`);
  });

  client.on("error", (error) => {
    console.error(`${tag}: Discord client error:`, error.message);
  });

  client.on("shardError", (error, shardId) => {
    console.error(`${tag}: shard ${shardId} WebSocket error:`, error.message);
  });

  return { client, health };
}

/**
 * Check if a message is an @-mention for our bot.
 *
 * Default policy: ignore all bot-authored messages and ALWAYS ignore our
 * own messages (self-loop guard, even across redundant bot processes).
 *
 * `trustedBotIds` (cortex#84) is an optional allowlist of Discord user
 * ids of peer bots that are permitted to ping us. When a bot-authored
 * message comes from a listed id, the mention check proceeds. The self
 * id is NEVER allowed even if accidentally listed — the self-check runs
 * first and short-circuits.
 */
export function isMentionForBot(
  message: Message,
  client: Client,
  trustedBotIds?: ReadonlySet<string>,
): boolean {
  if (!client.user) return false;
  // Explicit self-check — never respond to our own messages, regardless
  // of any allowlist. Defends against accidentally listing the bot's own
  // user id in `trustedBotIds`.
  if (message.author.id === client.user.id) return false;
  if (message.author.bot && !trustedBotIds?.has(message.author.id)) return false;
  return message.mentions.has(client.user);
}

/**
 * Extract clean content from a mention message (strip the @mention).
 */
export function extractContent(message: Message, client: Client): string {
  if (!client.user) return message.content;
  return message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();
}
