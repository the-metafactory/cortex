import {
  startGatewayIfEnabled,
  type StartGatewayOpts,
} from "../start-gateway";
import { isGatewayEnabled } from "../gateway-bootstrap";
import { planSurfaceOwnership } from "../surface-ownership-plan";
import { registryFromFactory, type SurfacePluginRegistry } from "../../adapters/registry";
import { defaultGatewayAdapterFactory } from "../gateway-adapters";
import { stringBindingField } from "../../adapters/plugin-support";
import { z } from "zod/v4";
import { createHash } from "node:crypto";

/**
 * cortex#1797 (S12 MOVE) — `registryFromFactory` no longer auto-registers
 * discord/slack/mattermost stubs (no in-tree plugin descriptors left to
 * spread from any of the three — see that function's doc in
 * `adapters/registry.ts`). This test helper's whole POINT is exercising
 * `startGatewayIfEnabled`'s factory-driven construction path end-to-end
 * (`makeCountingFactory`-style fakes in `start-gateway.test.ts` /
 * `cross-principal-routing.integration.test.ts`), so it needs a registry
 * whose adapter plugins actually DELEGATE to the caller's `factory` — the
 * same shape `registryFromFactory` gave pre-extraction for every platform.
 * Builds one FRESH per call (never shared/cached) so each test's own
 * `factory` closure is the one invoked.
 */
function registryFromFactoryWithAllPlatforms(
  factory: StartGatewayOpts["factory"],
): SurfacePluginRegistry {
  const registry = registryFromFactory(factory ?? defaultGatewayAdapterFactory);
  const f = factory ?? defaultGatewayAdapterFactory;
  registry.registerAdapter({
    kind: "adapter",
    id: "discord",
    platform: "discord",
    bindingSchema: z.record(z.string(), z.unknown()),
    foldsIntoPresence: true,
    secretFields: ["token"],
    demuxKey: (binding) => stringBindingField(binding, "guildId"),
    // cortex#1797 (S12 MOVE) — Discord token-grouping (one gateway session
    // per bot token, not per guild), reproduced from the real
    // `metafactory-cortex-adapter-discord` bundle's `token-groups.ts` so
    // "same token, two guild bindings → one adapter" fixtures still collapse
    // correctly through this test-only registry.
    groupBindings: (entries) => {
      const groups = new Map<string, typeof entries[number][]>();
      for (const entry of entries) {
        const key = JSON.stringify({ token: entry.binding.token, stack: entry.stack ?? null });
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
      }
      return [...groups.values()].map((groupedEntries) => {
        const guildIds = groupedEntries.map((e) => stringBindingField(e.binding, "guildId"));
        const firstEntry = groupedEntries[0];
        const token = typeof firstEntry?.binding.token === "string" ? firstEntry.binding.token : "";
        const stack = firstEntry?.stack;
        const instanceId =
          guildIds.length === 1
            ? `discord:${guildIds[0]}`
            : `discord:token:${createHash("sha256").update(JSON.stringify({ token, stack: stack ?? null })).digest("hex").slice(0, 12)}`;
        return { entries: groupedEntries, instanceId };
      });
    },
    buildGatewayConstructArgs: (group, base) => ({
      instanceId: base.instanceId,
      source: base.source,
      binding: group.entries[0]?.binding,
      runtime: base.runtime,
    }),
    createAdapter: (args) => f.discord(args as never),
  });
  registry.registerAdapter({
    kind: "adapter",
    id: "slack",
    platform: "slack",
    bindingSchema: z.record(z.string(), z.unknown()),
    foldsIntoPresence: true,
    secretFields: ["botToken", "appToken"],
    demuxKey: (binding) => stringBindingField(binding, "workspaceId"),
    buildGatewayConstructArgs: (group, base) => ({
      instanceId: base.instanceId,
      source: base.source,
      binding: group.entries[0]?.binding,
      runtime: base.runtime,
    }),
    createAdapter: (args) => f.slack(args as never),
  });
  registry.registerAdapter({
    kind: "adapter",
    id: "mattermost",
    platform: "mattermost",
    bindingSchema: z.record(z.string(), z.unknown()),
    foldsIntoPresence: true,
    secretFields: ["apiToken"],
    demuxKey: (binding) => stringBindingField(binding, "apiUrl", "<unset>"),
    buildGatewayConstructArgs: (group, base) => ({
      instanceId: base.instanceId,
      source: base.source,
      binding: group.entries[0]?.binding,
      runtime: base.runtime,
    }),
    createAdapter: (args) => f.mattermost(args as never),
  });
  return registry;
}

export function startGatewayWithPlan(
  opts: Omit<StartGatewayOpts, "ownershipPlan">,
): ReturnType<typeof startGatewayIfEnabled> {
  const registry = opts.registry ?? registryFromFactoryWithAllPlatforms(opts.factory);
  return startGatewayIfEnabled({
    ...opts,
    registry,
    ownershipPlan: planSurfaceOwnership({
      surfaces: opts.surfaces,
      gatewayEnabled: isGatewayEnabled(opts.env),
      principal: opts.principal,
      // cortex#1951 — same registry `startGatewayIfEnabled` itself resolves
      // above, so the ownership plan's Gateway adapter instance ids never
      // drift from what gets constructed.
      registry,
    }),
  });
}
