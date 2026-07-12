/**
 * cortex#1951 — shared test registry helpers for gateway inbound-routing
 * tests.
 *
 * `buildBindingIndex`/`planSurfaceOwnership`/`maybeCreateSurfaceGateway` now
 * derive each platform's demux key via the registered plugin's
 * `demuxKey(binding)` instead of a hardcoded field read — they default to
 * {@link createDefaultSurfacePluginRegistry} (in-tree discord/slack/
 * mattermost) when the caller omits a registry, so most existing gateway
 * tests need zero changes. `web` extracted out-of-tree (cortex#1794 S9) and
 * is normally loaded at boot via `loadExternalPlugins` against the REAL
 * `metafactory-cortex-adapter-web` bundle — gateway-layer tests that
 * exercise `surfaces.web[]` don't need that bundle machinery, just a plugin
 * whose `demuxKey` reproduces the real bundle's contract
 * (`stringBindingField(binding, "instanceId")`, see that bundle's
 * `src/plugin.ts` / the fixture copy at
 * `src/adapters/__tests__/fixtures/metafactory-cortex-adapter-web/src/plugin.ts`).
 */

import { z } from "zod/v4";
import {
  createDefaultSurfacePluginRegistry,
  type AdapterPlugin,
  type SurfacePluginRegistry,
} from "../../adapters/registry";
import { stringBindingField } from "../../adapters/plugin-support";

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
 * The in-tree default (discord/slack/mattermost) plus a `web` stub —
 * for tests that exercise `surfaces.web[]` demux/ownership-plan derivation.
 */
export function testRegistryWithWeb(): SurfacePluginRegistry {
  const registry = createDefaultSurfacePluginRegistry();
  registry.registerAdapter(webAdapterPluginStub);
  return registry;
}
