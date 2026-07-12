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
  parseStack,
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
// Runtime attach/detach (cortex#1793, S8, ADR-0024 D3 renderer-delta note +
// "the adapter side is the hard half" scope amendment)
// =============================================================================

/**
 * One binding seed to fold into the gateway's live {@link GatewayBindingIndex}
 * when {@link SurfaceGateway.attachAdapter} brings a new adapter instance up
 * at RUNTIME (no boot, no restart) — the runtime twin of the per-platform
 * loops `buildBindingIndex` runs once at boot. Uses the SAME demux-key
 * conventions byte-for-byte (`binding-resolver.ts`'s "v1 decisions") so an
 * adapter attached mid-life resolves inbound identically to one present at
 * boot:
 *
 *   - discord / slack: `demuxKey` = `binding.guildId` / `binding.workspaceId`.
 *   - mattermost: `demuxKey` = `binding.apiUrl` (only meaningful for the
 *     single-vs-multi recompute — see {@link SurfaceGateway.attachAdapter}).
 *   - web: `demuxKey` = the adapter's own `instanceId` (NOT pre-fixed with
 *     `"web:"` — the gateway derives the `web:${demuxKey}` index key itself,
 *     matching `buildBindingIndex`'s web loop).
 */
export interface GatewayBindingSeed {
  platform: "discord" | "slack" | "mattermost" | "web";
  agent: string;
  stack?: string;
  demuxKey: string;
}

/** Outcome of {@link SurfaceGateway.detachAdapter}. */
export interface DetachAdapterResult {
  /** `false` when no attached instance matched `instanceId` — a no-op, not an error. */
  detached: boolean;
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

  /**
   * cortex#1793 (S8) — the seeds each ATTACHED (runtime, not boot) instance
   * folded into {@link index}, keyed by `PlatformAdapter.instanceId`. Boot-time
   * adapters (constructed via the constructor's initial `adapters` array) are
   * NOT tracked here — their index entries live for the gateway's whole
   * lifetime and are torn down only by a full {@link stop}. Only entries added
   * via {@link attachAdapter} are tracked, so {@link detachAdapter} removes
   * EXACTLY what its matching attach added — never a boot-time binding.
   */
  private readonly attachedSeeds = new Map<string, GatewayBindingSeed[]>();

  /**
   * cortex#1793 (S8) — instance ids currently mid-detach or fully detached.
   * Checked FIRST (synchronously, before any await) at the top of
   * {@link handleInbound} so inbound racing in during/after a detach is
   * dropped + logged rather than routed through a binding index entry that
   * `detachAdapter` may already have removed. Cleared once the matching
   * `detachAdapter` call returns (never inhabited by a boot-time instance).
   */
  private readonly detachedInstanceIds = new Set<string>();

  /**
   * cortex#1793 (S8) — in-flight `handleInbound` work per instance id, so
   * {@link detachAdapter} can DRAIN: wait for everything already admitted
   * before the detach flag was set, without blocking on work that arrives
   * (and is dropped) after.
   */
  private readonly inFlight = new Map<string, Set<Promise<void>>>();

  constructor(
    adapters: PlatformAdapter[],
    index: GatewayBindingIndex,
    sink: GatewayInboundSink,
    opts?: SurfaceGatewayOptions,
  ) {
    this.adapters = adapters;
    this.index = index;
    this.sink = sink;
    this.onUnroutable = opts?.onUnroutable ?? defaultUnroutableWarn;
  }

  /**
   * The inbound sink this gateway publishes routing decisions to.
   *
   * Read-only observability accessor: lets callers (and tests) inspect which
   * sink mode the gateway was constructed with — {@link LoggingInboundSink}
   * (shadow, no bus publish) vs a live `BusInboundSink` (publishing). The
   * shadow-vs-live selection is made by `startGatewayIfEnabled` behind the
   * `CORTEX_GATEWAY_PUBLISH` flag; exposing the sink here is how the boot path
   * and tests confirm which mode is in effect without reaching into privates.
   */
  get inboundSink(): GatewayInboundSink {
    return this.sink;
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
      this.adapters.map(async (adapter) => {
        await adapter.start((msg) => this.handleInbound(adapter, msg));
        // Two-phase inbound: start() connects + stores onMessage; this registers
        // the platform message listener (Discord/Slack split the two — see
        // PlatformAdapter.attachInboundDispatch). Without it the adapter connects
        // but never delivers inbound (the cortex#524 dry-run caught exactly this).
        // The gateway has no Pass-2 trust merge to defer for, so attach right
        // after start. Optional-chaining: single-phase adapters (Mattermost) omit
        // it → no-op.
        adapter.attachInboundDispatch?.();
        process.stdout.write(
          `[surface-gateway] adapter started + inbound listener attached — ` +
            `platform=${adapter.platform} instanceId=${adapter.instanceId}` +
            `${adapter.attachInboundDispatch === undefined ? " (single-phase; no attach)" : ""}\n`,
        );
      }),
    );
  }

  /**
   * Stop all adapters, releasing their platform connections.
   */
  async stop(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop()));
  }

  /**
   * cortex#1793 (S8, ADR-0024 D3) — bring ONE new adapter instance up at
   * runtime, no restart. The per-instance counterpart to {@link start}
   * (which brings every BOOT-time adapter up together): folds `seeds` into
   * the live {@link GatewayBindingIndex} (same demux-key rules
   * `buildBindingIndex` uses — see {@link GatewayBindingSeed}), then
   * `start()`s the adapter and attaches its inbound listener exactly like the
   * boot-time loop does.
   *
   * Throws (adapter NOT attached) when:
   *   - `adapter.instanceId` is already attached (boot-time or a prior
   *     runtime attach) — call {@link detachAdapter} first to replace it;
   *   - any discord/slack/web seed's demux key collides with an
   *     already-bound key — the SAME loud "ambiguous config" error
   *     `buildBindingIndex` throws at boot, so a colliding runtime attach
   *     fails exactly as loudly as a colliding boot config would.
   *
   * Mattermost has no per-entry demux map (boot-time `buildBindingIndex`
   * tracks only a single-vs-multi flag) — attaching a mattermost seed
   * recomputes that flag from every seed this gateway has EVER attached
   * (tracked in {@link attachedSeeds}), mirroring the boot-time loop's
   * "exactly one binding is the fallback; more than one is ambiguous" rule.
   *
   * Never partially applies: index entries are added BEFORE `adapters.push`,
   * so a throw here leaves neither the index nor the adapter list mutated
   * for this attach.
   */
  async attachAdapter(
    adapter: PlatformAdapter,
    seeds: readonly GatewayBindingSeed[],
  ): Promise<void> {
    if (this.adapters.some((a) => a.instanceId === adapter.instanceId)) {
      throw new Error(
        `SurfaceGateway.attachAdapter: instance "${adapter.instanceId}" is already attached — ` +
          `detachAdapter it first to replace it.`,
      );
    }

    // Fold every non-mattermost seed into the index FIRST (loud throw on
    // collision, before touching adapters/attachedSeeds) — mattermost is
    // handled separately below via recompute, since it has no per-entry map.
    for (const seed of seeds) {
      if (seed.platform === "mattermost") continue;
      this.addNonMattermostSeed(seed);
    }
    this.attachedSeeds.set(adapter.instanceId, [...seeds]);
    if (seeds.some((s) => s.platform === "mattermost")) {
      this.recomputeMattermostSlot();
    }

    this.detachedInstanceIds.delete(adapter.instanceId);
    this.adapters.push(adapter);
    await adapter.start((msg) => this.handleInbound(adapter, msg));
    adapter.attachInboundDispatch?.();
    process.stdout.write(
      `[surface-gateway] adapter attached at runtime + inbound listener attached — ` +
        `platform=${adapter.platform} instanceId=${adapter.instanceId}\n`,
    );
  }

  /**
   * cortex#1793 (S8, ADR-0024 D3) — detach ONE adapter instance at runtime,
   * no restart, WITHOUT disturbing any other attached instance (the
   * acceptance criterion: "detach of one adapter leaves every other adapter
   * delivering").
   *
   * Sequence:
   *   1. Mark `instanceId` detached FIRST (synchronous, before any await) —
   *      any `handleInbound` call whose entry check runs after this point
   *      drops its message (logged) instead of routing it, even though the
   *      adapter object and its index entries are torn down a few lines
   *      later in this same call. JS's single-threaded execution means no
   *      inbound can slip between this line and the index/adapters mutation
   *      below (neither yields to the event loop).
   *   2. Remove the instance from `adapters` and fold its seeds back out of
   *      the index (mattermost: recompute the slot from the REMAINING
   *      tracked seeds).
   *   3. DRAIN — await every `handleInbound` call already admitted into
   *      {@link inFlight} for this instance (work that started before step 1)
   *      so `adapter.stop()` never races an in-flight render/publish.
   *   4. `adapter.stop()`.
   *
   * Returns `{ detached: false }` (no-op, not an error) when `instanceId`
   * names no currently-attached adapter — mirrors the idempotent-miss
   * convention `PlatformAdapter.stop()` documents elsewhere in this codebase.
   */
  async detachAdapter(instanceId: string): Promise<DetachAdapterResult> {
    const idx = this.adapters.findIndex((a) => a.instanceId === instanceId);
    if (idx === -1) return { detached: false };
    const adapter = this.adapters[idx];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- idx came from findIndex on THIS array, one line above; TS narrows via noUncheckedIndexedAccess but the index is provably in-bounds.
    const liveAdapter = adapter!;

    // Step 1 — flag FIRST. No await between here and step 2's mutations, so
    // no inbound can observe a half-torn-down state.
    this.detachedInstanceIds.add(instanceId);

    // Step 2 — remove from the live adapter list + fold seeds back out of
    // the index.
    this.adapters.splice(idx, 1);
    const seeds = this.attachedSeeds.get(instanceId) ?? [];
    this.attachedSeeds.delete(instanceId);
    for (const seed of seeds) {
      if (seed.platform === "mattermost") continue;
      this.removeNonMattermostSeed(seed);
    }
    if (seeds.some((s) => s.platform === "mattermost")) {
      this.recomputeMattermostSlot();
    }

    // Step 3 — drain in-flight handleInbound work for this instance.
    const pending = this.inFlight.get(instanceId);
    if (pending && pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    this.inFlight.delete(instanceId);

    // Step 4 — release the platform connection.
    await liveAdapter.stop();

    process.stdout.write(
      `[surface-gateway] adapter detached at runtime — platform=${liveAdapter.platform} ` +
        `instanceId=${instanceId}\n`,
    );
    return { detached: true };
  }

  /** Fold one discord/slack/web seed into the live index. Throws the same
   *  loud ambiguous-binding error {@link binding-resolver.ts}'s
   *  `buildBindingIndex` throws at boot on a duplicate demux key. */
  private addNonMattermostSeed(seed: GatewayBindingSeed): void {
    const { principal, stack } = parseStack(seed.stack);
    if (seed.platform === "discord") {
      if (this.index.discord.has(seed.demuxKey)) {
        throw new Error(
          `SurfaceGateway.attachAdapter: ambiguous discord config — guildId "${seed.demuxKey}" is already bound.`,
        );
      }
      this.index.discord.set(seed.demuxKey, {
        agent: seed.agent,
        principal,
        stack,
        instance: `discord:${seed.demuxKey}`,
      });
      return;
    }
    if (seed.platform === "slack") {
      if (this.index.slack.has(seed.demuxKey)) {
        throw new Error(
          `SurfaceGateway.attachAdapter: ambiguous slack config — workspaceId "${seed.demuxKey}" is already bound.`,
        );
      }
      this.index.slack.set(seed.demuxKey, {
        agent: seed.agent,
        principal,
        stack,
        instance: `slack:${seed.demuxKey}`,
      });
      return;
    }
    // web
    const key = `web:${seed.demuxKey}`;
    if (this.index.web.has(key)) {
      throw new Error(
        `SurfaceGateway.attachAdapter: ambiguous web config — instanceId "${seed.demuxKey}" is already bound.`,
      );
    }
    this.index.web.set(key, {
      agent: seed.agent,
      principal,
      stack,
      instance: key,
    });
  }

  /** Reverse of {@link addNonMattermostSeed} — removes exactly the entry the
   *  matching attach inserted. */
  private removeNonMattermostSeed(seed: GatewayBindingSeed): void {
    if (seed.platform === "discord") {
      this.index.discord.delete(seed.demuxKey);
      return;
    }
    if (seed.platform === "slack") {
      this.index.slack.delete(seed.demuxKey);
      return;
    }
    this.index.web.delete(`web:${seed.demuxKey}`);
  }

  /**
   * Recompute the index's mattermost single/multi slot from every mattermost
   * seed CURRENTLY attached at runtime (`attachedSeeds`), mirroring
   * `buildBindingIndex`'s "exactly one binding → fallback; more than one →
   * ambiguous" rule. Deliberately does NOT consider boot-time mattermost
   * bindings separately — those are already folded into the SAME
   * `mattermostSingle`/`mattermostMulti` slot this recompute overwrites, so a
   * boot-time binding must also flow through `attachedSeeds` bookkeeping to
   * survive a later runtime attach/detach. In v1 (S8), boot never populates
   * `attachedSeeds` (only `attachAdapter` does), so this recompute is a
   * runtime-only concern until a boot-time mattermost + a runtime-attached
   * mattermost coexist — not a configuration this slice's scope produces.
   */
  private recomputeMattermostSlot(): void {
    const mmSeeds = [...this.attachedSeeds.values()]
      .flat()
      .filter((s) => s.platform === "mattermost");
    if (mmSeeds.length === 0) {
      this.index.mattermostSingle = null;
      this.index.mattermostMulti = false;
      return;
    }
    if (mmSeeds.length === 1) {
      const sole = mmSeeds[0];
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length check above guarantees index 0 exists.
      const { agent, stack, demuxKey } = sole!;
      const { principal, stack: parsedStack } = parseStack(stack);
      this.index.mattermostSingle = {
        agent,
        principal,
        stack: parsedStack,
        instance: `mattermost:${demuxKey}`,
      };
      this.index.mattermostMulti = false;
      return;
    }
    this.index.mattermostSingle = null;
    this.index.mattermostMulti = true;
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
   * cortex#1793 (S8) — checks {@link detachedInstanceIds} FIRST: inbound for
   * an instance mid-detach or already detached is dropped + logged rather
   * than routed. Otherwise the actual work is tracked in {@link inFlight} for
   * the duration of the call so {@link detachAdapter} can drain it.
   *
   * @param adapter the adapter that received the message. Used to key the
   *   detached-check and the in-flight tracking by `instanceId`.
   */
  async handleInbound(
    adapter: PlatformAdapter,
    msg: InboundMessage,
  ): Promise<void> {
    if (this.detachedInstanceIds.has(adapter.instanceId)) {
      process.stderr.write(
        `[surface-gateway] dropping inbound — instance "${adapter.instanceId}" is detached. ` +
          `platform=${msg.platform} channelId=${msg.channelId}\n`,
      );
      return;
    }
    const work = this.doHandleInbound(adapter, msg);
    let set = this.inFlight.get(adapter.instanceId);
    if (!set) {
      set = new Set();
      this.inFlight.set(adapter.instanceId, set);
    }
    set.add(work);
    try {
      await work;
    } finally {
      set.delete(work);
    }
  }

  private async doHandleInbound(
    _adapter: PlatformAdapter,
    msg: InboundMessage,
  ): Promise<void> {
    try {
      // Observability: every message that reaches the gateway is logged at
      // entry, BEFORE routing — so "message arrived but didn't route" (a binding
      // gap) is distinguishable from "no message arrived" (an adapter filter /
      // listener gap) without guessing. (Interim stdout; the proper system.*
      // bus/signal emission is the GW-observability follow-up.)
      process.stdout.write(
        `[surface-gateway] handleInbound received — platform=${msg.platform} ` +
          `instanceId=${msg.instanceId} channel=${msg.channelId} ` +
          `author=${msg.authorName} contentLen=${msg.content.length}\n`,
      );
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
 * The gateway's default `onUnroutable` breadcrumb — a `console.warn` naming the
 * dropped inbound and the reason.
 *
 * Exported (cortex#596) as the single source of truth for the breadcrumb string
 * so the composition-root's bus-emitting `onUnroutable` (see
 * `makeEmittingUnroutable` in `gateway-unroutable-emit.ts`) can PRESERVE the
 * exact stdout breadcrumb — it stays the fallback when the bus is down — while
 * ALSO emitting the structured `system.gateway.routing_decision` event. Reusing
 * this function keeps the two in lockstep instead of duplicating the format.
 *
 * `onUnroutable` must never throw; `console.warn` does not.
 */
export function defaultUnroutableWarn(
  msg: InboundMessage,
  reason: string,
): void {
  console.warn(
    `[surface-gateway] unroutable inbound message — dropping. ` +
      `platform=${msg.platform} instanceId=${msg.instanceId} ` +
      `channelId=${msg.channelId} reason="${reason}"`,
  );
}

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
