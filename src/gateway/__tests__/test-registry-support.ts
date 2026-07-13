/**
 * cortex#1951 — shared test registry helpers for gateway inbound-routing
 * tests.
 *
 * `buildBindingIndex`/`planSurfaceOwnership`/`maybeCreateSurfaceGateway` now
 * derive each platform's demux key via the registered plugin's
 * `demuxKey(binding)` instead of a hardcoded field read — they default to
 * {@link createDefaultSurfacePluginRegistry} when the caller omits a
 * registry. cortex#1797 (S12 MOVE) — that default registry now composes
 * ZERO in-tree adapters (discord was the last one; see that function's doc),
 * so EVERY gateway test that needs discord/web/slack/mattermost demux
 * derivation must go through one of this file's `testRegistryWith*` helpers
 * — there is no more implicit "discord just works" default. `web`
 * (cortex#1794 S9), `slack` (cortex#1795 S10), `mattermost` (cortex#1796
 * S11), and `discord` (cortex#1797 S12) all extracted out-of-tree and are
 * normally loaded at boot via `loadExternalPlugins` against their REAL
 * bundles — gateway-layer tests that exercise `surfaces.{platform}[]` don't
 * need that bundle machinery, just a plugin whose `demuxKey` reproduces the
 * real bundle's contract (`stringBindingField(binding, "instanceId")` /
 * `"workspaceId"` / `"apiUrl"` / `"guildId"`, see each bundle's
 * `src/plugin.ts` — the web fixture copy lives at
 * `src/adapters/__tests__/fixtures/metafactory-cortex-adapter-web/src/plugin.ts`).
 */

import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  createDefaultSurfacePluginRegistry,
  type AdapterPlugin,
  type BindingGroup,
  type SurfaceBindingEntry,
  type SurfacePluginRegistry,
} from "../../adapters/registry";
import { stringBindingField } from "../../adapters/plugin-support";

/**
 * Byte-identical to the real bundle's `discordTokenInstanceId`
 * (`metafactory-cortex-adapter-discord`'s `src/token-groups.ts`) — a
 * multi-guild token group's instance id is a sha256(token, stack) digest,
 * not a JSON-stringified guildId list. The surface-ownership-plan suite
 * pins this exact `/^discord:token:[0-9a-f]{12}$/` shape, so the stub must
 * reproduce the hash, not just group membership.
 */
function discordTokenInstanceIdStub(token: string, stack: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ token, stack: stack ?? null }))
    .digest("hex")
    .slice(0, 12);
  return `discord:token:${digest}`;
}

/**
 * The discord platform's `demuxKey`/`groupBindings`/`secretFields` contract,
 * reproduced from the real `metafactory-cortex-adapter-discord` bundle
 * (out-of-tree, cortex#1797 S12 MOVE — see module doc). `groupBindings`
 * mirrors that bundle's `token-groups.ts` (token-keyed grouping — Discord
 * delivers every guild event for one bot token over ONE gateway session) so
 * "same Discord token across two guild bindings" tests still exercise real
 * grouping behaviour, not just per-binding demux. `createAdapter` throws —
 * gateway-layer routing/ownership-plan tests never construct a live
 * `DiscordAdapter` through this stub, only derive demux keys / groups.
 */
function groupDiscordBindingsByTokenStub(entries: readonly SurfaceBindingEntry[]): BindingGroup[] {
  const groups = new Map<string, SurfaceBindingEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify({ token: entry.binding.token, stack: entry.stack ?? null });
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()].map((groupedEntries) => {
    const firstEntry = groupedEntries[0];
    const token = stringBindingField(firstEntry?.binding ?? {}, "token", "");
    const stack = firstEntry?.stack;
    const guildIds = groupedEntries.map((e) => stringBindingField(e.binding, "guildId"));
    const firstGuildId = guildIds[0];
    const instanceId =
      guildIds.length === 1 && firstGuildId !== undefined
        ? `discord:${firstGuildId}`
        : discordTokenInstanceIdStub(token, stack);
    return { entries: groupedEntries, instanceId };
  });
}

const discordAdapterPluginStub: AdapterPlugin = {
  kind: "adapter",
  id: "discord",
  platform: "discord",
  bindingSchema: z.object({
    token: z.string(),
    guildId: z.coerce.string(),
    agentChannelId: z.coerce.string(),
    logChannelId: z.coerce.string(),
  }).catchall(z.unknown()),
  foldsIntoPresence: true,
  secretFields: ["token"],
  demuxKey: (binding) => stringBindingField(binding, "guildId"),
  groupBindings: (entries) => groupDiscordBindingsByTokenStub(entries),
  buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
  createAdapter: () => {
    throw new Error("discordAdapterPluginStub — never constructed in gateway-layer tests");
  },
};

/**
 * The web platform's `demuxKey` contract, reproduced from the real
 * `metafactory-cortex-adapter-web` bundle (out-of-tree — see module doc).
 * `createAdapter` throws — gateway-layer routing/ownership-plan tests never
 * construct a live `WebAdapter` through this stub, only derive demux keys.
 */
const webAdapterPluginStub: AdapterPlugin = {
  kind: "adapter",
  id: "web",
  platform: "web",
  bindingSchema: z.unknown(),
  foldsIntoPresence: false,
  secretFields: [],
  demuxKey: (binding) => stringBindingField(binding, "instanceId"),
  buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
  createAdapter: () => {
    throw new Error("webAdapterPluginStub — never constructed in gateway-layer tests");
  },
};

/**
 * The slack platform's `demuxKey` contract, reproduced from the real
 * `metafactory-cortex-adapter-slack` bundle (out-of-tree, cortex#1795 S10 —
 * see module doc). `createAdapter` throws for the same reason
 * {@link webAdapterPluginStub}'s does.
 */
const slackAdapterPluginStub: AdapterPlugin = {
  kind: "adapter",
  id: "slack",
  platform: "slack",
  bindingSchema: z.unknown(),
  foldsIntoPresence: true,
  secretFields: ["botToken", "appToken"],
  demuxKey: (binding) => stringBindingField(binding, "workspaceId"),
  buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
  createAdapter: () => {
    throw new Error("slackAdapterPluginStub — never constructed in gateway-layer tests");
  },
};

/**
 * The mattermost platform's `demuxKey`/`secretFields`/`foldsIntoPresence`
 * contract, reproduced from the real `metafactory-cortex-adapter-mattermost`
 * bundle (out-of-tree, cortex#1796 S11 MOVE — see module doc).
 * `createAdapter` throws — gateway-layer routing/ownership-plan tests never
 * construct a live `MattermostAdapter` through this stub, only derive demux
 * keys / exercise the single-binding fallback path.
 */
const mattermostAdapterPluginStub: AdapterPlugin = {
  kind: "adapter",
  id: "mattermost",
  platform: "mattermost",
  bindingSchema: z.record(z.string(), z.unknown()),
  foldsIntoPresence: true,
  secretFields: ["apiToken"],
  demuxKey: (binding) => stringBindingField(binding, "apiUrl", "<unset>"),
  buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
  createAdapter: () => {
    throw new Error("mattermostAdapterPluginStub — never constructed in gateway-layer tests");
  },
};

/**
 * cortex#1797 (S12 MOVE) — the in-tree default registry now composes ZERO
 * adapters (discord was the last one). This is the new baseline every other
 * helper below builds on: `createDefaultSurfacePluginRegistry()` plus JUST
 * the `discord` stub — for tests that only need `surfaces.discord[]` demux/
 * grouping derivation (the shape the bare default registry used to provide
 * implicitly, pre-S12).
 */
export function testRegistryWithDiscord(): SurfacePluginRegistry {
  const registry = createDefaultSurfacePluginRegistry();
  registry.registerAdapter(discordAdapterPluginStub);
  return registry;
}

/**
 * `discord` + `web` + `mattermost` stubs — for tests that exercise
 * `surfaces.web[]`/`surfaces.mattermost[]` demux/ownership-plan derivation
 * alongside discord. Kept the same exported name it had pre-cortex#1796
 * (`testRegistryWithWeb`) so every existing call site needs zero changes —
 * it now also covers mattermost AND discord (cortex#1797 S12).
 */
export function testRegistryWithWeb(): SurfacePluginRegistry {
  const registry = testRegistryWithDiscord();
  registry.registerAdapter(webAdapterPluginStub);
  registry.registerAdapter(mattermostAdapterPluginStub);
  return registry;
}

/**
 * `discord` + `slack` stubs — for tests that exercise `surfaces.slack[]`
 * demux/ownership-plan derivation alongside discord (cortex#1795 S10 MOVE —
 * slack is no longer part of the in-tree default; cortex#1797 S12 MOVE —
 * neither is discord any more).
 */
export function testRegistryWithSlack(): SurfacePluginRegistry {
  const registry = testRegistryWithDiscord();
  registry.registerAdapter(slackAdapterPluginStub);
  return registry;
}

/**
 * `discord` + `web` + `slack` stubs — for tests that mix bindings from
 * every platform in one fixture (e.g. "all platforms combined").
 */
export function testRegistryWithWebAndSlack(): SurfacePluginRegistry {
  const registry = testRegistryWithDiscord();
  registry.registerAdapter(webAdapterPluginStub);
  registry.registerAdapter(slackAdapterPluginStub);
  return registry;
}

/**
 * `discord` + `slack` + `mattermost` stubs (no `web`) — for tests that mix
 * discord/slack/mattermost bindings in one fixture without needing the
 * `web` platform too (e.g. binding-resolver's "all platforms combined"
 * test).
 */
export function testRegistryWithSlackAndMattermost(): SurfacePluginRegistry {
  const registry = testRegistryWithDiscord();
  registry.registerAdapter(slackAdapterPluginStub);
  registry.registerAdapter(mattermostAdapterPluginStub);
  return registry;
}
