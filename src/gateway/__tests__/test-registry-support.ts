/**
 * cortex#1951 — shared test registry helpers for gateway inbound-routing
 * tests.
 *
 * `buildBindingIndex`/`planSurfaceOwnership`/`maybeCreateSurfaceGateway` now
 * derive each platform's demux key via the registered plugin's
 * `demuxKey(binding)` instead of a hardcoded field read — they default to
 * {@link createDefaultSurfacePluginRegistry} (in-tree discord/slack) when
 * the caller omits a registry, so most existing gateway tests need zero
 * changes. `web` (cortex#1794 S9) and `mattermost` (cortex#1796 S11) both
 * extracted out-of-tree and are normally loaded at boot via
 * `loadExternalPlugins` against their REAL bundles — gateway-layer tests
 * that exercise `surfaces.web[]`/`surfaces.mattermost[]` don't need that
 * bundle machinery, just a plugin whose `demuxKey` reproduces the real
 * bundle's contract
 * (`stringBindingField(binding, "instanceId")`/`"apiUrl"`, see those
 * bundles' `src/plugin.ts` / the fixture copies at
 * `src/adapters/__tests__/fixtures/metafactory-cortex-adapter-{web,mattermost}/src/plugin.ts`).
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
 * The in-tree default (discord/slack) plus `web` + `mattermost` stubs — for
 * tests that exercise `surfaces.web[]`/`surfaces.mattermost[]` demux/
 * ownership-plan derivation. Kept the same exported name it had
 * pre-cortex#1796 (`testRegistryWithWeb`) so every existing call site needs
 * zero changes — it now also covers mattermost.
 */
export function testRegistryWithWeb(): SurfacePluginRegistry {
  const registry = createDefaultSurfacePluginRegistry();
  registry.registerAdapter(webAdapterPluginStub);
  registry.registerAdapter(mattermostAdapterPluginStub);
  return registry;
}
