/**
 * GW.a.2 — SurfaceGateway inbound orchestrator (cortex#524, shadow stage).
 *
 * This module implements the INBOUND half of the shared surface gateway:
 * for each platform adapter, it rebinds the `onMessage` callback to route
 * inbound messages through the binding resolver and hand routing decisions
 * to an injected {@link GatewayInboundSink}.
 *
 * ## Shadow stage (Stage 1, §7)
 *
 * In Stage 1 the sink is {@link LoggingInboundSink} — it logs the routing
 * decision that WOULD be published to the bus, but does not actually publish.
 * This lets the gateway run alongside per-stack adapters on a staging identity
 * to prove demux correctness before any stack loses its own adapter.
 *
 * ## GW.a.3 follow-on
 *
 * The real bus-publishing sink, the `SurfaceGateway` wiring in `cortex.ts`,
 * and the launchd plist that runs the gateway as a supervised process are all
 * GW.a.3 work. This module is kept fully unit-testable behind injected
 * interfaces so GW.a.3 only adds a sink implementation and wires things up,
 * without touching the orchestrator.
 *
 * ## v1 decisions baked in
 *
 * - `responseRouting.adapter_instance` = `msg.instanceId` (the adapter's own
 *   connection-instance key). This aligns with the outbound mux key the
 *   gateway will use in GW.a.3: the `response_routing.instance` carried on
 *   lifecycle envelopes back to the gateway is the adapter-instance id that
 *   sourced the dispatch, so the mux can route the reply back to the right
 *   platform connection.
 *   NOTE: `GatewayBindingMatch.instance` (from GW.a.1) is derived from the
 *   binding config (`platform:guildId`, etc.) and acts as a stable binding id;
 *   `responseRouting.adapter_instance` = `msg.instanceId` is the live
 *   connection-instance key (what the per-adapter `instanceId` carries at
 *   runtime). In v1 these are the same value for non-gateway adapters; the
 *   gateway itself owns a single adapter per binding and stamps the adapter's
 *   `instanceId` on the wire so outbound mux keys reconcile.
 *
 * - Unroutable inbound is logged and dropped. The adapter loop must never throw
 *   — a throw from `onMessage` can crash the adapter's internal event loop.
 *
 * - Sink errors are logged to stderr and swallowed. Same reason: the adapter
 *   loop must stay alive even if a downstream publish transiently fails.
 */

import type { PlatformAdapter, InboundMessage } from "../adapters/types";
import {
  resolveBinding,
  type GatewayBindingIndex,
  type GatewayBindingMatch,
} from "./binding-resolver";
import type { ResponseRouting } from "../bus/dispatch-events";

// =============================================================================
// Public types
// =============================================================================

/**
 * The routing decision the gateway derives from one inbound message.
 *
 * Carries the full binding match (target principal / stack / agent) and the
 * response-routing address the runner must echo onto every lifecycle envelope
 * so the outbound mux can deliver replies back to the correct platform
 * connection.
 */
export interface GatewayInboundDecision {
  /** Full binding match from the resolver — principal, stack, agent, instance. */
  match: GatewayBindingMatch;

  /**
   * Wire-level response-routing address for this inbound message.
   *
   * `adapter_instance` = `msg.instanceId` — the connection-instance key of the
   * adapter that received the message. The outbound mux in GW.a.3 reads this
   * field off the lifecycle envelope to select which platform connection to
   * render the reply on.
   *
   * `channel_id` / `thread_id` are the platform-native ids carried on the
   * inbound message and echoed verbatim onto the lifecycle envelope chain.
   */
  responseRouting: ResponseRouting;
}

/**
 * The injected seam that the gateway hands routing decisions to.
 *
 * In Stage 1 (shadow) this is {@link LoggingInboundSink} — it logs the
 * decision for observability but does NOT publish to the bus.
 *
 * In GW.a.3 this is replaced by a real bus-publishing sink that publishes a
 * canonical `tasks.@{did-encoded-assistant}.chat` envelope per
 * `dispatch-source-publisher.ts`.
 */
export interface GatewayInboundSink {
  publish(decision: GatewayInboundDecision, msg: InboundMessage): Promise<void>;
}

// =============================================================================
// SurfaceGateway
// =============================================================================

/** Options for {@link SurfaceGateway}. */
export interface SurfaceGatewayOptions {
  /**
   * Called when an inbound message cannot be routed (no binding match, DM on
   * Discord/Slack with no single-binding fallback, or Mattermost multi-binding
   * ambiguity). The default implementation emits a `console.warn`.
   *
   * Shadow stage: this is a logging hook. The adapter loop is never interrupted
   * — `onUnroutable` must not throw.
   */
  onUnroutable?: (msg: InboundMessage, reason: string) => void;
}

/**
 * The shared surface gateway's inbound orchestrator.
 *
 * Drives one or more {@link PlatformAdapter} instances, rebinding their
 * `onMessage` callback to route inbound messages through the binding index
 * and publish routing decisions to the injected {@link GatewayInboundSink}.
 *
 * In production (GW.a.3) the gateway is constructed once at startup, given the
 * adapters for all `(platform, identity)` connections the gateway owns, and
 * kept alive for the lifetime of the process. The launchd plist owns restart.
 */
export class SurfaceGateway {
  private readonly adapters: PlatformAdapter[];
  private readonly index: GatewayBindingIndex;
  private readonly sink: GatewayInboundSink;
  private readonly onUnroutable: (msg: InboundMessage, reason: string) => void;

  constructor(
    adapters: PlatformAdapter[],
    index: GatewayBindingIndex,
    sink: GatewayInboundSink,
    opts?: SurfaceGatewayOptions,
  ) {
    this.adapters = adapters;
    this.index = index;
    this.sink = sink;
    this.onUnroutable =
      opts?.onUnroutable ??
      ((msg, reason) => {
        console.warn(
          `[surface-gateway] unroutable inbound message — dropping. ` +
            `platform=${msg.platform} instanceId=${msg.instanceId} ` +
            `channelId=${msg.channelId} reason="${reason}"`,
        );
      });
  }

  /**
   * Start all adapters, rebinding each `onMessage` callback to route through
   * this gateway.
   *
   * Each adapter owns one `(platform, identity)` connection. The gateway is
   * the sole `onMessage` handler — the per-stack `dispatchHandler.handleMessage`
   * path is bypassed (design §5: "the `onMessage` callback is rebound").
   */
  async start(): Promise<void> {
    await Promise.all(
      this.adapters.map((adapter) =>
        adapter.start((msg) => this.handleInbound(adapter, msg)),
      ),
    );
  }

  /**
   * Stop all adapters, releasing their platform connections.
   */
  async stop(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop()));
  }

  /**
   * Route one inbound message to the sink.
   *
   * Called from inside the adapter's `onMessage` callback — MUST NOT throw.
   * The ENTIRE body runs under one try/catch so never-throw is a code
   * invariant, not a caller obligation: a throwing `onUnroutable` hook, a
   * throwing `sink.publish`, or anything else is logged with full context and
   * swallowed so the adapter loop stays alive.
   *
   * @param _adapter the adapter that received the message. Unused in the shadow
   *   stage; reserved for GW.a.3, where the outbound mux needs the per-connection
   *   context to render replies. Kept on the signature (design §5 references
   *   `gateway.handleInbound(adapter, msg)`) rather than re-threaded later.
   */
  async handleInbound(
    _adapter: PlatformAdapter,
    msg: InboundMessage,
  ): Promise<void> {
    try {
      const match = resolveBinding(this.index, msg);

      if (match === null) {
        const reason = unroutableReason(msg, this.index);
        this.onUnroutable(msg, reason);
        return;
      }

      const decision: GatewayInboundDecision = {
        match,
        responseRouting: {
          // adapter_instance = msg.instanceId — the connection-instance key.
          // See module doc "v1 decisions" for the reconciliation note.
          adapter_instance: msg.instanceId,
          channel_id: msg.channelId,
          ...(msg.threadId !== undefined && { thread_id: msg.threadId }),
        },
      };

      await this.sink.publish(decision, msg);
    } catch (err: unknown) {
      // handleInbound runs inside the adapter's onMessage loop and MUST NOT
      // throw — a throw can crash the adapter's event loop. Any error (a
      // throwing onUnroutable hook, a sink failure at Shadow stage before the
      // bus is connected, etc.) is logged with full context and swallowed so
      // the loop stays alive. This is NOT an empty catch.
      process.stderr.write(
        `[surface-gateway] handleInbound error — dropping message. ` +
          `platform=${msg.platform} instanceId=${msg.instanceId} ` +
          `channelId=${msg.channelId} ` +
          `error=${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// =============================================================================
// LoggingInboundSink (shadow-stage sink)
// =============================================================================

/**
 * Shadow-stage sink — logs the routing decision and response-routing address
 * that WOULD be published to the bus, without publishing.
 *
 * Used in Stage 1 to observe demux correctness on real traffic before any
 * stack's adapter is retired. Replace with the real bus-publishing sink in
 * GW.a.3.
 *
 * The logged subject mirrors the canonical `tasks.@{did-encoded-assistant}.chat`
 * form the bus-publishing sink will use, so the shadow log is directly
 * comparable to what the real sink will emit.
 */
export class LoggingInboundSink implements GatewayInboundSink {
  publish(
    decision: GatewayInboundDecision,
    msg: InboundMessage,
  ): Promise<void> {
    const { match, responseRouting } = decision;

    // Build the subject the GW.a.3 bus-publishing sink will publish on.
    // principal / stack may be undefined when the binding carries no `stack`
    // field (binding-resolver gap 4 / OQ4).
    const subjectHint =
      match.principal !== undefined && match.stack !== undefined
        ? `local.${match.principal}.${match.stack}.tasks.@${match.agent}.chat`
        : `<unresolved-stack>.tasks.@${match.agent}.chat`;

    process.stdout.write(
      `[surface-gateway:shadow] inbound routed ` +
        `platform=${match.platform} ` +
        `agent=${match.agent} ` +
        `principal=${match.principal ?? "<unresolved>"} ` +
        `stack=${match.stack ?? "<unresolved>"} ` +
        `subject=${subjectHint} ` +
        `response_routing={ adapter_instance=${responseRouting.adapter_instance} ` +
        `channel_id=${responseRouting.channel_id}` +
        (responseRouting.thread_id !== undefined
          ? ` thread_id=${responseRouting.thread_id}`
          : "") +
        ` } ` +
        `author=${msg.authorName} ` +
        `content_length=${msg.content.length}\n`,
    );

    return Promise.resolve();
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Derive a human-readable reason string for an unroutable inbound message.
 * Used by the default `onUnroutable` handler and can be passed to a custom one.
 */
function unroutableReason(
  msg: InboundMessage,
  index: GatewayBindingIndex,
): string {
  const { platform } = msg;

  if (platform === "discord" || platform === "slack") {
    if (!msg.guildId) {
      return "DM (no guildId) — guild-granularity demux only in v1";
    }
    const map = platform === "discord" ? index.discord : index.slack;
    if (!map.has(msg.guildId)) {
      return `no binding for ${platform} guildId "${msg.guildId}"`;
    }
  }

  if (platform === "mattermost") {
    if (index.mattermostMulti) {
      return "mattermost multi-binding ambiguity — no per-message server id to discriminate";
    }
    if (!index.mattermostSingle) {
      return "no mattermost bindings configured";
    }
  }

  return `no binding match for platform "${platform}"`;
}
