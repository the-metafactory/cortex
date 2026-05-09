/**
 * F-007: Mattermost Platform Adapter
 *
 * Wraps existing Mattermost poller/context modules into the PlatformAdapter interface.
 * Thin I/O wrapper — all pipeline logic lives in MessageRouter.
 */

import type {
  PlatformAdapter,
  InboundMessage,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "../types";
import type { BotConfig, DiscordRole } from "../../common/types/config";
import type { MattermostInboundMessage } from "./server";
import {
  createMattermostPoller,
  postReply,
  postReplyWithFiles,
  fetchMattermostFileInfos,
} from "./poller";
import { fetchMattermostContext } from "./context";
import { resolveRole } from "../discord/role-resolver";

export interface MattermostAdapterConfig {
  instanceId: string;
  apiUrl: string;
  apiToken: string;
  triggerWord?: string;
  channels: string[];
  pollIntervalMs: number;
  operatorMattermostId?: string;
  roles?: DiscordRole[];
  defaultRole?: string;
}

export class MattermostAdapter implements PlatformAdapter {
  readonly platform = "mattermost";
  readonly instanceId: string;

  private stopPoller: (() => void) | null = null;
  private botConfig: BotConfig;
  private scopedConfig: BotConfig; // Config with mattermost scoped to this instance
  private adapterConfig: MattermostAdapterConfig;

  constructor(adapterConfig: MattermostAdapterConfig, botConfig: BotConfig) {
    this.instanceId = adapterConfig.instanceId;
    this.adapterConfig = adapterConfig;
    this.botConfig = botConfig;
    // Scoped config: replace mattermost array with just this instance's config
    this.scopedConfig = {
      ...botConfig,
      mattermost: [{
        ...adapterConfig,
        enabled: true,
      }],
    } as BotConfig;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const { stop } = createMattermostPoller({
      config: this.scopedConfig,
      pollIntervalMs: this.adapterConfig.pollIntervalMs,
      onMessage: async (mmMsg: MattermostInboundMessage) => {
        const inboundMsg: InboundMessage = {
          platform: "mattermost",
          instanceId: this.instanceId,
          authorId: mmMsg.userId,
          authorName: mmMsg.userName,
          content: mmMsg.content,
          channelId: mmMsg.channelId,
          threadId: mmMsg.rootId, // Thread to original message for proper reply threading
          attachments: mmMsg.fileIds
            ? await this.fetchFileAttachments(mmMsg.fileIds)
            : [],
          timestamp: new Date(mmMsg.timestamp),
          _native: mmMsg,
        };

        await onMessage(inboundMsg);
        return ""; // Poller expects a string return; router handles posting
      },
    });

    this.stopPoller = stop;
  }

  async stop(): Promise<void> {
    this.stopPoller?.();
    this.stopPoller = null;
  }

  /**
   * F-092: Hot-reload safe config fields.
   * Only updates fields that don't require reconnection.
   */
  updateConfig(config: BotConfig): void {
    // Extract this instance's config from the new BotConfig
    const newInstance = config.mattermost.find(
      (inst: any) => (inst.instanceId ?? `mattermost-${config.agent.name}`) === this.instanceId
    );

    if (!newInstance) {
      console.warn(`mattermost-adapter[${this.instanceId}]: instance removed from config, ignoring update`);
      return;
    }

    // Update safe fields
    this.adapterConfig.channels = newInstance.channels;
    this.adapterConfig.pollIntervalMs = newInstance.pollIntervalMs;
    this.adapterConfig.roles = newInstance.roles;
    this.adapterConfig.defaultRole = newInstance.defaultRole;

    // Update bot config (for claude execution settings)
    this.botConfig = config;

    // Update scoped config
    this.scopedConfig = {
      ...config,
      mattermost: [{
        ...this.adapterConfig,
        enabled: true,
      }],
    } as BotConfig;

    console.log(`mattermost-adapter[${this.instanceId}]: config updated`);
  }

  async fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]> {
    const mmMsg = msg._native as MattermostInboundMessage | undefined;
    if (!mmMsg) return [];

    const { messages } = await fetchMattermostContext(
      mmMsg.postId,
      mmMsg.channelId,
      this.scopedConfig,
    );
    return messages;
  }

  resolveAccess(msg: InboundMessage): AccessDecision {
    const role = resolveRole(msg.authorId, {
      roles: this.adapterConfig.roles ?? [],
      defaultRole: this.adapterConfig.defaultRole ?? "allow-all",
    });

    if (role.denied) {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Sorry, I'm only configured to respond to my operator.",
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

  async postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void> {
    const apiUrl = this.adapterConfig.apiUrl;
    const apiToken = this.adapterConfig.apiToken;
    const rootId = target.threadId;

    if (files && files.length > 0) {
      // Write files to temp paths for upload
      const tempPaths: string[] = [];
      for (const f of files) {
        const tempPath = `/tmp/grove-mm-${Date.now()}-${f.filename}`;
        await Bun.write(tempPath, f.content);
        tempPaths.push(tempPath);
      }
      await postReplyWithFiles(target.channelId, text, rootId, tempPaths, apiUrl, apiToken);
    } else {
      await postReply(target.channelId, text, rootId, apiUrl, apiToken);
    }
  }

  async sendTyping(_target: ResponseTarget): Promise<void> {
    // Mattermost has no typing indicator API for bots — no-op
  }

  private progressSent = new Set<string>();

  async sendProgress(target: ResponseTarget, text: string): Promise<void> {
    const key = target.threadId ?? target.channelId;
    // Mattermost can't edit posts easily — just send once, skip subsequent
    if (this.progressSent.has(key)) return;
    this.progressSent.add(key);
    await postReply(
      target.channelId,
      `> ${text}`,
      target.threadId,
      this.adapterConfig.apiUrl,
      this.adapterConfig.apiToken,
    );
  }

  async clearProgress(target: ResponseTarget): Promise<void> {
    const key = target.threadId ?? target.channelId;
    this.progressSent.delete(key);
    // Mattermost: no easy delete — leave the single progress message
  }

  async createThread(msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    // Mattermost threading: reply to the original post (rootId)
    const mmMsg = msg._native as MattermostInboundMessage | undefined;
    const rootId = mmMsg?.postId ?? msg.channelId;

    return {
      instanceId: this.instanceId,
      channelId: msg.channelId,
      threadId: rootId,
    };
  }

  async notifyOperator(text: string): Promise<void> {
    const operatorId = this.adapterConfig.operatorMattermostId;
    if (!operatorId) return;

    const apiUrl = this.adapterConfig.apiUrl;
    const apiToken = this.adapterConfig.apiToken;

    try {
      // Get bot's own user ID
      const meRes = await fetch(`${apiUrl}/api/v4/users/me`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const me: any = meRes.ok ? await meRes.json() : null;
      if (!me) return;

      // Create/get DM channel with operator
      const dmRes = await fetch(`${apiUrl}/api/v4/channels/direct`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([me.id, operatorId]),
      });

      if (dmRes.ok) {
        const dmChannel: any = await dmRes.json();
        await postReply(dmChannel.id, text, undefined, apiUrl, apiToken);
      }
    } catch (err) {
      console.warn("grove-bot: mattermost: failed to notify operator:", err instanceof Error ? err.message : err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetchFileAttachments(fileIds: string[]) {
    const infos = await fetchMattermostFileInfos(
      fileIds,
      this.adapterConfig.apiUrl,
      this.adapterConfig.apiToken,
    );
    return infos.map((i) => ({
      url: i.url,
      filename: i.originalName,
      contentType: i.contentType,
      size: i.size,
    }));
  }
}
