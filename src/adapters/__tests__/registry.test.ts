/**
 * cortex#1788 (S3, ADR-0024 D5) — `SurfacePluginRegistry` + in-tree plugin
 * descriptor tests.
 *
 * `buildGatewayAdapters` (`src/gateway/__tests__/gateway-adapters.test.ts`)
 * and `wireSurfaceAdapters` (`src/runner/__tests__/surface-adapter-boot.test.ts`)
 * already exercise construction END-TO-END through these plugins. This file
 * pins the registry primitive itself — register/get/list, duplicate-id
 * rejection, and the SHAPE of each in-tree plugin descriptor (id, platform/
 * rendererKind, demuxKey, secretFields, groupBindings presence) so a future
 * change to any one plugin's metadata fails a fast, targeted test instead of
 * only showing up as a construction-behavior regression three layers away.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  SurfacePluginRegistry,
  createDefaultSurfacePluginRegistry,
  validateSurfacesAgainstRegistry,
  resolveAdapterPluginOrThrow,
  resolveRendererPluginOrThrow,
  type AdapterPlugin,
  type RendererPlugin,
} from "../registry";
import type { Surfaces } from "../../common/types/surfaces";

// cortex#1797 (S12 MOVE) — `discordAdapterPlugin`'s descriptor no longer
// lives in-tree (extracted to `metafactory-cortex-adapter-discord`, the
// FOURTH and FINAL in-tree adapter). Tests below that need a "discord"
// registry entry build their own minimal stub via this helper, same
// workaround the web/slack/mattermost precedents already established.
function makeDiscordStubPlugin(
  overrides: Partial<import("../registry").AdapterPlugin> = {},
): AdapterPlugin {
  return {
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
    demuxKey: (binding) => (typeof binding.guildId === "string" ? binding.guildId : ""),
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => {
      throw new Error("stub — never constructed in this test");
    },
    ...overrides,
  };
}

// cortex#1789 (S4) — `bindingSchema`/`configSchema` are real `z.ZodType`s
// now, not inert `unknown` placeholders; stubs use a permissive `z.unknown()`
// since these tests exercise registry primitives, not schema validation.
function makeStubAdapterPlugin(id: string): AdapterPlugin {
  return {
    kind: "adapter",
    id,
    platform: id,
    bindingSchema: z.unknown(),
    foldsIntoPresence: false,
    secretFields: [],
    demuxKey: () => id,
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => {
      throw new Error("stub — never constructed in this test");
    },
  };
}

function makeStubRendererPlugin(id: string): RendererPlugin {
  return {
    kind: "renderer",
    id,
    rendererKind: id,
    configSchema: z.unknown(),
    createRenderer: () => {
      throw new Error("stub — never constructed in this test");
    },
  };
}

describe("SurfacePluginRegistry", () => {
  test("registers and retrieves an adapter plugin by id", () => {
    const registry = new SurfacePluginRegistry();
    const plugin = makeStubAdapterPlugin("fake-platform");
    registry.registerAdapter(plugin);
    expect(registry.getAdapter("fake-platform")).toBe(plugin);
    expect(registry.getAdapter("nonexistent")).toBeUndefined();
  });

  test("registers and retrieves a renderer plugin by id", () => {
    const registry = new SurfacePluginRegistry();
    const plugin = makeStubRendererPlugin("fake-renderer");
    registry.registerRenderer(plugin);
    expect(registry.getRenderer("fake-renderer")).toBe(plugin);
    expect(registry.getRenderer("nonexistent")).toBeUndefined();
  });

  test("adapter and renderer namespaces are independent — same id in both kinds does not collide", () => {
    const registry = new SurfacePluginRegistry();
    registry.registerAdapter(makeStubAdapterPlugin("dashboard"));
    registry.registerRenderer(makeStubRendererPlugin("dashboard"));
    expect(registry.getAdapter("dashboard")?.kind).toBe("adapter");
    expect(registry.getRenderer("dashboard")?.kind).toBe("renderer");
  });

  test("registering a duplicate adapter id throws", () => {
    const registry = new SurfacePluginRegistry();
    registry.registerAdapter(makeStubAdapterPlugin("dup"));
    expect(() => registry.registerAdapter(makeStubAdapterPlugin("dup"))).toThrow(/already registered/);
  });

  test("registering a duplicate renderer id throws", () => {
    const registry = new SurfacePluginRegistry();
    registry.registerRenderer(makeStubRendererPlugin("dup"));
    expect(() => registry.registerRenderer(makeStubRendererPlugin("dup"))).toThrow(/already registered/);
  });

  test("listAdapters/listRenderers return insertion order", () => {
    const registry = new SurfacePluginRegistry();
    registry.registerAdapter(makeStubAdapterPlugin("a"));
    registry.registerAdapter(makeStubAdapterPlugin("b"));
    registry.registerRenderer(makeStubRendererPlugin("x"));
    registry.registerRenderer(makeStubRendererPlugin("y"));
    expect(registry.listAdapters().map((p) => p.id)).toEqual(["a", "b"]);
    expect(registry.listRenderers().map((p) => p.id)).toEqual(["x", "y"]);
  });
});

describe("createDefaultSurfacePluginRegistry", () => {
  test("registers ZERO in-tree adapters (cortex#1794 S9 web + cortex#1795 S10 slack + cortex#1796 S11 mattermost + cortex#1797 S12 discord all extracted to bundles)", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(registry.listAdapters()).toEqual([]);
  });

  test("registers exactly the 1 in-tree renderer, dashboard (pagerduty extracted, cortex#1894 S12b)", () => {
    const registry = createDefaultSurfacePluginRegistry();
    // cortex#1894 (S12b) — `pagerduty` extracted to the
    // `metafactory-cortex-renderer-pagerduty` bundle; `dashboard` is the only
    // never-extracted in-tree renderer (OQ8 anchor).
    expect(registry.listRenderers().map((p) => p.id)).toEqual(["dashboard"]);
  });

  test("does NOT register cli-tail or webhook-out (S6 owns shipping them as bundles)", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(registry.getRenderer("cli-tail")).toBeUndefined();
    expect(registry.getRenderer("webhook-out")).toBeUndefined();
  });
});

describe("in-tree AdapterPlugin descriptors — shape", () => {
  // cortex#1795 (S10 MOVE) — `slack`'s descriptor now lives in the
  // `metafactory-cortex-adapter-slack` bundle (not importable here); its
  // shape is pinned by that repo's own standalone test suite instead (same
  // pattern as `web`, cortex#1794 S9 MOVE, below).

  // cortex#1794 (S9 MOVE) — `web`'s descriptor now lives in the
  // `metafactory-cortex-adapter-web` bundle (not importable here); its
  // shape is pinned by that repo's own standalone test suite instead.
  //
  // cortex#1796 (S11 MOVE) — `mattermost`'s descriptor (platform id,
  // apiToken secret, demuxKey <unset> fallback) now lives in the
  // `metafactory-cortex-adapter-mattermost` bundle's own `src/__tests__/`
  // suite, same reasoning. `loader.mattermost-bundle.test.ts`'s "constructs
  // a REAL, working MattermostAdapter" test re-asserts the same shape
  // against the LOADED (bundle) plugin, so the coverage isn't lost, only
  // relocated to where the code now lives.
  //
  // cortex#1797 (S12 MOVE) — `discord`'s descriptor (platform id, token-field
  // secret, groupBindings token-grouping, demuxKey guildId fallback) is the
  // FOURTH and FINAL one to move: it now lives in the
  // `metafactory-cortex-adapter-discord` bundle's own `src/__tests__/` suite
  // (`token-groups.ts`'s grouping behaviour, `schema.ts`'s binding schema).
  // `loader.discord-bundle.test.ts`'s "constructs a REAL, working
  // DiscordAdapter" test re-asserts the same shape against the LOADED
  // (bundle) plugin, same reasoning as mattermost above.
});

// =============================================================================
// cortex#1789 (S4, ADR-0024 D5) — registry-pass validation
// =============================================================================

describe("in-tree AdapterPlugin descriptors — foldsIntoPresence (ADR-0024 D5 scope item 3)", () => {
  // cortex#1797 (S12 MOVE) — "discord DOES fold" is no longer assertable
  // against an in-tree `discordAdapterPlugin.foldsIntoPresence` here; it's
  // pinned by the `metafactory-cortex-adapter-discord` bundle's own test
  // suite, and by `src/common/config/__tests__/surfaces-layer.test.ts`'s
  // end-to-end `surfaces.discord[]` → `agents[*].presence.discord` fold
  // coverage (which exercises `DEFAULT_FOLD_PLATFORMS` directly, the
  // cortex-owned constant that still lists "discord" — see
  // `common/types/surfaces.ts`).
  //
  // cortex#1794 (S9 MOVE) — "web does NOT fold" is now pinned by the
  // `metafactory-cortex-adapter-web` bundle's own test suite; there is no
  // in-tree `webAdapterPlugin` left to assert against here.
  //
  // cortex#1795 (S10 MOVE) — "slack DOES fold" (unchanged behaviour, unlike
  // web) is likewise no longer assertable against an in-tree
  // `slackAdapterPlugin.foldsIntoPresence` here; it's pinned by the
  // `metafactory-cortex-adapter-slack` bundle's own test suite, and by
  // `src/common/config/__tests__/surfaces-layer.test.ts`'s end-to-end
  // `surfaces.slack[]` → `agents[*].presence.slack` fold coverage (which
  // exercises `DEFAULT_FOLD_PLATFORMS` directly, the cortex-owned constant
  // that still lists "slack" — see `common/types/surfaces.ts`).
  //
  // cortex#1796 (S11 MOVE) — "mattermost DOES fold" is now pinned by the
  // `metafactory-cortex-adapter-mattermost` bundle's own test suite AND by
  // `src/common/config/__tests__/loader.test.ts`'s fold-behavior coverage
  // (`defaultFoldPlatforms()` unions the registry-derived list with
  // `DEFAULT_FOLD_PLATFORMS` specifically so this out-of-tree platform's
  // fold contract survives — see that function's doc).
});

describe("resolveAdapterPluginOrThrow", () => {
  test("resolves an installed platform", () => {
    // cortex#1797 (S12 MOVE) — the default registry has ZERO in-tree
    // adapters now; register a discord stub first (the documented
    // stub-registration workaround used throughout this suite).
    const registry = createDefaultSurfacePluginRegistry();
    const stub = makeDiscordStubPlugin();
    registry.registerAdapter(stub);
    expect(resolveAdapterPluginOrThrow("discord", registry)).toBe(stub);
  });

  test("unknown platform throws, naming the key and the installed set", () => {
    const registry = createDefaultSurfacePluginRegistry();
    registry.registerAdapter(makeDiscordStubPlugin());
    expect(() => resolveAdapterPluginOrThrow("discrod", registry)).toThrow(
      /no adapter installed for platform "discrod".*installed: discord/,
    );
  });
});

describe("resolveRendererPluginOrThrow", () => {
  test("resolves an installed renderer kind", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(resolveRendererPluginOrThrow("dashboard", registry).id).toBe("dashboard");
  });

  test("unregistered kind (cli-tail — S6 territory) throws, naming the kind and the installed set", () => {
    const registry = createDefaultSurfacePluginRegistry();
    // cortex#1894 (S12b) — pagerduty extracted; only dashboard remains in-tree.
    expect(() => resolveRendererPluginOrThrow("cli-tail", registry)).toThrow(
      /no renderer installed for kind "cli-tail".*installed: dashboard/,
    );
  });
});

describe("validateSurfacesAgainstRegistry", () => {
  // cortex#1797 (S12 MOVE) — register a discord stub since the default
  // registry no longer carries one in-tree.
  const registry = createDefaultSurfacePluginRegistry();
  registry.registerAdapter(makeDiscordStubPlugin());

  test("undefined surfaces is a no-op", () => {
    expect(() => validateSurfacesAgainstRegistry(undefined, registry)).not.toThrow();
  });

  test("a valid discord binding passes", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "ivy",
          binding: { token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" },
        },
      ],
    };
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).not.toThrow();
  });

  test("an unknown top-level platform key throws — same loudness as the old .strict()", () => {
    // The STRUCTURAL schema (`SurfacesSchema`) no longer rejects this key on
    // its own (cortex#1789 catchall change) — this is the seam that now does.
    const surfaces = { discrod: [{ agent: "ivy", binding: {} }] } as unknown as Surfaces;
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).toThrow(
      /no adapter installed for platform "discrod"/,
    );
  });

  test("a structurally-valid but field-invalid discord binding throws, and never echoes the secret", () => {
    // Deliberately WRONG TYPE on `token` (a number, not a string) — a cast
    // is needed since `Surfaces["discord"]` is strongly typed
    // (DiscordSurfaceBinding) and would reject this at compile time; this
    // simulates a raw value that has already cleared the STRUCTURAL pass
    // (any record satisfies `binding: z.record(...)`) but not the REGISTRY
    // pass this test exercises. NOTE: `guildId`/`agentChannelId`/
    // `logChannelId` use `z.coerce.string()` on `DiscordBindingSchema` — an
    // absent value coerces to the (non-empty!) string `"undefined"` rather
    // than failing requiredness, so a MISSING field doesn't reliably fail
    // here; `token` (plain `z.string()`, no coerce) is the reliable failure
    // trigger, and its would-be-secret value (a number, so certainly not the
    // real secret string) lets this test also confirm the thrown message
    // never echoes the offending value.
    const surfaces = {
      discord: [
        {
          agent: "ivy",
          binding: { token: 999999, guildId: "1", agentChannelId: "2", logChannelId: "3" },
        },
      ],
    } as unknown as Surfaces;
    expect(() => validateSurfacesAgainstRegistry(surfaces, registry)).toThrow(
      /surfaces\.discord\[0\]\.binding is invalid/,
    );
    try {
      validateSurfacesAgainstRegistry(surfaces, registry);
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toContain("999999");
    }
  });
});
