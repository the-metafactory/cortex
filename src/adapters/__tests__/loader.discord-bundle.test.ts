/**
 * cortex#1797 (S12 MOVE) — the TRANSPARENT-UPGRADE end-to-end proof for
 * Discord, mirroring `loader.slack-bundle.test.ts`'s S10 proof structure
 * (itself mirroring `loader.web-bundle.test.ts`'s S9 proof).
 *
 * This is the load-bearing deliverable of the S12 MOVE slice — Discord is
 * the FOURTH and FINAL in-tree adapter to extract, and
 * `createDefaultSurfacePluginRegistry()` now composes ZERO in-tree
 * adapters. Unlike web/slack/mattermost (where an in-tree sibling still
 * registered by default), THIS suite is the SOLE end-to-end proof that
 * Discord works purely as a loaded bundle — there is no more implicit
 * "discord just works" default anywhere in cortex core.
 *
 * ## What this test actually exercises (and what it deliberately does NOT)
 *
 * - `pkgRoot` points at `./fixtures` (the SAME trusted root every other
 *   loader test uses) and `installPath` resolves to
 *   `./fixtures/metafactory-cortex-adapter-discord/` — a byte-identical
 *   copy of the real, already-pushed `metafactory-cortex-adapter-discord`
 *   bundle repo's `cortex-plugin.yaml` + every `src/*.ts` file EXCEPT one
 *   import-line-per-file deviation (`from "discord.js"` → `from
 *   "./discordjs-stub"`) and `client.ts` (a fixture-local stand-in, exactly
 *   like the slack fixture's `client.ts` for `@slack/socket-mode`/
 *   `@slack/web-api`) — see `discordjs-stub.ts`'s module doc for why:
 *   `discord.js` (and its `@discordjs/*` transitive deps) left cortex's OWN
 *   `package.json` in this same S12 slice, so importing it from a fixture
 *   living inside cortex's `src/` tree — no separate `node_modules` of its
 *   own — would only resolve by accident on a not-yet-pruned local install
 *   and break on a genuinely clean one (e.g. CI). No test below calls
 *   `.start()` on a constructed `DiscordAdapter`, so the stand-in's
 *   throwing `createDiscordClient` never fires.
 * - `runner` fabricates the `arc list --json` entry an `arc upgrade cortex`
 *   auto-install of the declared dependency would produce.
 * - `cortexManifestPath` is **deliberately left unset** — the loader reads
 *   cortex's OWN REAL `arc-manifest.yaml` (`defaultCortexManifestPath()`),
 *   which this same S12 slice edited to declare
 *   `metafactory-cortex-adapter-discord` under `dependencies:`.
 * - `externalEnabled: false` — the default-off `system.plugins.external`
 *   posture. If the bundle loads anyway, it can ONLY be because the S9a
 *   first-party ADAPTER exemption fired.
 * - Registers into a registry that ALSO carries a stand-in for a SIBLING
 *   platform (`createDefaultSurfacePluginRegistry` composes zero adapters
 *   now — see that function's doc) to prove a second platform registers
 *   into the SAME registry instance without disturbing the first.
 * - Constructs a REAL `DiscordAdapter` through the loaded plugin's
 *   `createAdapter` and asserts it behaves correctly (platform id,
 *   instanceId, and a deny-by-default `resolveAccess` when no policy port
 *   is supplied) — not just that the shape validation passed.
 * - Discord carries a SECRET (`token`, the bot token) unlike web — every
 *   test that can throw asserts the thrown message never echoes the fake
 *   secret value, mirroring `registry.test.ts`'s existing "never echoes the
 *   secret" discipline and `loader.slack-bundle.test.ts`'s equivalent.
 * - `groupBindings` (Discord's non-default, token-keyed grouping — the ONE
 *   platform with this contract, see `token-groups.ts`'s doc) is exercised
 *   via `buildGatewayAdapters`: two distinct tokens produce two distinct
 *   `discord:<guildId>` instance ids.
 *
 * Out of scope: standing up a live daemon/dev-stack boot, or any real
 * Discord gateway connection — this loader-level test (discover → gate →
 * import → register → construct) is the proof; `cortex.ts`'s boot sequence
 * calls this exact pipeline unchanged.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { loadExternalPlugins } from "../loader";
import { createDefaultSurfacePluginRegistry, validateSurfacesAgainstRegistry, type AdapterPlugin } from "../registry";

/**
 * cortex#1797 (S12 MOVE) — `createDefaultSurfacePluginRegistry()` composes
 * ZERO in-tree adapters (discord was the last one). The "alongside it" test
 * below only needs a placeholder occupant of a DIFFERENT platform to prove
 * a second platform registers into the SAME registry instance without
 * disturbing the first — this stub never constructs anything real.
 */
function makeSlackTestStub(): AdapterPlugin {
  return {
    kind: "adapter",
    id: "slack",
    platform: "slack",
    bindingSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    foldsIntoPresence: true,
    secretFields: ["botToken", "appToken"],
    demuxKey: () => "",
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => {
      throw new Error("makeSlackTestStub — never constructed in loader-bundle tests");
    },
  };
}

import type { ArcPackage } from "../../common/types/plugin-manifest";
import type { ArcListRunResult } from "../loader";
import type { Surfaces } from "../../common/types/surfaces";
import { buildBindingIndex, resolveBinding } from "../../gateway/binding-resolver";
import { buildGatewayAdapters } from "../../gateway/gateway-adapters";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures");
const DISCORD_BUNDLE_REPO_URL = "https://github.com/the-metafactory/metafactory-cortex-adapter-discord";

// Fake secret — real-shaped (a non-empty string, all `DiscordBindingSchema`
// requires) but obviously not a live credential. Used to assert NO error
// message ever echoes it.
const FAKE_DISCORD_TOKEN = "FAKE-discord-bot-token-1234567890abcdef";

function discordBundlePkg(): ArcPackage {
  return {
    name: "metafactory-cortex-adapter-discord",
    version: "0.1.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: DISCORD_BUNDLE_REPO_URL,
    installPath: resolve(FIXTURES_ROOT, "metafactory-cortex-adapter-discord"),
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

describe("transparent upgrade E2E — the real metafactory-cortex-adapter-discord bundle loads flag-OFF as first-party (cortex#1797 S12)", () => {
  test("cortex's REAL arc-manifest.yaml declares the discord bundle, so it loads with system.plugins.external OFF", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // Sanity precondition: discord is NOT one of the in-tree plugins any
    // more (cortex#1797 S12 MOVE deleted src/adapters/discord/) — if this
    // ever fails, the test below would trivially pass for the WRONG reason
    // (duplicate-id gate refusing an already-registered "discord", not the
    // exemption firing).
    expect(registry.getAdapter("discord")).toBeUndefined();

    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false, // the secure default — no principal opt-in
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([discordBundlePkg()]),
      // cortexManifestPath intentionally OMITTED — reads the REAL
      // repo-root arc-manifest.yaml via defaultCortexManifestPath().
    });

    expect(result.discoveryIssues).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-discord", kind: "adapter", id: "discord", firstParty: true },
    ]);
  });

  test("the loaded plugin registers into the SAME registry a slack stub already lives in, alongside it", async () => {
    // The in-tree default registers ZERO adapters (cortex#1794/1795/1796/1797
    // — web/slack/mattermost/discord all out-of-tree now). Register a slack
    // stand-in ourselves so this test still proves what it always meant to:
    // a second platform (`discord`) registers into the SAME registry
    // instance alongside an already-present one, without disturbing it.
    const registry = createDefaultSurfacePluginRegistry();
    registry.registerAdapter(makeSlackTestStub());
    const beforeIds = registry.listAdapters().map((p) => p.id);
    expect(beforeIds).toEqual(["slack"]);

    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([discordBundlePkg()]),
    });

    expect(registry.listAdapters().map((p) => p.id).sort()).toEqual(["discord", "slack"]);
  });

  test("the registered plugin constructs a REAL, working DiscordAdapter — not just a shape-valid stub", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([discordBundlePkg()]),
    });

    const plugin = registry.getAdapter("discord");
    expect(plugin).toBeDefined();
    expect(plugin?.platform).toBe("discord");
    expect(plugin?.secretFields).toEqual(["token"]);
    expect(plugin?.foldsIntoPresence).toBe(true);
    // Discord is the ONE platform with non-default grouping (token-keyed —
    // see token-groups.ts's doc).
    expect(plugin?.groupBindings).toBeDefined();
    expect(plugin?.demuxKey({ guildId: "111111111111111111" })).toBe("111111111111111111");

    // Construct-only (never start()) — mirrors buildGatewayAdapters' own
    // construct-only contract, and never touches the fixture's throwing
    // createDiscordClient stand-in (see discordjs-stub.ts's module doc).
    const adapter = plugin!.createAdapter({
      instanceId: "discord:111111111111111111",
      source: { agent: "gateway" },
      presence: {
        enabled: true,
        token: FAKE_DISCORD_TOKEN,
        guildId: "111111111111111111",
        agentChannelId: "222222222222222222",
        logChannelId: "333333333333333333",
        contextDepth: 10,
        enableAgentLog: false,
        trustedBotIds: [],
        dmOwner: true,
        surfaceSubjects: [],
      },
      allowedGuildIds: new Set(["111111111111111111"]),
      presenceByGuildId: new Map(),
    });
    expect(adapter.platform).toBe("discord");
    expect(adapter.instanceId).toBe("discord:111111111111111111");

    // Deny-by-default when no policy port is supplied (the bundle's own
    // NO_POLICY_PORT fallback, cortex#1797 S12 MOVE) — proves the loaded
    // code is genuinely functional, not merely shape-valid.
    const decision = adapter.resolveAccess({
      platform: "discord",
      instanceId: "discord:111111111111111111",
      guildId: "111111111111111111",
      authorId: "U1",
      authorName: "U",
      content: "hi",
      channelId: "222222222222222222",
      attachments: [],
      timestamp: new Date(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyCode).toBe("no_policy");
    // No secret echo anywhere in the deny reason.
    expect(decision.denyReason ?? "").not.toContain(FAKE_DISCORD_TOKEN);
  });

  test("bindingSchema on the loaded plugin is the REAL DiscordBindingSchema — validates a binding end to end, no secret echo on failure", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([discordBundlePkg()]),
    });

    const plugin = registry.getAdapter("discord")!;
    const ok = plugin.bindingSchema.safeParse({
      token: FAKE_DISCORD_TOKEN,
      guildId: "111111111111111111",
      agentChannelId: "222222222222222222",
      logChannelId: "333333333333333333",
    });
    expect(ok.success).toBe(true);

    // Empty required field — the real bundle's schema `.coerce.string()`s
    // every id field, so an OMITTED key coerces `undefined` to the string
    // `"undefined"` (passes `.min(1)` by accident); an explicit empty
    // string is the reliable way to trip the real `.min(1)` guard.
    const bad = plugin.bindingSchema.safeParse({
      token: FAKE_DISCORD_TOKEN,
      guildId: "111111111111111111",
      agentChannelId: "",
      logChannelId: "333333333333333333",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const message = JSON.stringify(bad.error.issues);
      expect(message).not.toContain(FAKE_DISCORD_TOKEN);
    }
  });

  test("control: the SAME bundle does NOT load when its repoUrl is un-declared (proves the exemption is doing the work, not a blanket allow)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor(
        [discordBundlePkg()].map((pkg) => ({
          ...pkg,
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-discord",
        })),
      ),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([
      {
        bundleName: "metafactory-cortex-adapter-discord",
        kind: "adapter",
        id: "discord",
        reason: "system.plugins.external is off and this adapter bundle is not an exempt first-party bundle",
      },
    ]);
    expect(registry.getAdapter("discord")).toBeUndefined();
  });

  test("control: with the flag ON, the bundle loads regardless of declaration (the flag is the other, non-exemption path)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        {
          ...discordBundlePkg(),
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-discord",
        },
      ]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-discord", kind: "adapter", id: "discord", firstParty: false },
    ]);
  });
});

// =============================================================================
// cortex#1797 (S12, mirrors #1948 B1 class) — the CONFIG-CONSUMPTION path
// =============================================================================

/**
 * The suite above proves the LOAD path. This describe block proves the
 * CONFIG-CONSUMPTION path a real boot uses to turn a `surfaces.discord[...]`
 * binding into a routed, running adapter: `validateSurfacesAgainstRegistry`
 * (registry-pass per-field validation, including the secret field) →
 * `buildBindingIndex`/`resolveBinding` (the shared gateway's inbound
 * demux) → `buildGatewayAdapters` (construction from a REAL binding, not a
 * hand-built `DiscordCreateArgs`, exercising the token-keyed `groupBindings`
 * path) — the exact class of gap #1948's B1 finding caught for web (a
 * platform extracting out of `SurfacesSchema`'s hardcoded keys silently
 * changing behaviour for cortex-core code that still reads concrete
 * per-platform fields directly). Since the default registry is now EMPTY,
 * this describe block (together with the suite above) is the SOLE proof
 * discord works purely as a loaded bundle.
 */
describe("config-path E2E — a REAL surfaces.discord[] config survives validate → resolve → construct once the bundle loads (cortex#1797 S12)", () => {
  const RUNTIME_STUB = {
    publish: async () => {},
    onEnvelope: () => () => {},
    stop: async () => {},
  } as unknown as MyelinRuntime;

  async function loadDiscordRegistry() {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([discordBundlePkg()]),
    });
    expect(result.loaded).toHaveLength(1);
    return registry;
  }

  // A genuine `surfaces.discord[]` entry, shaped exactly as a principal's
  // surfaces.yaml would declare it — NOT a hand-built DiscordCreateArgs.
  function discordSurfacesConfig(guildId: string, token = FAKE_DISCORD_TOKEN): Surfaces {
    return {
      discord: [
        {
          agent: "luna",
          binding: {
            token,
            guildId,
            agentChannelId: "222222222222222222",
            logChannelId: "333333333333333333",
          },
        },
      ],
    };
  }

  test("validateSurfacesAgainstRegistry accepts a valid surfaces.discord[] entry once the bundle is loaded, and rejects an invalid one without echoing the secret", async () => {
    const registry = await loadDiscordRegistry();

    expect(() =>
      validateSurfacesAgainstRegistry(discordSurfacesConfig("111111111111111111"), registry),
    ).not.toThrow();

    // Empty required agentChannelId — the REAL bundle's
    // DiscordBindingSchema (not a fixture stand-in) must reject this at the
    // registry pass. (`.coerce.string()` turns an OMITTED key's `undefined`
    // into the string `"undefined"`, which passes `.min(1)` by accident —
    // an explicit empty string reliably trips the real guard.)
    const invalid: Surfaces = {
      discord: [
        {
          agent: "luna",
          binding: {
            token: FAKE_DISCORD_TOKEN,
            guildId: "111111111111111111",
            agentChannelId: "",
            logChannelId: "333333333333333333",
          },
        },
      ],
    };
    let thrown: unknown;
    try {
      validateSurfacesAgainstRegistry(invalid, registry);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/surfaces\.discord\[0\]\.binding is invalid/);
    // No secret echo — the token never appears in the thrown message.
    expect(message).not.toContain(FAKE_DISCORD_TOKEN);
  });

  test("buildBindingIndex + resolveBinding demux a real discord binding to the right agent", async () => {
    // cortex#1951 — buildBindingIndex derives the discord demux key via
    // this registry's registered `discord` plugin `demuxKey`, not a
    // hardcoded `binding.guildId` read.
    const registry = await loadDiscordRegistry();
    const surfaces = discordSurfacesConfig("111111111111111111");

    const index = buildBindingIndex(surfaces, registry);
    expect(index.discord.size).toBe(1);
    expect(index.discord.get("111111111111111111")?.agent).toBe("luna");

    const match = resolveBinding(index, {
      platform: "discord",
      instanceId: "discord:111111111111111111",
      guildId: "111111111111111111",
      authorId: "U1",
      authorName: "U",
      content: "hi",
      channelId: "222222222222222222",
      attachments: [],
      timestamp: new Date(),
    });
    expect(match).not.toBeNull();
    expect(match?.agent).toBe("luna");
    expect(match?.platform).toBe("discord");
  });

  test("buildGatewayAdapters constructs a REAL DiscordAdapter from the config, with the right instanceId, once the bundle is registered", async () => {
    const registry = await loadDiscordRegistry();
    const surfaces = discordSurfacesConfig("111111111111111111");

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
    expect(adapter.platform).toBe("discord");
    expect(adapter.instanceId).toBe("discord:111111111111111111");
  });

  test("two distinct-token discord guild bindings survive the whole config path with distinct instanceIds (token-keyed groupBindings)", async () => {
    const registry = await loadDiscordRegistry();
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            token: "FAKE-discord-token-luna-0000000000",
            guildId: "111111111111111111",
            agentChannelId: "222222222222222222",
            logChannelId: "333333333333333333",
          },
        },
        {
          agent: "sage",
          stack: "andreas/work",
          binding: {
            token: "FAKE-discord-token-sage-0000000000",
            guildId: "444444444444444444",
            agentChannelId: "555555555555555555",
            logChannelId: "666666666666666666",
          },
        },
      ],
    };
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();

    const index = buildBindingIndex(surfaces, registry);
    expect([...index.discord.keys()].sort()).toEqual([
      "111111111111111111",
      "444444444444444444",
    ]);

    const adapters = buildGatewayAdapters(surfaces, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      registry,
    });
    // Distinct tokens → distinct gateway sessions → one instance per guild
    // (token-keyed groupBindings only collapses SAME-token guilds — see
    // token-groups.ts's doc), same shape the pre-registry factory produced.
    expect(adapters.map((a) => a.instanceId).sort()).toEqual([
      "discord:111111111111111111",
      "discord:444444444444444444",
    ]);
  });

  test("two guild bindings sharing the SAME discord token collapse into ONE token-scoped gateway adapter", async () => {
    const registry = await loadDiscordRegistry();
    const sharedToken = "FAKE-discord-token-shared-00000000";
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "juniper",
          stack: "jc/default",
          binding: {
            token: sharedToken,
            guildId: "111111111111111111",
            agentChannelId: "222222222222222222",
            logChannelId: "333333333333333333",
          },
        },
        {
          agent: "juniper",
          stack: "jc/default",
          binding: {
            token: sharedToken,
            guildId: "444444444444444444",
            agentChannelId: "555555555555555555",
            logChannelId: "666666666666666666",
          },
        },
      ],
    };
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();

    const adapters = buildGatewayAdapters(surfaces, {
      principal: "jc",
      runtime: RUNTIME_STUB,
      registry,
    });
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.instanceId).toMatch(/^discord:token:[0-9a-f]{12}$/);
  });
});
