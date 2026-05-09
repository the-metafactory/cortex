/**
 * F-007: Discord Platform Adapter
 *
 * Wraps existing discord.js modules into the PlatformAdapter interface.
 * Thin I/O wrapper — all pipeline logic lives in MessageRouter.
 */

import { ChannelType, type Client, type TextChannel, type ThreadChannel, type DMChannel, type Message } from "discord.js";
import type {
  PlatformAdapter,
  InboundMessage,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "../types";
import type { BotConfig, DiscordRole, DMConfig } from "../../common/types/config";
import { createDiscordClient, isMentionForBot, extractContent, type ConnectionHealth } from "./client";
import { fetchContext } from "./context-fetcher";
import { postToDiscord } from "./response-poster";
import { resolveRole } from "./role-resolver";
import { isRetryableError } from "./retry";

export interface DiscordAdapterConfig {
  instanceId: string;
  token: string;
  guildId: string;
  agentChannelId: string;
  logChannelId: string;
  contextDepth: number;
  enableAgentLog: boolean;
  operatorDiscordId?: string;
  roles?: DiscordRole[];
  defaultRole?: string;
  /** G-300: DM privilege configuration */
  dm?: DMConfig;
}

interface PendingResult {
  target: ResponseTarget;
  text: string;
  files?: OutboundFile[];
  createdAt: number;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord";
  readonly instanceId: string;

  private client: Client | null = null;
  private connectionHealth: ConnectionHealth | null = null;
  private botConfig: BotConfig;
  private adapterConfig: DiscordAdapterConfig;

  constructor(adapterConfig: DiscordAdapterConfig, botConfig: BotConfig) {
    this.instanceId = adapterConfig.instanceId;
    this.adapterConfig = adapterConfig;
    this.botConfig = botConfig;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const { client, health } = createDiscordClient(this.botConfig, {
      instanceId: this.instanceId,
    });
    this.client = client;
    this.connectionHealth = health;

    // Retry pending deliveries on reconnect
    this.client.on("shardReady", async () => {
      await this.drainPendingResults();
      await this.drainPendingOperatorDMs();
    });

    // Dedup: Discord gateway can redeliver events on reconnect
    const recentMessageIds = new Set<string>();
    const DEDUP_WINDOW = 30_000; // 30s

    this.client.on("messageCreate", async (message: Message) => {
      if (!this.client) return;

      // Deduplicate — skip if we've already seen this message ID
      if (recentMessageIds.has(message.id)) return;
      recentMessageIds.add(message.id);
      setTimeout(() => recentMessageIds.delete(message.id), DEDUP_WINDOW);

      // G-300: DM detection — no @mention required in DMs
      const isDM = message.channel.type === ChannelType.DM;

      if (isDM) {
        // Never respond to our own messages or other bots
        if (message.author.id === this.client.user?.id) return;
        if (message.author.bot) return;
      } else {
        // Guild: require @mention
        if (!isMentionForBot(message, this.client)) return;
      }

      const content = isDM ? message.content.trim() : extractContent(message, this.client);
      const channel = message.channel as TextChannel | ThreadChannel | DMChannel;
      const isThread = !isDM && (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread || channel.type === ChannelType.AnnouncementThread);
      const isPrivateChannel = !isDM && !isThread && (channel as any).members?.size === 2;

      // Handle message.txt (Discord auto-generates for messages > 2000 chars)
      let finalContent = content;
      const allAttachments = Array.from(message.attachments.values());
      const messageTxt = allAttachments.find((a) => a.name === "message.txt" && a.size < 50_000);
      if (messageTxt && !content) {
        try {
          const res = await fetch(messageTxt.url);
          if (res.ok) finalContent = (await res.text()).trim();
        } catch (err) {
          console.warn("grove-bot: discord: failed to fetch message.txt attachment:", err instanceof Error ? err.message : err);
        }
      }

      // G-300: Classify DM type
      let dmType: "operator" | "user" | undefined;
      if (isDM) {
        const operatorId = this.adapterConfig.operatorDiscordId;
        if (operatorId && message.author.id === operatorId) {
          dmType = "operator";
        } else {
          dmType = "user";
        }
      }

      // G-204c: Resolve channel/thread names for context routing
      let channelName: string | undefined;
      let threadName: string | undefined;
      if (!isDM) {
        if (isThread && "parentId" in channel) {
          const thread = channel as ThreadChannel;
          // parent may be null if not in cache — fetch it
          let parent = thread.parent;
          if (!parent && thread.parentId) {
            try {
              parent = (await this.client.channels.fetch(thread.parentId)) as TextChannel | null;
            } catch (err) {
              console.warn("grove-bot: discord: failed to fetch parent channel:", err instanceof Error ? err.message : err);
            }
          }
          channelName = parent?.name ?? undefined;
          threadName = thread.name ?? undefined;
        } else {
          channelName = (channel as TextChannel).name ?? undefined;
        }
        if (channelName) {
          console.log(`grove-bot: channel="${channelName}"${threadName ? ` thread="${threadName}"` : ""}`);
        }
      }

      const inboundMsg: InboundMessage = {
        platform: "discord",
        instanceId: this.instanceId,
        authorId: message.author.id,
        authorName: message.author.displayName ?? message.author.username,
        content: finalContent,
        channelId: channel.id,
        threadId: isDM ? channel.id : (isThread || isPrivateChannel ? channel.id : undefined),
        channelName,
        threadName,
        guildId: message.guildId ?? undefined,
        isDM,
        dmType,
        attachments: allAttachments
          .filter((a) => !(a.name === "message.txt" && messageTxt))
          .map((a) => ({
            url: a.url,
            filename: a.name ?? "unknown",
            contentType: a.contentType ?? "application/octet-stream",
            size: a.size ?? 0,
          })),
        timestamp: message.createdAt,
        _native: message,
      };

      await onMessage(inboundMsg);
    });

    await this.client.login(this.adapterConfig.token);
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }

  /**
   * F-092: Hot-reload safe config fields.
   * Only updates fields that don't require reconnection.
   */
  updateConfig(config: BotConfig): void {
    // Extract this instance's config from the new BotConfig
    const newInstance = config.discord.find(
      (inst: any) => (inst.instanceId ?? `discord-${inst.guildId}`) === this.instanceId
    );

    if (!newInstance) {
      console.warn(`discord-adapter[${this.instanceId}]: instance removed from config, ignoring update`);
      return;
    }

    // Update safe fields
    this.adapterConfig.contextDepth = newInstance.contextDepth;
    this.adapterConfig.enableAgentLog = newInstance.enableAgentLog;
    this.adapterConfig.roles = newInstance.roles;
    this.adapterConfig.defaultRole = newInstance.defaultRole;
    this.adapterConfig.dm = newInstance.dm;

    // Update bot config (for claude execution settings)
    this.botConfig = config;

    console.log(`discord-adapter[${this.instanceId}]: config updated`);
  }

  async fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]> {
    const nativeMsg = msg._native as Message | undefined;
    if (!nativeMsg) return [];

    const channel = nativeMsg.channel as TextChannel | ThreadChannel;
    const { messages } = await fetchContext(channel, depth, this.client?.user?.id);
    return messages;
  }

  resolveAccess(msg: InboundMessage): AccessDecision {
    // G-300: DM-specific role resolution
    if (msg.isDM) {
      return this.resolveDMAccess(msg);
    }

    const role = resolveRole(msg.authorId, {
      roles: this.adapterConfig.roles ?? [],
      defaultRole: this.adapterConfig.defaultRole ?? "allow-all",
    });

    if (role.denied) {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Sorry, I'm not set up to respond to you. Ask the operator to add you to a role in bot.yaml.",
      };
    }

    return {
      allowed: true,
      features: {
        chat: role.features.has("chat"),
        async: role.features.has("async"),
        team: role.features.has("team"),
      },
      toolRestrictions: role.disallowedTools.length > 0 ? role.disallowedTools : undefined,
      dirRestrictions: role.allowedDirs,
      allowedSkills: role.allowedSkills,
    };
  }

  /** G-300: Resolve access for DM messages */
  private resolveDMAccess(msg: InboundMessage): AccessDecision {
    const dm = this.adapterConfig.dm;

    // Operator DM — full access
    if (msg.dmType === "operator" && dm?.operatorRole) {
      const opRole = dm.operatorRole;
      return {
        allowed: true,
        features: {
          chat: opRole.features.includes("chat"),
          async: opRole.features.includes("async"),
          team: opRole.features.includes("team"),
        },
        toolRestrictions: opRole.disallowedTools.length > 0 ? opRole.disallowedTools : undefined,
        dirRestrictions: opRole.allowedDirs,
        allowedSkills: opRole.allowedSkills,
        bashGuard: opRole.bashGuard,
        bashAllowlist: opRole.bashAllowlist,
        isDM: true,
      };
    }

    // Check per-user DM roles
    if (dm?.userRoles) {
      const userRole = dm.userRoles.find((r) => r.users.includes(msg.authorId));
      if (userRole) {
        return {
          allowed: true,
          features: {
            chat: userRole.features.includes("chat"),
            async: userRole.features.includes("async"),
            team: userRole.features.includes("team"),
          },
          toolRestrictions: userRole.disallowedTools.length > 0 ? userRole.disallowedTools : undefined,
          dirRestrictions: userRole.allowedDirs,
          allowedSkills: userRole.allowedSkills,
          bashGuard: userRole.bashGuard,
          isDM: true,
        };
      }
    }

    // Default DM role
    const defaultDM = dm?.defaultRole ?? "denied";
    if (defaultDM === "denied") {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        isDM: true,
      };
    }

    // allow-all fallback
    return {
      allowed: true,
      features: { chat: true, async: true, team: true },
      bashGuard: true,
      isDM: true,
    };
  }

  async postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void> {
    if (this.pendingResults.size > 0) {
      this.cleanExpiredPending();
    }
    try {
      const channel = await this.resolveChannel(target);
      if (!channel) throw new Error("channel not resolved");

      const discordFiles = DiscordAdapter.toDiscordFiles(files);

      await postToDiscord(channel, text, discordFiles);
    } catch (err) {
      const key = target.threadId ?? target.channelId;
      if (!this.connectionHealth?.currentlyConnected) {
        if (this.pendingResults.size >= DiscordAdapter.PENDING_MAX_SIZE) {
          const oldest = this.pendingResults.keys().next().value;
          if (oldest) this.pendingResults.delete(oldest);
        }
        this.pendingResults.set(key, { target, text, files, createdAt: Date.now() });
        console.warn(`grove-bot: discord: buffered result for ${key} (Discord disconnected, ${this.pendingResults.size} pending)`);
      } else {
        console.error("grove-bot: discord: postResponse failed while connected:", err instanceof Error ? err.message : err);
      }
    }
  }

  async sendTyping(target: ResponseTarget): Promise<void> {
    const channel = await this.resolveChannel(target);
    if (channel) await channel.sendTyping();
  }

  private progressMessages = new Map<string, Message>();
  private progressSending = new Set<string>();
  private pendingResults = new Map<string, PendingResult>();
  // Note on data-model asymmetry vs `pendingResults`:
  //   - `pendingResults` is keyed by channel/thread, so a later result for the
  //     same target last-write-wins coalesces — which is correct, because the
  //     caller only ever wants the *final* result delivered to that target.
  //   - `pendingOperatorDMs` is an array of independent payloads ("task X
  //     completed", "task Y failed", "warning Z"). Coalescing by key would
  //     drop messages that the operator needs to see. Order and completeness
  //     matter more than dedup, so we use a FIFO array.
  private pendingOperatorDMs: Array<{ text: string; createdAt: number }> = [];
  private static readonly PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly PENDING_MAX_SIZE = 100;
  private static readonly PENDING_OPERATOR_MAX = 50;

  async sendProgress(target: ResponseTarget, text: string): Promise<void> {
    const key = target.threadId ?? target.channelId;
    const existing = this.progressMessages.get(key);
    try {
      if (existing) {
        await existing.edit(`> ${text}`);
      } else if (!this.progressSending.has(key)) {
        this.progressSending.add(key);
        const channel = await this.resolveChannel(target);
        if (channel) {
          const msg = await channel.send(`> ${text}`);
          this.progressMessages.set(key, msg);
        }
      }
    } catch {
      // Edit failed (message deleted/stale) — remove stale reference so
      // clearProgress doesn't try to delete a non-existent message.
      if (existing) {
        this.progressMessages.delete(key);
        this.progressSending.delete(key);
      }
    }
  }

  async clearProgress(target: ResponseTarget): Promise<void> {
    const key = target.threadId ?? target.channelId;
    const msg = this.progressMessages.get(key);
    this.progressMessages.delete(key);
    this.progressSending.delete(key);
    try { await msg?.delete(); } catch (err) {
      console.warn("grove-bot: discord: failed to delete progress message:", err instanceof Error ? err.message : err);
    }
  }

  async createThread(msg: InboundMessage, name: string): Promise<ResponseTarget> {
    const nativeMsg = msg._native as Message | undefined;
    if (!nativeMsg) {
      // Fallback: reply in the same channel
      return { instanceId: this.instanceId, channelId: msg.channelId, _native: null };
    }

    try {
      const thread = await nativeMsg.startThread({
        name,
        autoArchiveDuration: 60,
      });
      return {
        instanceId: this.instanceId,
        channelId: thread.id,
        threadId: thread.id,
        _native: thread,
      };
    } catch (err) {
      console.warn("grove-bot: discord: thread creation failed, falling back to channel:", err instanceof Error ? err.message : err);
      return { instanceId: this.instanceId, channelId: msg.channelId, _native: nativeMsg.channel };
    }
  }

  async notifyOperator(text: string): Promise<void> {
    const operatorId = this.adapterConfig.operatorDiscordId;
    if (!operatorId || !this.client) return;

    if (!this.connectionHealth?.currentlyConnected) {
      this.bufferOperatorDM(text);
      return;
    }

    try {
      const operator = await this.client.users.fetch(operatorId);
      await operator.send(text);
    } catch (err) {
      // TOCTOU: connection may have flipped between the check above and here.
      // Classify the error so we don't buffer permanently-undeliverable DMs:
      //   - Transient (network, 5xx, abort) → buffer if we're now disconnected,
      //     otherwise log+drop (probably-permanent server fault)
      //   - Non-transient (DiscordAPIError 50007 "cannot DM this user", 10013
      //     "unknown user", any other 4xx) → log+drop. Buffering would re-fire
      //     the same failure forever and crowd out genuinely transient DMs.
      if (DiscordAdapter.isPermanentlyUndeliverableDMError(err)) {
        console.warn(
          "grove-bot: discord: dropping operator DM, permanently undeliverable:",
          err instanceof Error ? err.message : err,
        );
        return;
      }
      if (!this.connectionHealth?.currentlyConnected && isRetryableError(err)) {
        this.bufferOperatorDM(text);
      } else {
        console.warn("grove-bot: discord: failed to notify operator:", err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * True for errors that mean "this DM will never succeed", e.g. user has DMs
   * closed (50007), user account deleted (10013), or any other discord-level
   * 4xx app error. We must NOT buffer these — they would consume buffer slots
   * and re-fail forever on every drain attempt.
   */
  private static isPermanentlyUndeliverableDMError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    // discord.js DiscordAPIError carries `.code` (number|string) and a 4xx
    // `.status`. Anything that isn't transient (5xx / network / abort) is
    // treated as permanent for DM purposes.
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return true;
    // Belt-and-braces: DiscordAPIError sets name to e.g. "DiscordAPIError[50007]"
    // — match the prefix in case .status isn't populated by some wrapper.
    const name = (err as { name?: string }).name;
    if (typeof name === "string" && name.startsWith("DiscordAPIError")) return true;
    return false;
  }

  private bufferOperatorDM(text: string): void {
    // TTL enforcement at write time — mirrors `cleanExpiredPending` for
    // pendingResults. Without this, a long disconnect window would cap the
    // buffer at PENDING_OPERATOR_MAX of stale entries which then get dropped
    // wholesale at drain time; better to evict expired entries proactively
    // so newer operator events have room.
    this.cleanExpiredOperatorDMs();
    if (this.pendingOperatorDMs.length >= DiscordAdapter.PENDING_OPERATOR_MAX) {
      this.pendingOperatorDMs.shift();
    }
    this.pendingOperatorDMs.push({ text, createdAt: Date.now() });
    console.warn(
      `grove-bot: discord: buffered operator DM (Discord disconnected, ${this.pendingOperatorDMs.length} pending)`
    );
  }

  private cleanExpiredOperatorDMs(): void {
    if (this.pendingOperatorDMs.length === 0) return;
    const now = Date.now();
    const before = this.pendingOperatorDMs.length;
    this.pendingOperatorDMs = this.pendingOperatorDMs.filter(
      (p) => now - p.createdAt <= DiscordAdapter.PENDING_TTL_MS,
    );
    const expired = before - this.pendingOperatorDMs.length;
    if (expired > 0) {
      console.warn(`grove-bot: discord: expired ${expired} pending operator DM(s)`);
    }
  }

  private async drainPendingOperatorDMs(): Promise<void> {
    // Re-use the write-time cleaner so drain-time TTL is consistent with
    // bufferOperatorDM. Anything still in the buffer afterwards is fresh.
    this.cleanExpiredOperatorDMs();
    if (this.pendingOperatorDMs.length === 0) return;
    const operatorId = this.adapterConfig.operatorDiscordId;
    if (!operatorId || !this.client) {
      this.pendingOperatorDMs = [];
      return;
    }
    const toDeliver = this.pendingOperatorDMs;
    this.pendingOperatorDMs = [];

    console.log(`grove-bot: discord: draining ${toDeliver.length} pending operator DM(s)`);
    try {
      const operator = await this.client.users.fetch(operatorId);
      for (const pending of toDeliver) {
        try {
          await operator.send(pending.text);
        } catch (err) {
          console.error(
            "grove-bot: discord: failed to deliver buffered operator DM:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error(
        "grove-bot: discord: could not fetch operator user to drain DMs:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async deliverPendingResult(key: string, pending: PendingResult): Promise<boolean> {
    const channel = await this.resolveChannel(pending.target, true);
    if (!channel) {
      console.warn(`grove-bot: discord: could not resolve channel ${key} for pending result, dropping`);
      return false;
    }
    await postToDiscord(channel, pending.text, DiscordAdapter.toDiscordFiles(pending.files));
    console.log(`grove-bot: discord: delivered pending result to ${key}`);
    return true;
  }

  private async drainPendingResults(): Promise<void> {
    if (this.pendingResults.size === 0) return;
    console.log(`grove-bot: discord: draining ${this.pendingResults.size} pending result(s) after reconnect`);

    for (const [key, pending] of this.pendingResults) {
      try {
        await this.deliverPendingResult(key, pending);
      } catch (err) {
        console.error(`grove-bot: discord: failed to deliver pending result to ${key}:`, err instanceof Error ? err.message : err);
      }
    }
    this.pendingResults.clear();
  }

  private cleanExpiredPending(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingResults) {
      if (now - pending.createdAt > DiscordAdapter.PENDING_TTL_MS) {
        console.warn(`grove-bot: discord: expired pending result for ${key} (age: ${((now - pending.createdAt) / 1000).toFixed(0)}s)`);
        this.pendingResults.delete(key);
      }
    }
  }

  private static toDiscordFiles(files?: OutboundFile[]): Array<{ attachment: Buffer | string; name: string }> | undefined {
    return files?.map((f) => ({
      attachment: f.content,
      name: f.filename,
    }));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Resolve a ResponseTarget to a discord.js channel object */
  private async resolveChannel(target: ResponseTarget, skipNativeCache = false): Promise<TextChannel | ThreadChannel | null> {
    // Use cached native channel if available
    if (!skipNativeCache && target._native && typeof (target._native as any).send === "function") {
      return target._native as TextChannel | ThreadChannel;
    }

    if (!this.client) return null;

    try {
      const channelId = target.threadId ?? target.channelId;
      const channel = await this.client.channels.fetch(channelId);
      return channel as TextChannel | ThreadChannel | null;
    } catch (_err) {
      // Channel may not exist or be inaccessible — safe to return null
      return null;
    }
  }

  /** Get the underlying discord.js client (for outbound JSONL tailing) */
  getClient(): Client | null {
    return this.client;
  }
}
