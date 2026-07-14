/**
 * cortex#1792 (S6, ADR-0024 D1/D3/D4/D5, OQ9/OQ11) — plugin loader tests.
 *
 * No network: `arc list --json` is fully injected via `runner` — nothing
 * here shells out to a real `arc` binary. Fixture bundles live under
 * `./fixtures/*-bundle/` and are exercised through the SAME
 * discover → gate → import → register pipeline a real installed bundle
 * would go through; `pkgRoot` is pointed at the fixtures directory so the
 * path-traversal containment check runs for real (not mocked away).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  defaultCortexManifestPath,
  discoverPluginBundles,
  isFirstPartyAdapterBundle,
  isFirstPartyBundle,
  isFirstPartyRendererBundle,
  isTrustedOrgRepo,
  loadExternalPlugins,
  readCortexDeclaredAdapterRepos,
  type ArcListRunResult,
} from "../loader";
import { createDefaultSurfacePluginRegistry, SurfacePluginRegistry, type AdapterPlugin } from "../registry";
import type { ArcPackage } from "../../common/types/plugin-manifest";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { buildGatewayAdapters } from "../../gateway/gateway-adapters";
import type { PlatformAdapter } from "../../adapters/types";

/**
 * cortex#1896 — the recording-fake shape used below, replacing the retired
 * legacy adapter-factory type. Only `discord` is actually invoked (via a stub
 * `AdapterPlugin` registered on a directly-built registry); slack/mattermost
 * round out the shape.
 */
interface LocalRecordingFactory {
  discord(args: { instanceId: string; binding: Record<string, unknown> }): PlatformAdapter;
  slack(args: { instanceId: string }): PlatformAdapter;
  mattermost(args: { instanceId: string }): PlatformAdapter;
}
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { Surfaces } from "../../common/types/surfaces";
// cortex#1792 (S6 blocker fix, ROUND 2) — static imports of the getter-/
// mutation-bypass fixtures' EXTRA exports (beyond the default plugin
// export the loader itself dynamically `import()`s). Bun's module registry
// is keyed by resolved file path, so a static import here and the loader's
// `import(pathToFileURL(...).href)` resolve to the SAME module instance —
// `readLog` accumulates across both, and `mutateToDiscord()` mutates the
// exact object the loader saw.
import { readLog as getterBypassReadLog } from "./fixtures/getter-bypass-bundle/index";
import { mutateToDiscord } from "./fixtures/mutation-bypass-bundle/index";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures");
const TRUSTED_REPO = "https://github.com/the-metafactory/metafactory-fixture-plugins";

function fixturePkg(dirName: string, overrides: Partial<ArcPackage> = {}): ArcPackage {
  return {
    name: dirName,
    version: "0.0.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: TRUSTED_REPO,
    installPath: join(FIXTURES_ROOT, dirName),
    ...overrides,
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

/**
 * cortex#1797 (S12 MOVE) — the duplicate-platform and TOCTOU-bypass tests
 * below simulate "discord is already a live, registered adapter" (the
 * production shape once `loadExternalPlugins` has loaded the REAL
 * `metafactory-cortex-adapter-discord` bundle, or — pre-S12 — the in-tree
 * plugin `createDefaultSurfacePluginRegistry()` used to provide
 * synchronously). Since the default registry now composes ZERO in-tree
 * adapters, these tests register this minimal stand-in themselves so the
 * "an adapter already occupies this platform id" scenario they're actually
 * testing (the duplicate/TOCTOU gate, not discord specifically) still holds.
 */
function makeInTreeDiscordStub(): AdapterPlugin {
  return {
    kind: "adapter",
    id: "discord",
    platform: "discord",
    bindingSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    foldsIntoPresence: true,
    secretFields: ["token"],
    demuxKey: () => "",
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => {
      throw new Error("makeInTreeDiscordStub — never constructed in loader tests");
    },
  };
}

describe("discoverPluginBundles (cortex#1792)", () => {
  test("finds every fixture bundle with a cortex-plugin.yaml and parses its manifest", async () => {
    const packages = [
      fixturePkg("cli-tail-bundle"),
      fixturePkg("echo-adapter-bundle"),
      fixturePkg("failing-import-bundle"),
      fixturePkg("sdk-mismatch-bundle"),
      fixturePkg("shadow-discord-bundle"),
      fixturePkg("bad-shape-bundle"),
    ];
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor(packages),
    });
    expect(issues).toEqual([]);
    expect(bundles.map((b) => b.bundleName).sort()).toEqual([
      "bad-shape-bundle",
      "cli-tail-bundle",
      "echo-adapter-bundle",
      "failing-import-bundle",
      "sdk-mismatch-bundle",
      "shadow-discord-bundle",
    ]);
  });

  test("a package with no cortex-plugin.yaml is silently NOT a bundle (no issue)", async () => {
    const notAPlugin = fixturePkg("cli-tail-bundle", { installPath: FIXTURES_ROOT }); // the fixtures ROOT itself has no manifest
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([notAPlugin]),
    });
    expect(bundles).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("bad manifest (invalid id + unknown key) is recorded as a manifest_parse issue, not a bundle", async () => {
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("bad-manifest-bundle")]),
    });
    expect(bundles).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.bundleName).toBe("bad-manifest-bundle");
    expect(issues[0]?.stage).toBe("manifest_parse");
  });

  test("an installPath outside the trusted pkgRoot is refused (path traversal / symlinked pkg dir)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cortex-plugin-loader-outside-"));
    try {
      writeFileSync(
        join(outside, "cortex-plugin.yaml"),
        "kind: renderer\nid: escaped\nentry: ./index.ts\nsdkRange: \"^1\"\n",
      );
      const pkg = fixturePkg("escaped-bundle", { installPath: outside });
      const { bundles, issues } = await discoverPluginBundles({
        pkgRoot: FIXTURES_ROOT,
        runner: runnerFor([pkg]),
      });
      expect(bundles).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.stage).toBe("containment");
      expect(issues[0]?.reason).toMatch(/escapes the trusted pkgRoot/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlinked bundle directory that resolves outside pkgRoot is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cortex-plugin-loader-symtarget-"));
    const symlinkParent = mkdtempSync(join(tmpdir(), "cortex-plugin-loader-symparent-"));
    try {
      writeFileSync(
        join(outside, "cortex-plugin.yaml"),
        "kind: renderer\nid: escaped\nentry: ./index.ts\nsdkRange: \"^1\"\n",
      );
      const symlinkPath = join(symlinkParent, "sneaky-bundle");
      symlinkSync(outside, symlinkPath, "dir");
      // Use the symlink's parent as pkgRoot but the symlink itself as the
      // installPath — realpath resolves THROUGH the symlink to `outside`,
      // which is not contained in `symlinkParent`... but here we invert it:
      // pkgRoot is FIXTURES_ROOT (the trusted root) and installPath is the
      // symlink planted OUTSIDE it, resolving further outside still.
      const pkg = fixturePkg("sneaky", { installPath: symlinkPath });
      const { bundles, issues } = await discoverPluginBundles({
        pkgRoot: FIXTURES_ROOT,
        runner: runnerFor([pkg]),
      });
      expect(bundles).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.stage).toBe("containment");
    } finally {
      rmSync(symlinkParent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlinked cortex-plugin.yaml FILE (dir itself real+contained) is refused — symlinked-manifest defense", async () => {
    // Unlike the two tests above (which escape via the install DIRECTORY),
    // this one plants a bundle dir that is itself real, contained, and
    // legitimate — but whose `cortex-plugin.yaml` is a symlink pointing at a
    // file OUTSIDE the trusted pkgRoot. Pre-fix, `existsSync` +
    // `Bun.file(manifestPath).text()` followed the symlink with no
    // realpath/containment check on the FILE itself (only the directory was
    // checked) — an arbitrary-read / boot-OOM primitive via a bundle's own
    // manifest path.
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-plugin-loader-manifest-symlink-pkgroot-"));
    const outsideSecret = mkdtempSync(join(tmpdir(), "cortex-plugin-loader-manifest-symlink-outside-"));
    try {
      const bundleDir = join(pkgRoot, "manifest-symlink-bundle");
      mkdirSync(bundleDir);
      const secretFile = join(outsideSecret, "not-a-manifest.yaml");
      writeFileSync(secretFile, "kind: renderer\nid: escaped-via-manifest\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      symlinkSync(secretFile, join(bundleDir, "cortex-plugin.yaml"));

      const pkg = fixturePkg("manifest-symlink-bundle", { installPath: bundleDir });
      const { bundles, issues } = await discoverPluginBundles({
        pkgRoot,
        runner: runnerFor([pkg]),
      });
      expect(bundles).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.stage).toBe("manifest_containment");
      expect(issues[0]?.reason).toMatch(/escapes the trusted bundle directory/);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
      rmSync(outsideSecret, { recursive: true, force: true });
    }
  });

  test("a dead `arc list` does not throw — returns a discovery issue and zero bundles", async () => {
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: FIXTURES_ROOT,
      runner: async () => ({ stdout: "", stderr: "arc: command not found", exitCode: 127 }),
    });
    expect(bundles).toEqual([]);
    expect(issues[0]?.stage).toBe("arc_list");
  });

  test("malformed arc list JSON does not throw — returns a discovery issue", async () => {
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: FIXTURES_ROOT,
      runner: async () => ({ stdout: "{not json", stderr: "", exitCode: 0 }),
    });
    expect(bundles).toEqual([]);
    expect(issues[0]?.stage).toBe("arc_list_parse");
  });

  test("a missing pkgRoot (fresh stack, never ran arc install) is a quiet empty result, not an error", async () => {
    const { bundles, issues } = await discoverPluginBundles({
      pkgRoot: join(FIXTURES_ROOT, "does-not-exist-at-all"),
      runner: runnerFor([fixturePkg("cli-tail-bundle")]),
    });
    expect(bundles).toEqual([]);
    expect(issues).toEqual([]);
  });
});

describe("isTrustedOrgRepo / isFirstPartyRendererBundle (cortex#1792, ADR-0024 D4/OQ9)", () => {
  test("org-trust gate accepts only the-metafactory org URLs", () => {
    expect(isTrustedOrgRepo("https://github.com/the-metafactory/metafactory-pagerduty")).toBe(true);
    expect(isTrustedOrgRepo("https://github.com/the-metafactory/metafactory-pagerduty/")).toBe(true);
    expect(isTrustedOrgRepo("https://github.com/attacker/metafactory-pagerduty")).toBe(false);
    expect(isTrustedOrgRepo("https://gitlab.com/the-metafactory/metafactory-pagerduty")).toBe(false);
  });

  test("first-party exemption requires BOTH kind===renderer AND allowlist membership — manifest content alone never grants it", () => {
    const allowlist = new Set([TRUSTED_REPO.toLowerCase()]);
    // Renderer + on the allowlist -> exempt.
    expect(isFirstPartyRendererBundle({ repoUrl: TRUSTED_REPO }, "renderer", allowlist)).toBe(true);
    // Adapter kind is NEVER exempt (OQ9 is renderer-only), even on the allowlist.
    expect(isFirstPartyRendererBundle({ repoUrl: TRUSTED_REPO }, "adapter", allowlist)).toBe(false);
    // Renderer but NOT on the allowlist -> not exempt, no matter how
    // trustworthy the repo looks.
    expect(
      isFirstPartyRendererBundle(
        { repoUrl: "https://github.com/the-metafactory/some-other-renderer" },
        "renderer",
        allowlist,
      ),
    ).toBe(false);
  });

  test("the production allowlist default is empty (no first-party renderer bundle ships yet)", () => {
    // Calling with no allowlist argument uses the real in-tree constant.
    expect(isFirstPartyRendererBundle({ repoUrl: TRUSTED_REPO }, "renderer")).toBe(false);
  });
});

// cortex#1794 (S9a) — the ADAPTER half of the OQ9 exemption, extended per
// epic #1784's "Andreas decision 2026-07-12" (transparent repackaging).
// `CORTEX_MANIFESTS_ROOT` fixtures stand in for cortex's OWN
// `arc-manifest.yaml` via the `cortexManifestPath` test seam — never the
// real repo-root file, except in the one test that deliberately reads it to
// prove the real file doesn't accidentally widen trust.
const CORTEX_MANIFESTS_ROOT = join(FIXTURES_ROOT, "cortex-manifests");
// PR #1942 MAJOR fix — the repo name MUST follow the compass#115
// `metafactory-cortex-adapter-<name>` naming standard, or
// `readCortexDeclaredAdapterRepos`'s narrowing filter drops it even though
// it's a legitimately declared cortex dependency (see
// `ADAPTER_BUNDLE_DEP_NAME_RE` in loader.ts).
const DECLARED_ADAPTER_REPO = "https://github.com/the-metafactory/metafactory-cortex-adapter-fixture";
// Mirrors the REAL manifest's `metafactory-discord` entry: a genuinely
// cortex-declared, org-trusted dependency that is NOT an adapter bundle by
// name shape (tooling, ADR-0017) — must never grant the adapter exemption.
const NON_ADAPTER_DECLARED_REPO = "https://github.com/the-metafactory/metafactory-discord";
const CORTEX_MANIFEST_DECLARES_FIXTURE = join(CORTEX_MANIFESTS_ROOT, "declares-fixture-adapter.yaml");

describe("isFirstPartyAdapterBundle / isFirstPartyBundle (cortex#1794 S9a, epic #1784 decision)", () => {
  test("adapter + on the declared-dependency allowlist -> exempt", () => {
    const allowlist = new Set([DECLARED_ADAPTER_REPO.toLowerCase()]);
    expect(isFirstPartyAdapterBundle({ repoUrl: DECLARED_ADAPTER_REPO }, "adapter", allowlist)).toBe(true);
  });

  test("renderer kind is NEVER exempt via the adapter allowlist path — the two exemptions are namespaced by kind", () => {
    const allowlist = new Set([DECLARED_ADAPTER_REPO.toLowerCase()]);
    expect(isFirstPartyAdapterBundle({ repoUrl: DECLARED_ADAPTER_REPO }, "renderer", allowlist)).toBe(false);
  });

  test("adapter NOT on the allowlist -> not exempt, no matter how trustworthy the repo looks", () => {
    const allowlist = new Set([DECLARED_ADAPTER_REPO.toLowerCase()]);
    expect(isFirstPartyAdapterBundle({ repoUrl: TRUSTED_REPO }, "adapter", allowlist)).toBe(false);
  });

  test("isFirstPartyBundle dispatches by kind: renderer path delegates verbatim, adapter path uses the adapter allowlist", () => {
    const rendererAllowlist = new Set([TRUSTED_REPO.toLowerCase()]);
    const adapterAllowlist = new Set([DECLARED_ADAPTER_REPO.toLowerCase()]);
    expect(
      isFirstPartyBundle({ repoUrl: TRUSTED_REPO }, "renderer", { rendererAllowlist, adapterAllowlist }),
    ).toBe(true);
    expect(
      isFirstPartyBundle({ repoUrl: DECLARED_ADAPTER_REPO }, "adapter", { rendererAllowlist, adapterAllowlist }),
    ).toBe(true);
    // Cross-checks: a repo on the RENDERER list gets no adapter exemption,
    // and vice versa — no accidental cross-pollination between the two.
    expect(
      isFirstPartyBundle({ repoUrl: DECLARED_ADAPTER_REPO }, "renderer", { rendererAllowlist, adapterAllowlist }),
    ).toBe(false);
    expect(
      isFirstPartyBundle({ repoUrl: TRUSTED_REPO }, "adapter", { rendererAllowlist, adapterAllowlist }),
    ).toBe(false);
  });

  test("isFirstPartyBundle with no allowlists supplied defaults closed for adapters (empty set, not open)", () => {
    expect(isFirstPartyBundle({ repoUrl: DECLARED_ADAPTER_REPO }, "adapter")).toBe(false);
  });
});

describe("readCortexDeclaredAdapterRepos (cortex#1794 S9a) — the un-spoofable anchor source", () => {
  test("reads dependency names from a fixture arc-manifest.yaml and derives EXACTLY the adapter-shaped repo URL — nothing else", () => {
    // PR #1942 MAJOR regression test: the fixture manifest declares THREE
    // dependencies (arc, metafactory-discord, metafactory-cortex-adapter-fixture)
    // — asserting the EXACT resulting set (not just "contains X") proves the
    // narrowing filter, not merely the happy path.
    const repos = readCortexDeclaredAdapterRepos(CORTEX_MANIFEST_DECLARES_FIXTURE);
    expect([...repos]).toEqual([DECLARED_ADAPTER_REPO.toLowerCase()]);
    // Spelled out explicitly too, so a future refactor that silently widens
    // the set (e.g. reverting the filter) fails loudly on BOTH assertions.
    expect(repos.has("https://github.com/the-metafactory/arc")).toBe(false);
    expect(repos.has(NON_ADAPTER_DECLARED_REPO.toLowerCase())).toBe(false);
  });

  test("PR #1942 MAJOR: a legitimately-declared but non-adapter-named dependency (mirrors the real metafactory-discord entry) never grants the exemption", () => {
    const repos = readCortexDeclaredAdapterRepos(CORTEX_MANIFEST_DECLARES_FIXTURE);
    expect(repos.has(NON_ADAPTER_DECLARED_REPO.toLowerCase())).toBe(false);
    expect(isFirstPartyAdapterBundle({ repoUrl: NON_ADAPTER_DECLARED_REPO }, "adapter", repos)).toBe(false);
  });

  test("fail-closed: a missing manifest file returns an empty set, never throws", () => {
    const missing = join(CORTEX_MANIFESTS_ROOT, "does-not-exist.yaml");
    expect(() => readCortexDeclaredAdapterRepos(missing)).not.toThrow();
    expect(readCortexDeclaredAdapterRepos(missing).size).toBe(0);
  });

  test("fail-closed: malformed YAML returns an empty set, never throws", () => {
    const malformed = join(CORTEX_MANIFESTS_ROOT, "malformed.yaml");
    expect(() => readCortexDeclaredAdapterRepos(malformed)).not.toThrow();
    expect(readCortexDeclaredAdapterRepos(malformed).size).toBe(0);
  });

  test("a valid manifest with no `dependencies:` key at all returns an empty set", () => {
    const noDeps = join(CORTEX_MANIFESTS_ROOT, "no-dependencies-key.yaml");
    expect(readCortexDeclaredAdapterRepos(noDeps).size).toBe(0);
  });

  // PR #1942 nit/test-coverage — the two fail-closed branches below were
  // promised in the doc comment but previously untested.
  test("fail-closed: `dependencies:` present but NOT an array returns an empty set, never throws", () => {
    const notArray = join(CORTEX_MANIFESTS_ROOT, "dependencies-not-array.yaml");
    expect(() => readCortexDeclaredAdapterRepos(notArray)).not.toThrow();
    expect(readCortexDeclaredAdapterRepos(notArray).size).toBe(0);
  });

  test("fail-closed: a dependency entry with no `name` field is skipped, not thrown on — the OTHER valid entry still resolves", () => {
    const missingName = join(CORTEX_MANIFESTS_ROOT, "dependency-missing-name.yaml");
    const repos = readCortexDeclaredAdapterRepos(missingName);
    expect([...repos]).toEqual([DECLARED_ADAPTER_REPO.toLowerCase()]);
  });

  test("cortex's REAL arc-manifest.yaml is readable, and its NARROWED adapter-exemption set contains exactly the web + slack + mattermost + discord bundles (cortex#1794 S9 / cortex#1795 S10 / cortex#1796 S11 / cortex#1797 S12 MOVE)", () => {
    // PR #1942 MAJOR: the narrowing means only a dependency `name` matching
    // `metafactory-cortex-adapter-*` grants the exemption — `arc` and
    // `metafactory-discord` (both real, org-trusted dependencies declared for
    // UNRELATED reasons) never do, no matter what they ship. cortex#1794 (S9
    // MOVE) was the first time the raw dependency list actually contained a
    // name matching that shape (`metafactory-cortex-adapter-web`); cortex#1795
    // (S10 MOVE) added a second (`metafactory-cortex-adapter-slack`);
    // cortex#1796 (S11 MOVE) added a third
    // (`metafactory-cortex-adapter-mattermost`); cortex#1797 (S12 MOVE) added
    // the fourth and final (`metafactory-cortex-adapter-discord`) — this test
    // documents that the narrowed set now resolves to exactly those four
    // entries, not "genuinely empty" (that was the pre-move state; see git
    // history for the prior version of this test).
    const repos = readCortexDeclaredAdapterRepos(defaultCortexManifestPath());
    expect([...repos].sort()).toEqual([
      "https://github.com/the-metafactory/metafactory-cortex-adapter-discord",
      "https://github.com/the-metafactory/metafactory-cortex-adapter-mattermost",
      "https://github.com/the-metafactory/metafactory-cortex-adapter-slack",
      "https://github.com/the-metafactory/metafactory-cortex-adapter-web",
    ]);
    expect(repos.has(DECLARED_ADAPTER_REPO.toLowerCase())).toBe(false);
    expect(repos.has(TRUSTED_REPO.toLowerCase())).toBe(false);
    expect(repos.has("https://github.com/the-metafactory/arc")).toBe(false);
    expect(repos.has("https://github.com/the-metafactory/metafactory-discord")).toBe(false);
  });
});

describe("loadExternalPlugins (cortex#1792) — the full discover-gate-import-register pipeline", () => {
  test("happy path: a zero-cortex-code renderer bundle (cli-tail) loads, registers, and its render() runs", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("cli-tail-bundle")]),
    });
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "cli-tail-bundle", kind: "renderer", id: "cli-tail", firstParty: false },
    ]);

    const plugin = registry.getRenderer("cli-tail");
    expect(plugin).toBeDefined();
    const renderer = plugin?.createRenderer({ kind: "cli-tail", subscribe: ["local.andreas.>"] });
    if (!renderer) throw new Error("renderer was not constructed");
    expect(renderer.id).toBe("cli-tail");
    // render() must not throw — exercise the actual render path end-to-end.
    const envelope: Envelope = {
      id: "env-1",
      type: "system.plugin.loaded",
      source: "andreas.cortex.local",
      timestamp: new Date(0).toISOString(),
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: {},
    };
    await expect(renderer.render(envelope)).resolves.toBeUndefined();
  });

  test("happy path: an adapter bundle (fixture-echo) loads and registers", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("echo-adapter-bundle")]),
    });
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "echo-adapter-bundle", kind: "adapter", id: "fixture-echo", firstParty: false },
    ]);
    expect(registry.getAdapter("fixture-echo")).toBeDefined();
  });

  test("bad manifest bundle never reaches load — surfaced only as a discovery issue", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("bad-manifest-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.discoveryIssues).toHaveLength(1);
    expect(result.discoveryIssues[0]?.stage).toBe("manifest_parse");
  });

  test("failing entry import is caught, skipped, and does not stop the next bundle from loading", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("failing-import-bundle"), fixturePkg("cli-tail-bundle")]),
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.bundleName).toBe("failing-import-bundle");
    expect(result.failed[0]?.stage).toBe("import");
    expect(result.failed[0]?.reason).toMatch(/fixture-induced top-level import failure/);
    // The daemon (and the OTHER bundle) must still come up.
    expect(result.loaded.map((l) => l.bundleName)).toEqual(["cli-tail-bundle"]);
  });

  test("sdk-range mismatch is refused at the compat gate BEFORE import", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("sdk-mismatch-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("compat_check");
    expect(registry.getRenderer("sdk-mismatch")).toBeUndefined();
  });

  test("duplicate-platform shadow attempt against an in-tree plugin is refused BEFORE import — the bundle's code never runs", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // cortex#1797 (S12 MOVE) — the default registry composes ZERO in-tree
    // adapters now; register a discord stand-in so "discord" is already
    // occupied when the shadow bundle attempts to claim it (see
    // `makeInTreeDiscordStub`'s doc).
    registry.registerAdapter(makeInTreeDiscordStub());
    const inTreeDiscord = registry.getAdapter("discord");
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("shadow-discord-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("duplicate");
    // The failure was NOT an "import" failure (which is what
    // shadow-discord-bundle/index.ts would produce if it were ever
    // executed) — proving the gate fired before import.
    expect(result.failed[0]?.reason).not.toMatch(/must never be imported/);
    // In-tree discord plugin is untouched — still the SAME object.
    expect(registry.getAdapter("discord")).toBe(inTreeDiscord);
  });

  test("module-shape violation (default export missing required members) is refused after a clean import", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("bad-shape-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("shape_validate");
    expect(registry.getRenderer("bad-shape")).toBeUndefined();
  });

  test("system.plugins.external OFF skips a non-first-party bundle (adapter AND renderer)", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("cli-tail-bundle"), fixturePkg("echo-adapter-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.bundleName).sort()).toEqual([
      "cli-tail-bundle",
      "echo-adapter-bundle",
    ]);
    expect(registry.getRenderer("cli-tail")).toBeUndefined();
    expect(registry.getAdapter("fixture-echo")).toBeUndefined();
  });

  test("OQ9: a first-party renderer bundle loads even when system.plugins.external is OFF", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("cli-tail-bundle")]),
      firstPartyRendererRepos: new Set([TRUSTED_REPO.toLowerCase()]),
    });
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "cli-tail-bundle", kind: "renderer", id: "cli-tail", firstParty: true },
    ]);
    expect(registry.getRenderer("cli-tail")).toBeDefined();
  });

  test("OQ9 exemption is renderer-only: an adapter bundle on the SAME allowlist entry still skips when the flag is off", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("echo-adapter-bundle")]),
      firstPartyRendererRepos: new Set([TRUSTED_REPO.toLowerCase()]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(registry.getAdapter("fixture-echo")).toBeUndefined();
  });

  test("org-trust gate refuses a non-the-metafactory bundle even when the flag is ON", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        fixturePkg("cli-tail-bundle", { repoUrl: "https://github.com/attacker/cli-tail" }),
      ]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("org_trust");
  });

  test("renaming the ARC PACKAGE (bundleName) is independent of the plugin id", async () => {
    // The arc package name and the plugin's registry id are different axes:
    // renaming the former (e.g. a re-published bundle) must not affect the
    // latter. cli-tail-bundle's manifest and export agree on id, so this
    // still loads cleanly under the relabelled bundle name.
    const pkg = fixturePkg("cli-tail-bundle", { name: "cli-tail-relabelled" });
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([pkg]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "cli-tail-relabelled", kind: "renderer", id: "cli-tail", firstParty: false },
    ]);
  });

  test("manifest.id/export.id mismatch is refused at shape_validate (genuinely exercises the mismatch branch)", async () => {
    // Prior version of this test (see git history) was misnamed — it
    // actually asserted the AGREEING (happy-path) case and never drove the
    // `imported.id !== manifest.id` branch at all. `id-mismatch-bundle`'s
    // manifest declares id "id-mismatch-renderer"; its default export
    // declares its own id as "totally-different-id" — a genuine mismatch.
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("id-mismatch-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("shape_validate");
    expect(result.failed[0]?.reason).toMatch(/does not match the manifest/);
    expect(registry.getRenderer("id-mismatch-renderer")).toBeUndefined();
    expect(registry.getRenderer("totally-different-id")).toBeUndefined();
  });

  // cortex#1792 BLOCKER (adversarial finding) — shadow-via-platform Discord
  // bot-token disclosure. The id-keyed duplicate gate (stage d) alone is not
  // enough: `buildGatewayAdapters` (`src/gateway/gateway-adapters.ts`)
  // resolves which surface binding an adapter receives by `plugin.platform`,
  // NOT by registry id. A bundle could declare a UNIQUE manifest.id (clearing
  // stage d) while its export's `platform` claims an ALREADY-BOUND platform
  // (e.g. "discord") — pre-fix it would register under the unique id and
  // then be handed the REAL discord binding (bot token included) at gateway
  // construction. The fix pins `platform === manifest.id` (and the renderer
  // analogue `rendererKind === manifest.id`) at shape_validate.
  test("BLOCKER: platform-collision bundle (unique id, platform='discord') is refused at shape_validate, not registered, in-tree discord untouched", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const inTreeDiscord = registry.getAdapter("discord");
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("platform-collision-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("shape_validate");
    expect(result.failed[0]?.reason).toMatch(/platform.*does not match its own id/);
    // Never registered under EITHER key — not the manifest's unique id, and
    // (since it was refused before registration) certainly not "discord".
    expect(registry.getAdapter("evil-unique")).toBeUndefined();
    // The real in-tree discord adapter is untouched — still the SAME object,
    // proving the malicious bundle never shadowed or replaced it.
    expect(registry.getAdapter("discord")).toBe(inTreeDiscord);
  });

  test("BLOCKER (renderer analogue): rendererKind-collision bundle (unique id, rendererKind='dashboard') is refused at shape_validate", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const inTreeDashboard = registry.getRenderer("dashboard");
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("renderer-kind-collision-bundle")]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("shape_validate");
    expect(result.failed[0]?.reason).toMatch(/rendererKind.*does not match its own id/);
    expect(registry.getRenderer("evil-renderer-unique")).toBeUndefined();
    expect(registry.getRenderer("dashboard")).toBe(inTreeDashboard);
  });

  // cortex#1792 BLOCKER, ROUND 2 (adversarial re-check) — the round-1 static
  // `platform === manifest.id` check is a live re-read of the untrusted
  // default export, and is bypassable: a GETTER can return the safe value on
  // the loader's one check-time read and a different value on every read
  // after that (the loader's own `{...imported}` spread; `buildGatewayAdapters`,
  // much later, when the gateway resolves which `surfaces.*` binding — bot
  // token included — to hand the registered adapter). The fix snapshots the
  // routing-critical fields ONCE and registers a FROZEN, DECOUPLED copy, so
  // nothing downstream ever reads the live (attacker-controlled) object
  // again. These tests exercise the fixtures built for exactly that PoC.
  describe("BLOCKER ROUND 2 — TOCTOU getter/mutation bypass of the platform pin", () => {
    const RUNTIME_STUB = {
      publish: async () => {},
      onEnvelope: () => () => {},
      stop: async () => {},
    } as unknown as MyelinRuntime;

    /** Recording fake — constructs a cheap stub adapter, never a real
     *  network client, and captures every call's args (mirrors
     *  `gateway-adapters.test.ts`'s own recording factory). */
    function makeRecordingDiscordFactory(): {
      factory: LocalRecordingFactory;
      discordCalls: { instanceId: string; binding: Record<string, unknown> }[];
    } {
      const discordCalls: { instanceId: string; binding: Record<string, unknown> }[] = [];
      const stubAdapter = (platform: string, instanceId: string) => ({
        platform,
        instanceId,
        start: async () => {},
        stop: async () => {},
        getPlatformUserId: async () => "stub-bot",
        fetchContext: async () => [],
        resolveAccess: () => ({ allowed: true, features: { chat: true, async: false, team: false } }),
        postResponse: async () => {},
        sendTyping: async () => {},
        sendProgress: async () => {},
        clearProgress: async () => {},
        createThread: async () => ({ instanceId, channelId: "ch" }),
        resolveLogicalTarget: async () => null,
        notifyPrincipal: async () => {},
      });
      const factory: LocalRecordingFactory = {
        discord: (args) => {
          discordCalls.push({ instanceId: args.instanceId, binding: args.binding });
          return stubAdapter("discord", args.instanceId);
        },
        slack: (args) => stubAdapter("slack", args.instanceId),
        mattermost: (args) => stubAdapter("mattermost", args.instanceId),
      };
      return { factory, discordCalls };
    }

    test("getter-bypass: platform lies AFTER the check but the registered plugin stays pinned — buildGatewayAdapters never hands it the discord binding", async () => {
      const { factory, discordCalls } = makeRecordingDiscordFactory();
      // A registry built directly and seeded with the SAME safe recording-fake
      // discord adapter — this lets us drive the REAL `buildGatewayAdapters`
      // end-to-end without constructing a real network-capable Discord client.
      // The discord adapter is out-of-tree (no in-tree descriptor); register a
      // stub that delegates to the SAME `factory.discord`, reproducing the
      // exact pre-extraction shape this test's "in-tree discord stays pinned"
      // assertion needs.
      const registry = new SurfacePluginRegistry();
      registry.registerAdapter({
        kind: "adapter",
        id: "discord",
        platform: "discord",
        bindingSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        foldsIntoPresence: true,
        secretFields: ["token"],
        demuxKey: () => "",
        buildGatewayConstructArgs: (group, base) => ({
          instanceId: base.instanceId,
          source: base.source,
          binding: group.entries[0]?.binding,
          runtime: base.runtime,
        }),
        createAdapter: (args) => factory.discord(args as never),
      });

      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot: FIXTURES_ROOT,
        runner: runnerFor([fixturePkg("getter-bypass-bundle")]),
      });

      // The loader's OWN checks both saw the safe value and let it through —
      // this is not merely re-testing the round-1 static-mismatch case.
      expect(result.failed).toEqual([]);
      expect(result.loaded).toEqual([
        { bundleName: "getter-bypass-bundle", kind: "adapter", id: "getter-bypass-evil", firstParty: false },
      ]);

      // The fixture's getter recorded at least 2 safe reads (the shape check
      // + our equality check) and at least one "discord" read it tried to
      // sneak in afterward (the shape_validate stage's own spread) — proving
      // the getter genuinely attempted the bypass, not that it was simply
      // never exercised.
      expect(getterBypassReadLog.slice(0, 2)).toEqual(["getter-bypass-evil", "getter-bypass-evil"]);
      expect(getterBypassReadLog).toContain("discord");
      const readsBeforeGateway = getterBypassReadLog.length;

      const registered = registry.getAdapter("getter-bypass-evil");
      expect(registered).toBeDefined();
      // Read `.platform` several times — a live-delegating (unfixed) object
      // would eventually return "discord" again; the frozen, decoupled copy
      // can't, because it never touches the getter again.
      for (let i = 0; i < 5; i++) {
        expect(registered?.platform).toBe("getter-bypass-evil");
      }
      // None of those 5 reads reached back into the fixture's live getter —
      // the read log is unchanged since before we touched the registry.
      expect(getterBypassReadLog.length).toBe(readsBeforeGateway);

      // The in-tree discord adapter (here, the safe recording fake) is
      // still registered under "discord", untouched.
      expect(registry.getAdapter("discord")).toBeDefined();
      expect(registry.getAdapter("discord")?.platform).toBe("discord");

      // The actual PoC: run the REAL `buildGatewayAdapters` with a discord
      // surface binding carrying a fake "bot token", plus zero bindings for
      // the malicious plugin's own (correctly pinned) namespace.
      const surfaces: Surfaces = {
        discord: [
          {
            agent: "luna",
            binding: {
              token: "SUPER-SECRET-BOT-TOKEN",
              guildId: "111111111111111111",
              agentChannelId: "222222222222222222",
              logChannelId: "333333333333333333",
            },
          },
        ],
      };
      const adapters = buildGatewayAdapters(surfaces, {
        principal: "andreas",
        runtime: RUNTIME_STUB,
        registry,
      });

      // Exactly ONE adapter is constructed — the real (fake-factory) discord
      // one. The malicious plugin's own namespace ("getter-bypass-evil") has
      // no configured binding, so it is skipped entirely (0 bindings ->
      // `continue`, `createAdapter` never called for it).
      expect(adapters).toHaveLength(1);
      expect(adapters[0]?.platform).toBe("discord");
      expect(discordCalls).toHaveLength(1);
      expect(discordCalls[0]?.binding.token).toBe("SUPER-SECRET-BOT-TOKEN");

      // Reading `.platform` off the registered malicious plugin AGAIN, after
      // `buildGatewayAdapters` iterated the whole registry (which reads
      // every adapter's `.platform` at least once per binding-group loop),
      // is STILL the safe value — durable across the full gateway build.
      expect(registry.getAdapter("getter-bypass-evil")?.platform).toBe("getter-bypass-evil");
      expect(getterBypassReadLog.length).toBe(readsBeforeGateway);
    });

    test("mutation-bypass: flipping the ORIGINAL export's platform after registration does not affect the registered (frozen) copy", async () => {
      const registry = createDefaultSurfacePluginRegistry();
      const inTreeDiscord = registry.getAdapter("discord");

      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot: FIXTURES_ROOT,
        runner: runnerFor([fixturePkg("mutation-bypass-bundle")]),
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded).toEqual([
        { bundleName: "mutation-bypass-bundle", kind: "adapter", id: "mutation-bypass-evil", firstParty: false },
      ]);

      const registered = registry.getAdapter("mutation-bypass-evil");
      expect(registered).toBeDefined();
      expect(registered?.platform).toBe("mutation-bypass-evil");

      // Simulate the bundle's own later code (a `setTimeout`, a webhook
      // handler, …) reaching back into its still-live default export and
      // flipping its platform identity post-registration.
      mutateToDiscord();

      // The REGISTERED plugin is a decoupled, frozen snapshot — mutating the
      // bundle's own original object has NO effect on it.
      expect(registry.getAdapter("mutation-bypass-evil")?.platform).toBe("mutation-bypass-evil");
      // The in-tree discord adapter is still untouched — still the SAME
      // object, and mutating the malicious bundle's own export obviously
      // cannot reach it either.
      expect(registry.getAdapter("discord")).toBe(inTreeDiscord);

      // Attempting to mutate the REGISTERED object directly (not the
      // bundle's original export) throws — it's frozen, strict mode.
      expect(() => {
        (registered as unknown as { platform: string }).platform = "discord";
      }).toThrow();
      expect(registry.getAdapter("mutation-bypass-evil")?.platform).toBe("mutation-bypass-evil");
    });
  });

  test("deterministic load order: bundles process in bundleName-sorted order regardless of arc list order", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      // Deliberately reverse-ordered input.
      runner: runnerFor([fixturePkg("echo-adapter-bundle"), fixturePkg("cli-tail-bundle")]),
    });
    expect(result.loaded.map((l) => l.bundleName)).toEqual(["cli-tail-bundle", "echo-adapter-bundle"]);
  });
});

// cortex#1794 (S9a, epic #1784 "TRANSPARENT REPACKAGING" decision) — the
// end-to-end fixture proof: a first-party ADAPTER bundle loads with
// `system.plugins.external` OFF exactly like a first-party renderer already
// does, but gated on cortex's OWN declared `arc-manifest.yaml` dependencies
// instead of a hardcoded allowlist; an undeclared adapter bundle does not.
describe("loadExternalPlugins — first-party ADAPTER exemption (cortex#1794 S9a)", () => {
  test("a first-party ADAPTER bundle (repoUrl declared in cortex's arc-manifest dependencies) loads with system.plugins.external OFF", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("adapter-declared-bundle", { repoUrl: DECLARED_ADAPTER_REPO })]),
      cortexManifestPath: CORTEX_MANIFEST_DECLARES_FIXTURE,
    });
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([
      {
        bundleName: "adapter-declared-bundle",
        kind: "adapter",
        id: "fixture-declared-adapter",
        firstParty: true,
      },
    ]);
    expect(registry.getAdapter("fixture-declared-adapter")).toBeDefined();
  });

  // PR #1942 MAJOR regression, end-to-end: a dependency that mirrors the
  // REAL `metafactory-discord` entry (genuinely declared by cortex,
  // org-trusted, but NOT an adapter-shaped name) must not grant the
  // exemption even if a `kind: adapter` bundle is later installed at that
  // exact repo. Uses `echo-adapter-bundle`'s manifest/export (any valid
  // adapter shape works) with its repoUrl overridden to the non-adapter
  // declared repo.
  test("PR #1942 MAJOR: an adapter bundle at a legitimately-declared but non-adapter-shaped repo (metafactory-discord) does NOT get the exemption", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("echo-adapter-bundle", { repoUrl: NON_ADAPTER_DECLARED_REPO })]),
      cortexManifestPath: CORTEX_MANIFEST_DECLARES_FIXTURE,
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.bundleName).toBe("echo-adapter-bundle");
    expect(registry.getAdapter("fixture-echo")).toBeUndefined();
  });

  test("an adapter bundle whose repoUrl is NOT declared does not load with the flag off, but WOULD with it on (org-trust already satisfied)", async () => {
    const registryOff = new SurfacePluginRegistry();
    const offResult = await loadExternalPlugins({
      registry: registryOff,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      // echo-adapter-bundle's repoUrl defaults to TRUSTED_REPO, which is NOT
      // declared in declares-fixture-adapter.yaml's dependencies.
      runner: runnerFor([fixturePkg("echo-adapter-bundle")]),
      cortexManifestPath: CORTEX_MANIFEST_DECLARES_FIXTURE,
    });
    expect(offResult.loaded).toEqual([]);
    expect(offResult.skipped).toHaveLength(1);
    expect(offResult.skipped[0]?.bundleName).toBe("echo-adapter-bundle");
    expect(registryOff.getAdapter("fixture-echo")).toBeUndefined();

    // Same bundle, same (irrelevant) cortexManifestPath, flag ON — loads.
    // Proves the skip above was SPECIFICALLY the first-party-adapter gate
    // (org-trust and every other gate already pass for this fixture).
    const registryOn = new SurfacePluginRegistry();
    const onResult = await loadExternalPlugins({
      registry: registryOn,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("echo-adapter-bundle")]),
      cortexManifestPath: CORTEX_MANIFEST_DECLARES_FIXTURE,
    });
    expect(onResult.loaded).toEqual([
      { bundleName: "echo-adapter-bundle", kind: "adapter", id: "fixture-echo", firstParty: false },
    ]);
  });

  test("fail-closed: an unreadable cortexManifestPath grants NO adapter exemption — a genuinely declared-looking bundle still skips with the flag off", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("adapter-declared-bundle", { repoUrl: DECLARED_ADAPTER_REPO })]),
      cortexManifestPath: join(CORTEX_MANIFESTS_ROOT, "does-not-exist.yaml"),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(registry.getAdapter("fixture-declared-adapter")).toBeUndefined();
  });

  test("firstPartyAdapterRepos (explicit test seam) wins over cortexManifestPath when both are set", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("adapter-declared-bundle", { repoUrl: DECLARED_ADAPTER_REPO })]),
      // Points at a manifest that does NOT declare the bundle...
      cortexManifestPath: join(CORTEX_MANIFESTS_ROOT, "no-dependencies-key.yaml"),
      // ...but the explicit allowlist DOES include it, and must win.
      firstPartyAdapterRepos: new Set([DECLARED_ADAPTER_REPO.toLowerCase()]),
    });
    expect(result.loaded).toEqual([
      {
        bundleName: "adapter-declared-bundle",
        kind: "adapter",
        id: "fixture-declared-adapter",
        firstParty: true,
      },
    ]);
  });

  test("renderer path regression: a first-party RENDERER bundle still loads via firstPartyRendererRepos exactly as before, unaffected by the new adapter mechanism", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([fixturePkg("cli-tail-bundle")]),
      firstPartyRendererRepos: new Set([TRUSTED_REPO.toLowerCase()]),
      // A cortex manifest is present and even declares a DIFFERENT adapter
      // repo — must have zero bearing on the renderer exemption path.
      cortexManifestPath: CORTEX_MANIFEST_DECLARES_FIXTURE,
    });
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "cli-tail-bundle", kind: "renderer", id: "cli-tail", firstParty: true },
    ]);
  });

  test("org-trust gate still refuses a non-the-metafactory adapter bundle even if it magically matched the adapter allowlist", async () => {
    const registry = new SurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        fixturePkg("adapter-declared-bundle", { repoUrl: "https://github.com/attacker/metafactory-cortex-adapter-fixture" }),
      ]),
      // Allowlist derived from the ATTACKER url directly (simulating a bug
      // elsewhere) — org-trust must still refuse it BEFORE the first-party
      // gate is ever consulted (D4 mitigation #1 is unconditional).
      firstPartyAdapterRepos: new Set(["https://github.com/attacker/metafactory-cortex-adapter-fixture"]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe("org_trust");
  });
});
