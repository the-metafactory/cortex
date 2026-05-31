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
import type { AgentConfig } from "../../common/types/config";
import type { Agent, DiscordPresence } from "../../common/types/cortex-config";
import { createDiscordClient, isMentionForBot, extractContent, type ConnectionHealth } from "./client";
import { fetchContext } from "./context-fetcher";
import { postToDiscord } from "./response-poster";
import { isRetryableError } from "./retry";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SurfaceAdapter } from "../../bus/surface-router";
import type { PayloadFilter } from "../../bus/payload-filter";
import {
  type SystemEventSource,
  createSystemAdapterDegradedEvent,
  createSystemAdapterDisconnectedEvent,
  createSystemAdapterRecoveredEvent,
  createSystemAccessDeniedEvent,
} from "../../bus/system-events";
import {
  isOperatorPrincipal,
  resolvePolicyAccess,
  type PlatformPrincipalIndex,
  type PrincipalRegistry,
} from "../../common/policy";
import type { PolicyEngine } from "../../common/policy";
import { formatEnvelopeAsMarkdown } from "../envelope-renderer";
import { parseReviewWireFormat, reviewThreadName } from "./wire-format";

/**
 * Cortex-deployment-level wiring passed alongside the agent + presence pair.
 * Bundles the deployment-scoped concerns the agent/presence model itself
 * doesn't carry: the routing/log-prefix `instanceId`, the principal's
 * platform identity, bus wiring for `system.adapter.*` envelope emission,
 * and the MIG-3b surface-router fields.
 *
 * The surface-router fields (`surfaceSubjects`, `surfaceFilter`,
 * `surfaceFallbackChannelId`) park here transitionally — architecture §9.2
 * makes them a renderer concern (activity-centric, not agent-credential),
 * and a dedicated `kind: discord-channel` renderer lifts them out at
 * MIG-7.2d. Until then, `DiscordAdapter` reads them via `this.infra.*`.
 *
 * Anti-pattern note (G-1111 §4.6.2): a degraded adapter publishing its OWN
 * `degraded` event is the wrong long-term home — that belongs to a sibling
 * `connection-watcher` component. MIG-3b-ii intentionally took the shorter
 * path so the wiring exists end-to-end; the watcher refactor is tracked as
 * a follow-on iteration.
 */
export interface DiscordAdapterInfra {
  /** Surface-router + log-prefix key. Cortex derives `${agent.id}-discord-${guildId}` while
   * AgentConfig.discord[] still permits multiple entries per agent.name; collapses to
   * `${agent.id}-discord` at MIG-7.2e when migrate-config emits a real agents[] array. */
  instanceId: string;
  /** Principal's platform identity. Architecture §9.1: the principal runs the cortex
   * deployment, distinct from the agents they host. */
  principal: { discordId?: string };
  /** Myelin runtime for `system.adapter.*` envelope emission. Optional — adapters started
   * without NATS still track degradation/reconnect locally. */
  runtime?: MyelinRuntime;
  /** `{principal}.{agent}.{instance}` source triple stamped onto emitted `system.*` envelopes
   * (spec §3.6 names the agent, not the principal). */
  systemEventSource?: SystemEventSource;
  /** MIG-3b: NATS subject patterns this adapter renders to Discord. Empty/undefined → adapter
   * never matches in the surface-router (still subscribes for messages, just doesn't render
   * envelopes). Moves to Renderer config at MIG-7.2d. */
  surfaceSubjects?: string[];
  /** MIG-3b: optional payload filter applied AFTER subject match. Moves to Renderer at MIG-7.2d. */
  surfaceFilter?: PayloadFilter;
  /** MIG-3b: fallback Discord channel ID for envelope rendering when no per-envelope routing
   * rule applies. Channel ID, NOT name. Moves to Renderer at MIG-7.2d. */
  surfaceFallbackChannelId?: string;
  /**
   * cortex#84: Discord user ids of peer bots whose messages this adapter
   * is permitted to act on. Empty/undefined → strict default (drop every
   * bot-authored message, the pre-cortex#84 behaviour).
   *
   * The adapter's own bot id is NEVER allowed regardless of this set —
   * the self-check in the messageCreate handler short-circuits before
   * the allowlist is consulted.
   *
   * Bridge field; at MIG-7.2e the in-process TrustResolver populates the
   * effective allowlist from `agents[].trust`. Cross-process trust still
   * needs this field because the resolver only sees adapters running in
   * its own process. See `DiscordInstance.trustedBotIds` in
   * `common/types/config.ts`.
   */
  trustedBotIds?: ReadonlySet<string>;
  /**
   * v2.0.0 cutover (cortex#297) — PolicyEngine is the sole authorisation
   * gate. Resolved by `cortex.ts` from the parsed `policy:` block via
   * `policyEngineFromConfig`. `undefined` only when the deployment has
   * not declared a `policy:` block — in that case every inbound message
   * is denied with a pointer at `migrate-config`. Principals upgrading
   * from <v2.0.0 MUST run the CLI first.
   */
  policyEngine?: PolicyEngine;
  /**
   * v2.0.0 (cortex#297) — `(platform, platformId) → principalId` lookup
   * index built from `policy.principals[].platform_ids`. Resolves
   * inbound `message.author.id` to a principal id before the engine
   * consults capabilities. `undefined` follows the same condition as
   * `policyEngine`.
   */
  policyLookup?: PlatformPrincipalIndex;
  /**
   * v2.0.0 (cortex#297) — `principal_id → PolicyPrincipal` registry
   * used to look up `session_config` (channel vs DM CC session
   * construction parameters). PolicyEngine itself answers yes/no on
   * capabilities; session config is a sibling concern that lives on
   * the principal record.
   */
  policyRegistry?: PrincipalRegistry;
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
  private agent: Agent;
  private presence: DiscordPresence;
  private infra: DiscordAdapterInfra;
  /**
   * cortex#108 item 1: stored `onMessage` callback from `start()` so the
   * separately-invoked `attachInboundDispatch()` can register the
   * `messageCreate` listener AFTER Pass 2 of cortex.ts has populated the
   * trusted-bot allowlist. The TOCTOU window between adapter login and
   * `setTrustedBotIds` was silently dropping bot-to-bot messages.
   *
   * Null between construction and `start()`; set by `start()`; consumed by
   * `attachInboundDispatch()`. Latched once attached so re-calls are no-ops.
   */
  private onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;
  private inboundDispatchAttached = false;
  /**
   * Cached pointers to `infra.runtime` / `infra.systemEventSource`. Kept as
   * dedicated fields (rather than always reading via `this.infra.*`) so the
   * `warnedMissingSource` latch — which fires once per process per
   * misconfiguration — has the same lifecycle it had pre-flip. Set at
   * construction; never re-read from `infra` afterwards.
   */
  private runtime: MyelinRuntime | undefined;
  private systemEventSource: SystemEventSource | undefined;
  /**
   * cortex#84: snapshot of `infra.trustedBotIds` taken at construction
   * time. `ReadonlySet` so the messageCreate hot path can't accidentally
   * mutate the allowlist; the reference itself is swappable via
   * `setTrustedBotIds` so cortex.ts (cortex#98 part B) can merge in
   * resolver-derived peer ids after adapter-start without rebuilding the
   * adapter. Empty set when no allowlist was supplied — the default
   * "drop every bot author" branch becomes an O(1) `set.has` lookup
   * that returns false.
   *
   * The `readonly` was dropped at cortex#98: the only mutation path is
   * `setTrustedBotIds`, which replaces the reference atomically (no
   * partial-write races). Hot-path readers see either the old set or
   * the new set, never a half-built one.
   */
  private trustedBotIds: ReadonlySet<string>;
  /**
   * Latches once we've warned about the runtime-without-source case so a
   * busy adapter doesn't flood the log with the same diagnostic on every
   * shard event. Cleared only when the adapter is reconstructed.
   */
  private warnedMissingSource = false;

  constructor(
    agent: Agent,
    presence: DiscordPresence,
    infra: DiscordAdapterInfra,
  ) {
    this.agent = agent;
    this.presence = presence;
    this.infra = infra;
    this.instanceId = infra.instanceId;
    this.runtime = infra.runtime;
    this.systemEventSource = infra.systemEventSource;
    // cortex#84: snapshot the allowlist at construction. Pre-build the
    // empty-set sentinel so the messageCreate hot path can call
    // `set.has` unconditionally without a null check.
    this.trustedBotIds = infra.trustedBotIds ?? new Set<string>();

    // MIG-3b: warn once at construction if surfaceSubjects is explicitly empty.
    // `undefined` is silent (adapter opted out of bus rendering entirely);
    // `[]` is a config-typo signal — the surface-router will never match this
    // adapter, so any envelopes intended for it are silently dropped. Catching
    // it here avoids the "why is nothing rendering?" diagnostic dance.
    if (infra.surfaceSubjects?.length === 0) {
      console.warn(
        `discord-${this.instanceId}: surfaceSubjects is empty — adapter will never render bus envelopes`,
      );
    }
  }

  /**
   * Connect to Discord and prepare the adapter for inbound dispatch.
   *
   * cortex#108 item 1 (TOCTOU fix): `start()` performs `client.login()` and
   * wires up the shard-lifecycle listeners (disconnect/recovered/degraded
   * envelopes, pending-delivery drains) but does NOT register the
   * `messageCreate` handler. The caller MUST call `attachInboundDispatch()`
   * after Pass 2 has populated `trustedBotIds` so the hot-path readers see
   * the post-merge allowlist on the first delivered event.
   *
   * The split is deliberate: registering `messageCreate` inside `start()`
   * (the pre-cortex#108 shape) opens a TOCTOU window where adapter A's
   * login resolves before adapter B exists in the resolver, so any
   * bot-to-bot @-mention from B that lands in that window is silently
   * dropped by A's allowlist check. Deferring listener attach to AFTER
   * Pass 2 closes the window; the discord.js gateway buffers events at
   * the WebSocket layer until the listener registers, so no message loss.
   */
  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const { client, health } = createDiscordClient(
      { displayName: this.agent.displayName, guildId: this.presence.guildId },
      {
        instanceId: this.instanceId,
        // MIG-3b-ii: emit `system.adapter.{degraded,recovered}` envelopes so
        // operators get out-of-band visibility (see G-1111 §3.5.3 + §4.6).
        // The callbacks are also wired to console.error for log retention;
        // the bus emission is additive, not a replacement.
        onDegraded: ({ instanceId, thresholdMs, since }) => {
          this.publishAdapterDegraded({ instanceId, thresholdMs, since });
        },
        onRecovered: ({ instanceId, degradedForMs }) => {
          this.publishAdapterRecovered({ instanceId, degradedForMs });
        },
      },
    );
    this.client = client;
    this.connectionHealth = health;
    // cortex#108 item 1: stash the callback for the deferred
    // `attachInboundDispatch()` call. The listener registration itself is
    // intentionally NOT done here — see the method's doc comment for the
    // TOCTOU rationale.
    this.onMessage = onMessage;

    // MIG-3b-ii: emit `system.adapter.disconnected` on every shard disconnect.
    // Distinct from degraded — disconnect fires immediately, degraded only
    // after threshold elapses without recovery. Surfaces filter on `was_clean`
    // and on the disconnected→degraded escalation.
    this.client.on("shardDisconnect", (closeEvent, shardId) => {
      this.publishAdapterDisconnected({
        shardId,
        closeCode: closeEvent.code,
        // `closeEvent.reason` is flagged `@deprecated` by discord.js — the
        // upstream WebSocketShard no longer fills it. Cortex still surfaces
        // whatever the gateway emits (may be empty string) for incident
        // attribution; the codeOnly path remains the load-bearing signal.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        closeReason: closeEvent.reason,
        // `was_clean` follows RFC 6455 close-frame semantics: codes 1000/1001
        // are clean; everything else is unclean.
        //
        // Discord layers gateway-specific 4xxx codes on top of the WebSocket
        // standard set (see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway):
        //   - 4004 (auth failed)         — permanent; was_clean: false
        //   - 4014 (disallowed intents)  — permanent; was_clean: false
        //   - 4000 (unknown error)       — retryable; was_clean: false
        // All currently classify as unclean; a surface that wants
        // transient-vs-permanent must inspect `code` itself. Keep this
        // conservative — surfaces filter on `was_clean` for incident vs
        // flap classification, and an "unknown 4xxx" being flagged unclean
        // is the right default during an outage.
        wasClean: closeEvent.code === 1000 || closeEvent.code === 1001,
      });
    });

    // Retry pending deliveries on reconnect
    this.client.on("shardReady", () => {
      void (async () => {
        await this.drainPendingResults();
        await this.drainPendingPrincipalDMs();
      })();
    });

    await this.client.login(this.presence.token);
  }

  /**
   * cortex#108 item 1 — register the `messageCreate` listener using the
   * callback stored by `start()`. Idempotent: re-calls after the first are
   * no-ops, so cortex.ts can safely call this from a Pass-2 loop even if
   * the adapter was started via a path that hot-reloads / re-binds.
   *
   * Why this exists as a separate phase (the TOCTOU fix):
   *   Pass 1 in cortex.ts logs every adapter into Discord (and registers
   *   each `client.user.id` with TrustResolver). Pass 2 walks each
   *   adapter's `agent.trust[]`, resolves peer bot ids, and calls
   *   `setTrustedBotIds(merged)`. If `messageCreate` registered inside
   *   `start()`, then adapter A would be processing inbound messages
   *   BEFORE Pass 2 merged in peer B's bot id, silently dropping any
   *   bot-to-bot @-mention from B (the messageCreate handler's
   *   `trustedBotIds.has()` check returns false because B wasn't merged
   *   in yet).
   *
   *   By splitting attach off, cortex.ts can guarantee the strict order:
   *
   *     1. Pass 1: start() all adapters, register bot user ids in resolver
   *     2. Pass 2: setTrustedBotIds(merged) on each adapter
   *     3. Pass 2 (continued): attachInboundDispatch() on each adapter
   *
   *   The discord.js gateway buffers events at the WebSocket layer until
   *   a JS listener is attached, so no events are dropped during the
   *   start()→attach window — they're held in the underlying socket and
   *   delivered in arrival order once the listener registers.
   *
   * Throws if called before `start()` (no client / no onMessage stored).
   */
  attachInboundDispatch(): void {
    if (this.inboundDispatchAttached) return;
    if (!this.client || !this.onMessage) {
      throw new Error(
        `discord-adapter[${this.instanceId}]: attachInboundDispatch() called before start() completed — client / onMessage not initialised. ` +
          `Cortex.ts must await start() (Pass 1) before attachInboundDispatch() (Pass 2).`,
      );
    }
    const onMessage = this.onMessage;

    // Dedup: Discord gateway can redeliver events on reconnect
    const recentMessageIds = new Set<string>();
    const DEDUP_WINDOW = 30_000; // 30s

    this.client.on("messageCreate", (message: Message) => {
      void (async () => {
      if (!this.client) return;

      // Deduplicate — skip if we've already seen this message ID
      if (recentMessageIds.has(message.id)) return;
      recentMessageIds.add(message.id);
      setTimeout(() => recentMessageIds.delete(message.id), DEDUP_WINDOW);

      // G-300: DM detection — no @mention required in DMs
      const isDM = message.channel.type === ChannelType.DM;

      if (isDM) {
        // Self-loop guard — never respond to our own DMs, regardless of
        // any trustedBotIds entry (the bot's own id is never allowed).
        if (message.author.id === this.client.user?.id) return;
        // cortex#84: drop bot-authored DMs unless the author is a
        // principal-blessed peer in `trustedBotIds`. The role-resolver
        // (resolveDMAccess) then makes the final allow/deny call on
        // the message, so listing a bot here is necessary-but-not-
        // sufficient to elicit a response.
        if (message.author.bot && !this.trustedBotIds.has(message.author.id)) {
          this.publishUntrustedBotDenied(message);
          return;
        }
      } else {
        // Guild: require @mention (which itself honours trustedBotIds
        // via the same allowlist — peer bots that @-mention us are
        // allowed through; un-listed bot authors are dropped).
        if (!isMentionForBot(message, this.client, this.trustedBotIds)) {
          if (message.author.bot && message.author.id !== this.client.user?.id) {
            this.publishUntrustedBotDenied(message);
          }
          return;
        }
      }

      const content = isDM ? message.content.trim() : extractContent(message, this.client);
      const channel = message.channel as TextChannel | ThreadChannel | DMChannel;
      const isThread = !isDM && (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread || channel.type === ChannelType.AnnouncementThread);
      // cortex#123 item 1: detect group DMs by `channel.type === ChannelType.GroupDM`,
      // the actual semantic discord.js carries. The prior heuristic was
      // `channel.members?.size === 2`, which without the `GuildMembers` intent
      // (cortex's client only enables `Guilds` + `GuildMessages`) was a CACHE
      // hit count, not a real group-DM signal — and it falsely flipped true
      // in quiet text channels whose member cache happened to hold exactly
      // bot + peer. Group DMs need their own gating because Discord rejects
      // `threads.create` on guild-less channels (DM or GroupDM).
      // GroupDM is not part of the narrowed `channel` union (TextChannel |
      // ThreadChannel | DMChannel), but at runtime discord.js can deliver
      // a GroupDM-typed channel here. The `as ChannelType` widens the
      // narrowed enum back to the full ChannelType union so tsc accepts
      // the GroupDM comparison without an unnecessary `as number` cast.
      const isGroupDM =
        !isDM && (channel.type as ChannelType) === ChannelType.GroupDM;

      // Handle message.txt (Discord auto-generates for messages > 2000 chars)
      let finalContent = content;
      const allAttachments = Array.from(message.attachments.values());
      const messageTxt = allAttachments.find((a) => a.name === "message.txt" && a.size < 50_000);
      if (messageTxt && !content) {
        try {
          const res = await fetch(messageTxt.url);
          if (res.ok) finalContent = (await res.text()).trim();
        } catch (err) {
          console.warn(`discord-${this.instanceId}: failed to fetch message.txt attachment:`, err instanceof Error ? err.message : err);
        }
      }

      // G-300 + v2.0.0 (cortex#297): Classify DM type. The legacy
      // `operatorDiscordId` comparison is retired; the principal
      // classification now flows through the PolicyEngine capability that
      // grants principal-level access. A principal who holds it
      // short-circuits to full DM access in `resolvePolicyAccess`. The
      // `infra.principal.discordId` field is preserved for the
      // `notifyPrincipal` / `bufferPrincipalDM` paths which still need a
      // Discord-side mailbox.
      let dmType: "principal" | "user" | undefined;
      if (isDM) {
        dmType = isOperatorPrincipal(
          "discord",
          message.author.id,
          this.infra.policyEngine,
          this.infra.policyLookup,
        )
          ? "principal"
          : "user";
      }

      // G-204c: Resolve channel/thread names for context routing
      let channelName: string | undefined;
      let threadName: string | undefined;
      if (!isDM) {
        if (isThread && "parentId" in channel) {
          const thread = channel;
          // parent may be null if not in cache — fetch it
          let parent = thread.parent;
          if (!parent && thread.parentId) {
            try {
              parent = (await this.client.channels.fetch(thread.parentId)) as TextChannel | null;
            } catch (err) {
              console.warn(`discord-${this.instanceId}: failed to fetch parent channel:`, err instanceof Error ? err.message : err);
            }
          }
          channelName = parent?.name;
          threadName = thread.name;
        } else {
          channelName = (channel as TextChannel).name;
        }
        if (channelName) {
          console.log(`discord-${this.instanceId}: channel="${channelName}"${threadName ? ` thread="${threadName}"` : ""}`);
        }
      }

      const inboundMsg: InboundMessage = {
        platform: "discord",
        instanceId: this.instanceId,
        authorId: message.author.id,
        authorName: message.author.displayName,
        content: finalContent,
        channelId: channel.id,
        threadId: isDM ? channel.id : (isThread || isGroupDM ? channel.id : undefined),
        channelName,
        threadName,
        guildId: message.guildId ?? undefined,
        isDM,
        dmType,
        attachments: allAttachments
          .filter((a) => !(a.name === "message.txt" && messageTxt))
          .map((a) => ({
            url: a.url,
            filename: a.name,
            contentType: a.contentType ?? "application/octet-stream",
            size: a.size,
          })),
        timestamp: message.createdAt,
        _native: message,
      };

      // cortex#120 — Auto-thread on inbound review wire format.
      //
      // When a message in a CHANNEL (not already in a thread, not a DM)
      // matches `<@bot> review <repo>#<N>`, find-or-create the
      // `{repo}/pr/<N>` thread and redirect the inbound dispatch to it.
      // The agent's reply then posts to the thread (per dispatch-handler's
      // `targetFromMsg` which routes on `msg.threadId`), per the SOP at
      // `CLAUDE.md ## Discord Channel Routing` step 3.
      //
      // Gates:
      //   - Skip if DM (DMs don't have threads in our routing model)
      //   - Skip if already in a thread/private channel (existing thread
      //     handles it — don't re-create or duplicate)
      //   - Only match the `review` verb in v1; other verbs (`work-on`,
      //     `ship`, `babysit`) are explicitly deferred to a follow-up PR
      //   - Parsed `botId` MUST equal this bot's `client.user.id`. The
      //     adapter's mention-check already filtered for mentions to us,
      //     but with `trustedBotIds` peer-mentions can also reach this
      //     point — we don't want adapter A auto-threading on a message
      //     that mentions adapter B.
      // cortex#122: dropped the broken `!isPrivateChannel` heuristic
      // (`channel.members?.size === 2`) that falsely flipped true in quiet
      // text channels without the `GuildMembers` intent.
      //
      // cortex#123 item 3: tightened the gate to `message.guildId` to
      // explicitly skip DMs and Group DMs. Discord's threads API is
      // guild-only — `threads.create()` rejects on DM and GroupDM
      // channels, which would surface as a hot-path throw from
      // `findOrCreateThreadByName`. The `isDM` + `isThread` checks above
      // already cover regular DMs; the `guildId` gate adds GroupDM
      // coverage without depending on the discord.js channel-type ladder
      // staying in sync.
      if (!isDM && !isThread && message.guildId !== null) {
        // Match against the RAW Discord content (`message.content`),
        // not `finalContent` — the latter has the @-mention stripped by
        // `extractContent`, and the wire format anchors on `<@bot>`.
        const parsed = parseReviewWireFormat(message.content);
        if (parsed && parsed.botId === this.client.user?.id) {
          const targetName = reviewThreadName(parsed);
          const result = await this.findOrCreateThreadByName(
            channel.id,
            targetName,
          );
          if (result) {
            // Mutate the InboundMessage so all downstream code
            // (dispatch-handler.targetFromMsg, channel-context
            // resolution, session-key derivation) sees the thread
            // context. We intentionally do NOT swap `_native` — it
            // stays as the original Discord Message so
            // dispatch-handler's `inboundMessageId` derivation
            // (`(msg._native as { id }).id`) keeps using the inbound
            // message id, not the thread id (which would lose the
            // dedup correlation for `system.inbound.aborted` envelopes).
            inboundMsg.threadId = result.threadId;
            inboundMsg.threadName = targetName;
            console.log(
              `discord-${this.instanceId}: auto-threaded inbound review to "${targetName}" (thread=${result.threadId})`,
            );
          } else {
            // Thread create failed — leave inboundMsg as channel-level
            // and let the agent reply at channel scope. The user sees
            // a normal reply; the principal sees the warn log from
            // `findOrCreateThreadByName`. Graceful degradation rather
            // than silently dropping the message.
            console.warn(
              `discord-${this.instanceId}: auto-thread for "${targetName}" failed — falling back to channel reply`,
            );
          }
        }
      }

      await onMessage(inboundMsg);
      })();
    });

    this.inboundDispatchAttached = true;
  }

  async stop(): Promise<void> {
    // discord.js v14 client.destroy() returns a Promise<void>; await it so
    // the gateway socket fully closes before the adapter is considered
    // stopped (no-floating-promises). The await also makes the `async` on
    // this method legitimate (no require-await).
    await this.client?.destroy();
    this.client = null;
  }

  /**
   * MIG-7.2c-binding: Return the Discord snowflake of the bot account this
   * adapter is logged in as. discord.js populates `client.user` after the
   * `ready` event fires (which `start()` awaits via `client.login`). Calling
   * this before `start()` completes — or after `stop()` — throws.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getPlatformUserId(): Promise<string> {
    // PlatformAdapter.getPlatformUserId returns Promise<string> per the
    // interface contract (Mattermost adapter does network I/O here). The
    // Discord client populates `user` synchronously after `ready`, so this
    // implementation is a non-awaiting Promise.resolve() in disguise.
    const userId = this.client?.user?.id;
    if (!userId) {
      throw new Error(
        `discord-adapter[${this.instanceId}]: getPlatformUserId() called ` +
          `before start() completed or after stop() — client.user is null. ` +
          `Ensure PresenceBinding awaits start() before binding.`,
      );
    }
    return userId;
  }

  /**
   * cortex#98 (part B): replace the trusted-peer-bot allowlist after
   * construction. Cortex.ts uses this to merge in-process peer bot ids
   * (resolved via `TrustResolver.lookupPlatformIdByAgent`) on top of the
   * principal-explicit `presence.discord.trustedBotIds` once all adapters
   * have logged in and registered their `client.user.id` in the resolver.
   *
   * Atomic reference swap — hot-path `messageCreate` readers see either
   * the previous set or the new set, never a partially-built one. Safe
   * to call any time after construction; cortex.ts calls it once during
   * its second adapter-start pass.
   *
   * The caller is responsible for including any prior principal-explicit
   * ids in `next`; this method does NOT merge with the existing set —
   * it replaces it. The intent is to surface "the allowlist as
   * cortex.ts computes it" as a single, well-defined value rather than
   * an accreting mutation log.
   *
   * For the adapter's own self-loop guard (`message.author.id ===
   * client.user?.id`) is unchanged and runs BEFORE this set is consulted
   * (see messageCreate handler at the top of `start`), so the bot's own
   * id is never allowed regardless of what `next` contains.
   */
  setTrustedBotIds(next: ReadonlySet<string>): void {
    // cortex#108 item 3: single reference reassignment — atomic in
    // single-threaded JS, so the messageCreate hot path always observes
    // either the pre-call or the post-call ReadonlySet (never a partially
    // mutated set). If you extend this mutator to touch more than one
    // field, replace the bare assignment with a coordinated swap (e.g.
    // build the next state in a local + assign once) so the same
    // atomicity property is preserved.
    this.trustedBotIds = next;
  }

  /**
   * cortex#98 (part B) — current size of the trusted-bot allowlist. Used
   * by cortex.ts for the per-adapter "trustedBotIds: N" startup log so
   * operators can confirm the resolver actually populated the set.
   */
  get trustedBotIdCount(): number {
    return this.trustedBotIds.size;
  }

  /**
   * F-092: Hot-reload safe config fields.
   * Only updates fields that don't require reconnection.
   *
   * MIG-7.2c-discord-flip: still takes `AgentConfig` since the bot.yaml watch
   * pipeline upstream of this method hasn't been migrated yet. The matching
   * key is the immutable `guildId` (token/agentChannelId/logChannelId are
   * reconnect-only and must not change in a hot-reload). Updates are applied
   * via immutable replacement so downstream readers can rely on
   * structural-identity changes signalling a config refresh.
   */
  updateConfig(config: AgentConfig): void {
    const newInstance = config.discord.find((inst) => inst.guildId === this.presence.guildId);

    if (!newInstance) {
      console.warn(`discord-adapter[${this.instanceId}]: instance removed from config, ignoring update`);
      return;
    }

    // Apply only hot-reload-safe fields to presence; token, guildId, and
    // channel ids are reconnect-only and intentionally NOT overwritten here.
    // v2.0.0 (cortex#297) — roles/defaultRole/dm retired. Policy hot-reload
    // is a separate surface (the `policy:` block is parsed once at boot;
    // refresh requires restart in v2.0.0).
    this.presence = {
      ...this.presence,
      contextDepth: newInstance.contextDepth,
      enableAgentLog: newInstance.enableAgentLog,
    };

    // Rebuild agent AFTER `this.presence` is refreshed so
    // `agent.presence.discord` and `agent.id` / `agent.displayName` reflect
    // the post-reload state. Same hot-reload-sync invariant Holly flagged
    // at MIG-7.2c-internal cycle 1: a stale agent reference becomes a
    // runtime bug the moment any consumer (PresenceBinding, TrustResolver)
    // starts reading from `this.agent` during a live config change.
    this.agent = {
      ...this.agent,
      id: config.agent.name,
      displayName: config.agent.displayName,
      presence: { ...this.agent.presence, discord: this.presence },
    };

    console.log(`discord-adapter[${this.instanceId}]: config updated`);
  }

  async fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]> {
    const nativeMsg = msg._native as Message | undefined;
    if (!nativeMsg) return [];

    const channel = nativeMsg.channel as TextChannel | ThreadChannel;
    const { messages } = await fetchContext(channel, depth, this.client?.user?.id);
    return messages;
  }

  /**
   * v2.0.0 (cortex#297) — single-gate authorisation via PolicyEngine.
   * Replaces the legacy role-resolver + the cortex#296 parallel-mode
   * orchestrator with a direct PolicyEngine consultation. The
   * adapter-side logic lives in `resolvePolicyAccess`
   * (`src/common/policy/resolve-access.ts`) so Discord, Mattermost,
   * and Slack share it.
   */
  resolveAccess(msg: InboundMessage): AccessDecision {
    return resolvePolicyAccess({
      msg,
      engine: this.infra.policyEngine,
      index: this.infra.policyLookup,
      registry: this.infra.policyRegistry,
    });
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
        console.warn(`discord-${this.instanceId}: buffered result for ${key} (Discord disconnected, ${this.pendingResults.size} pending)`);
      } else {
        console.error(`discord-${this.instanceId}: postResponse failed while connected:`, err instanceof Error ? err.message : err);
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
  //   - `pendingPrincipalDMs` is an array of independent payloads ("task X
  //     completed", "task Y failed", "warning Z"). Coalescing by key would
  //     drop messages that the principal needs to see. Order and completeness
  //     matter more than dedup, so we use a FIFO array.
  private pendingPrincipalDMs: { text: string; createdAt: number }[] = [];
  private static readonly PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly PENDING_MAX_SIZE = 100;
  private static readonly PENDING_PRINCIPAL_MAX = 50;

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
      console.warn(`discord-${this.instanceId}: failed to delete progress message:`, err instanceof Error ? err.message : err);
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
      console.warn(`discord-${this.instanceId}: thread creation failed, falling back to channel:`, err instanceof Error ? err.message : err);
      return { instanceId: this.instanceId, channelId: msg.channelId, _native: nativeMsg.channel };
    }
  }

  /**
   * cortex#120 — Find or create a public thread by name on a parent text
   * channel. Used by the inbound auto-thread path: when a message in a
   * CHANNEL matches the review wire format, route the agent's reply into
   * the per-PR thread `{repo}/pr/<N>` instead of the channel.
   *
   * Distinct from `createThread` (which always creates a NEW thread
   * attached to a specific message via `msg.startThread`):
   *
   *   - `createThread(msg, name)` — message-anchored, used by async/team
   *      dispatch paths that always create a fresh per-task thread
   *   - `findOrCreateThreadByName(parentChannelId, name)` — channel-
   *      anchored, idempotent. First call creates; subsequent calls reuse
   *      the existing thread. The right primitive for `{repo}/pr/<N>`
   *      threads which must collapse to one regardless of how many review
   *      requests land in the channel.
   *
   * Lookup strategy: `channel.threads.fetchActive()` lists currently
   * non-archived threads. Discord's API distinguishes active vs archived
   * — once a thread auto-archives after 24h of inactivity it's no longer
   * in this list. We accept that: any inbound review ping inside the
   * 24h window reuses the active thread; one that lands after archive
   * creates a fresh thread. The alternative (also list archived via
   * `fetchArchived`) is slower and rarely worth it for per-PR work
   * windows that close in hours.
   *
   * Failure modes: if `client.channels.fetch` returns a non-text
   * channel, or the parent doesn't support threads, returns `null`.
   * Callers fall back to channel-level reply.
   */
  async findOrCreateThreadByName(
    parentChannelId: string,
    name: string,
  ): Promise<{ threadId: string; channel: ThreadChannel } | null> {
    if (!this.client) return null;

    let parent: TextChannel;
    try {
      const fetched = await this.client.channels.fetch(parentChannelId);
      if (fetched?.type !== ChannelType.GuildText) {
        // We only auto-thread on regular guild text channels. Forum
        // channels, voice channels, announcement channels etc. have
        // different thread semantics (or no thread support) — caller
        // falls back to channel-level reply.
        return null;
      }
      parent = fetched;
    } catch (err) {
      console.warn(
        `discord-${this.instanceId}: findOrCreateThreadByName: cannot fetch parent ${parentChannelId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }

    // Active-threads lookup. discord.js caches the result; subsequent
    // hits in the same process don't re-fetch — important because the
    // hot path is "every channel inbound that mentions a bot".
    try {
      const active = await parent.threads.fetchActive();
      for (const thread of active.threads.values()) {
        if (thread.name === name) {
          return { threadId: thread.id, channel: thread };
        }
      }
    } catch (err) {
      // Lookup failure shouldn't prevent thread creation — the create
      // call may still succeed even if listing didn't. Log and continue.
      console.warn(
        `discord-${this.instanceId}: findOrCreateThreadByName: fetchActive failed for ${parentChannelId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Not found in the active set → create. Use `auto_archive_duration:
    // 1440` (24h) per the existing `worklog-manager` convention so the
    // archive window matches what operators already expect for per-task
    // threads. `type: PublicThread` because review threads are
    // discoverable to everyone in the channel — the alternative
    // (PrivateThread) restricts visibility to the @-mentioned users
    // and the bot, which is wrong for review work that the wider team
    // observes.
    try {
      const thread = await parent.threads.create({
        name,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `cortex#120 auto-thread for review wire format`,
      });
      return { threadId: thread.id, channel: thread };
    } catch (err) {
      console.warn(
        `discord-${this.instanceId}: findOrCreateThreadByName: create failed for "${name}" on ${parentChannelId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * cortex#502 — resolve a LOGICAL surface address (the review-path
   * `response_routing` shape) to a native Discord {@link ResponseTarget}.
   *
   * The review wire stays platform-neutral: `channel` is a repo short name
   * (the channel-routing SOP's "repos get channels") and `thread`, when
   * present, is the `{repo}/{entity-type}/{number}` logical key ("GitHub
   * entities get threads"). This method maps logical→native:
   *
   *   1. If `addr.surface !== "discord"`, return `null` — this is not our
   *      surface, the review sink skips us (no cross-surface posting).
   *   2. Resolve `addr.channel` (the repo short name) to a guild text
   *      channel by NAME. The SOP guarantees one logical channel per repo,
   *      so a name match is unambiguous.
   *   3. If `addr.thread` is present, reuse the existing
   *      {@link findOrCreateThreadByName} (the same primitive the inbound
   *      channel-routing path uses) to get/create the `{repo}/...` thread
   *      snowflake.
   *   4. Return `null` on any unresolved channel/thread so the sink ignores
   *      the envelope rather than mis-posting.
   */
  async resolveLogicalTarget(addr: {
    surface: string;
    channel: string;
    thread?: string;
  }): Promise<ResponseTarget | null> {
    // Surface guard — only resolve addresses targeting Discord.
    if (addr.surface !== this.platform) return null;
    if (!this.client) return null;

    // Resolve the repo-short-name channel to a guild text-channel snowflake
    // by name. Scope the lookup to this adapter's guild so a name that
    // exists in multiple guilds the bot is in can't cross-resolve.
    const channelSnowflake = this.resolveChannelByName(addr.channel);
    if (channelSnowflake === null) {
      console.warn(
        `discord-${this.instanceId}: resolveLogicalTarget: no channel named "${addr.channel}" in guild ${this.presence.guildId}`,
      );
      return null;
    }

    // Channel-scope target when no thread is requested.
    if (addr.thread === undefined) {
      return { instanceId: this.instanceId, channelId: channelSnowflake };
    }

    // Entity→thread: reuse the SOP machinery. `findOrCreateThreadByName`
    // is idempotent — repeated review pings for the same PR collapse to a
    // single `{repo}/pr/N` thread.
    const thread = await this.findOrCreateThreadByName(
      channelSnowflake,
      addr.thread,
    );
    if (thread === null) {
      // Thread couldn't be created/found (non-text parent, perms, etc.).
      // Fall back to channel-scope rather than dropping the reply.
      return { instanceId: this.instanceId, channelId: channelSnowflake };
    }
    return {
      instanceId: this.instanceId,
      channelId: channelSnowflake,
      threadId: thread.threadId,
      _native: thread.channel,
    };
  }

  /**
   * cortex#502 — resolve a channel NAME (repo short name) to its Discord
   * snowflake within this adapter's guild. Returns `null` when no guild
   * text channel of that name is found. Uses the discord.js channel cache
   * (populated on connect via the `Guilds` intent); a cache miss for a
   * channel that exists is rare for a long-lived connection.
   */
  private resolveChannelByName(name: string): string | null {
    if (!this.client) return null;
    const guild = this.client.guilds.cache.get(this.presence.guildId);
    if (!guild) return null;
    const match = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === name,
    );
    return match ? match.id : null;
  }

  async notifyPrincipal(text: string): Promise<void> {
    const principalDiscordId = this.infra.principal.discordId;
    if (!principalDiscordId || !this.client) return;

    if (!this.connectionHealth?.currentlyConnected) {
      this.bufferPrincipalDM(text);
      return;
    }

    try {
      const principalUser = await this.client.users.fetch(principalDiscordId);
      await principalUser.send(text);
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
          `discord-${this.instanceId}: dropping principal DM, permanently undeliverable:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      // TOCTOU re-check: TS narrowed `currentlyConnected` to true via the
      // earlier-return guard at the top of `notifyPrincipal`, but the
      // connection can flip between that check and this catch. The
      // re-read is load-bearing per the comment block above; suppress
      // the rule that flags it as dead.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.connectionHealth.currentlyConnected && isRetryableError(err)) {
        this.bufferPrincipalDM(text);
      } else {
        console.warn(`discord-${this.instanceId}: failed to notify principal:`, err instanceof Error ? err.message : err);
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

  private bufferPrincipalDM(text: string): void {
    // TTL enforcement at write time — mirrors `cleanExpiredPending` for
    // pendingResults. Without this, a long disconnect window would cap the
    // buffer at PENDING_PRINCIPAL_MAX of stale entries which then get dropped
    // wholesale at drain time; better to evict expired entries proactively
    // so newer principal events have room.
    this.cleanExpiredPrincipalDMs();
    if (this.pendingPrincipalDMs.length >= DiscordAdapter.PENDING_PRINCIPAL_MAX) {
      this.pendingPrincipalDMs.shift();
    }
    this.pendingPrincipalDMs.push({ text, createdAt: Date.now() });
    console.warn(
      `discord-${this.instanceId}: buffered principal DM (Discord disconnected, ${this.pendingPrincipalDMs.length} pending)`
    );
  }

  private cleanExpiredPrincipalDMs(): void {
    if (this.pendingPrincipalDMs.length === 0) return;
    const now = Date.now();
    const before = this.pendingPrincipalDMs.length;
    this.pendingPrincipalDMs = this.pendingPrincipalDMs.filter(
      (p) => now - p.createdAt <= DiscordAdapter.PENDING_TTL_MS,
    );
    const expired = before - this.pendingPrincipalDMs.length;
    if (expired > 0) {
      console.warn(`discord-${this.instanceId}: expired ${expired} pending principal DM(s)`);
    }
  }

  private async drainPendingPrincipalDMs(): Promise<void> {
    // Re-use the write-time cleaner so drain-time TTL is consistent with
    // bufferPrincipalDM. Anything still in the buffer afterwards is fresh.
    this.cleanExpiredPrincipalDMs();
    if (this.pendingPrincipalDMs.length === 0) return;
    const principalDiscordId = this.infra.principal.discordId;
    if (!principalDiscordId || !this.client) {
      this.pendingPrincipalDMs = [];
      return;
    }
    const toDeliver = this.pendingPrincipalDMs;
    this.pendingPrincipalDMs = [];

    console.log(`discord-${this.instanceId}: draining ${toDeliver.length} pending principal DM(s)`);
    try {
      const principalUser = await this.client.users.fetch(principalDiscordId);
      for (const pending of toDeliver) {
        try {
          await principalUser.send(pending.text);
        } catch (err) {
          console.error(
            `discord-${this.instanceId}: failed to deliver buffered principal DM:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error(
        `discord-${this.instanceId}: could not fetch principal user to drain DMs:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async deliverPendingResult(key: string, pending: PendingResult): Promise<boolean> {
    const channel = await this.resolveChannel(pending.target, true);
    if (!channel) {
      console.warn(`discord-${this.instanceId}: could not resolve channel ${key} for pending result, dropping`);
      return false;
    }
    await postToDiscord(channel, pending.text, DiscordAdapter.toDiscordFiles(pending.files));
    console.log(`discord-${this.instanceId}: delivered pending result to ${key}`);
    return true;
  }

  private async drainPendingResults(): Promise<void> {
    if (this.pendingResults.size === 0) return;
    console.log(`discord-${this.instanceId}: draining ${this.pendingResults.size} pending result(s) after reconnect`);

    for (const [key, pending] of this.pendingResults) {
      try {
        await this.deliverPendingResult(key, pending);
      } catch (err) {
        console.error(`discord-${this.instanceId}: failed to deliver pending result to ${key}:`, err instanceof Error ? err.message : err);
      }
    }
    this.pendingResults.clear();
  }

  private cleanExpiredPending(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingResults) {
      if (now - pending.createdAt > DiscordAdapter.PENDING_TTL_MS) {
        console.warn(`discord-${this.instanceId}: expired pending result for ${key} (age: ${((now - pending.createdAt) / 1000).toFixed(0)}s)`);
        this.pendingResults.delete(key);
      }
    }
  }

  private static toDiscordFiles(files?: OutboundFile[]): { attachment: Buffer | string; name: string }[] | undefined {
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
    // `target._native` is the cached discord.js channel (TextChannel /
    // ThreadChannel / DMChannel) from the inbound message. Duck-type via
    // `.send`-shape narrowing rather than casting through `any`.
    const native = target._native as { send?: unknown } | undefined;
    if (!skipNativeCache && native && typeof native.send === "function") {
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

  // ---------------------------------------------------------------------------
  // MIG-3b: Surface-router integration
  // ---------------------------------------------------------------------------

  /**
   * MIG-3b — Surface-adapter face for the surface-router (G-1111.A).
   *
   * Returns a fresh `SurfaceAdapter` describing the bus-envelope-rendering
   * side of this Discord adapter:
   *
   *   - `id`        — the adapter instance ID (matches `this.instanceId`)
   *   - `subjects`  — NATS subject patterns from `surfaceSubjects` (empty if unset → never matches)
   *   - `filter`    — optional payload filter from `surfaceFilter`
   *   - `render`    — bound to `renderEnvelope` so `this` is preserved
   *
   * Wiring: the bot's startup composer calls `router.register(adapter.surfaceConfig)`
   * once per adapter, after MyelinRuntime has started. The router never opens
   * a NATS subscription — that's MyelinRuntime's job (per spec §5.1) — so this
   * face is purely the rendering hook.
   */
  get surfaceConfig(): SurfaceAdapter {
    return {
      id: this.instanceId,
      subjects: this.infra.surfaceSubjects ?? [],
      ...(this.infra.surfaceFilter ? { filter: this.infra.surfaceFilter } : {}),
      render: (envelope, signal) => this.renderEnvelope(envelope, signal),
    };
  }

  /**
   * MIG-3b — Render a bus envelope as a Discord message.
   *
   * v1 strategy: post the envelope to the adapter's configured fallback
   * channel as a markdown code block via `postResponse`. This re-uses the
   * existing pending-result + connection-health buffering from the chat
   * post path, so envelopes that arrive during a Discord disconnect get
   * the same retry behaviour as chat replies.
   *
   * v2 (MIG-7.2d Renderer model): per-event-type templates with channel
   * routing based on `envelope.payload` (e.g. `payload.repo` → repo-specific
   * channel) and sovereignty-aware redaction. This method stays as the
   * default fallback for envelopes that don't match a registered template.
   *
   * `signal` is the surface-router's per-render abort signal. We accept it
   * for contract symmetry but don't currently forward it into discord.js —
   * the underlying client doesn't accept an AbortSignal and `postResponse`
   * already buffers on disconnect, so the timeout-cancellation benefit is
   * marginal. Future refinement: thread the signal into a fetch-based
   * Discord REST client (a follow-on iteration when v2 templates land).
   *
   * Failure modes: this method never throws — `postResponse` already swallows
   * delivery errors and buffers when disconnected. The router's
   * `renderWithIsolation` wraps us in a timeout regardless.
   */
  private shouldRenderEnvelope(envelope: Envelope): boolean {
    const envelopeAgentId = envelope.payload.agent_id;
    return typeof envelopeAgentId !== "string" || envelopeAgentId === this.agent.id;
  }

  private async renderEnvelope(envelope: Envelope, _signal?: AbortSignal): Promise<void> {
    if (!this.shouldRenderEnvelope(envelope)) {
      return;
    }

    // Buffering at the adapter level would duplicate `postResponse`'s
    // existing pending-result mechanism; instead we drop here and rely
    // on JetStream replay (per design-cortex.md §3.3 "lost event ≠ lost
    // state") to redeliver after reconnect. Future refinement at MIG-3b-ii.
    //
    // We split null-client (adapter never started) from not-ready-client
    // (started but shard reconnecting) so operators can tell a config bug
    // from a transient gateway blip in the logs.
    if (this.client === null) {
      console.warn(
        `discord-${this.instanceId}: renderEnvelope called before start() — dropping envelope ${envelope.id}`,
      );
      return;
    }
    if (!this.client.isReady()) {
      console.warn(
        `discord-${this.instanceId}: renderEnvelope called while shard reconnecting — dropping envelope ${envelope.id}`,
      );
      return;
    }
    const channelId = this.infra.surfaceFallbackChannelId;
    if (!channelId) {
      console.warn(
        `discord-${this.instanceId}: has no surfaceFallbackChannelId configured — dropping envelope ${envelope.id}`,
      );
      return;
    }
    await this.postResponse(
      { instanceId: this.instanceId, channelId },
      formatEnvelopeAsMarkdown(envelope),
    );
  }

  // ---------------------------------------------------------------------------
  // MIG-3b-ii: system.adapter.* event emission
  // ---------------------------------------------------------------------------

  /**
   * Common gate for `system.adapter.*` emission. Returns the bound runtime +
   * source pair when both are configured, or `null` otherwise. Splits the "no
   * runtime configured" case (silent — bot was started without NATS) from the
   * "no source configured but runtime present" case (warn once — the principal
   * wired NATS but forgot to pass `systemEventSource`, which is a config bug
   * worth surfacing).
   *
   * Returning the pair (rather than a boolean) lets callers publish without
   * any non-null assertions on `this.runtime` / `this.systemEventSource` —
   * the discriminated shape carries the type evidence the compiler needs.
   */
  private canPublishSystemEvent(): { runtime: MyelinRuntime; source: SystemEventSource } | null {
    const runtime = this.runtime;
    if (!runtime) return null;
    const source = this.systemEventSource;
    if (!source) {
      if (!this.warnedMissingSource) {
        // Warn once per process — without the source, we'd emit envelopes
        // that fail schema validation on the receiver side. The principal
        // needs this signal at start time, not flooded across every shard
        // disconnect during a real outage.
        console.warn(
          `discord-${this.instanceId}: runtime is configured but systemEventSource is missing — system.* events will not be emitted`,
        );
        this.warnedMissingSource = true;
      }
      return null;
    }
    return { runtime, source };
  }

  private publishAdapterDegraded(opts: {
    instanceId: string;
    thresholdMs: number;
    since: Date;
  }): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const env = createSystemAdapterDegradedEvent({
      source: wiring.source,
      adapterId: opts.instanceId,
      platform: "discord",
      disconnectedSince: opts.since,
      thresholdMs: opts.thresholdMs,
      reconnectAttempts: this.connectionHealth?.reconnectCount,
    });
    // Fire-and-forget — `MyelinRuntime.publish` swallows + logs errors so we
    // never crash the bot just because a degraded notification couldn't ship.
    void wiring.runtime.publish(env);
  }

  private publishAdapterRecovered(opts: {
    instanceId: string;
    degradedForMs: number;
  }): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const env = createSystemAdapterRecoveredEvent({
      source: wiring.source,
      adapterId: opts.instanceId,
      platform: "discord",
      degradedForMs: opts.degradedForMs,
      reconnectAttempts: this.connectionHealth?.reconnectCount,
    });
    void wiring.runtime.publish(env);
  }

  private publishAdapterDisconnected(opts: {
    shardId: number;
    closeCode?: number;
    closeReason?: string;
    wasClean: boolean;
  }): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    // The disconnect timestamp lives on the connection-health snapshot; if
    // discord.js fired shardDisconnect before connection-health updated (or
    // the field was cleared between event and publish), fall back to "now"
    // — the envelope timestamp is an upper bound on disconnect time anyway.
    const disconnectedSince =
      this.connectionHealth?.lastDisconnectedAt ?? new Date();
    const env = createSystemAdapterDisconnectedEvent({
      source: wiring.source,
      adapterId: this.instanceId,
      platform: "discord",
      disconnectedSince,
      shardId: opts.shardId,
      ...(opts.closeCode !== undefined && { closeCode: opts.closeCode }),
      ...(opts.closeReason !== undefined && opts.closeReason !== "" && {
        closeReason: opts.closeReason,
      }),
      wasClean: opts.wasClean,
    });
    void wiring.runtime.publish(env);
  }

  private publishUntrustedBotDenied(message: Message): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const envelopeSubject =
      message.guildId ?
        `discord.${message.guildId}.${message.channelId}.messageCreate` :
        `discord.dm.${message.channelId}.messageCreate`;
    const env = createSystemAccessDeniedEvent({
      source: wiring.source,
      principalId: `discord:${message.author.id}`,
      capability: "discord.inbound",
      sovereignty: {
        classification: "local",
        data_residency: wiring.source.principal,
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      correlationId: `discord:${message.id}`,
      signedBy: [],
      envelopeSubject,
      envelopeId: message.id,
      reason: {
        kind: "untrusted_bot_author",
        platform: "discord",
        author_id: message.author.id,
        channel_id: message.channelId,
        guild_id: message.guildId ?? undefined,
      },
    });
    void wiring.runtime.publish(env);
  }
}
