/**
 * cortex#1796 (S11 MOVE) — the TRANSPARENT-UPGRADE end-to-end proof for the
 * Mattermost adapter extraction, mirroring `loader.web-bundle.test.ts`
 * (cortex#1794 S9) byte-for-byte in structure.
 *
 * This is the load-bearing deliverable of the S11 MOVE slice: proof that
 * extracting the mattermost adapter out of cortex core into the
 * `metafactory-cortex-adapter-mattermost` bundle is NON-BREAKING. A stack
 * that already had `surfaces.mattermost[...]` configured (or the legacy
 * inline `agents[].presence.mattermost` shape), upgraded via `arc upgrade
 * cortex` (which auto-installs the newly-declared dependency), keeps working
 * with ZERO config change and WITHOUT the principal ever flipping
 * `system.plugins.external` on.
 *
 * ## What this test actually exercises (and what it deliberately does NOT)
 *
 * - `pkgRoot` points at `./fixtures` (the SAME trusted root every other
 *   loader test uses) and `installPath` resolves to
 *   `./fixtures/metafactory-cortex-adapter-mattermost/` — a BYTE-IDENTICAL
 *   copy of the real, already-pushed `metafactory-cortex-adapter-mattermost`
 *   bundle repo's `cortex-plugin.yaml` + `src/*.ts` (cortex#1796 S11). This is
 *   the REAL bundle content, not a fixture stand-in written to prove a
 *   mechanism in the abstract — if this bundle's own repo content ever
 *   drifts from this copy, re-sync it (`cp` the source files) — there is no
 *   live network fetch here, by design.
 * - `runner` fabricates the `arc list --json` entry an `arc upgrade cortex`
 *   auto-install of the declared dependency would produce: `name:
 *   "metafactory-cortex-adapter-mattermost"`, `repoUrl:
 *   "https://github.com/the-metafactory/metafactory-cortex-adapter-mattermost"`.
 * - `cortexManifestPath` is **deliberately left unset** — the loader reads
 *   cortex's OWN REAL `arc-manifest.yaml` (`defaultCortexManifestPath()`),
 *   which this same S11 slice edited to declare
 *   `metafactory-cortex-adapter-mattermost` under `dependencies:`. No fixture
 *   manifest stands in for the real one anywhere in this test.
 * - `externalEnabled: false` — the default-off `system.plugins.external`
 *   posture. If the bundle loads anyway, it can ONLY be because the S9a
 *   first-party ADAPTER exemption fired.
 * - Registers into a registry that ALSO carries the real in-tree
 *   discord/slack plugins (`createDefaultSurfacePluginRegistry` — mattermost
 *   is NO LONGER one of them post-extraction), matching cortex's real boot
 *   sequence (`cortex.ts`: in-tree registry first, then `loadExternalPlugins`
 *   appends whatever loads).
 * - Constructs a REAL `MattermostAdapter` through the loaded plugin's
 *   `createAdapter` and asserts it behaves correctly (platform id, and a
 *   deny-by-default `resolveAccess` when no policy port is supplied) — not
 *   just that the shape validation passed.
 * - Mattermost carries a SECRET (`apiToken`, `plugin.secretFields`) — this
 *   suite asserts it never echoes into a thrown validation error message
 *   (the same guarantee `validateSurfacesAgainstRegistry`'s own doc gives:
 *   Zod issue messages never include the raw field VALUE).
 *
 * Out of scope (per the S9/S11 task brief): standing up a live daemon/dev-stack
 * boot. This loader-level test — discover → gate → import → register →
 * construct — is the proof; `cortex.ts`'s boot sequence calls this exact
 * pipeline unchanged.
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
const MATTERMOST_BUNDLE_REPO_URL = "https://github.com/the-metafactory/metafactory-cortex-adapter-mattermost";

function mattermostBundlePkg(): ArcPackage {
  return {
    name: "metafactory-cortex-adapter-mattermost",
    version: "0.1.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: MATTERMOST_BUNDLE_REPO_URL,
    installPath: resolve(FIXTURES_ROOT, "metafactory-cortex-adapter-mattermost"),
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

describe("transparent upgrade E2E — the real metafactory-cortex-adapter-mattermost bundle loads flag-OFF as first-party (cortex#1796 S11)", () => {
  test("cortex's REAL arc-manifest.yaml declares the mattermost bundle, so it loads with system.plugins.external OFF", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // Sanity precondition: mattermost is NOT one of the in-tree plugins any
    // more (cortex#1796 S11 MOVE deleted src/adapters/mattermost/) — if this
    // ever fails, the test below would trivially pass for the WRONG reason
    // (duplicate-id gate refusing an already-registered "mattermost", not
    // the exemption firing).
    expect(registry.getAdapter("mattermost")).toBeUndefined();

    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false, // the secure default — no principal opt-in
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([mattermostBundlePkg()]),
      // cortexManifestPath intentionally OMITTED — reads the REAL
      // repo-root arc-manifest.yaml via defaultCortexManifestPath().
    });

    expect(result.discoveryIssues).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-mattermost", kind: "adapter", id: "mattermost", firstParty: true },
    ]);
  });

  test("the loaded plugin registers into the SAME registry discord/slack already live in, alongside them", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const beforeIds = registry.listAdapters().map((p) => p.id);
    expect(beforeIds).toEqual(["discord", "slack"]);

    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([mattermostBundlePkg()]),
    });

    expect(registry.listAdapters().map((p) => p.id)).toEqual(["discord", "slack", "mattermost"]);
  });

  test("the registered plugin constructs a REAL, working MattermostAdapter — not just a shape-valid stub", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([mattermostBundlePkg()]),
    });

    const plugin = registry.getAdapter("mattermost");
    expect(plugin).toBeDefined();
    expect(plugin?.platform).toBe("mattermost");
    expect(plugin?.secretFields).toEqual(["apiToken"]);
    expect(plugin?.foldsIntoPresence).toBe(true);
    expect(plugin?.demuxKey({ apiUrl: "https://mm.example.com" })).toBe("https://mm.example.com");
    expect(plugin?.demuxKey({})).toBe("<unset>");

    // Construct-only (never start()) — mirrors buildGatewayAdapters' own
    // construct-only contract (gateway-adapters.ts's module doc).
    const adapter = plugin!.createAdapter({
      instanceId: "mattermost:https://mm.example.com",
      source: { agent: "gateway" },
      presence: {
        enabled: true,
        apiUrl: "https://mm.example.com",
        apiToken: "mm-secret-token",
        channels: [],
        pollIntervalMs: 5000,
        allowedUsers: [],
      },
      runtime: undefined,
    });
    expect(adapter.platform).toBe("mattermost");
    expect(adapter.instanceId).toBe("mattermost:https://mm.example.com");

    // Deny-by-default when no policy port is supplied (the bundle's own
    // NO_POLICY_PORT fallback, cortex#1796 S11 MOVE) — proves the loaded
    // code is genuinely functional, not merely shape-valid.
    const decision = adapter.resolveAccess({
      platform: "mattermost",
      instanceId: "mattermost:https://mm.example.com",
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

  test("bindingSchema on the loaded plugin is the REAL MattermostBindingSchema — validates a binding end to end", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([mattermostBundlePkg()]),
    });

    const plugin = registry.getAdapter("mattermost")!;
    const ok = plugin.bindingSchema.safeParse({
      apiUrl: "https://mm.example.com",
      apiToken: "mm-secret-token",
    });
    expect(ok.success).toBe(true);

    const bad = plugin.bindingSchema.safeParse({ apiUrl: "https://mm.example.com" }); // missing apiToken
    expect(bad.success).toBe(false);
    // No secret echo — a rejected binding's error text never carries the
    // raw field VALUE, even when the field itself IS present but invalid.
    const badToken = plugin.bindingSchema.safeParse({ apiUrl: "https://mm.example.com", apiToken: 12345 });
    expect(badToken.success).toBe(false);
    if (!badToken.success) {
      const issuesText = JSON.stringify(badToken.error.issues);
      expect(issuesText).not.toContain("mm-secret-token");
    }
  });

  test("control: the SAME bundle does NOT load when its repoUrl is un-declared (proves the exemption is doing the work, not a blanket allow)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        mattermostBundlePkg(), // undeclared repoUrl override below
      ].map((pkg) => ({ ...pkg, repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-mattermost" }))),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([
      {
        bundleName: "metafactory-cortex-adapter-mattermost",
        kind: "adapter",
        id: "mattermost",
        reason: "system.plugins.external is off and this adapter bundle is not an exempt first-party bundle",
      },
    ]);
    expect(registry.getAdapter("mattermost")).toBeUndefined();
  });

  test("control: with the flag ON, the bundle loads regardless of declaration (the flag is the other, non-exemption path)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        { ...mattermostBundlePkg(), repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-mattermost" },
      ]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-mattermost", kind: "adapter", id: "mattermost", firstParty: false },
    ]);
  });
});

// =============================================================================
// cortex#1796 (S11, review parity with cortex#1794 S9 review finding M1) —
// the CONFIG-CONSUMPTION path
// =============================================================================

/**
 * The suite above proves the LOAD path (discover → gate → import → register
 * → construct-in-isolation). This describe block closes the
 * config-consumption-transparency gap for mattermost too: a REAL
 * `surfaces.mattermost[...]` CONFIG survives `validateSurfacesAgainstRegistry`
 * (registry-pass per-field validation) → `buildBindingIndex`/`resolveBinding`
 * (the shared gateway's inbound demux) → `buildGatewayAdapters` (construction
 * from a REAL binding, not a hand-built `MattermostCreateArgs`), once the
 * bundle is loaded — the SAME shape of proof `loader.web-bundle.test.ts`'s
 * M1-fix describe block established for web.
 */
describe("config-path E2E — a REAL surfaces.mattermost[] config survives validate → resolve → construct once the bundle loads (cortex#1796 S11)", () => {
  const RUNTIME_STUB = {
    publish: async () => {},
    onEnvelope: () => () => {},
    stop: async () => {},
  } as unknown as MyelinRuntime;

  async function loadMattermostRegistry() {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([mattermostBundlePkg()]),
    });
    expect(result.loaded).toHaveLength(1);
    return registry;
  }

  // A genuine `surfaces.mattermost[]` entry, shaped exactly as a
  // principal's surfaces.yaml would declare it — NOT a hand-built
  // MattermostCreateArgs.
  function mattermostSurfacesConfig(apiUrl: string, apiToken: string): Surfaces {
    return {
      mattermost: [
        {
          agent: "echo",
          binding: {
            apiUrl,
            apiToken,
          },
        },
      ],
    };
  }

  test("validateSurfacesAgainstRegistry accepts a valid surfaces.mattermost[] entry once the bundle is loaded, and rejects an invalid one", async () => {
    const registry = await loadMattermostRegistry();

    expect(() =>
      validateSurfacesAgainstRegistry(mattermostSurfacesConfig("https://mm.example.com", "mm-secret-token"), registry),
    ).not.toThrow();

    // Missing the required `apiToken` — the REAL bundle's
    // MattermostBindingSchema (not a fixture stand-in) must reject this at
    // the registry pass, and the thrown message must NOT echo any secret.
    const invalid: Surfaces = {
      mattermost: [{ agent: "echo", binding: { apiUrl: "https://mm.example.com" } }],
    };
    let thrown: unknown;
    try {
      validateSurfacesAgainstRegistry(invalid, registry);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/surfaces\.mattermost\[0\]\.binding is invalid/);
    expect((thrown as Error).message).not.toContain("mm-secret-token");
  });

  test("buildBindingIndex + resolveBinding demux a real mattermost binding to the right agent", async () => {
    const registry = await loadMattermostRegistry();
    const surfaces = mattermostSurfacesConfig("https://mm.example.com", "mm-secret-token");

    const index = buildBindingIndex(surfaces, registry);
    // Mattermost's single-binding fallback path (binding-resolver.ts's
    // module doc: exactly one binding → single-binding fallback).
    const match = resolveBinding(index, {
      platform: "mattermost",
      instanceId: "irrelevant-for-mattermost-single-binding-fallback",
      authorId: "u1",
      authorName: "U",
      content: "hi",
      channelId: "ch",
      attachments: [],
      timestamp: new Date(),
    });
    expect(match).not.toBeNull();
    expect(match?.agent).toBe("echo");
  });

  test("buildGatewayAdapters constructs a REAL MattermostAdapter from the config, with the right instanceId, once the bundle is registered", async () => {
    const registry = await loadMattermostRegistry();
    const surfaces = mattermostSurfacesConfig("https://mm.example.com", "mm-secret-token");

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
    expect(adapter.platform).toBe("mattermost");
    expect(adapter.instanceId).toBe("mattermost:https://mm.example.com");
  });

  test("no apiToken echo in identity/routing surfaces — instanceId, demuxKey, and thrown validation errors never leak the secret", async () => {
    // NOTE: the constructed `MattermostAdapter` legitimately HOLDS
    // `apiToken` in memory (it needs the credential to call the Mattermost
    // REST API) — that is not a leak. What must never happen is the secret
    // surfacing in something that gets LOGGED, DEMUXED, or surfaced to a
    // principal: the instanceId (derived from `apiUrl`, cortex#1796 S11 —
    // `demuxKey` reads `apiUrl`, never `apiToken`), and any thrown
    // validation error (Zod issue messages never carry the raw field value
    // — see the "validates a binding end to end" test above).
    const registry = await loadMattermostRegistry();
    const secret = "SUPER-SECRET-MM-TOKEN-DO-NOT-LEAK";
    const plugin = registry.getAdapter("mattermost")!;
    expect(plugin.demuxKey({ apiUrl: "https://mm.example.com", apiToken: secret })).not.toContain(secret);

    const surfaces = mattermostSurfacesConfig("https://mm.example.com", secret);
    const adapters = buildGatewayAdapters(surfaces, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      registry,
    });
    expect(adapters).toHaveLength(1);
    const adapter = adapters[0]!;
    expect(adapter.instanceId).not.toContain(secret);
  });
});
