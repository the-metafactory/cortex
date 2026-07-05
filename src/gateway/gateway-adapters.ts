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
 *
 * ## S9 (cortex#1523) — a second caller
 *
 * `wireSurfaceAdapters` (`./wire-surface-adapters.ts`) is the per-stack boot
 * path's construction — the direct-connect adapters `startCortex` runs
 * against a stack's own `agents[].presence.*`, as opposed to this file's
 * shared-surface-gateway construction. It calls the SAME
 * `GatewayAdapterFactory.discord/mattermost/slack()` functions so exactly one
 * module (`defaultGatewayAdapterFactory`) knows how to build a
 * `new DiscordAdapter` / `new MattermostAdapter` / `new SlackAdapter`. The
 * per-platform `*FactoryArgs` grew optional fields (`agent`, `principal`,
 * the policy triad, `trustedBotIds`, `surfaceSubjects`,
 * `surfaceFallbackChannelId`) so that caller can supply what the gateway
 * never needed — every addition is optional and the gateway's own call sites
 * (`buildGatewayAdapters`) are unchanged. `source` loosened from required to
 * optional for the same reason: the per-stack path omits it for Mattermost,
 * mirroring that platform's pre-existing (no `systemEventSource` wiring)
 * inline construction.
 */

import { DiscordAdapter } from "../adapters/discord";
import { SlackAdapter } from "../adapters/slack";
import { MattermostAdapter } from "../adapters/mattermost";
import { WebAdapter } from "../adapters/web";
import type { PlatformAdapter } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import type { WebBinding } from "../common/types/surfaces";
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
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../common/policy";
import { assertNoUnresolvedPlaceholder } from "../common/config/resolve-env-placeholders";
import { groupDiscordBindingsByToken } from "./discord-token-groups";
// Back-compat re-export for callers that still import the old suppression helper here.
export { gatewayOwnedSurfaceKeys } from "./surface-ownership-plan";

// =============================================================================
// Factory seam — injected so tests construct without live connections
// =============================================================================

/** Args common to every per-platform factory call. */
interface FactoryArgsBase {
  /** Interim instance id `{platform}:{demuxKey}` (= binding-resolver match.instance). */
  instanceId: string;
  /**
   * Gateway source identity `{principal}.gateway.{instance}`. Optional —
   * S9 (cortex#1523) lets the per-stack boot path (`wireSurfaceAdapters`)
   * omit it for a platform whose inline construction historically never
   * wired `systemEventSource` onto the adapter (today that's Mattermost
   * only — see `MattermostAdapterInfra.runtime`'s doc: "today's
   * resolveAccess path doesn't publish"). Forwarded to the constructed
   * adapter's `infra.systemEventSource` ONLY when defined; gateway callers
   * always supply one, so gateway behaviour is unchanged.
   */
  source: SystemEventSource | undefined;
  /**
   * The raw credential block from `surfaces.{platform}[].binding`. Forwarded
   * for observability / test assertions; the typed `presence` below is what
   * the adapter constructor consumes.
   */
  binding: Record<string, unknown>;
  /** Myelin runtime for `system.adapter.*` emission (may be dormant). */
  runtime: MyelinRuntime | undefined;
  /**
   * S9 (cortex#1523) — the real `Agent` to construct the adapter with.
   * Optional: the gateway omits this (shadow/log-only; every gateway-owned
   * adapter uses the synthetic {@link syntheticGatewayAgent} placeholder).
   * The per-stack boot path always supplies the config-matched (or
   * deferred-fallback) `Agent` so the constructed adapter carries the real
   * persona/trust list instead of the gateway's placeholder.
   */
  agent?: Agent;
  /**
   * S9 (cortex#1523) — principal's platform identity block, forwarded
   * verbatim to the constructed adapter's `infra.principal`. Defaults to
   * `{}` (the gateway's shadow/log-only shape) when omitted.
   */
  principal?: Record<string, unknown>;
  /**
   * S9 (cortex#1523) — v2.0.0 (cortex#297) policy triad. The gateway omits
   * these (shadow/log-only, never dispatches inbound); the per-stack boot
   * path supplies the deployment's resolved policy engine/lookup/registry
   * (shared verbatim across all three platforms — see `cortex.ts`'s
   * `adapterPolicyEngine` comment).
   */
  policyEngine?: PolicyEngine;
  policyLookup?: PlatformPrincipalIndex;
  policyRegistry?: PrincipalRegistry;
}

interface DiscordFactoryArgs extends FactoryArgsBase {
  presence: DiscordPresence;
  /** Discord guild ids accepted by this gateway-owned token connection. */
  allowedGuildIds: ReadonlySet<string>;
  /** Per-guild presence config for grouped token connections. */
  presenceByGuildId: ReadonlyMap<string, DiscordPresence>;
  /**
   * S9 (cortex#1523) — cortex#84 cross-process bridge allowlist. The gateway
   * omits this (shadow/log-only, doesn't dispatch inbound); the per-stack
   * boot path supplies the config-declared set (merged with in-process peers
   * in its own Pass 2, same as pre-extraction).
   */
  trustedBotIds?: ReadonlySet<string>;
  /** S9 (cortex#1523) — MIG-3b surface-router fields; gateway omits both. */
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}
interface SlackFactoryArgs extends FactoryArgsBase {
  presence: SlackPresence;
  /** S9 (cortex#1523) — see {@link DiscordFactoryArgs.trustedBotIds}. */
  trustedBotIds?: ReadonlySet<string>;
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}
interface MattermostFactoryArgs extends FactoryArgsBase {
  presence: MattermostPresence;
}

/** Args for the web factory call. `binding` carries the typed WebBinding. */
interface WebFactoryArgs extends FactoryArgsBase {
  /** Typed web binding (port, broadcastUrl, transport, authScheme). */
  webBinding: WebBinding;
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
  /** C-110: Generic web/SSE surface adapter. */
  web(args: WebFactoryArgs): PlatformAdapter;
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

/**
 * S9 (cortex#1523) — resolve the `Agent` a factory call constructs the
 * adapter with. `args.agent` (the per-stack boot path always supplies it)
 * wins; the gateway never supplies `agent`, so it falls through to the
 * synthetic gateway-owned placeholder keyed off `args.source`. Throws if
 * NEITHER is present — a caller must supply one or the other so the
 * constructed adapter always has a real identity.
 */
function resolveFactoryAgent(
  args: Pick<FactoryArgsBase, "agent" | "source">,
  presence: Agent["presence"],
): Agent {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "GatewayAdapterFactory: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return syntheticGatewayAgent(args.source.agent, presence);
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
  discord: (args) => {
    const {
      instanceId, source, presence, runtime, allowedGuildIds, presenceByGuildId,
      principal, policyEngine, policyLookup, policyRegistry,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = args;
    return new DiscordAdapter(
      resolveFactoryAgent(args, { discord: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
        allowedGuildIds,
        presenceByGuildId,
        ...(trustedBotIds !== undefined && { trustedBotIds }),
        ...(policyEngine !== undefined && { policyEngine }),
        ...(policyLookup !== undefined && { policyLookup }),
        ...(policyRegistry !== undefined && { policyRegistry }),
        ...(surfaceSubjects !== undefined && { surfaceSubjects }),
        ...(surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId }),
      },
    );
  },

  slack: (args) => {
    const {
      instanceId, source, presence, runtime,
      principal, policyEngine, policyLookup, policyRegistry,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = args;
    return new SlackAdapter(
      resolveFactoryAgent(args, { slack: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
        ...(trustedBotIds !== undefined && { trustedBotIds }),
        ...(policyEngine !== undefined && { policyEngine }),
        ...(policyLookup !== undefined && { policyLookup }),
        ...(policyRegistry !== undefined && { policyRegistry }),
        ...(surfaceSubjects !== undefined && { surfaceSubjects }),
        ...(surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId }),
      },
    );
  },

  mattermost: (args) => {
    const { instanceId, source, presence, runtime, principal, policyEngine, policyLookup, policyRegistry } = args;
    return new MattermostAdapter(
      resolveFactoryAgent(args, { mattermost: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
        ...(policyEngine !== undefined && { policyEngine }),
        ...(policyLookup !== undefined && { policyLookup }),
        ...(policyRegistry !== undefined && { policyRegistry }),
      },
    );
  },

  /**
   * C-110: Generic web/SSE surface adapter. No presence schema re-parse
   * needed — the WebBinding carries everything the adapter needs directly.
   * No reconnect credentials to guard (no bot token); the binding's
   * `broadcastUrl` is already validated by `WebBindingSchema`.
   */
  web: (args) =>
    new WebAdapter(
      resolveFactoryAgent(args, {}),
      args.webBinding,
      {
        instanceId: args.instanceId,
        principal: {},
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

  // ── Discord — one gateway connection per bot token ────────────────────────
  //
  // Discord delivers every guild event for a bot token over that token's one
  // gateway session. Surface routing remains guild-keyed, but the platform
  // connection is token-keyed so one assistant can serve multiple guilds
  // without opening duplicate sessions for the same bot identity.
  for (const group of groupDiscordBindingsByToken(surfaces.discord ?? [])) {
    const presences = group.entries.map((entry) => DiscordPresenceSchema.parse(entry.binding));
    const presence = presences[0];
    const firstBinding = group.entries[0]?.binding;
    if (!presence || !firstBinding) continue;
    // cortex#1209 belt-and-suspenders — a resolved binding can never carry a
    // literal `__X__` token; fail-fast if one slipped past the load-time
    // resolver before it reaches Discord `connect()`.
    for (const p of presences) {
      assertNoUnresolvedPlaceholder(p.token, "surfaces.discord[].binding.token");
    }
    const presenceByGuildId = new Map(presences.map((p) => [p.guildId, p] as const));
    const allowedGuildIds = new Set(presenceByGuildId.keys());
    adapters.push(
      factory.discord({
        instanceId: group.instanceId,
        source: gatewaySource(principal, group.instanceId),
        binding: firstBinding,
        runtime,
        presence,
        allowedGuildIds,
        presenceByGuildId,
      }),
    );
  }

  // ── Slack — demux key = workspaceId ───────────────────────────────────────
  for (const entry of surfaces.slack ?? []) {
    const presence = SlackPresenceSchema.parse(entry.binding);
    assertNoUnresolvedPlaceholder(presence.botToken, "surfaces.slack[].binding.botToken");
    assertNoUnresolvedPlaceholder(presence.appToken, "surfaces.slack[].binding.appToken");
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
    assertNoUnresolvedPlaceholder(presence.apiToken, "surfaces.mattermost[].binding.apiToken");
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

  // ── Web/SSE — demux key = binding.instanceId ──────────────────────────────
  //
  // C-110: generic web/SSE surface. No presence schema re-parse (the
  // WebBinding already carries all runtime fields via WebBindingSchema). The
  // instanceId is `web:{binding.instanceId}` — the tenant slug the binding
  // declares. Unlike Discord (token-keyed) or Slack/Mattermost (URL-keyed),
  // the web binding carries an explicit `instanceId` so multi-tenant
  // deployments can give each surface a stable, configured name.
  //
  // No placeholder guard: the web binding carries no secrets (broadcastUrl
  // is a non-secret endpoint; auth is CF Access at the edge, not a bot token).
  for (const entry of surfaces.web ?? []) {
    const webBinding: WebBinding = entry.binding;
    const instanceId = `web:${webBinding.instanceId}`;
    adapters.push(
      factory.web({
        instanceId,
        source: gatewaySource(principal, instanceId),
        binding: entry.binding,
        runtime,
        webBinding,
      }),
    );
  }

  return adapters;
}
