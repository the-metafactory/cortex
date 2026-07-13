/**
 * cortex#1794 (S9 MOVE) — the TRANSPARENT-UPGRADE end-to-end proof.
 *
 * This is the load-bearing deliverable of the S9 MOVE slice: proof that
 * extracting the web adapter out of cortex core into the
 * `metafactory-cortex-adapter-web` bundle is NON-BREAKING. A stack that
 * already had `surfaces.web[...]` configured, upgraded via `arc upgrade
 * cortex` (which auto-installs the newly-declared dependency), keeps
 * working with ZERO config change and WITHOUT the principal ever flipping
 * `system.plugins.external` on — exactly the guarantee `docs/plugin-sdk.md`
 * §"Loading & the first-party exemption" describes for a repackage that only
 * relocates cortex's own code.
 *
 * ## What this test actually exercises (and what it deliberately does NOT)
 *
 * - `pkgRoot` points at `./fixtures` (the SAME trusted root every other
 *   loader test uses) and `installPath` resolves to
 *   `./fixtures/metafactory-cortex-adapter-web/` — a BYTE-IDENTICAL copy of
 *   the real, already-pushed `metafactory-cortex-adapter-web` bundle repo's
 *   `cortex-plugin.yaml` + `src/*.ts` (cortex#1794 S9, commit history at
 *   github.com/the-metafactory/metafactory-cortex-adapter-web). This is the
 *   REAL bundle, not a fixture stand-in written to prove a mechanism in the
 *   abstract (contrast `adapter-declared-bundle/` above, S9a's mechanism
 *   fixture) — mirroring how `cli-tail-bundle` is S6's real zero-cortex-code
 *   LOAD-PATH proof. If this bundle's own repo content ever drifts from this
 *   copy, re-sync it (`cp` the four files) — there is no live network fetch
 *   here, by design (never stand up a live stack / hit GitHub from a test).
 * - `runner` fabricates the `arc list --json` entry an `arc upgrade cortex`
 *   auto-install of the declared dependency would produce: `name:
 *   "metafactory-cortex-adapter-web"`, `repoUrl:
 *   "https://github.com/the-metafactory/metafactory-cortex-adapter-web"`.
 * - `cortexManifestPath` is **deliberately left unset** — the loader reads
 *   cortex's OWN REAL `arc-manifest.yaml` (`defaultCortexManifestPath()`),
 *   which this same S9 slice edited to declare
 *   `metafactory-cortex-adapter-web` under `dependencies:`. This is the
 *   single strongest form of the proof: no fixture manifest stands in for
 *   the real one anywhere in this test.
 * - `externalEnabled: false` — the default-off `system.plugins.external`
 *   posture. If the bundle loads anyway, it can ONLY be because the S9a
 *   first-party ADAPTER exemption fired.
 * - Registers into a registry that ALSO carries the real in-tree
 *   discord/slack/mattermost plugins (`createDefaultSurfacePluginRegistry`),
 *   matching cortex's real boot sequence (`cortex.ts`: in-tree registry
 *   first, then `loadExternalPlugins` appends whatever loads).
 * - Constructs a REAL `WebAdapter` through the loaded plugin's
 *   `createAdapter` and asserts it behaves correctly (platform id, and a
 *   deny-by-default `resolveAccess` when no policy port is supplied) — not
 *   just that the shape validation passed.
 *
 * Out of scope (per the S9 task brief): standing up a live daemon/dev-stack
 * boot. This loader-level test — discover → gate → import → register →
 * construct — is the proof; `cortex.ts`'s boot sequence calls this exact
 * pipeline unchanged (see `loader.ts`'s module doc), so there is nothing
 * stack-boot-specific left for a live stack to exercise beyond what's
 * covered here.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { loadExternalPlugins } from "../loader";
import { createDefaultSurfacePluginRegistry, validateSurfacesAgainstRegistry } from "../registry";
import type { ArcPackage } from "../../common/types/plugin-manifest";
import type { ArcListRunResult } from "../loader";
import type { Surfaces } from "../../common/types/surfaces";
import { buildBindingIndex, resolveBinding } from "../../gateway/binding-resolver";
import { buildGatewayAdapters } from "../../gateway/gateway-adapters";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures");
const WEB_BUNDLE_REPO_URL = "https://github.com/the-metafactory/metafactory-cortex-adapter-web";

function webBundlePkg(): ArcPackage {
  return {
    name: "metafactory-cortex-adapter-web",
    version: "0.1.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: WEB_BUNDLE_REPO_URL,
    installPath: resolve(FIXTURES_ROOT, "metafactory-cortex-adapter-web"),
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

describe("transparent upgrade E2E — the real metafactory-cortex-adapter-web bundle loads flag-OFF as first-party (cortex#1794 S9)", () => {
  test("cortex's REAL arc-manifest.yaml declares the web bundle, so it loads with system.plugins.external OFF", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // Sanity precondition: web is NOT one of the in-tree plugins any more
    // (cortex#1794 S9 MOVE deleted src/adapters/web/) — if this ever fails,
    // the test below would trivially pass for the WRONG reason (duplicate-id
    // gate refusing an already-registered "web", not the exemption firing).
    expect(registry.getAdapter("web")).toBeUndefined();

    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false, // the secure default — no principal opt-in
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([webBundlePkg()]),
      // cortexManifestPath intentionally OMITTED — reads the REAL
      // repo-root arc-manifest.yaml via defaultCortexManifestPath().
    });

    expect(result.discoveryIssues).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-web", kind: "adapter", id: "web", firstParty: true },
    ]);
  });

  test("the loaded plugin registers into the SAME registry discord/slack already live in, alongside them", async () => {
    // cortex#1796 (S11 MOVE) — `mattermost` also extracted out-of-tree since
    // this suite was written; the in-tree registry is discord/slack only now.
    const registry = createDefaultSurfacePluginRegistry();
    const beforeIds = registry.listAdapters().map((p) => p.id);
    expect(beforeIds).toEqual(["discord", "slack"]);

    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([webBundlePkg()]),
    });

    expect(registry.listAdapters().map((p) => p.id)).toEqual(["discord", "slack", "web"]);
  });

  test("the registered plugin constructs a REAL, working WebAdapter — not just a shape-valid stub", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([webBundlePkg()]),
    });

    const plugin = registry.getAdapter("web");
    expect(plugin).toBeDefined();
    expect(plugin?.platform).toBe("web");
    expect(plugin?.secretFields).toEqual([]);
    expect(plugin?.foldsIntoPresence).toBe(false);
    expect(plugin?.demuxKey({ instanceId: "acme" })).toBe("acme");

    // Construct-only (never start()) — mirrors buildGatewayAdapters' own
    // construct-only contract (gateway-adapters.ts's module doc).
    const adapter = plugin!.createAdapter({
      instanceId: "web:acme",
      webBinding: {
        instanceId: "acme",
        host: "127.0.0.1",
        port: 0,
        broadcastUrl: "http://localhost:9999/broadcast",
        transport: "ws",
        authScheme: "none",
      },
      source: { agent: "gateway" },
    });
    expect(adapter.platform).toBe("web");
    expect(adapter.instanceId).toBe("web:acme");

    // Deny-by-default when no policy port is supplied (the bundle's own
    // NO_POLICY_PORT fallback, cortex#1794 S9 MOVE) — proves the loaded
    // code is genuinely functional, not merely shape-valid.
    const decision = adapter.resolveAccess({
      platform: "web",
      instanceId: "web:acme",
      authorId: "u1",
      authorName: "U",
      content: "hi",
      channelId: "ch",
      attachments: [],
      timestamp: new Date(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyCode).toBe("no_policy");
  });

  test("bindingSchema on the loaded plugin is the REAL WebBindingSchema — validates a binding end to end", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([webBundlePkg()]),
    });

    const plugin = registry.getAdapter("web")!;
    const ok = plugin.bindingSchema.safeParse({
      instanceId: "acme",
      broadcastUrl: "http://example.com/broadcast",
    });
    expect(ok.success).toBe(true);

    const bad = plugin.bindingSchema.safeParse({ instanceId: "acme" }); // missing broadcastUrl
    expect(bad.success).toBe(false);
  });

  test("control: the SAME bundle does NOT load when its repoUrl is un-declared (proves the exemption is doing the work, not a blanket allow)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        webBundlePkg(), // undeclared repoUrl override below
      ].map((pkg) => ({ ...pkg, repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-web" }))),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([
      {
        bundleName: "metafactory-cortex-adapter-web",
        kind: "adapter",
        id: "web",
        reason: "system.plugins.external is off and this adapter bundle is not an exempt first-party bundle",
      },
    ]);
    expect(registry.getAdapter("web")).toBeUndefined();
  });

  test("control: with the flag ON, the bundle loads regardless of declaration (the flag is the other, non-exemption path)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        { ...webBundlePkg(), repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-web" },
      ]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-web", kind: "adapter", id: "web", firstParty: false },
    ]);
  });
});

// =============================================================================
// cortex#1794 (S9, review finding M1) — the CONFIG-CONSUMPTION path
// =============================================================================

/**
 * The suite above proves the LOAD path (discover → gate → import → register
 * → construct-in-isolation). It never drives an actual `surfaces.web[...]`
 * CONFIG through the pipeline a real boot uses to turn that config into a
 * routed, running adapter: `validateSurfacesAgainstRegistry` (registry-pass
 * per-field validation) → `buildBindingIndex`/`resolveBinding` (the shared
 * gateway's inbound demux) → `buildGatewayAdapters` (construction from a
 * REAL binding, not a hand-built `WebCreateArgs`). That gap is exactly what
 * the review's B1 finding caught: `web` extracting out of `SurfacesSchema`'s
 * hardcoded keys silently changed `surfaces.web[].binding.instanceId` from a
 * typed `string` to `unknown` everywhere cortex-core code (the gateway
 * binding-resolver + ownership-plan, both pre-dating the plugin registry and
 * reading concrete per-platform fields by design) still reads it directly —
 * a lint-time break (`@typescript-eslint/restrict-template-expressions`)
 * this test suite would have caught pre-CI had it existed before the move.
 * This describe block closes that gap: config-consumption-transparency, not
 * just load-transparency.
 */
describe("config-path E2E — a REAL surfaces.web[] config survives validate → resolve → construct once the bundle loads (cortex#1794 S9, M1)", () => {
  const RUNTIME_STUB = {
    publish: async () => {},
    onEnvelope: () => () => {},
    stop: async () => {},
  } as unknown as MyelinRuntime;

  async function loadWebRegistry() {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([webBundlePkg()]),
    });
    expect(result.loaded).toHaveLength(1);
    return registry;
  }

  // A genuine `surfaces.web[]` entry, shaped exactly as a principal's
  // surfaces.yaml would declare it — NOT a hand-built WebCreateArgs.
  function webSurfacesConfig(instanceId: string): Surfaces {
    return {
      web: [
        {
          agent: "ivy",
          binding: {
            instanceId,
            host: "127.0.0.1",
            port: 8090,
            broadcastUrl: "http://example.com/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
      ],
    };
  }

  test("validateSurfacesAgainstRegistry accepts a valid surfaces.web[] entry once the bundle is loaded, and rejects an invalid one", async () => {
    const registry = await loadWebRegistry();

    expect(() =>
      validateSurfacesAgainstRegistry(webSurfacesConfig("acme"), registry),
    ).not.toThrow();

    // Missing the required `broadcastUrl` — the REAL bundle's WebBindingSchema
    // (not a fixture stand-in) must reject this at the registry pass.
    const invalid: Surfaces = {
      web: [{ agent: "ivy", binding: { instanceId: "acme" } }],
    };
    expect(() => validateSurfacesAgainstRegistry(invalid, registry)).toThrow(
      /surfaces\.web\[0\]\.binding is invalid/,
    );
  });

  test("buildBindingIndex + resolveBinding demux a real web binding to the right agent (proves the B1 fix: instanceId reads correctly post-extraction)", async () => {
    // cortex#1951 — now genuinely consumed: buildBindingIndex derives the web
    // demux key via this registry's registered `web` plugin `demuxKey`, not a
    // hardcoded `binding.instanceId` read.
    const registry = await loadWebRegistry();
    const surfaces = webSurfacesConfig("acme");

    const index = buildBindingIndex(surfaces, registry);
    expect(index.web.size).toBe(1);
    expect(index.web.get("web:acme")?.agent).toBe("ivy");

    const match = resolveBinding(index, {
      platform: "web",
      instanceId: "web:acme",
      authorId: "u1",
      authorName: "U",
      content: "hi",
      channelId: "ch",
      attachments: [],
      timestamp: new Date(),
    });
    expect(match).not.toBeNull();
    expect(match?.agent).toBe("ivy");
    expect(match?.instance).toBe("web:acme");
  });

  test("buildGatewayAdapters constructs a REAL WebAdapter from the config, with the right instanceId, once the bundle is registered", async () => {
    const registry = await loadWebRegistry();
    const surfaces = webSurfacesConfig("acme");

    // Registry-pass validation must pass before construction (mirrors real
    // boot: cortex.ts validates before calling buildGatewayAdapters).
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();

    const adapters = buildGatewayAdapters(surfaces, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      registry,
    });

    expect(adapters).toHaveLength(1);
    const adapter = adapters[0]!;
    expect(adapter.platform).toBe("web");
    expect(adapter.instanceId).toBe("web:acme");
  });

  test("two distinct web bindings survive the whole config path with distinct instanceIds (no silent collision from the unknown-narrowing fix)", async () => {
    const registry = await loadWebRegistry();
    const surfaces: Surfaces = {
      web: [
        { agent: "ivy", binding: { instanceId: "tenant-a", broadcastUrl: "http://a.example/broadcast" } },
        { agent: "oak", binding: { instanceId: "tenant-b", broadcastUrl: "http://b.example/broadcast" } },
      ],
    };
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();

    const index = buildBindingIndex(surfaces, registry);
    expect([...index.web.keys()].sort()).toEqual(["web:tenant-a", "web:tenant-b"]);

    const adapters = buildGatewayAdapters(surfaces, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      registry,
    });
    expect(adapters.map((a) => a.instanceId).sort()).toEqual(["web:tenant-a", "web:tenant-b"]);
  });
});
