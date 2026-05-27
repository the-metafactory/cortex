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
import type { AgentConfig } from "../../common/types/config";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SurfaceAdapter } from "../../bus/surface-router";
import type { PayloadFilter } from "../../bus/payload-filter";
import {
  type SystemEventSource,
  createSystemAdapterDisconnectedEvent,
  createSystemAdapterRecoveredEvent,
} from "../../bus/system-events";
import {
  isOperatorPrincipal,
  resolvePolicyAccess,
  type PlatformPrincipalIndex,
  type PolicyEngine,
  type PrincipalRegistry,
} from "../../common/policy";
import { formatEnvelopeAsMarkdown } from "../envelope-renderer";
import { RealSlackClient, type SlackClient, type SlackInboundEvent, type SlackBotIdentity } from "./client";

/**
 * Cortex-deployment-level wiring passed alongside the agent + presence
 * pair. Mirror of `DiscordAdapterInfra` / `MattermostAdapterInfra`.
 *
 * `principal.slackId` is the principal's Slack user id (`U...`), used to
 * route `notifyOperator` DMs the same way the Discord/Mattermost
 * variants route theirs.
 *
 * `client` is the pluggable Slack client surface — defaults to
 * `RealSlackClient` in production, mocked in unit tests.
 */
export interface SlackAdapterInfra {
  /** Surface-router + log-prefix key. Cortex derives `${agent.id}-slack`. */
  instanceId: string;
  /** Principal's platform identity. */
  principal: { slackId?: string };
  /**
   * MyelinRuntime for `system.adapter.*` envelope emission (cortex#235
   * r1#4). Optional — adapters started without NATS still track
   * connection state locally; bus emission is additive.
   */
  runtime?: MyelinRuntime;
  /**
   * `{principal}.{agent}.{instance}` source triple stamped onto emitted
   * `system.*` envelopes. Required for any `system.adapter.*` envelope
   * to fire — see `canPublishSystemEvent()`.
   */
  systemEventSource?: SystemEventSource;
  /** MIG-3b: NATS subject patterns this adapter renders to Slack. */
  surfaceSubjects?: string[];
  /** MIG-3b: optional payload filter applied AFTER subject match. */
  surfaceFilter?: PayloadFilter;
  /** MIG-3b: fallback Slack channel id for envelope rendering. */
  surfaceFallbackChannelId?: string;
  /** Principal-set trusted peer bot user ids (`U...`). */
  trustedBotIds?: ReadonlySet<string>;
  /**
   * Pluggable client implementation. Production callers omit this and
   * get a `RealSlackClient` built from `presence.botToken` +
   * `presence.appToken`. Tests inject a fake.
   */
  client?: SlackClient;
  /** v2.0.0 (cortex#297) — PolicyEngine is the sole authorisation gate. */
  policyEngine?: PolicyEngine;
  /** v2.0.0 (cortex#297) — `(platform, platformId) → principalId` index. */
  policyLookup?: PlatformPrincipalIndex;
  /** v2.0.0 (cortex#297) — `principal_id → PolicyPrincipal` registry. */
  policyRegistry?: PrincipalRegistry;
}

/**
 * Slack adapter. Constructor wires the agent + presence + infra and
 * either instantiates `RealSlackClient` (production) or accepts the
 * caller's mock (tests).
 */
export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack";
  readonly instanceId: string;

  // cortex#235 r1#5 — agent + presence are reassigned by
  // `updateConfig` to reflect hot-reload state. Same pattern as
  // Discord + Mattermost adapters.
  private agent: Agent;
  private presence: SlackPresence;
  private readonly infra: SlackAdapterInfra;
  private readonly client: SlackClient;
  /**
   * Resolved bot identity, fetched in `start()` BEFORE the socket opens
   * (Echo cortex#233 round-1 TOCTOU fix). `userId` is the `U…` carried
   * on normal messages; `botId` is the `B…` carried on `bot_message`
   * subtype events. The self-loop guard checks BOTH so a `chat.postMessage`
   * that round-trips through Slack as a `bot_message` cannot echo
   * (Echo cortex#233 round-2 N1).
   */
  private botIdentity: SlackBotIdentity | null = null;
  /** Principal-explicit + adapter-side anti-self-loop set. */
  // cortex#235 r1#5 — mutable to support hot-reload of the trusted
  // bot ids set via `updateConfig`. The runtime is still read-only:
  // every consumer treats it as a `ReadonlySet<string>`. Only
  // `updateConfig` reassigns the reference.
  private trustedBotIds: ReadonlySet<string>;
  /**
   * Echo cortex#233: bounded FIFO dedup ring of recently-seen Slack
   * message `ts` values. Slack's Socket Mode fires BOTH the `message`
   * and `app_mention` events for a single user message when the bot is
   * a member of the channel where it was mentioned — the client
   * subscribes to both events (so DMs + outside-channel mentions still
   * arrive), and this set collapses the duplicate at the adapter layer
   * before the dispatch pipeline sees it. Capacity 256 is generous
   * versus the bot's effective ingest rate (one human + a few trusted
   * bots) and is small enough to be irrelevant for memory.
   */
  private readonly seenTs = new Set<string>();
  private readonly seenTsOrder: string[] = [];
  private static readonly DEDUP_CAPACITY = 256;

  /**
   * cortex#235 r1#4 — connection-state tracking for `system.adapter.*`
   * envelope emission. Slack's Socket Mode is a single connection (no
   * shard concept), so this is simpler than Discord's per-shard health
   * map.
   *
   * `lastDisconnectedAt` is set when `disconnected` fires; cleared
   * after the next `connected` recovers. `connectedOnce` distinguishes
   * the initial successful connect (no envelope emitted — matches
   * Discord which doesn't emit `connected` either) from a recovery
   * after a prior disconnect (emit `system.adapter.recovered`).
   */
  private lastDisconnectedAt: Date | null = null;
  private connectedOnce = false;
  private warnedMissingSource = false;
  private readonly runtime: MyelinRuntime | undefined;
  private readonly systemEventSource: SystemEventSource | undefined;
  /**
   * cortex#235 r1#7 — two-pass dispatch gate. `start()` stores the
   * caller's `onMessage` here so `attachInboundDispatch()` (Pass 2)
   * can later flip the dispatch gate. Pre-attach events queue in
   * `pendingMessages` and drain in arrival order at attach time —
   * Slack's equivalent of discord.js's gateway-buffered events.
   */
  private onMessageRef: ((msg: InboundMessage) => Promise<void>) | null = null;
  private inboundDispatchAttached = false;
  private pendingMessages: InboundMessage[] = [];
  /**
   * Drain serialisation. While true, NEW events arriving via
   * `onEvent` queue into `pendingMessages` even though
   * `inboundDispatchAttached` is true — the drain loop reads
   * `pendingMessages.shift()` each iteration, so anything pushed
   * mid-drain is picked up in arrival order. Without this, a new
   * post-attach event could race the in-flight drain and complete
   * before a queued one (Echo cortex#257 round 1 M1).
   */
  private draining = false;
  /**
   * Promise that resolves when the in-flight drain settles. `stop()`
   * awaits this so a teardown-during-drain doesn't bleed messages
   * from cycle N into cycle N+1 (Echo cortex#257 round 1 M2).
   */
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(agent: Agent, presence: SlackPresence, infra: SlackAdapterInfra) {
    this.agent = agent;
    this.presence = presence;
    this.infra = infra;
    this.instanceId = infra.instanceId;
    this.runtime = infra.runtime;
    this.systemEventSource = infra.systemEventSource;
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
    // Echo cortex#233 (review #2): close the self-loop TOCTOU window by
    // resolving the bot identity BEFORE opening the Socket Mode
    // connection. `auth.test` uses the bot token (xoxb-) — it does NOT
    // need a live Socket Mode session. Fetching identity after
    // `client.start()` opens a ~one-round-trip gap where inbound events
    // would pass through `translateEvent` with the cache null, silently
    // failing-open on the self-loop guard. Fail-closed: if
    // `getBotIdentity()` rejects, abort startup rather than open a
    // socket whose self-echo will be dispatched as a real message.
    this.botIdentity = await this.client.getBotIdentity();
    // cortex#235 r1#7 — two-pass boot. Stash `onMessage` so
    // `attachInboundDispatch()` can later flip the dispatch gate.
    // Inbound events arriving BEFORE `attachInboundDispatch()` are
    // queued in `pendingMessages`; drained in arrival order on
    // attach. This is the Slack equivalent of discord.js's
    // gateway-buffered events. Without this gate, cortex.ts's Pass-2
    // trust-resolver merge happens AFTER inbound events have already
    // been delivered with the principal-only `trustedBotIds` set —
    // bot-to-bot traffic at boot time would be silently rejected
    // until the merge lands (the [major/security] bug Echo flagged
    // on cortex#105 for Discord, ported here for Slack parity).
    this.onMessageRef = onMessage;
    await this.client.start({
      onEvent: async (event) => {
        const msg = this.translateEvent(event);
        if (!msg) return;
        // cortex#257 r1 M1 — queue if either pre-attach OR an
        // in-flight drain is processing the existing queue. The
        // drain loop reads `pendingMessages.shift()` on each
        // iteration, so anything pushed mid-drain is picked up in
        // arrival order. Without the `draining` check, a new event
        // arriving mid-drain would take the direct path and could
        // complete before a queued one (out-of-order delivery).
        if (!this.inboundDispatchAttached || this.draining) {
          this.pendingMessages.push(msg);
        } else {
          await onMessage(msg);
        }
      },
      // cortex#235 r1#4 — Socket Mode lifecycle hooks.
      // - `onConnected` fires on EVERY Socket Mode reconnect, not just the
      //   initial connect; the adapter's `connectedOnce` latch
      //   distinguishes initial-connect (silent) from recovery
      //   (emit system.adapter.recovered).
      // - `onDisconnected` fires on every Socket Mode disconnect; emits
      //   system.adapter.disconnected unconditionally (mirrors Discord's
      //   per-shard disconnect emission).
      onConnected: () => { this.handleConnected(); },
      onDisconnected: (info) => { this.handleDisconnected(info); },
    });
  }

  /**
   * cortex#235 r1#7 — Pass-2 hook for cortex.ts. Flips the dispatch
   * gate to live; drains queued pre-attach messages in arrival
   * order. Latched once attached so re-calls are no-ops.
   *
   * The caller MUST call this AFTER `setTrustedBotIds(merged)` has
   * populated the resolver-merged allowlist. Otherwise queued events
   * would dispatch against the principal-only set and bot-to-bot
   * traffic that arrived during the start→attach window would be
   * silently dropped at `resolveAccess`. Mirrors the TOCTOU
   * invariant Echo round-1 on cortex#105 locked in for Discord.
   */
  attachInboundDispatch(): void {
    if (this.inboundDispatchAttached) return;
    if (!this.onMessageRef) {
      throw new Error(
        `slack-adapter[${this.instanceId}]: attachInboundDispatch() called before start() completed — onMessage not stored. ` +
          `cortex.ts must await start() (Pass 1) before attachInboundDispatch() (Pass 2).`,
      );
    }
    this.inboundDispatchAttached = true;
    this.drainPromise = this.drainPendingMessages();
  }

  /**
   * Sequentially deliver every queued message. While running, the
   * `onEvent` callback continues to push new arrivals onto
   * `pendingMessages` (because `this.draining === true` is checked
   * there) — the `while` loop below re-reads `length` per iteration
   * and picks up anything added mid-drain in arrival order.
   *
   * Bails if `stop()` flips `inboundDispatchAttached` to false
   * mid-drain — that's the Echo cortex#257 round 1 M2 contract:
   * stop()-during-drain MUST NOT bleed messages from cycle N into
   * cycle N+1. The remaining queue is dropped by stop() itself.
   */
  private async drainPendingMessages(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (
        this.inboundDispatchAttached &&
        this.pendingMessages.length > 0 &&
        this.onMessageRef !== null
      ) {
        const msg = this.pendingMessages.shift();
        if (msg === undefined) break;
        try {
          await this.onMessageRef(msg);
        } catch (err) {
          // cortex#257 r1 nit — adapter event-loop errors stay on
          // console.warn (matches the `ack failed:` and `onEvent
          // threw:` patterns in client.ts; the `system.error`
          // envelope path is reserved for state machine violations
          // principals should page on).
          console.warn(
            `slack-adapter[${this.instanceId}]: drain of queued message threw:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * cortex#235 r1#7 — Pass-2 hook for cortex.ts. Replaces the
   * trusted-bot-ids reference atomically (single assignment); the
   * existing self-loop guard reads from the live reference on each
   * inbound event, so subsequent events see the post-merge set with
   * zero race window.
   */
  setTrustedBotIds(next: ReadonlySet<string>): void {
    this.trustedBotIds = next;
  }

  /**
   * Diagnostic accessor for the boot log line. Matches Discord's
   * `trustedBotIdCount` getter — same call site shape in cortex.ts.
   */
  get trustedBotIdCount(): number {
    return this.trustedBotIds.size;
  }

  async stop(): Promise<void> {
    // cortex#257 r1 M2 — flip the dispatch gate BEFORE awaiting
    // client.stop() so any in-flight drain bails on its next
    // iteration. Then await the drain promise so a stop()-during-
    // drain doesn't bleed messages from cycle N into cycle N+1.
    this.inboundDispatchAttached = false;
    try {
      await this.drainPromise;
    } catch (err) {
      console.warn(
        `slack-adapter[${this.instanceId}]: drain settle on stop() threw:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await this.client.stop();
    // Drop the cached bot identity so a subsequent `start()` re-fetches —
    // guards against a token swap between sessions.
    this.botIdentity = null;
    // Echo cortex#233 round-2 N4: clear the dedup ring so a reused
    // adapter instance doesn't carry over `ts` values from a prior run.
    // For long-lived processes this is academic (the cap bounds memory),
    // but for hot-restart and test-fixture reuse it prevents stale
    // dedup decisions that would silently drop legitimate messages.
    this.seenTs.clear();
    this.seenTsOrder.length = 0;
    // Echo cortex#254 round 1 — reset system.adapter.* latches so a
    // subsequent `start()` on the same instance has clean state:
    //   - `connectedOnce` would otherwise treat the next initial
    //     connect as a recovery, emitting a spurious `recovered`.
    //   - `lastDisconnectedAt` could falsely pair with that
    //     synthetic recovered.
    //   - `warnedMissingSource` is process-lifetime in spirit but
    //     resetting on stop()/start() boundaries is fine (principal
    //     restarting an adapter probably wants the diagnostic again
    //     if they fixed nothing in between).
    this.connectedOnce = false;
    this.lastDisconnectedAt = null;
    this.warnedMissingSource = false;
    // cortex#235 r1#7 / cortex#257 r1 — reset the two-pass gate so a
    // subsequent start() → attachInboundDispatch() cycle on the same
    // instance operates against a clean slate. `inboundDispatchAttached`
    // is already false (we flipped it at the top of stop() before
    // awaiting the drain); reset the rest. Any messages still in
    // `pendingMessages` after the drain settle are intentionally
    // dropped — they belonged to the cycle stop() just ended.
    this.pendingMessages = [];
    this.onMessageRef = null;
    this.draining = false;
    this.drainPromise = Promise.resolve();
  }

  async getPlatformUserId(): Promise<string> {
    if (this.botIdentity) return this.botIdentity.userId;
    const identity = await this.client.getBotIdentity();
    this.botIdentity = identity;
    return identity.userId;
  }

  /**
   * F-092 hot-reload (cortex#235 r1#5). Match the live presence by
   * the immutable `workspaceId` (Slack's analogue to Mattermost's
   * `apiUrl` and Discord's `guildId` — the principal-paste-stable
   * identifier within `config.slack[]`).
   *
   * Hot-reload-safe fields (no socket reconnect required):
   *   - channels[]               (router targets — pure data)
   *   - roles[] / defaultRole    (access control — adapter-local)
   *   - allowedUserIds[]         (access control — adapter-local)
   *   - trustedBotIds            (self-loop guard — adapter-local)
   *
   * NOT reloaded (would require dropping + reopening Socket Mode):
   *   - botToken, appToken       (auth — needs new Socket Mode session)
   *   - workspaceId              (immutable identity — used as match key)
   *
   * Mirrors the Discord (`adapters/discord/index.ts:583`) and
   * Mattermost (`adapters/mattermost/index.ts:182`) implementations
   * — same shape, same invariants. The agent reference is rebuilt
   * so `agent.presence.slack` reflects the post-reload state (the
   * stale-agent invariant Holly flagged at MIG-7.2c-internal cycle
   * 1).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  updateConfig(config: AgentConfig): void {
    const newInstance = config.slack.find((inst) => inst.workspaceId === this.presence.workspaceId);
    if (!newInstance) {
      console.warn(
        `slack-adapter[${this.instanceId}]: instance removed from config (workspaceId=${this.presence.workspaceId}), ignoring update`,
      );
      return;
    }

    this.presence = {
      ...this.presence,
      channels: newInstance.channels,
      // v2.0.0 (cortex#297) — roles/defaultRole retired.
      allowedUserIds: newInstance.allowedUserIds,
      // The PresenceSchema field is `trustedBotIds: string[]` but the
      // adapter caches a `ReadonlySet<string>` for O(1) lookup at the
      // self-loop guard. Keep the schema-shape value on `presence`
      // and rebuild the set below.
      trustedBotIds: newInstance.trustedBotIds,
    };

    // Rebuild the trusted-bot-ids set the self-loop guard consults.
    // Note: `infra.trustedBotIds` (the Pass-2 resolver-merged set)
    // wins over `presence.trustedBotIds` at construction time per
    // cortex#108 item 1; on hot-reload we go back to the
    // presence-only set, which matches the Mattermost behaviour and
    // is the principal-intent surface a config edit speaks to.
    // Two-pass trust resolver merge is a separate follow-up (r1#7).
    this.trustedBotIds = new Set(newInstance.trustedBotIds);

    // Rebuild agent so `agent.presence.slack` + `agent.id` /
    // `agent.displayName` reflect the post-reload state. Same
    // invariant Holly flagged for Discord + Mattermost.
    this.agent = {
      ...this.agent,
      id: config.agent.name,
      displayName: config.agent.displayName,
      presence: { ...this.agent.presence, slack: this.presence },
    };

    console.log(`slack-adapter[${this.instanceId}]: config updated`);
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

  /**
   * v2.0.0 (cortex#297) — single-gate authorisation via PolicyEngine.
   * Adapter-side invariants (self-loop, allowedUserIds allowlist)
   * short-circuit BEFORE the policy gate — they enforce platform
   * preconditions the engine doesn't model. Once those pass,
   * `resolvePolicyAccess` consults the engine + principal registry.
   */
  resolveAccess(msg: InboundMessage): AccessDecision {
    // Self-loop guard: never act on messages authored by this bot.
    // Check both the user id and the bot id — `chat.postMessage` from
    // this bot can round-trip as a `bot_message` event where
    // `authorId === botId`, not `botUserId` (Echo cortex#233 round-2 N1).
    const isSelfUser = this.botIdentity?.userId === msg.authorId;
    const isSelfBot = this.botIdentity?.botId !== undefined && this.botIdentity.botId === msg.authorId;
    if (this.botIdentity && (isSelfUser || isSelfBot)) {
      return {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Self-loop guard: message authored by this bot.",
      };
    }

    // allowedUserIds gate (mirror of MattermostAdapter.allowedUsers).
    // Empty list = "no allowlist" = fall through to policy gate.
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

    return resolvePolicyAccess({
      msg,
      engine: this.infra.policyEngine,
      index: this.infra.policyLookup,
      registry: this.infra.policyRegistry,
    });
  }

  /**
   * v2.0.0 (cortex#297) — operator detection via the policy `operator`
   * capability. Kept for adapter-internal use; the `notifyOperator`
   * path still routes by `infra.principal.slackId`.
   */
  protected isOperator(authorId: string): boolean {
    return isOperatorPrincipal(
      "slack",
      authorId,
      this.infra.policyEngine,
      this.infra.policyLookup,
    );
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
    // Mattermost adapter's shape so principals get consistent UX.
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
    // message's ts and the reply lands in that thread. The "thread name"
    // parameter is irrelevant on Slack (no thread titles).
    //
    // Echo cortex#233 round-2: `thread_ts` is a Slack message timestamp
    // (`1700000000.123456`), NEVER a channel id (`C...`/`G...`). The
    // legitimate sources are, in order:
    //   1. `_native.thread_ts` — message arrived inside a thread
    //   2. `_native.ts`         — root of a new thread (this message)
    //   3. `msg.threadId`       — already-translated thread id
    // If none of these are available we cannot synthesise a thread root;
    // return `threadId: undefined` so the caller posts top-level. (The
    // old fallback used `msg.channelId`, which `chat.postMessage`
    // silently treated as "no thread" — same effect, but masked the
    // bug.)
    const ev = msg._native as SlackInboundEvent | undefined;
    const threadTs = ev?.thread_ts ?? ev?.ts ?? msg.threadId;
    return {
      instanceId: this.instanceId,
      channelId: msg.channelId,
      ...(threadTs !== undefined && { threadId: threadTs }),
    };
  }

  async notifyOperator(text: string): Promise<void> {
    const principalSlackId = this.infra.principal.slackId;
    if (!principalSlackId) return;
    try {
      // For DMs, Slack accepts the user id directly as `channel`. The
      // Web API opens (or reuses) the IM channel implicitly.
      await this.client.postMessage(principalSlackId, text);
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
    // Echo cortex#233 (review #1): collapse the `message`/`app_mention`
    // double-dispatch by ts BEFORE doing any other work. Events without
    // a `ts` (defensive — real Slack messages always carry one) skip
    // dedup and pass through. See `seenTs` field docstring for the
    // ring's capacity rationale.
    if (event.ts) {
      if (this.seenTs.has(event.ts)) {
        // Second sighting — drop. This is the expected path for a
        // channel-member mention, where Slack fires both the
        // `message` and `app_mention` events for the same `ts`.
        return null;
      }
      this.seenTs.add(event.ts);
      this.seenTsOrder.push(event.ts);
      if (this.seenTsOrder.length > SlackAdapter.DEDUP_CAPACITY) {
        const evicted = this.seenTsOrder.shift();
        if (evicted !== undefined) this.seenTs.delete(evicted);
      }
    }

    // Self-loop drop at the source. Echo cortex#233 round-2 N1:
    // `auth.test` exposes BOTH `user_id` (`U…`) and `bot_id` (`B…`);
    // Slack delivers self-echoed `chat.postMessage` calls as either
    // shape depending on subtype. Match both.
    if (this.botIdentity) {
      if (event.user === this.botIdentity.userId) return null;
      if (event.bot_id !== undefined && event.bot_id === this.botIdentity.botId) return null;
    }

    // Subtype gate: accept only "real" messages and trusted bot
    // messages. System notices like `channel_join`, `channel_leave`,
    // `message_changed` are noise for cortex's dispatch path.
    if (event.subtype !== undefined && event.subtype !== "bot_message") {
      return null;
    }
    if (event.subtype === "bot_message") {
      // bot_message events authenticate via `bot_id` (`B…`) — NOT the
      // `user_id` (`U…`) shape carried on normal messages. Echo
      // cortex#233 round-2 N2: the schema doc previously said "user
      // ids (`U…`)" while the runtime checked `event.user ?? event.bot_id`,
      // which silently never matched the `B…` shape Slack actually
      // delivers for bot_message events. Match `event.bot_id`
      // explicitly; operators populate `trustedBotIds` with `B…`
      // values (schema doc updated to reflect this).
      const author = event.bot_id ?? "";
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
      // cortex#235 r1#9 — preserve millisecond precision. Slack's
      // event.ts is a string like "1700000000.000123" (seconds.micros).
      // The old `split(".")[0]) * 1000` derivation dropped the
      // fractional portion entirely, so the dedup ring + downstream
      // ordering both saw second-resolution timestamps. Multiplying
      // the full float by 1000 + flooring keeps millisecond precision
      // (Slack doesn't fire enough events per ms for sub-ms detail to
      // matter; Math.floor avoids the rounding edge cases on .5).
      timestamp: new Date(Math.floor(Number(event.ts) * 1000)),
      _native: event,
    };
  }

  // ---------------------------------------------------------------------------
  // cortex#235 r1#4 — Socket Mode lifecycle → system.adapter.* envelopes.
  //
  // Mirror of Discord's per-shard emission pattern, simplified for
  // Socket Mode's single-connection model:
  //   - No shard_id field on emitted envelopes (Slack has no shards).
  //   - No `degraded` event: degraded requires a wall-clock threshold
  //     timer ("disconnected longer than X seconds"). Slack's Socket
  //     Mode reconnect cadence is typically faster than any reasonable
  //     threshold; the disconnected → recovered pair carries the
  //     duration on `degraded_for_ms` directly.
  //   - Initial connect is silent (matches Discord — no
  //     `system.adapter.connected` envelope kind exists).
  // ---------------------------------------------------------------------------

  /**
   * Common gate for `system.adapter.*` emission. Returns the bound
   * runtime + source pair when both are configured, or `null`
   * otherwise. Mirrors Discord's `canPublishSystemEvent`.
   */
  private canPublishSystemEvent(): { runtime: MyelinRuntime; source: SystemEventSource } | null {
    const runtime = this.runtime;
    if (!runtime) return null;
    const source = this.systemEventSource;
    if (!source) {
      if (!this.warnedMissingSource) {
        console.warn(
          `slack-${this.instanceId}: runtime is configured but systemEventSource is missing — system.* events will not be emitted`,
        );
        this.warnedMissingSource = true;
      }
      return null;
    }
    return { runtime, source };
  }

  /**
   * Socket Mode `connected` event. First-ever connect is silent
   * (matches Discord — initial connect is the expected steady state);
   * any subsequent connect is a recovery from a prior disconnect and
   * emits `system.adapter.recovered`.
   */
  private handleConnected(): void {
    if (!this.connectedOnce) {
      this.connectedOnce = true;
      return;
    }
    const disconnectedSince = this.lastDisconnectedAt;
    this.lastDisconnectedAt = null;
    if (disconnectedSince === null) return;
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const env = createSystemAdapterRecoveredEvent({
      source: wiring.source,
      adapterId: this.instanceId,
      platform: "slack",
      degradedForMs: Date.now() - disconnectedSince.getTime(),
      disconnectedSince,
    });
    void wiring.runtime.publish(env);
  }

  /**
   * Socket Mode `disconnected` event. Emits `system.adapter.disconnected`
   * unconditionally — mirrors Discord which emits on every shard
   * disconnect (clean or unclean). Surfaces filter on `was_clean` to
   * separate routine reconnects from genuine outages.
   *
   * `info.wasClean` is plumbed from Socket Mode's close reason; if
   * the upstream event doesn't supply it, default to `false` (the
   * conservative-for-incidents path — surfaces err on the alerting
   * side).
   */
  private handleDisconnected(info: { wasClean?: boolean; closeReason?: string }): void {
    const now = new Date();
    this.lastDisconnectedAt = now;
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const env = createSystemAdapterDisconnectedEvent({
      source: wiring.source,
      adapterId: this.instanceId,
      platform: "slack",
      disconnectedSince: now,
      wasClean: info.wasClean ?? false,
      ...(info.closeReason !== undefined && info.closeReason !== "" && {
        closeReason: info.closeReason,
      }),
    });
    void wiring.runtime.publish(env);
  }
}
