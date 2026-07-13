/**
 * cortex#1795 (S10 MOVE) — the TRANSPARENT-UPGRADE end-to-end proof for
 * Slack, mirroring `loader.web-bundle.test.ts`'s S9 proof structure.
 *
 * This is the load-bearing deliverable of the S10 MOVE slice: proof that
 * extracting the Slack adapter out of cortex core into the
 * `metafactory-cortex-adapter-slack` bundle is NON-BREAKING. A stack that
 * already had `surfaces.slack[...]` configured, upgraded via `arc upgrade
 * cortex` (which auto-installs the newly-declared dependency), keeps
 * working with ZERO config change and WITHOUT the principal ever flipping
 * `system.plugins.external` on.
 *
 * ## What this test actually exercises (and what it deliberately does NOT)
 *
 * - `pkgRoot` points at `./fixtures` (the SAME trusted root every other
 *   loader test uses) and `installPath` resolves to
 *   `./fixtures/metafactory-cortex-adapter-slack/` — a byte-identical copy
 *   of the real, already-pushed `metafactory-cortex-adapter-slack` bundle
 *   repo's `cortex-plugin.yaml` + `src/index.ts` + `src/plugin.ts` +
 *   `src/schema.ts`. `src/client.ts` is the ONE exception — see that
 *   file's own module doc: it's a fixture-local stand-in that avoids a
 *   top-level `@slack/socket-mode`/`@slack/web-api` import (both packages
 *   left cortex's OWN `package.json` in this same S10 slice, so importing
 *   them from a fixture living inside cortex's `src/` tree — no separate
 *   `node_modules` of its own — would only resolve by accident on a
 *   not-yet-pruned local install and break on a genuinely clean one, e.g.
 *   CI). No test below calls `.start()`/`.postMessage()` on a
 *   `RealSlackClient`, so the stand-in's throwing methods never fire.
 * - `runner` fabricates the `arc list --json` entry an `arc upgrade cortex`
 *   auto-install of the declared dependency would produce.
 * - `cortexManifestPath` is **deliberately left unset** — the loader reads
 *   cortex's OWN REAL `arc-manifest.yaml` (`defaultCortexManifestPath()`),
 *   which this same S10 slice edited to declare
 *   `metafactory-cortex-adapter-slack` under `dependencies:`.
 * - `externalEnabled: false` — the default-off `system.plugins.external`
 *   posture. If the bundle loads anyway, it can ONLY be because the S9a
 *   first-party ADAPTER exemption fired.
 * - Registers into a registry that ALSO carries the real in-tree
 *   discord/mattermost plugins (`createDefaultSurfacePluginRegistry`),
 *   matching cortex's real boot sequence.
 * - Constructs a REAL `SlackAdapter` through the loaded plugin's
 *   `createAdapter` and asserts it behaves correctly (platform id, and a
 *   deny-by-default `resolveAccess` when no policy port is supplied) — not
 *   just that the shape validation passed.
 * - Slack carries SECRETS (`botToken`/`appToken`) unlike web — every test
 *   that can throw asserts the thrown message never echoes the fake secret
 *   value, mirroring `registry.test.ts`'s existing "never echoes the
 *   secret" discipline for discord's `token`.
 *
 * Out of scope: standing up a live daemon/dev-stack boot, or any real
 * Socket Mode connection — this loader-level test (discover → gate →
 * import → register → construct) is the proof; `cortex.ts`'s boot sequence
 * calls this exact pipeline unchanged.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { loadExternalPlugins } from "../loader";
import { createDefaultSurfacePluginRegistry, validateSurfacesAgainstRegistry, type AdapterPlugin } from "../registry";

/**
 * cortex#1797 (S12 MOVE) — `createDefaultSurfacePluginRegistry()` composes
 * ZERO in-tree adapters now (discord was the last one). The "alongside it"
 * test below only needs a placeholder occupant to prove a SECOND platform
 * registers into the SAME registry instance without disturbing the first —
 * this stub never constructs anything real.
 */
function makeDiscordTestStub(): AdapterPlugin {
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
      throw new Error("makeDiscordTestStub — never constructed in loader-bundle tests");
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
const SLACK_BUNDLE_REPO_URL = "https://github.com/the-metafactory/metafactory-cortex-adapter-slack";

// Fake secrets — real-shaped (pass the bundle's own regex) but obviously
// not live credentials. Used to assert NO error message ever echoes them.
const FAKE_BOT_TOKEN = "xoxb-FAKE-1234-5678-abcdefFAKE01";
const FAKE_APP_TOKEN = "xapp-FAKE-1234-5678-abcdefFAKE02";

function slackBundlePkg(): ArcPackage {
  return {
    name: "metafactory-cortex-adapter-slack",
    version: "0.1.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: SLACK_BUNDLE_REPO_URL,
    installPath: resolve(FIXTURES_ROOT, "metafactory-cortex-adapter-slack"),
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

describe("transparent upgrade E2E — the real metafactory-cortex-adapter-slack bundle loads flag-OFF as first-party (cortex#1795 S10)", () => {
  test("cortex's REAL arc-manifest.yaml declares the slack bundle, so it loads with system.plugins.external OFF", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // Sanity precondition: slack is NOT one of the in-tree plugins any more
    // (cortex#1795 S10 MOVE deleted src/adapters/slack/) — if this ever
    // fails, the test below would trivially pass for the WRONG reason
    // (duplicate-id gate refusing an already-registered "slack", not the
    // exemption firing).
    expect(registry.getAdapter("slack")).toBeUndefined();

    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false, // the secure default — no principal opt-in
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([slackBundlePkg()]),
      // cortexManifestPath intentionally OMITTED — reads the REAL
      // repo-root arc-manifest.yaml via defaultCortexManifestPath().
    });

    expect(result.discoveryIssues).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-slack", kind: "adapter", id: "slack", firstParty: true },
    ]);
  });

  test("the loaded plugin registers into the SAME registry a discord stub already lives in, alongside it", async () => {
    // cortex#1796/#1797 (S11/S12 MOVE) — `mattermost` AND `discord` are both
    // out-of-tree now; the in-tree default registers ZERO adapters. Register
    // a discord stand-in ourselves so this test still proves what it always
    // meant to: a second platform (`slack`) registers into the SAME registry
    // instance alongside an already-present one, without disturbing it.
    const registry = createDefaultSurfacePluginRegistry();
    registry.registerAdapter(makeDiscordTestStub());
    const beforeIds = registry.listAdapters().map((p) => p.id);
    expect(beforeIds).toEqual(["discord"]);

    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([slackBundlePkg()]),
    });

    expect(registry.listAdapters().map((p) => p.id)).toEqual(["discord", "slack"]);
  });

  test("the registered plugin constructs a REAL, working SlackAdapter — not just a shape-valid stub", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([slackBundlePkg()]),
    });

    const plugin = registry.getAdapter("slack");
    expect(plugin).toBeDefined();
    expect(plugin?.platform).toBe("slack");
    expect(plugin?.secretFields).toEqual(["botToken", "appToken"]);
    expect(plugin?.foldsIntoPresence).toBe(true);
    expect(plugin?.groupBindings).toBeUndefined();
    expect(plugin?.demuxKey({ workspaceId: "T0123456789" })).toBe("T0123456789");

    // Construct-only (never start()) — mirrors buildGatewayAdapters' own
    // construct-only contract, and never touches the fixture's throwing
    // RealSlackClient stand-in (see that file's module doc).
    const adapter = plugin!.createAdapter({
      instanceId: "slack:T0123456789",
      source: { agent: "gateway" },
      presence: {
        enabled: true,
        botToken: FAKE_BOT_TOKEN,
        appToken: FAKE_APP_TOKEN,
        workspaceId: "T0123456789",
        channels: [{ id: "C0123456789", name: "general" }],
        allowedUserIds: [],
        trustedBotIds: [],
        surfaceSubjects: [],
      },
    });
    expect(adapter.platform).toBe("slack");
    expect(adapter.instanceId).toBe("slack:T0123456789");

    // Deny-by-default when no policy port is supplied (the bundle's own
    // NO_POLICY_PORT fallback, cortex#1795 S10 MOVE) — proves the loaded
    // code is genuinely functional, not merely shape-valid.
    const decision = adapter.resolveAccess({
      platform: "slack",
      instanceId: "slack:T0123456789",
      authorId: "U1",
      authorName: "U",
      content: "hi",
      channelId: "C0123456789",
      attachments: [],
      timestamp: new Date(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyCode).toBe("no_policy");
    // No secret echo anywhere in the deny reason.
    expect(decision.denyReason ?? "").not.toContain(FAKE_BOT_TOKEN);
    expect(decision.denyReason ?? "").not.toContain(FAKE_APP_TOKEN);
  });

  test("bindingSchema on the loaded plugin is the REAL SlackBindingSchema — validates a binding end to end, no secret echo on failure", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([slackBundlePkg()]),
    });

    const plugin = registry.getAdapter("slack")!;
    const ok = plugin.bindingSchema.safeParse({
      botToken: FAKE_BOT_TOKEN,
      appToken: FAKE_APP_TOKEN,
      workspaceId: "T0123456789",
    });
    expect(ok.success).toBe(true);

    // Malformed botToken (real bundle's regex requires xoxb- prefix).
    const bad = plugin.bindingSchema.safeParse({
      botToken: "not-a-real-token",
      appToken: FAKE_APP_TOKEN,
      workspaceId: "T0123456789",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const message = JSON.stringify(bad.error.issues);
      expect(message).not.toContain(FAKE_APP_TOKEN);
    }
  });

  test("control: the SAME bundle does NOT load when its repoUrl is un-declared (proves the exemption is doing the work, not a blanket allow)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor(
        [slackBundlePkg()].map((pkg) => ({
          ...pkg,
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-slack",
        })),
      ),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([
      {
        bundleName: "metafactory-cortex-adapter-slack",
        kind: "adapter",
        id: "slack",
        reason: "system.plugins.external is off and this adapter bundle is not an exempt first-party bundle",
      },
    ]);
    expect(registry.getAdapter("slack")).toBeUndefined();
  });

  test("control: with the flag ON, the bundle loads regardless of declaration (the flag is the other, non-exemption path)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        {
          ...slackBundlePkg(),
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-not-slack",
        },
      ]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-adapter-slack", kind: "adapter", id: "slack", firstParty: false },
    ]);
  });
});

// =============================================================================
// cortex#1795 (S10, mirrors #1948 B1 class) — the CONFIG-CONSUMPTION path
// =============================================================================

/**
 * The suite above proves the LOAD path. This describe block proves the
 * CONFIG-CONSUMPTION path a real boot uses to turn a `surfaces.slack[...]`
 * binding into a routed, running adapter: `validateSurfacesAgainstRegistry`
 * (registry-pass per-field validation, including the secret fields) →
 * `buildBindingIndex`/`resolveBinding` (the shared gateway's inbound
 * demux) → `buildGatewayAdapters` (construction from a REAL binding, not a
 * hand-built `SlackCreateArgs`) — the exact class of gap #1948's B1 finding
 * caught for web (a platform extracting out of `SurfacesSchema`'s hardcoded
 * keys silently changing behaviour for cortex-core code that still reads
 * concrete per-platform fields directly).
 */
describe("config-path E2E — a REAL surfaces.slack[] config survives validate → resolve → construct once the bundle loads (cortex#1795 S10)", () => {
  const RUNTIME_STUB = {
    publish: async () => {},
    onEnvelope: () => () => {},
    stop: async () => {},
  } as unknown as MyelinRuntime;

  async function loadSlackRegistry() {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([slackBundlePkg()]),
    });
    expect(result.loaded).toHaveLength(1);
    return registry;
  }

  // A genuine `surfaces.slack[]` entry, shaped exactly as a principal's
  // surfaces.yaml would declare it — NOT a hand-built SlackCreateArgs.
  function slackSurfacesConfig(workspaceId: string): Surfaces {
    return {
      slack: [
        {
          agent: "ivy",
          binding: {
            botToken: FAKE_BOT_TOKEN,
            appToken: FAKE_APP_TOKEN,
            workspaceId,
          },
        },
      ],
    };
  }

  test("validateSurfacesAgainstRegistry accepts a valid surfaces.slack[] entry once the bundle is loaded, and rejects an invalid one without echoing the secret", async () => {
    const registry = await loadSlackRegistry();

    expect(() =>
      validateSurfacesAgainstRegistry(slackSurfacesConfig("T0123456789"), registry),
    ).not.toThrow();

    // Malformed appToken — the REAL bundle's SlackBindingSchema (not a
    // fixture stand-in) must reject this at the registry pass.
    const invalid: Surfaces = {
      slack: [
        {
          agent: "ivy",
          binding: { botToken: FAKE_BOT_TOKEN, appToken: "not-an-app-token", workspaceId: "T0123456789" },
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
    expect(message).toMatch(/surfaces\.slack\[0\]\.binding is invalid/);
    // No secret echo — neither the malformed value nor the valid botToken
    // ever appears in the thrown message.
    expect(message).not.toContain("not-an-app-token");
    expect(message).not.toContain(FAKE_BOT_TOKEN);
  });

  test("buildBindingIndex + resolveBinding demux a real slack binding to the right agent", async () => {
    // cortex#1951 — buildBindingIndex derives the slack demux key via this
    // registry's registered `slack` plugin `demuxKey`, not a hardcoded
    // `binding.workspaceId` read.
    const registry = await loadSlackRegistry();
    const surfaces = slackSurfacesConfig("T0123456789");

    const index = buildBindingIndex(surfaces, registry);
    expect(index.slack.size).toBe(1);
    expect(index.slack.get("T0123456789")?.agent).toBe("ivy");

    const match = resolveBinding(index, {
      platform: "slack",
      instanceId: "slack:T0123456789",
      guildId: "T0123456789", // Slack workspaceId maps to guildId on InboundMessage
      authorId: "U1",
      authorName: "U",
      content: "hi",
      channelId: "C0123456789",
      attachments: [],
      timestamp: new Date(),
    });
    expect(match).not.toBeNull();
    expect(match?.agent).toBe("ivy");
    expect(match?.platform).toBe("slack");
  });

  test("buildGatewayAdapters constructs a REAL SlackAdapter from the config, with the right instanceId, once the bundle is registered", async () => {
    const registry = await loadSlackRegistry();
    const surfaces = slackSurfacesConfig("T0123456789");

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
    expect(adapter.platform).toBe("slack");
    expect(adapter.instanceId).toBe("slack:T0123456789");
  });

  test("two distinct slack workspace bindings survive the whole config path with distinct instanceIds", async () => {
    const registry = await loadSlackRegistry();
    const surfaces: Surfaces = {
      slack: [
        {
          agent: "ivy",
          binding: { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, workspaceId: "T0111111111" },
        },
        {
          agent: "oak",
          binding: { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, workspaceId: "T0222222222" },
        },
      ],
    };
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();

    const index = buildBindingIndex(surfaces, registry);
    expect([...index.slack.keys()].sort()).toEqual(["T0111111111", "T0222222222"]);

    const adapters = buildGatewayAdapters(surfaces, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      registry,
    });
    expect(adapters.map((a) => a.instanceId).sort()).toEqual([
      "slack:T0111111111",
      "slack:T0222222222",
    ]);
  });
});
