/**
 * GW.a.3b.2b — gateway adapter construction (cortex#524).
 *
 * `buildGatewayAdapters` turns the validated `Surfaces` binding map into ONE
 * {@link PlatformAdapter} per binding, ready for the {@link SurfaceGateway} to
 * own. It is the construction half of the live wiring; `start-gateway.ts`
 * orchestrates the flag check + `gw.start()`.
 *
 * ## How a binding maps to a presence + adapter
 *
 * Each `surfaces.{platform}[]` entry is `{ agent, stack?, binding }` where
 * `binding` carries the platform credentials (CFG.c — it is a permissive
 * superset of the matching `{Discord,Slack,Mattermost}PresenceSchema`; see
 * `src/common/types/surfaces.ts`). To turn a binding into a live adapter:
 *
 *   1. Re-parse `binding` through the canonical presence schema. The binding
 *      schema validated only the required credential fields; the presence
 *      schema fills defaults (`enabled`, `contextDepth`, `channels`, …) and
 *      produces the exact typed shape each adapter constructor expects. This
 *      is correct-by-construction — no casts, no hand-built presence objects
 *      that could drift from the schema.
 *   2. Derive the gateway's interim instance id `{platform}:{demuxKey}` — the
 *      SAME id `binding-resolver.ts` stamps as `GatewayBindingMatch.instance`,
 *      so the inbound demux and the outbound adapter agree on the connection
 *      key (design §3.3 / OQ4: replace with an explicit `instance` field when
 *      the schema grows one).
 *   3. Build the gateway source identity `{principal}.gateway.{instance}` — a
 *      {@link SystemEventSource} with `agent: "gateway"` (principal-locked
 *      decision 2026-06-02). This is the source stamped onto any
 *      `system.adapter.*` envelope the gateway's adapters emit.
 *   4. Hand `{ instanceId, source, binding, presence, runtime }` to the
 *      injected {@link GatewayAdapterFactory}, which constructs the concrete
 *      adapter. The factory is injected so tests CONSTRUCT (never start /
 *      connect) — no live tokens required. Production uses
 *      {@link defaultGatewayAdapterFactory}.
 *
 * ## Shadow stage (this slice)
 *
 * The constructed adapters are NOT started here — `start()` is the
 * {@link SurfaceGateway}'s job (`gw.start()`), which rebinds each adapter's
 * `onMessage` to route through the binding index into the (shadow-stage)
 * `LoggingInboundSink`. So even when the gateway runs, nothing is published to
 * the bus yet (the `BusInboundSink` flip is a later slice).
 *
 * ## Gateway principal-DM target
 *
 * The adapter infra requires a `principal: { discordId? }` (etc.) block — the
 * principal's platform id used for `notifyPrincipal`. The gateway is
 * shadow/log-only and does not DM the principal, so it passes an empty block.
 * When the live bus-publishing slice lands, the gateway's principal-DM target
 * can be threaded through `deps` if needed.
 */

import { DiscordAdapter } from "../adapters/discord";
import { SlackAdapter } from "../adapters/slack";
import { MattermostAdapter } from "../adapters/mattermost";
import type { PlatformAdapter } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import {
  DiscordPresenceSchema,
  SlackPresenceSchema,
  MattermostPresenceSchema,
  type DiscordPresence,
  type SlackPresence,
  type MattermostPresence,
  type Agent,
} from "../common/types/cortex-config";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";

// =============================================================================
// Factory seam — injected so tests construct without live connections
// =============================================================================

/** Args common to every per-platform factory call. */
interface FactoryArgsBase {
  /** Interim instance id `{platform}:{demuxKey}` (= binding-resolver match.instance). */
  instanceId: string;
  /** Gateway source identity `{principal}.gateway.{instance}`. */
  source: SystemEventSource;
  /**
   * The raw credential block from `surfaces.{platform}[].binding`. Forwarded
   * for observability / test assertions; the typed `presence` below is what
   * the adapter constructor consumes.
   */
  binding: Record<string, unknown>;
  /** Myelin runtime for `system.adapter.*` emission (may be dormant). */
  runtime: MyelinRuntime | undefined;
}

interface DiscordFactoryArgs extends FactoryArgsBase {
  presence: DiscordPresence;
}
interface SlackFactoryArgs extends FactoryArgsBase {
  presence: SlackPresence;
}
interface MattermostFactoryArgs extends FactoryArgsBase {
  presence: MattermostPresence;
}

/**
 * The injected adapter-construction seam. One builder per platform. Production
 * uses {@link defaultGatewayAdapterFactory}; tests inject a recording fake that
 * returns construct-only stubs (no platform connection).
 */
export interface GatewayAdapterFactory {
  discord(args: DiscordFactoryArgs): PlatformAdapter;
  slack(args: SlackFactoryArgs): PlatformAdapter;
  mattermost(args: MattermostFactoryArgs): PlatformAdapter;
}

/** Injected dependencies for {@link buildGatewayAdapters}. */
export interface GatewayAdapterDeps {
  /** Principal slug — first segment of the gateway source identity. */
  principal: string;
  /** Myelin runtime (may be dormant — adapters track state locally either way). */
  runtime: MyelinRuntime | undefined;
  /** Adapter-construction seam. Defaults to {@link defaultGatewayAdapterFactory}. */
  factory: GatewayAdapterFactory;
}

// =============================================================================
// Synthetic agent for gateway-owned adapters
// =============================================================================

/**
 * The gateway owns one connection per binding but is NOT a stack — it has no
 * persona file and dispatches nothing locally (inbound is rebound to the
 * gateway's sink, bypassing `dispatchHandler.handleMessage`). The adapter
 * constructor still requires an `Agent`; build a minimal synthetic one keyed
 * to the binding's `agent` id so log lines and the trust set are coherent.
 *
 * `persona` is a sentinel — the gateway never spawns a CC session through this
 * adapter, so the persona file is never read.
 */
function syntheticGatewayAgent(
  agentId: string,
  presence: Agent["presence"],
): Agent {
  return {
    id: agentId,
    displayName: agentId,
    persona: "(gateway-owned — no local dispatch)",
    trust: [],
    presence,
  };
}

// =============================================================================
// Default (production) factory — constructs the real adapters
// =============================================================================

/**
 * Production factory. Constructs the concrete platform adapters with an empty
 * principal-DM block (the gateway is shadow/log-only; see module doc). The
 * adapters are CONSTRUCTED only — `buildGatewayAdapters` does not start them.
 */
export const defaultGatewayAdapterFactory: GatewayAdapterFactory = {
  discord: ({ instanceId, source, presence, runtime }) =>
    new DiscordAdapter(syntheticGatewayAgent(source.agent, { discord: presence }), presence, {
      instanceId,
      principal: {},
      ...(runtime !== undefined && { runtime }),
      systemEventSource: source,
    }),

  slack: ({ instanceId, source, presence, runtime }) =>
    new SlackAdapter(syntheticGatewayAgent(source.agent, { slack: presence }), presence, {
      instanceId,
      principal: {},
      ...(runtime !== undefined && { runtime }),
      systemEventSource: source,
    }),

  mattermost: ({ instanceId, source, presence, runtime }) =>
    new MattermostAdapter(
      syntheticGatewayAgent(source.agent, { mattermost: presence }),
      presence,
      {
        instanceId,
        principal: {},
        ...(runtime !== undefined && { runtime }),
        systemEventSource: source,
      },
    ),
};

// =============================================================================
// buildGatewayAdapters
// =============================================================================

/** Build the gateway source identity `{principal}.gateway.{instance}`. */
function gatewaySource(principal: string, instance: string): SystemEventSource {
  return { principal, agent: "gateway", instance };
}

/**
 * Construct ONE {@link PlatformAdapter} per surface binding.
 *
 * Synchronous + construct-only: it never calls `adapter.start()` (that is the
 * {@link SurfaceGateway}'s responsibility). Returns the adapters in
 * discord→slack→mattermost order. An empty/absent `Surfaces` map yields `[]`
 * and never touches the factory.
 *
 * @throws re-throws any error from the canonical presence parse (a binding
 *   that the binding-schema admitted but the presence-schema rejects) or from
 *   an adapter constructor (e.g. Mattermost requires apiUrl + apiToken) so a
 *   misconfigured binding fails loudly at boot rather than silently dropping a
 *   connection.
 */
export function buildGatewayAdapters(
  surfaces: Surfaces,
  deps: GatewayAdapterDeps,
): PlatformAdapter[] {
  const { principal, runtime, factory } = deps;
  const adapters: PlatformAdapter[] = [];

  // ── Discord — demux key = guildId ─────────────────────────────────────────
  for (const entry of surfaces.discord ?? []) {
    const presence = DiscordPresenceSchema.parse(entry.binding);
    const instanceId = `discord:${presence.guildId}`;
    adapters.push(
      factory.discord({
        instanceId,
        source: gatewaySource(principal, instanceId),
        binding: entry.binding,
        runtime,
        presence,
      }),
    );
  }

  // ── Slack — demux key = workspaceId ───────────────────────────────────────
  for (const entry of surfaces.slack ?? []) {
    const presence = SlackPresenceSchema.parse(entry.binding);
    const instanceId = `slack:${presence.workspaceId}`;
    adapters.push(
      factory.slack({
        instanceId,
        source: gatewaySource(principal, instanceId),
        binding: entry.binding,
        runtime,
        presence,
      }),
    );
  }

  // ── Mattermost — demux key = apiUrl (single-binding fallback) ─────────────
  for (const entry of surfaces.mattermost ?? []) {
    const presence = MattermostPresenceSchema.parse(entry.binding);
    // apiUrl is optional on the presence schema but required on the binding
    // schema; the binding-resolver keys the interim instance on it too.
    const instanceId = `mattermost:${presence.apiUrl ?? "<unset>"}`;
    adapters.push(
      factory.mattermost({
        instanceId,
        source: gatewaySource(principal, instanceId),
        binding: entry.binding,
        runtime,
        presence,
      }),
    );
  }

  return adapters;
}
