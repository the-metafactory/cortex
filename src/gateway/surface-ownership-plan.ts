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
  crossPrincipalBindings,
  distinctBoundPrincipalStacks,
  distinctBoundStacks,
  type BoundPrincipalStack,
} from "./binding-resolver";
import { groupDiscordBindingsByToken } from "./discord-token-groups";

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

function gatewayInstanceIds(surfaces: Surfaces | undefined): string[] {
  const ids: string[] = [];
  if (surfaces === undefined) return ids;
  for (const group of groupDiscordBindingsByToken(surfaces.discord ?? [])) {
    ids.push(group.instanceId);
  }
  for (const entry of surfaces.slack ?? []) {
    ids.push(`slack:${entry.binding.workspaceId}`);
  }
  for (const entry of surfaces.mattermost ?? []) {
    ids.push(`mattermost:${entry.binding.apiUrl}`);
  }
  for (const entry of surfaces.web ?? []) {
    ids.push(`web:${entry.binding.instanceId}`);
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

  return {
    gatewayEnabled: true,
    hasSurfaceBindings,
    gatewayStartEligible: true,
    ownedSurfaceKeys: ownedKeys(opts.surfaces),
    gatewayAdapterInstanceIds: gatewayInstanceIds(opts.surfaces),
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
