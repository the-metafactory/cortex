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
  registryFromFactory,
  registryToLegacyFactory,
  validateSurfacesAgainstRegistry,
  resolveAdapterPluginOrThrow,
  resolveRendererPluginOrThrow,
  type AdapterPlugin,
  type RendererPlugin,
} from "../registry";
import { discordAdapterPlugin } from "../discord/plugin";
import { slackAdapterPlugin } from "../slack/plugin";
import { mattermostAdapterPlugin } from "../mattermost/plugin";
import type { Surfaces } from "../../common/types/surfaces";

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
  test("registers exactly the 3 in-tree adapters, discord→slack→mattermost (cortex#1794 S9 — web extracted to a bundle)", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(registry.listAdapters().map((p) => p.id)).toEqual([
      "discord",
      "slack",
      "mattermost",
    ]);
  });

  test("registers exactly the 2 in-tree renderers, dashboard→pagerduty", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(registry.listRenderers().map((p) => p.id)).toEqual(["dashboard", "pagerduty"]);
  });

  test("does NOT register cli-tail or webhook-out (S6 owns shipping them as bundles)", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(registry.getRenderer("cli-tail")).toBeUndefined();
    expect(registry.getRenderer("webhook-out")).toBeUndefined();
  });
});

describe("in-tree AdapterPlugin descriptors — shape", () => {
  test("discord: platform id, token-field secret, groupBindings present (token-grouping)", () => {
    expect(discordAdapterPlugin.platform).toBe("discord");
    expect(discordAdapterPlugin.id).toBe("discord");
    expect(discordAdapterPlugin.secretFields).toEqual(["token"]);
    expect(typeof discordAdapterPlugin.groupBindings).toBe("function");
  });

  test("discord: demuxKey falls back to guildId (ungrouped spec-completeness path)", () => {
    expect(discordAdapterPlugin.demuxKey({ guildId: "123" })).toBe("123");
    expect(discordAdapterPlugin.demuxKey({})).toBe("");
  });

  test("discord: groupBindings groups same-token bindings, one group per distinct token+stack", () => {
    const groups = discordAdapterPlugin.groupBindings!([
      { agent: "juniper", stack: "jc/default", binding: { token: "tok-a", guildId: "111" } },
      { agent: "juniper", stack: "jc/default", binding: { token: "tok-a", guildId: "222" } },
      { agent: "vega", stack: "andreas/research", binding: { token: "tok-b", guildId: "333" } },
    ]);
    expect(groups.length).toBe(2);
    const tokenAGroup = groups.find((g) => g.entries.length === 2);
    expect(tokenAGroup?.entries.map((e) => e.binding.guildId)).toEqual(["111", "222"]);
  });

  test("slack: platform id, botToken+appToken secrets, no groupBindings (one adapter per binding)", () => {
    expect(slackAdapterPlugin.platform).toBe("slack");
    expect(slackAdapterPlugin.secretFields).toEqual(["botToken", "appToken"]);
    expect(slackAdapterPlugin.groupBindings).toBeUndefined();
    expect(slackAdapterPlugin.demuxKey({ workspaceId: "T0123" })).toBe("T0123");
  });

  test("mattermost: platform id, apiToken secret, demuxKey falls back to <unset>", () => {
    expect(mattermostAdapterPlugin.platform).toBe("mattermost");
    expect(mattermostAdapterPlugin.secretFields).toEqual(["apiToken"]);
    expect(mattermostAdapterPlugin.demuxKey({ apiUrl: "https://mm.example.com" })).toBe(
      "https://mm.example.com",
    );
    expect(mattermostAdapterPlugin.demuxKey({})).toBe("<unset>");
  });

  // cortex#1794 (S9 MOVE) — `web`'s descriptor now lives in the
  // `metafactory-cortex-adapter-web` bundle (not importable here); its
  // shape is pinned by that repo's own standalone test suite instead.
});

describe("registryFromFactory / registryToLegacyFactory — round trip", () => {
  test("registryFromFactory delegates each platform's createAdapter to the matching legacy method", () => {
    const calls: string[] = [];
    const stubAdapter = { platform: "x", instanceId: "y" } as never;
    const registry = registryFromFactory({
      discord: () => { calls.push("discord"); return stubAdapter; },
      slack: () => { calls.push("slack"); return stubAdapter; },
      mattermost: () => { calls.push("mattermost"); return stubAdapter; },
    });
    registry.getAdapter("discord")!.createAdapter({});
    registry.getAdapter("slack")!.createAdapter({});
    registry.getAdapter("mattermost")!.createAdapter({});
    expect(calls).toEqual(["discord", "slack", "mattermost"]);
  });

  test("registryToLegacyFactory routes each legacy method to the matching registry entry", () => {
    const registry = new SurfacePluginRegistry();
    const calls: string[] = [];
    const stubAdapter = { platform: "x", instanceId: "y" } as never;
    for (const id of ["discord", "slack", "mattermost"]) {
      registry.registerAdapter({
        ...makeStubAdapterPlugin(id),
        createAdapter: () => { calls.push(id); return stubAdapter; },
      });
    }
    const factory = registryToLegacyFactory(registry);
    factory.discord({});
    factory.slack({});
    factory.mattermost({});
    expect(calls).toEqual(["discord", "slack", "mattermost"]);
  });
});

// =============================================================================
// cortex#1789 (S4, ADR-0024 D5) — registry-pass validation
// =============================================================================

describe("in-tree AdapterPlugin descriptors — foldsIntoPresence (ADR-0024 D5 scope item 3)", () => {
  test("discord/slack/mattermost fold into agents[*].presence.{platform}", () => {
    expect(discordAdapterPlugin.foldsIntoPresence).toBe(true);
    expect(slackAdapterPlugin.foldsIntoPresence).toBe(true);
    expect(mattermostAdapterPlugin.foldsIntoPresence).toBe(true);
  });

  // cortex#1794 (S9 MOVE) — "web does NOT fold" is now pinned by the
  // `metafactory-cortex-adapter-web` bundle's own test suite; there is no
  // in-tree `webAdapterPlugin` left to assert against here.
});

describe("resolveAdapterPluginOrThrow", () => {
  test("resolves an installed platform", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(resolveAdapterPluginOrThrow("discord", registry)).toBe(discordAdapterPlugin);
  });

  test("unknown platform throws, naming the key and the installed set", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(() => resolveAdapterPluginOrThrow("discrod", registry)).toThrow(
      /no adapter installed for platform "discrod".*installed: discord, mattermost, slack/,
    );
  });
});

describe("resolveRendererPluginOrThrow", () => {
  test("resolves an installed renderer kind", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(resolveRendererPluginOrThrow("pagerduty", registry).id).toBe("pagerduty");
  });

  test("unregistered kind (cli-tail — S6 territory) throws, naming the kind and the installed set", () => {
    const registry = createDefaultSurfacePluginRegistry();
    expect(() => resolveRendererPluginOrThrow("cli-tail", registry)).toThrow(
      /no renderer installed for kind "cli-tail".*installed: dashboard, pagerduty/,
    );
  });
});

describe("validateSurfacesAgainstRegistry", () => {
  const registry = createDefaultSurfacePluginRegistry();

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
