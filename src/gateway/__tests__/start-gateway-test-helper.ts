import {
  startGatewayIfEnabled,
  type StartGatewayOpts,
} from "../start-gateway";
import { isGatewayEnabled } from "../gateway-bootstrap";
import { planSurfaceOwnership } from "../surface-ownership-plan";
import { SurfacePluginRegistry } from "../../adapters/registry";
import { stringBindingField } from "../../adapters/plugin-support";
import type { PlatformAdapter } from "../../adapters/types";
import { z } from "zod/v4";
import { createHash } from "node:crypto";

/**
 * cortex#1896 — the recording-fake shape these gateway tests build. The
 * per-platform closures only ever read `instanceId` off the construct args a
 * plugin's `buildGatewayConstructArgs` produced; the rest is forwarded
 * verbatim. Replaces the retired legacy adapter-factory type — the tests now
 * register `AdapterPlugin` stubs whose `createAdapter` delegates to these
 * closures, so the registry is built DIRECTLY.
 */
export interface RecordingGatewayFactory {
  discord(args: { instanceId: string } & Record<string, unknown>): PlatformAdapter;
  slack(args: { instanceId: string } & Record<string, unknown>): PlatformAdapter;
  mattermost(args: { instanceId: string } & Record<string, unknown>): PlatformAdapter;
}

/**
 * cortex#1896 — build a `SurfacePluginRegistry` directly, registering a
 * recording `AdapterPlugin` per platform whose `createAdapter` DELEGATES to the
 * caller's `factory` closure. This test helper's whole POINT is exercising
 * `startGatewayIfEnabled`'s registry-driven construction path end-to-end
 * (`makeCountingFactory`-style fakes in `start-gateway.test.ts` /
 * `cross-principal-routing.integration.test.ts`). Builds one FRESH per call
 * (never shared/cached) so each test's own `factory` closure is the one
 * invoked. `demuxKey`/`groupBindings`/`buildGatewayConstructArgs` reproduce the
 * bundle plugins' behaviour closely enough for these tests (discord's
 * token-grouping in particular, so "same token, two guild bindings → one
 * adapter" fixtures still collapse correctly).
 */
function buildRecordingRegistry(
  factory: RecordingGatewayFactory,
): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
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
    createAdapter: (args) => factory.discord(args as never),
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
    createAdapter: (args) => factory.slack(args as never),
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
    createAdapter: (args) => factory.mattermost(args as never),
  });
  return registry;
}

export function startGatewayWithPlan(
  opts: Omit<StartGatewayOpts, "ownershipPlan" | "registry"> & {
    factory?: RecordingGatewayFactory;
    registry?: SurfacePluginRegistry;
  },
): ReturnType<typeof startGatewayIfEnabled> {
  const { factory, registry: registryIn, ...rest } = opts;
  let registry = registryIn;
  if (!registry) {
    if (!factory) {
      throw new Error("startGatewayWithPlan requires `factory` or `registry`");
    }
    registry = buildRecordingRegistry(factory);
  }
  return startGatewayIfEnabled({
    ...rest,
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
