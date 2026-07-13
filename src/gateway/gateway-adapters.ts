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

import type { PlatformAdapter } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import type {
  DiscordPresence,
  SlackPresence,
  MattermostPresence,
  Agent,
} from "../common/types/cortex-config";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../common/policy";
import type { AdapterPolicyPort } from "../surface-sdk";
import { assertNoUnresolvedPlaceholder } from "../common/config/resolve-env-placeholders";
import type {
  BindingGroup,
  SurfaceBindingEntry,
  SurfacePluginRegistry,
} from "../adapters/registry";
import { buildAdapterPolicyPort, buildAdapterSystemEventPort } from "../adapters/plugin-support";
import { formatEnvelopeAsMarkdown } from "../adapters/envelope-renderer";
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
  /**
   * cortex#1796 (S11, ADR-0024 D5 extraction lane) — the host-bound
   * `AdapterPolicyPort` (mirrors `GatewayConstructBase.policy`,
   * cortex#1794 S9b). cortex#1797 (S12) — discord's plugin now reads this
   * field too (its dependency-inversion is complete, same as
   * mattermost/slack); all four extracted adapters read `policy` instead of
   * the raw triad above. The raw triad fields stay on this interface only
   * for `buildAdapterPolicyPort`'s inputs at the call site
   * (`surface-adapter-boot.ts`'s `baseFactoryArgs`) — no plugin body reads
   * them directly any more.
   */
  policy?: AdapterPolicyPort;
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

/**
 * The injected adapter-construction seam. One builder per platform. Production
 * uses {@link defaultGatewayAdapterFactory}; tests inject a recording fake that
 * returns construct-only stubs (no platform connection).
 *
 * cortex#1794 (S9 MOVE) — `web` (C-110, generic web/SSE surface adapter) is
 * NOT a method here any more. It extracted to the `metafactory-cortex-adapter-web`
 * bundle (ADR-0024 D2 — no in-tree fallback) and is now constructed via the
 * registry path only (`plugin.createAdapter(args)` inside `buildGatewayAdapters`'s
 * generic `registry.listAdapters()` loop below), never through this fixed
 * per-platform factory interface. A caller still using the pre-registry
 * `{factory}` seam (`registryFromFactory`) simply never gets a `web` adapter
 * — pass `{registry}` (which threads in whatever `loadExternalPlugins`
 * registered) to get one.
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
  /**
   * cortex#1788 (S3, ADR-0024 D5) — the `(kind, id)`-keyed adapter/renderer
   * registry. Replaces the pre-registry `factory: GatewayAdapterFactory`
   * field: `buildGatewayAdapters` no longer hardcodes 4 platform methods, it
   * iterates `registry.listAdapters()`. Production passes
   * `createDefaultSurfacePluginRegistry()` (`src/adapters/registry.ts`);
   * tests build one from a recording fake via `registryFromFactory`.
   */
  registry: SurfacePluginRegistry;
}

// =============================================================================
// Legacy back-compat shim — `defaultGatewayAdapterFactory`
// =============================================================================

/**
 * cortex#1788 (S3) — pre-registry construction seam, RETAINED so existing
 * imports (`start-gateway.ts`, `surface-adapter-boot.ts`, and their tests'
 * recording/counting fakes) keep resolving. The actual construction logic
 * moved verbatim into each platform's `AdapterPlugin.createAdapter` — `web`,
 * `slack`, `mattermost`, and `discord` all moved out-of-tree entirely
 * (cortex#1794 S9 / cortex#1795 S10 / cortex#1796 S11 / cortex#1797 S12
 * MOVE) — this object is now a thin delegating shim, not the source of
 * truth. New code should thread a {@link SurfacePluginRegistry}
 * (`createDefaultSurfacePluginRegistry`) instead of this factory.
 *
 * cortex#1795 (S10 MOVE) — `slack` keeps its method here (unlike `web`,
 * which dropped out of {@link GatewayAdapterFactory} entirely — see that
 * interface's doc): `wireSurfaceAdapters`'s per-stack boot lane
 * (`surface-adapter-boot.ts`) still calls `factory.slack(...)` on whichever
 * factory a ternary produces, and that ternary's OTHER branch
 * (`registryToLegacyFactory`, `adapters/registry.ts`) still has a real
 * `slack` method — removing it here would make the union type-check fail on
 * that call site for no behavioural gain. Production never actually reaches
 * THIS implementation, though: `cortex.ts` always threads `registry` (which
 * routes through `registryToLegacyFactory` instead, itself fully
 * registry-driven — no in-tree import). This synchronous shim genuinely
 * cannot construct a real Slack adapter any more (there is no in-tree
 * `slackAdapterPlugin` to delegate to, and dynamic-import is async) — it
 * throws a loud, actionable error instead of silently misbehaving. No
 * production or test call site is known to reach this branch (verified: no
 * test imports `defaultGatewayAdapterFactory` directly, and every
 * `wireSurfaceAdapters`/`startGatewayIfEnabled` call site supplies an
 * explicit `factory` or `registry`).
 *
 * cortex#1796 (S11 MOVE) — `mattermost` below throws for the SAME reason:
 * there is no more in-tree `mattermostAdapterPlugin` to delegate to. This is
 * genuinely unreachable in production — `wireSurfaceAdapters`
 * (`src/runner/surface-adapter-boot.ts`) always receives `opts.registry`
 * from `cortex.ts` and resolves mattermost via {@link registryToLegacyFactory}
 * instead (a pure runtime registry lookup), never falling through to this
 * default. Only a caller that supplies NEITHER `factory` NOR `registry`
 * would ever hit this arm — kept as a loud, actionable error instead of a
 * silent `undefined` crash so that caller finds out immediately what to fix.
 *
 * cortex#1797 (S12 MOVE) — `discord` below throws for the SAME reason: no
 * in-tree `discordAdapterPlugin` left to delegate to (the FOURTH and FINAL
 * in-tree adapter to extract). Same unreachable-in-production guarantee —
 * `wireSurfaceAdapters` always receives `opts.registry` and resolves
 * discord via {@link registryToLegacyFactory}'s pure runtime lookup.
 */
export const defaultGatewayAdapterFactory: GatewayAdapterFactory = {
  discord: () => {
    throw new Error(
      "defaultGatewayAdapterFactory.discord: discord extracted out-of-tree " +
        "(metafactory-cortex-adapter-discord, cortex#1797 S12 MOVE) — pass `registry` " +
        "(threaded from loadExternalPlugins) instead of the bare factory.",
    );
  },
  slack: () => {
    throw new Error(
      "defaultGatewayAdapterFactory.slack: unreachable in production — cortex#1795 (S10 MOVE) " +
        "extracted the Slack adapter to the metafactory-cortex-adapter-slack bundle; this legacy " +
        "synchronous factory has no in-tree implementation to delegate to. Pass a `registry` " +
        "(createDefaultSurfacePluginRegistry(), post-loadExternalPlugins) instead of relying on " +
        "this factory's default.",
    );
  },
  mattermost: () => {
    throw new Error(
      "defaultGatewayAdapterFactory.mattermost: mattermost extracted out-of-tree " +
        "(metafactory-cortex-adapter-mattermost, cortex#1796 S11 MOVE) — pass `registry` " +
        "(threaded from loadExternalPlugins) instead of the bare factory.",
    );
  },
};

// =============================================================================
// buildGatewayAdapters
// =============================================================================

/** Build the gateway source identity `{principal}.gateway.{instance}`. */
function gatewaySource(principal: string, instance: string): SystemEventSource {
  return { principal, agent: "gateway", instance };
}

/**
 * cortex#1788 (S3, ADR-0024 D5 / design-pluggable-adapters.md §3.3) — ONE
 * generic loop over `deps.registry.listAdapters()`, replacing the four
 * near-identical per-platform loops this function used to hardcode. No
 * platform-specific branching survives here: grouping (Discord's token
 * grouping), demuxing, and the secret-placeholder guard are all plugin-owned
 * (`AdapterPlugin.groupBindings` / `.demuxKey` / `.secretFields`).
 *
 * Construct ONE {@link PlatformAdapter} per surface binding.
 *
 * Synchronous + construct-only: it never calls `adapter.start()` (that is the
 * {@link SurfaceGateway}'s responsibility). Returns the adapters in the
 * registry's platform order (discord→slack→mattermost, matching the
 * pre-registry fixed order — `createDefaultSurfacePluginRegistry` registers
 * in that sequence — plus any loaded external/first-party adapter, e.g. `web`
 * once `loadExternalPlugins` registers it, appended after). An empty/absent
 * `Surfaces` map yields `[]` and never touches a plugin's `createAdapter`.
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
  const { principal, runtime, registry } = deps;
  const adapters: PlatformAdapter[] = [];
  const surfacesByPlatform = surfaces as unknown as Record<string, SurfaceBindingEntry[] | undefined>;
  // cortex#1794 (S9b) — the gateway path is shadow/log-only (see this
  // function's own doc + `cortex.ts`'s module doc): it never has a live
  // `PolicyEngine`/index/registry in hand for ANY platform, gateway-owned or
  // not. Built ONCE (stateless closures over an all-undefined triad) and
  // forwarded generically via `GatewayConstructBase.policy` — today only the
  // web plugin reads it (`buildAdapterPolicyPort()` reproduces EXACTLY the
  // `denyCode: "no_policy"` / `isOperatorPrincipal === false` behaviour a
  // direct call with no engine always gave pre-S9b).
  const policy = buildAdapterPolicyPort();

  for (const plugin of registry.listAdapters()) {
    // `Object.hasOwn` guard: a bundle-loaded plugin's `platform` is an
    // untrusted (if manifest-validated) string. The id regex permits
    // reserved property names (`constructor`, `toString`, …), so a bare
    // `surfacesByPlatform[plugin.platform]` could resolve up the prototype
    // chain to e.g. `Object` and crash the gateway build. Only own,
    // enumerable surface keys are real bindings. (#1792 final adversarial pass.)
    const bindings = Object.hasOwn(surfacesByPlatform, plugin.platform)
      ? surfacesByPlatform[plugin.platform] ?? []
      : [];
    if (bindings.length === 0) continue;

    const groups: BindingGroup[] = plugin.groupBindings
      ? plugin.groupBindings(bindings)
      : bindings.map((entry) => ({
          entries: [entry],
          instanceId: `${plugin.platform}:${plugin.demuxKey(entry.binding)}`,
        }));

    for (const group of groups) {
      const firstEntry = group.entries[0];
      if (!firstEntry) continue;

      // cortex#1209 belt-and-suspenders — a resolved binding can never carry
      // a literal `__X__` token; fail-fast if one slipped past the
      // load-time resolver before it reaches the platform's `connect()`.
      // Checked against every entry in the group (matches the pre-registry
      // Discord loop, which checked every grouped presence, not just the
      // first) — the RAW binding value, equivalent to the parsed presence's
      // value since schema parsing never rewrites a required string field.
      for (const field of plugin.secretFields) {
        for (const entry of group.entries) {
          assertNoUnresolvedPlaceholder(entry.binding[field], `surfaces.${plugin.platform}[].binding.${field}`);
        }
      }

      const source = gatewaySource(principal, group.instanceId);
      // cortex#1795 (S10) — the shadow gateway's system-event port, built
      // per-instance (unlike `policy`, invariant across instances) since it
      // closes over this group's own `source`. Reproduces the pre-S10
      // `SlackAdapter.canPublishSystemEvent()` gate exactly — see
      // `buildAdapterSystemEventPort`'s doc.
      const systemEvents = buildAdapterSystemEventPort({ runtime, source });
      const args = plugin.buildGatewayConstructArgs(group, {
        instanceId: group.instanceId,
        source,
        runtime,
        policy,
        systemEvents,
        formatEnvelope: formatEnvelopeAsMarkdown,
      });
      adapters.push(plugin.createAdapter(args));
    }
  }

  return adapters;
}
