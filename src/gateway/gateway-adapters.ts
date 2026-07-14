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
 *   4. Hand the plugin-built construct args to the matching
 *      {@link AdapterPlugin}'s `createAdapter`, which constructs the concrete
 *      adapter. Construction is registry-driven so tests CONSTRUCT (never
 *      start / connect) — no live tokens required. Production passes the
 *      composed {@link SurfacePluginRegistry} (`createDefaultSurfacePluginRegistry`
 *      after `loadExternalPlugins`).
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
 * `wireSurfaceAdapters` (`../runner/surface-adapter-boot.ts`) is the per-stack
 * boot path's construction — the direct-connect adapters `startCortex` runs
 * against a stack's own `agents[].presence.*`, as opposed to this file's
 * shared-surface-gateway construction. It resolves each platform's
 * {@link AdapterPlugin} from the SAME {@link SurfacePluginRegistry} and calls
 * its `createAdapter`, so exactly one module (the bundle-loaded plugin) knows
 * how to build a `new DiscordAdapter` / `new MattermostAdapter` /
 * `new SlackAdapter`. That caller hand-builds richer construct args (`agent`,
 * `principal`, the policy port, `trustedBotIds`, `surfaceSubjects`,
 * `surfaceFallbackChannelId`) the gateway never needs; the gateway's own call
 * sites (`buildGatewayAdapters`) supply only what they use. `source` is
 * optional on the construct args for the same reason: the per-stack path omits
 * it for Mattermost, mirroring that platform's pre-existing (no
 * `systemEventSource` wiring) inline construction.
 */

import type { PlatformAdapter } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
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

/** Injected dependencies for {@link buildGatewayAdapters}. */
export interface GatewayAdapterDeps {
  /** Principal slug — first segment of the gateway source identity. */
  principal: string;
  /** Myelin runtime (may be dormant — adapters track state locally either way). */
  runtime: MyelinRuntime | undefined;
  /**
   * cortex#1788 (S3, ADR-0024 D5) — the `(kind, id)`-keyed adapter/renderer
   * registry. `buildGatewayAdapters` does not hardcode platform methods; it
   * iterates `registry.listAdapters()`. Production passes
   * `createDefaultSurfacePluginRegistry()` (`src/adapters/registry.ts`) after
   * `loadExternalPlugins` has registered the bundle-loaded adapters; tests
   * build one and register recording `AdapterPlugin` stubs directly.
   */
  registry: SurfacePluginRegistry;
}

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
