/**
 * F-slack: Slack Platform Adapter.
 *
 * Sibling to `DiscordAdapter` + `MattermostAdapter`. Wraps a pluggable
 * `SlackClient` into the `PlatformAdapter` interface so the
 * MessageRouter / dispatch-handler can dispatch Slack messages uniformly
 * with Discord + Mattermost. Pure I/O wrapper — every pipeline concern
 * (access control, context fetch, response posting, surface-router
 * envelope rendering) lives at the same layer the other adapters use.
 *
 * Transport choice: Socket Mode (xoxb- bot token + xapp- app-level
 * token). No public webhook URL needed — fits cortex's single-machine
 * deployment model. HTTP / Events API mode is deferred.
 */

import type {
  PlatformAdapter,
  InboundMessage,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "../types";
import type { Agent, SlackPresence } from "../../common/types/cortex-config";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../../bus/surface-router";
import type { PayloadFilter } from "../../bus/payload-filter";
import { resolveRole } from "../discord/role-resolver";
import { formatEnvelopeAsMarkdown } from "../envelope-renderer";
import { RealSlackClient, type SlackClient, type SlackInboundEvent } from "./client";

/**
 * Cortex-deployment-level wiring passed alongside the agent + presence
 * pair. Mirror of `DiscordAdapterInfra` / `MattermostAdapterInfra`.
 *
 * `operator.slackId` is the operator's Slack user id (`U...`), used to
 * route `notifyOperator` DMs the same way the Discord/Mattermost
 * variants route theirs.
 *
 * `client` is the pluggable Slack client surface — defaults to
 * `RealSlackClient` in production, mocked in unit tests.
 */
export interface SlackAdapterInfra {
  /** Surface-router + log-prefix key. Cortex derives `${agent.id}-slack`. */
  instanceId: string;
  /** Operator's platform identity. */
  operator: { slackId?: string };
  /** MIG-3b: NATS subject patterns this adapter renders to Slack. */
  surfaceSubjects?: string[];
  /** MIG-3b: optional payload filter applied AFTER subject match. */
  surfaceFilter?: PayloadFilter;
  /** MIG-3b: fallback Slack channel id for envelope rendering. */
  surfaceFallbackChannelId?: string;
  /** Operator-set trusted peer bot user ids (`U...`). */
  trustedBotIds?: ReadonlySet<string>;
  /**
   * Pluggable client implementation. Production callers omit this and
   * get a `RealSlackClient` built from `presence.botToken` +
   * `presence.appToken`. Tests inject a fake.
   */
  client?: SlackClient;
}

/**
 * Slack adapter. Constructor wires the agent + presence + infra and
 * either instantiates `RealSlackClient` (production) or accepts the
 * caller's mock (tests).
 */
export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack";
  readonly instanceId: string;

  private readonly agent: Agent;
  private readonly presence: SlackPresence;
  private readonly infra: SlackAdapterInfra;
  private readonly client: SlackClient;
  /** Resolved bot user id, fetched on first `start()`. Used for self-loop guards. */
  private botUserId: string | null = null;
  /** Operator-explicit + adapter-side anti-self-loop set. */
  private trustedBotIds: ReadonlySet<string>;

  constructor(agent: Agent, presence: SlackPresence, infra: SlackAdapterInfra) {
    this.agent = agent;
    this.presence = presence;
    this.infra = infra;
    this.instanceId = infra.instanceId;
    this.trustedBotIds = infra.trustedBotIds ?? new Set(presence.trustedBotIds);
    this.client = infra.client ?? new RealSlackClient({
      botToken: presence.botToken,
      appToken: presence.appToken,
      instanceId: this.instanceId,
    });

    // Same one-shot warning the Discord + Mattermost adapters emit when
    // surfaceSubjects is explicitly empty — an `undefined` is silent
    // (opted out), `[]` is the config-typo signal worth surfacing.
    if (infra.surfaceSubjects?.length === 0) {
      console.warn(
        `slack-${this.instanceId}: surfaceSubjects is empty — adapter will never render bus envelopes`,
      );
    }
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    await this.client.start({
      onEvent: async (event) => {
        const msg = this.translateEvent(event);
        if (!msg) return;
        await onMessage(msg);
      },
    });
    // Resolve the bot user id after start so subsequent
    // `getPlatformUserId()` calls are zero-RPC. Best-effort: if auth.test
    // fails we leave `botUserId` null and let `getPlatformUserId()` retry
    // on demand — better than aborting startup.
    try {
      this.botUserId = await this.client.getBotUserId();
    } catch (err) {
      process.stderr.write(
        `slack-${this.instanceId}: getBotUserId failed during start (will retry on demand): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.client.stop();
    // Drop the cached bot id so a subsequent `start()` re-fetches —
    // guards against a token swap between sessions.
    this.botUserId = null;
  }

  async getPlatformUserId(): Promise<string> {
    if (this.botUserId) return this.botUserId;
    const id = await this.client.getBotUserId();
    this.botUserId = id;
    return id;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchContext(_msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    // v1: no thread/channel context fetch yet. The dispatch pipeline can
    // operate on the direct message alone; thread context via
    // `conversations.replies` lands as a follow-up. Returning [] matches
    // the contract for "no context available" without forcing the
    // pipeline to special-case Slack.
    return [];
  }

  resolveAccess(msg: InboundMessage): AccessDecision {
    // Self-loop guard: never act on messages authored by this bot.
    if (this.botUserId && msg.authorId === this.botUserId) {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Self-loop guard: message authored by this bot.",
      };
    }

    // allowedUserIds gate (mirror of MattermostAdapter.allowedUsers).
    // Empty list = "no allowlist" = fall through to role resolution.
    if (
      this.presence.allowedUserIds.length > 0 &&
      !this.presence.allowedUserIds.includes(msg.authorId)
    ) {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Sorry, I'm only configured to respond to specific users.",
      };
    }

    const role = resolveRole(msg.authorId, {
      roles: this.presence.roles,
      defaultRole: this.presence.defaultRole,
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
    if (files && files.length > 0) {
      // File upload via files.upload / files.uploadV2 deferred to a
      // follow-up — v1 of the Slack adapter is text-only. Flag the
      // limitation so it surfaces in logs rather than silently dropping.
      console.warn(
        `slack-${this.instanceId}: file attachments not yet supported on Slack — ` +
          `dropping ${files.length} file(s) and posting text only`,
      );
    }
    await this.client.postMessage(target.channelId, text, target.threadId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendTyping(_target: ResponseTarget): Promise<void> {
    // Slack has no public typing-indicator API for Socket Mode bots — no-op.
  }

  private progressSent = new Set<string>();

  async sendProgress(target: ResponseTarget, text: string): Promise<void> {
    const key = target.threadId ?? target.channelId;
    // Like Mattermost, we can't edit posts easily without tracking ts +
    // calling chat.update. v1: send once, skip subsequent — matches the
    // Mattermost adapter's shape so operators get consistent UX.
    if (this.progressSent.has(key)) return;
    this.progressSent.add(key);
    await this.client.postMessage(target.channelId, `> ${text}`, target.threadId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clearProgress(target: ResponseTarget): Promise<void> {
    const key = target.threadId ?? target.channelId;
    this.progressSent.delete(key);
    // Slack: no delete in v1 — leave the single progress message in place.
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createThread(msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    // Slack threads are implicit: post with `thread_ts` set to the parent
    // message's ts and the reply lands in that thread. Same pattern as
    // Mattermost's rootId. The "thread name" parameter is irrelevant on
    // Slack (no thread titles) — we mirror Mattermost's behaviour of
    // returning a target keyed on the original message's id.
    const ev = msg._native as SlackInboundEvent | undefined;
    const threadTs = ev?.thread_ts ?? ev?.ts ?? msg.threadId ?? msg.channelId;
    return {
      instanceId: this.instanceId,
      channelId: msg.channelId,
      threadId: threadTs,
    };
  }

  async notifyOperator(text: string): Promise<void> {
    const operatorId = this.infra.operator.slackId;
    if (!operatorId) return;
    try {
      // For DMs, Slack accepts the user id directly as `channel`. The
      // Web API opens (or reuses) the IM channel implicitly.
      await this.client.postMessage(operatorId, text);
    } catch (err) {
      // Match the Mattermost/Discord notifyOperator pattern: log + drop.
      // A failed DM should never tear down the adapter; the operator can
      // see the same content on the dashboard / agent-log path.
      console.warn(
        `slack-${this.instanceId}: failed to notify operator:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // MIG-3b: Surface-router integration
  // ---------------------------------------------------------------------------

  /**
   * Surface-adapter face for the surface-router. Mirror of
   * `DiscordAdapter.surfaceConfig` / `MattermostAdapter.surfaceConfig` —
   * same shape, same render contract, same failure mode (log + drop;
   * JetStream replay handles recovery per architecture §3.3).
   */
  get surfaceConfig(): SurfaceAdapter {
    return {
      id: this.instanceId,
      subjects: this.infra.surfaceSubjects ?? [],
      ...(this.infra.surfaceFilter ? { filter: this.infra.surfaceFilter } : {}),
      render: (envelope, signal) => this.renderEnvelope(envelope, signal),
    };
  }

  private async renderEnvelope(envelope: Envelope, _signal?: AbortSignal): Promise<void> {
    const channelId = this.infra.surfaceFallbackChannelId;
    if (!channelId) {
      console.warn(
        `slack-${this.instanceId}: has no surfaceFallbackChannelId configured — dropping envelope ${envelope.id}`,
      );
      return;
    }
    try {
      await this.client.postMessage(channelId, formatEnvelopeAsMarkdown(envelope));
    } catch (err) {
      console.warn(
        `slack-${this.instanceId}: renderEnvelope failed for envelope ${envelope.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Translate a raw Slack event into a cortex `InboundMessage`. Returns
   * `null` for events we intentionally ignore (system subtypes like
   * `channel_join`, bot-authored messages not on the trusted list, etc.).
   *
   * Subtype filtering: real human messages have `subtype === undefined`.
   * `bot_message` is the only subtype we conditionally accept — and only
   * when the author is in `trustedBotIds`. Everything else is dropped to
   * keep the dispatch pipeline focused on actual chat content.
   */
  private translateEvent(event: SlackInboundEvent): InboundMessage | null {
    // Drop self-authored messages at the source — both via user id
    // (when we know our own id) and via the bot_id-shaped subtype path
    // (when Slack doesn't include `user`).
    if (this.botUserId && event.user === this.botUserId) return null;

    // Subtype gate: accept only "real" messages and trusted bot
    // messages. System notices like `channel_join`, `channel_leave`,
    // `message_changed` are noise for cortex's dispatch path.
    if (event.subtype !== undefined && event.subtype !== "bot_message") {
      return null;
    }
    if (event.subtype === "bot_message") {
      // bot_message events authenticate via `bot_id` instead of `user`.
      // Require the operator to opt the bot in via `trustedBotIds`.
      const author = event.user ?? event.bot_id ?? "";
      if (!author || !this.trustedBotIds.has(author)) return null;
    }

    const authorId = event.user ?? event.bot_id ?? "";
    if (!authorId) return null;

    const channelName = this.presence.channels.find((c) => c.id === event.channel)?.name;

    return {
      platform: "slack",
      instanceId: this.instanceId,
      authorId,
      // v1: we don't resolve users.info for display names — Slack user
      // ids are already stable identifiers, and the dispatch pipeline
      // tolerates an id-as-name. Display-name resolution is a
      // straightforward follow-up via `users.info`.
      authorName: authorId,
      content: event.text ?? "",
      channelId: event.channel,
      ...(event.thread_ts !== undefined && { threadId: event.thread_ts }),
      ...(channelName !== undefined && { channelName }),
      ...(event.team !== undefined && { guildId: event.team }),
      attachments: (event.files ?? []).map((f) => ({
        url: f.url_private ?? "",
        filename: f.name ?? "unnamed",
        ...(f.mimetype !== undefined && { contentType: f.mimetype }),
        ...(f.size !== undefined && { size: f.size }),
      })),
      timestamp: new Date(Number(event.ts.split(".")[0]) * 1000),
      _native: event,
    };
  }
}
