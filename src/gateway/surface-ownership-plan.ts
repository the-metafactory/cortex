/**
 * Surface ownership planning for the shared Gateway.
 *
 * The Gateway owns surface bindings from `surfaces.yaml`; the per-stack
 * adapter loops own folded `agents[].presence`. Because a Gateway-owned binding
 * is also folded into stack presence, runtime boot needs one pure plan that
 * says which per-stack adapters yield, which Gateway adapter instance ids must
 * stay disjoint, and which stack subjects the Gateway dispatch sink subscribes
 * to.
 */

import type { PlatformAdapter } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import {
  createDefaultSurfacePluginRegistry,
  resolveAdapterPluginOrThrow,
  type SurfacePluginRegistry,
} from "../adapters/registry";
import {
  crossPrincipalBindings,
  distinctBoundPrincipalStacks,
  distinctBoundStacks,
  type BoundPrincipalStack,
} from "./binding-resolver";

export interface SurfaceOwnershipPlan {
  /** True when `CORTEX_GATEWAY` selected the Gateway path. */
  gatewayEnabled: boolean;
  /** True when the composed `Surfaces` map has at least one binding. */
  hasSurfaceBindings: boolean;
  /** True when boot should attempt to construct and start the Gateway. */
  gatewayStartEligible: boolean;
  /** `{platform}:{agentId}` keys that per-stack adapter loops must yield. */
  ownedSurfaceKeys: ReadonlySet<string>;
  /** Expected Gateway adapter instance ids, derived from surface demux keys. */
  gatewayAdapterInstanceIds: readonly string[];
  /**
   * Legacy distinct stack leaves for single-principal dispatch sink callers.
   * `undefined` is the stackless binding bucket.
   */
  outboundStacks: readonly (string | undefined)[];
  /** Distinct `(principal, stack)` pairs for Gateway dispatch sink subjects. */
  outboundPrincipalStacks: readonly BoundPrincipalStack[];
  /** Raw `stack` values whose principal differs from the Gateway principal. */
  crossPrincipalBindings: readonly string[];
}

export interface SurfaceOwnershipPlanOpts {
  surfaces: Surfaces | undefined;
  gatewayEnabled: boolean;
  principal: string;
  /**
   * cortex#1951 — the `(kind, id)`-keyed plugin registry `gatewayInstanceIds`
   * derives each platform's demux key from (`plugin.demuxKey(binding)`)
   * instead of a hardcoded field read. Defaults to
   * {@link createDefaultSurfacePluginRegistry} (in-tree discord/mattermost
   * only — cortex#1795 S10 MOVE dropped slack from the in-tree default, same
   * as web before it) when omitted — a back-compat/test convenience;
   * production boot always threads its own composed registry explicitly.
   */
  registry?: SurfacePluginRegistry;
}

function countSurfaceBindings(surfaces: Surfaces | undefined): number {
  if (surfaces === undefined) return 0;
  return (
    (surfaces.discord?.length ?? 0) +
    (surfaces.slack?.length ?? 0) +
    (surfaces.mattermost?.length ?? 0) +
    (surfaces.web?.length ?? 0)
  );
}

function ownedKeys(surfaces: Surfaces | undefined): Set<string> {
  const keys = new Set<string>();
  if (surfaces === undefined) return keys;
  for (const entry of surfaces.discord ?? []) keys.add(`discord:${entry.agent}`);
  for (const entry of surfaces.slack ?? []) keys.add(`slack:${entry.agent}`);
  for (const entry of surfaces.mattermost ?? []) keys.add(`mattermost:${entry.agent}`);
  for (const entry of surfaces.web ?? []) keys.add(`web:${entry.agent}`);
  return keys;
}

/**
 * cortex#1951 — registry-driven Gateway adapter instance ids. Each platform's
 * id is derived via `registry.getAdapter(platform)` instead of a hardcoded
 * field read, so no gateway code knows any platform's binding shape.
 *
 * Discord is the one platform with non-default grouping: bindings are
 * token-keyed (one gateway session per bot token — Discord delivers every
 * guild event for a token over ONE gateway connection), so its ids come from
 * `discordPlugin.groupBindings` — the SAME token-grouping rule
 * `buildGatewayAdapters` uses to construct the live adapters, byte-identical
 * to calling `groupDiscordBindingsByToken` directly (that's exactly what the
 * plugin's `groupBindings` does under the hood). Slack/Mattermost/Web have no
 * grouping — one instance id per binding, `${platform}:${demuxKey}`.
 */
function gatewayInstanceIds(
  surfaces: Surfaces | undefined,
  registry: SurfacePluginRegistry,
): string[] {
  const ids: string[] = [];
  if (surfaces === undefined) return ids;

  const discordEntries = surfaces.discord ?? [];
  if (discordEntries.length > 0) {
    const discordPlugin = resolveAdapterPluginOrThrow("discord", registry);
    const groups = discordPlugin.groupBindings
      ? discordPlugin.groupBindings(discordEntries)
      : discordEntries.map((entry) => ({
          entries: [entry],
          instanceId: `discord:${discordPlugin.demuxKey(entry.binding)}`,
        }));
    for (const group of groups) {
      ids.push(group.instanceId);
    }
  }

  const slackEntries = surfaces.slack ?? [];
  if (slackEntries.length > 0) {
    const slackPlugin = resolveAdapterPluginOrThrow("slack", registry);
    for (const entry of slackEntries) {
      ids.push(`slack:${slackPlugin.demuxKey(entry.binding)}`);
    }
  }

  const mattermostEntries = surfaces.mattermost ?? [];
  if (mattermostEntries.length > 0) {
    const mattermostPlugin = resolveAdapterPluginOrThrow("mattermost", registry);
    for (const entry of mattermostEntries) {
      ids.push(`mattermost:${mattermostPlugin.demuxKey(entry.binding)}`);
    }
  }

  const webEntries = surfaces.web ?? [];
  if (webEntries.length > 0) {
    const webPlugin = resolveAdapterPluginOrThrow("web", registry);
    for (const entry of webEntries) {
      ids.push(`web:${webPlugin.demuxKey(entry.binding)}`);
    }
  }

  return ids;
}

function emptyPlan(
  opts: SurfaceOwnershipPlanOpts,
  hasSurfaceBindings: boolean,
): SurfaceOwnershipPlan {
  return {
    gatewayEnabled: opts.gatewayEnabled,
    hasSurfaceBindings,
    gatewayStartEligible: false,
    ownedSurfaceKeys: new Set(),
    gatewayAdapterInstanceIds: [],
    outboundStacks: [],
    outboundPrincipalStacks: [],
    crossPrincipalBindings: [],
  };
}

/**
 * Build the Gateway ownership plan from composed surfaces and the Gateway flag.
 *
 * Flag off always yields an inactive plan: no per-stack suppression, no Gateway
 * adapter ids, and no outbound subject pairs. This is the byte-identical
 * flag-off safety contract.
 */
export function planSurfaceOwnership(
  opts: SurfaceOwnershipPlanOpts,
): SurfaceOwnershipPlan {
  const hasSurfaceBindings = countSurfaceBindings(opts.surfaces) > 0;
  if (!opts.gatewayEnabled || opts.surfaces === undefined || !hasSurfaceBindings) {
    return emptyPlan(opts, hasSurfaceBindings);
  }

  const registry = opts.registry ?? createDefaultSurfacePluginRegistry();

  return {
    gatewayEnabled: true,
    hasSurfaceBindings,
    gatewayStartEligible: true,
    ownedSurfaceKeys: ownedKeys(opts.surfaces),
    gatewayAdapterInstanceIds: gatewayInstanceIds(opts.surfaces, registry),
    outboundStacks: distinctBoundStacks(opts.surfaces),
    outboundPrincipalStacks: distinctBoundPrincipalStacks(
      opts.surfaces,
      opts.principal,
    ),
    crossPrincipalBindings: crossPrincipalBindings(opts.surfaces, opts.principal),
  };
}

/**
 * Compatibility helper for existing per-stack loops and tests.
 *
 * Prefer `planSurfaceOwnership` when the caller also needs Gateway adapter ids
 * or outbound stack pairs.
 */
export function gatewayOwnedSurfaceKeys(
  surfaces: Surfaces | undefined,
  enabled: boolean,
): Set<string> {
  if (!enabled) return new Set();
  return ownedKeys(surfaces);
}

/**
 * Return Gateway adapter instance ids that collide with already-started
 * per-stack adapters. Runtime boot throws on a non-empty result.
 */
export function gatewayAdapterInstanceCollisions(
  perStackAdapters: readonly Pick<PlatformAdapter, "instanceId">[],
  gatewayAdapters: readonly Pick<PlatformAdapter, "instanceId">[],
): string[] {
  const perStackInstances = new Set(perStackAdapters.map((a) => a.instanceId));
  return gatewayAdapters
    .map((a) => a.instanceId)
    .filter((id) => perStackInstances.has(id));
}
