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
import type { BotConfig } from "../../common/types/config";
import type { Agent, MattermostPresence } from "../../common/types/cortex-config";
import type { MattermostInboundMessage } from "./server";
import {
  createMattermostPoller,
  postReply,
  postReplyWithFiles,
  fetchMattermostFileInfos,
} from "./poller";
import { fetchMattermostContext } from "./context";
import { fetchBotUserId } from "./bot-user";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SurfaceAdapter } from "../../bus/surface-router";
import type { PayloadFilter } from "../../bus/payload-filter";
import { formatEnvelopeAsMarkdown } from "../envelope-renderer";
import { type SystemEventSource } from "../../bus/system-events";
import {
  isOperatorPrincipal,
  resolvePolicyAccess,
  type PlatformPrincipalIndex,
  type PolicyEngine,
  type PrincipalRegistry,
} from "../../common/policy";

/**
 * Cortex-deployment-level wiring passed alongside the agent + presence pair.
 * Mirrors `DiscordAdapterInfra` (see cortex#48 / MIG-7.2c-discord-cleanup)
 * with Mattermost-specific bits: the operator's Mattermost user id lives
 * here, not on the agent block.
 *
 * The surface-router fields park here transitionally — architecture §9.2
 * makes them a renderer concern (activity-centric, not agent-credential),
 * and a dedicated `kind: mattermost-channel` renderer lifts them out at
 * MIG-7.2d alongside the matching Discord renderer.
 */
export interface MattermostAdapterInfra {
  /** Surface-router + log-prefix key. Cortex derives `${agent.id}-mattermost`
   * (or `${agent.id}-mattermost-${index}` when `botConfig.mattermost[]` has
   * multiple entries per agent.name); collapses to plain
   * `${agent.id}-mattermost` at MIG-7.2e when migrate-config emits a real
   * agents[] array. */
  instanceId: string;
  /** Operator's platform identity. Architecture §9.1: the operator runs the
   * cortex deployment, distinct from the agents they host. */
  operator: { mattermostId?: string };
  /** MIG-3b: NATS subject patterns this adapter renders to Mattermost.
   * Empty/undefined → adapter never matches in the surface-router. Moves to
   * Renderer config at MIG-7.2d. */
  surfaceSubjects?: string[];
  /** MIG-3b: optional payload filter applied AFTER subject match. Moves to
   * Renderer at MIG-7.2d. */
  surfaceFilter?: PayloadFilter;
  /** MIG-3b: fallback Mattermost channel ID for envelope rendering when no
   * per-envelope routing rule applies. The 26-char channel ID, NOT a name.
   * Moves to Renderer at MIG-7.2d. */
  surfaceFallbackChannelId?: string;
  /**
   * v2.0.0 (cortex#297) — myelin runtime preserved for forward compat
   * with sibling `system.access.*` envelopes that may publish here in
   * the future. Today's resolveAccess path doesn't publish; the field
   * is optional and the adapter still works when absent.
   */
  runtime?: MyelinRuntime;
  /** v2.0.0 (cortex#297) — `{org}.{agent}.{instance}` source triple. */
  systemEventSource?: SystemEventSource;
  /**
   * v2.0.0 cutover (cortex#297) — PolicyEngine is the sole authorisation
   * gate. See `DiscordAdapterInfra.policyEngine` for the full contract.
   */
  policyEngine?: PolicyEngine;
  /** v2.0.0 (cortex#297) — `(platform, platformId) → principalId` index. */
  policyLookup?: PlatformPrincipalIndex;
  /** v2.0.0 (cortex#297) — `principal_id → PolicyPrincipal` registry. */
  policyRegistry?: PrincipalRegistry;
}

export class MattermostAdapter implements PlatformAdapter {
  readonly platform = "mattermost";
  readonly instanceId: string;

  private stopPoller: (() => void) | null = null;
  private agent: Agent;
  private presence: MattermostPresence;
  private infra: MattermostAdapterInfra;
  /**
   * Constructor-validated, refined credentials. `MattermostPresenceSchema`
   * leaves `apiUrl` / `apiToken` optional because cortex.yaml can legitimately
   * declare a Mattermost presence with neither yet (e.g. webhook-only).
   * However, every call site in this adapter — poller, REST posts, /users/me
   * helper — needs both as concrete strings, and they're reconnect-only
   * (never updated on hot-reload). Validate once at construction and cache
   * the refined values; consumers read `this.apiUrl` / `this.apiToken`.
   */
  private apiUrl: string;
  private apiToken: string;
  /** MIG-7.2c-binding: lazily-fetched bot user id from `/api/v4/users/me`. */
  private cachedPlatformUserId: string | null = null;

  constructor(
    agent: Agent,
    presence: MattermostPresence,
    infra: MattermostAdapterInfra,
  ) {
    this.agent = agent;
    this.presence = presence;
    this.infra = infra;
    this.instanceId = infra.instanceId;
    if (!presence.apiUrl || !presence.apiToken) {
      throw new Error(
        `mattermost-adapter[${this.instanceId}]: construction requires presence.apiUrl + presence.apiToken (got apiUrl=${presence.apiUrl ? "set" : "missing"}, apiToken=${presence.apiToken ? "set" : "missing"}).`,
      );
    }
    this.apiUrl = presence.apiUrl;
    this.apiToken = presence.apiToken;

    // MIG-3b: warn once at construction if surfaceSubjects is explicitly empty.
    // Mirrors DiscordAdapter — `undefined` is silent (opted out), `[]` is a
    // config-typo signal worth surfacing.
    if (infra.surfaceSubjects?.length === 0) {
      console.warn(
        `mattermost-${this.instanceId}: surfaceSubjects is empty — adapter will never render bus envelopes`,
      );
    }
  }

  // PlatformAdapter contract — start/stop/clearProgress/createThread MUST be
  // Promise<void>. Mattermost's polling loop and per-channel state mutations
  // are sync today; suppress require-await for the interface conformance.
  /* eslint-disable @typescript-eslint/require-await */
  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const { stop } = createMattermostPoller({
      agentName: this.agent.id,
      presence: this.presence,
      pollIntervalMs: this.presence.pollIntervalMs,
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
    // Drop the cached id so a subsequent start() picks up the current
    // /users/me — guards against a token swap between sessions.
    this.cachedPlatformUserId = null;
  }

  /**
   * MIG-7.2c-binding: Return the Mattermost user id of the bot account this
   * adapter is connected as. Fetches `/api/v4/users/me` on first call and
   * caches the result; subsequent calls are zero-RPC. Cache cleared on
   * `stop()` so a token rotation between sessions re-fetches cleanly.
   */
  async getPlatformUserId(): Promise<string> {
    if (this.cachedPlatformUserId) return this.cachedPlatformUserId;

    // `this.apiUrl` / `this.apiToken` are constructor-validated non-empty
    // strings (the ctor throws if either is missing); no runtime null check
    // is reachable here. Holly cycle 1 N1.
    const id = await fetchBotUserId(this.apiUrl, this.apiToken, { instanceId: this.instanceId });
    this.cachedPlatformUserId = id;
    return id;
  }

  /**
   * F-092 hot-reload (MIG-7.2c-mattermost rework): matches the live presence
   * by the immutable `apiUrl` (Mattermost has no equivalent of Discord's
   * `guildId`; the server URL is what cleanly disambiguates entries within
   * `config.mattermost[]`). Only hot-reload-safe fields update;
   * `apiUrl`/`apiToken`/`webhookUrl` are reconnect-only and intentionally
   * preserved across the immutable spread.
   */
  updateConfig(config: BotConfig): void {
    const newInstance = config.mattermost.find((inst) => inst.apiUrl === this.apiUrl);

    if (!newInstance) {
      console.warn(`mattermost-adapter[${this.instanceId}]: instance removed from config, ignoring update`);
      return;
    }

    this.presence = {
      ...this.presence,
      channels: newInstance.channels,
      pollIntervalMs: newInstance.pollIntervalMs,
      // v2.0.0 (cortex#297) — roles/defaultRole retired.
      allowedUsers: newInstance.allowedUsers,
      ...(newInstance.triggerWord !== undefined && { triggerWord: newInstance.triggerWord }),
    };

    // Rebuild agent so `agent.presence.mattermost` + `agent.id` /
    // `agent.displayName` reflect the post-reload state. Same invariant
    // Holly flagged at MIG-7.2c-internal cycle 1 for Discord — a stale
    // agent reference becomes a runtime bug the moment PresenceBinding /
    // TrustResolver reads from it during a live config change.
    this.agent = {
      ...this.agent,
      id: config.agent.name,
      displayName: config.agent.displayName,
      presence: { ...this.agent.presence, mattermost: this.presence },
    };

    console.log(`mattermost-adapter[${this.instanceId}]: config updated`);
  }

  /* eslint-enable @typescript-eslint/require-await */

  async fetchContext(msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    const mmMsg = msg._native as MattermostInboundMessage | undefined;
    if (!mmMsg) return [];

    const { messages } = await fetchMattermostContext(
      mmMsg.postId,
      mmMsg.channelId,
      { agentName: this.agent.id, presence: this.presence },
    );
    return messages;
  }

  /**
   * v2.0.0 (cortex#297) — single-gate authorisation via PolicyEngine.
   * Mattermost messages aren't classified as DMs in the legacy shape;
   * `dmType` synthesis is omitted. The operator short-circuit lives in
   * `resolvePolicyAccess` via the `operator` capability.
   */
  resolveAccess(msg: InboundMessage): AccessDecision {
    return resolvePolicyAccess({
      msg,
      engine: this.infra.policyEngine,
      index: this.infra.policyLookup,
      registry: this.infra.policyRegistry,
    });
  }

  /**
   * v2.0.0 (cortex#297) — operator detection via the policy `operator`
   * capability. Used elsewhere (e.g. operator-DM notifier paths) to
   * decide privileged actions.
   */
  protected isOperator(authorId: string): boolean {
    return isOperatorPrincipal(
      "mattermost",
      authorId,
      this.infra.policyEngine,
      this.infra.policyLookup,
    );
  }

  async postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void> {
    const apiUrl = this.apiUrl;
    const apiToken = this.apiToken;
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
      this.apiUrl,
      this.apiToken,
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clearProgress(target: ResponseTarget): Promise<void> {
    const key = target.threadId ?? target.channelId;
    this.progressSent.delete(key);
    // Mattermost: no easy delete — leave the single progress message
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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
    const operatorId = this.infra.operator.mattermostId;
    if (!operatorId) return;

    try {
      // MIG-7.2c-mattermost (Holly cycle 1 W1+S1): use the cached bot user
      // id from `getPlatformUserId` instead of re-fetching /users/me here.
      // PresenceBinding populates the cache at startup; subsequent calls
      // are zero-RPC. Falls back to the shared helper on the rare path
      // where notifyOperator is called before PresenceBinding finished.
      const botUserId = await this.getPlatformUserId();

      // Create/get DM channel with operator.
      const dmRes = await fetch(`${this.apiUrl}/api/v4/channels/direct`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([botUserId, operatorId]),
      });

      if (dmRes.ok) {
        const dmChannel = (await dmRes.json()) as { id: string };
        await postReply(dmChannel.id, text, undefined, this.apiUrl, this.apiToken);
      }
    } catch (err) {
      console.warn(`mattermost-${this.instanceId}: failed to notify operator:`, err instanceof Error ? err.message : err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetchFileAttachments(fileIds: string[]) {
    const infos = await fetchMattermostFileInfos(
      fileIds,
      this.apiUrl,
      this.apiToken,
    );
    return infos.map((i) => ({
      url: i.url,
      filename: i.originalName,
      contentType: i.contentType,
      size: i.size,
    }));
  }

  // ---------------------------------------------------------------------------
  // MIG-3b: Surface-router integration
  // ---------------------------------------------------------------------------

  /**
   * MIG-3b — Surface-adapter face for the surface-router (G-1111.A).
   *
   * Mirror of `DiscordAdapter.surfaceConfig` — see that doc for the shape +
   * wiring pattern. Mattermost-specific note: the adapter has no equivalent
   * of Discord's pending-result buffer (Mattermost's reconnect story is
   * different — the poller pulls; it doesn't push), so renderEnvelope's
   * failure mode is "log + drop" rather than "buffer for retry". JetStream
   * replay covers the recovery path per design-cortex.md §3.3.
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
   * MIG-3b — Render a bus envelope as a Mattermost post.
   *
   * v1: post the formatted envelope to the configured fallback channel via
   * `postReply` (no rootId — top-level post in the channel). v2 routing
   * lives in the Renderer model (MIG-7.2d).
   *
   * `signal` is the surface-router's per-render abort signal. Accepted for
   * contract symmetry; not currently forwarded — `postReply` is a thin
   * fetch wrapper that doesn't take an AbortSignal yet. A follow-on
   * iteration can thread it through `postReply` so a hung HTTP request
   * actually unwinds at the timeout (today the timed-out fetch keeps
   * running in the background until its own connect/read deadline fires).
   *
   * Failure mode: `postReply` may throw on HTTP error; we catch + log
   * here so the surface-router's `renderWithIsolation` doesn't have to
   * be the only safety net. Dropping is acceptable because JetStream
   * replay handles redelivery.
   */
  private async renderEnvelope(envelope: Envelope, _signal?: AbortSignal): Promise<void> {
    const channelId = this.infra.surfaceFallbackChannelId;
    if (!channelId) {
      console.warn(
        `mattermost-${this.instanceId}: has no surfaceFallbackChannelId configured — dropping envelope ${envelope.id}`,
      );
      return;
    }
    try {
      await postReply(
        channelId,
        formatEnvelopeAsMarkdown(envelope),
        undefined,
        this.apiUrl,
        this.apiToken,
      );
    } catch (err) {
      console.warn(
        `mattermost-${this.instanceId}: renderEnvelope failed for envelope ${envelope.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
