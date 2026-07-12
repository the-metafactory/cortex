/**
 * cortex#1793 (S8, ADR-0024 D3) — `src/gateway/plugin-runtime.ts` unit tests.
 *
 * Pure logic, no NATS, no real loader/arc calls — `discoverBundles`/
 * `reimportRenderer` are injected fakes (`PluginRuntimeDeps`'s test seams).
 */

import { describe, expect, test } from "bun:test";
import {
  listLivePlugins,
  loadLivePlugin,
  reloadLivePlugin,
  unloadLivePlugin,
  type PluginRuntimeDeps,
  type RendererHandle,
} from "../plugin-runtime";
import { SurfacePluginRegistry } from "../../adapters/registry";
import type { PlatformAdapter, InboundMessage, AccessDecision, ResponseTarget, OutboundFile } from "../../adapters/types";
import type { Renderer } from "../../renderers/types";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { RendererPlugin } from "../../adapters/registry";
import type { DiscoveredBundle, DiscoverPluginBundlesResult, ReimportRendererResult } from "../../adapters/loader";
import { SurfaceGateway, LoggingInboundSink } from "../surface-gateway";
import type { GatewayBindingIndex } from "../binding-resolver";

function emptyBindingIndex(): GatewayBindingIndex {
  return { discord: new Map(), slack: new Map(), web: new Map(), mattermostSingle: null, mattermostMulti: false };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

class FakeAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly instanceId: string;
  constructor(platform: string, instanceId: string) {
    this.platform = platform;
    this.instanceId = instanceId;
  }
  async start(_onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {}
  async stop(): Promise<void> {}
  async getPlatformUserId(): Promise<string> {
    return "fake-bot-id";
  }
  async fetchContext() {
    return [];
  }
  resolveAccess(_msg: InboundMessage): AccessDecision {
    return { allowed: true, features: { chat: true, async: false, team: false } };
  }
  async postResponse(_t: ResponseTarget, _text: string, _files?: OutboundFile[]): Promise<void> {}
  async sendTyping(): Promise<void> {}
  async sendProgress(): Promise<void> {}
  async clearProgress(): Promise<void> {}
  async createThread(_msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    throw new Error("not supported");
  }
  async resolveLogicalTarget(): Promise<ResponseTarget | null> {
    return null;
  }
  async notifyPrincipal(_text: string): Promise<void> {}
}

class FakeRenderer implements Renderer {
  readonly kind: string;
  readonly id: string;
  readonly subjects: string[] = [];
  startCalled = 0;
  stopCalled = 0;
  constructor(kind: string, id?: string) {
    this.kind = kind;
    this.id = id ?? kind;
  }
  async start(): Promise<void> {
    this.startCalled++;
  }
  async stop(): Promise<void> {
    this.stopCalled++;
  }
  async render(_envelope: Envelope): Promise<void> {}
  get surfaceConfig() {
    return { id: this.id, subjects: this.subjects, render: (e: Envelope) => this.render(e) };
  }
}

function makeRouter() {
  const registrations: { id: string; unregisterCalled: boolean }[] = [];
  return {
    registrations,
    register(adapter: { id: string }) {
      const entry = { id: adapter.id, unregisterCalled: false };
      registrations.push(entry);
      return { unregister: () => { entry.unregisterCalled = true; } };
    },
  };
}

function baseDeps(overrides: Partial<PluginRuntimeDeps> = {}): PluginRuntimeDeps {
  return {
    adapters: [],
    rendererHandles: new Map(),
    router: makeRouter(),
    skippedRendererConfigs: new Map(),
    registry: new SurfacePluginRegistry(),
    ...overrides,
  };
}

function rendererHandle(renderer: FakeRenderer, opts: Partial<RendererHandle> = {}): RendererHandle {
  return {
    renderer,
    unregister: opts.unregister ?? (() => {}),
    bundleName: opts.bundleName ?? "in-tree",
    rendererKind: opts.rendererKind ?? renderer.kind,
    config: opts.config ?? { subscribe: [] },
  };
}

// ─── list ────────────────────────────────────────────────────────────────────

describe("listLivePlugins", () => {
  test("lists adapters and renderers together", () => {
    const adapter = new FakeAdapter("discord", "discord:guild1");
    const renderer = new FakeRenderer("dashboard");
    const deps = baseDeps({
      adapters: [adapter],
      rendererHandles: new Map([["dashboard", rendererHandle(renderer)]]),
    });

    const rows = listLivePlugins(deps);

    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      kind: "adapter",
      platformOrKind: "discord",
      instanceId: "discord:guild1",
      bundleName: "in-tree",
      running: true,
    });
    expect(rows).toContainEqual({
      kind: "renderer",
      platformOrKind: "dashboard",
      instanceId: "dashboard",
      bundleName: "in-tree",
      running: true,
    });
  });

  test("empty when nothing is live", () => {
    expect(listLivePlugins(baseDeps())).toEqual([]);
  });
});

// ─── unload ──────────────────────────────────────────────────────────────────

describe("unloadLivePlugin", () => {
  test("renderer: unregisters + stops + removes from the live map", async () => {
    const renderer = new FakeRenderer("pagerduty");
    let unregistered = false;
    const handle = rendererHandle(renderer, { unregister: () => { unregistered = true; } });
    const deps = baseDeps({ rendererHandles: new Map([["pagerduty", handle]]) });

    const result = await unloadLivePlugin(deps, "pagerduty");

    expect(result.ok).toBe(true);
    expect(unregistered).toBe(true);
    expect(renderer.stopCalled).toBe(1);
    expect(deps.rendererHandles.has("pagerduty")).toBe(false);
  });

  test("adapter: refused when no gateway is present", async () => {
    const adapter = new FakeAdapter("discord", "discord:guild1");
    const deps = baseDeps({ adapters: [adapter] });

    const result = await unloadLivePlugin(deps, "discord:guild1");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("CORTEX_GATEWAY");
  });

  test("adapter: detaches via the gateway when one is present", async () => {
    const adapter = new FakeAdapter("discord", "discord:guild1");
    const gateway = new SurfaceGateway([adapter], emptyBindingIndex(), new LoggingInboundSink());
    const deps = baseDeps({ adapters: [adapter], gateway });

    const result = await unloadLivePlugin(deps, "discord:guild1");

    expect(result.ok).toBe(true);
  });

  test("unknown instance id is refused, not a silent no-op", async () => {
    const result = await unloadLivePlugin(baseDeps(), "nope");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no plugin instance");
  });
});

// ─── reload ──────────────────────────────────────────────────────────────────

describe("reloadLivePlugin", () => {
  test("in-tree renderer refuses reload (restart-required)", async () => {
    const renderer = new FakeRenderer("dashboard");
    const deps = baseDeps({
      rendererHandles: new Map([["dashboard", rendererHandle(renderer, { bundleName: "in-tree" })]]),
    });

    const result = await reloadLivePlugin(deps, "dashboard");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("in-tree");
    expect(result.detail).toContain("restart");
  });

  test("adapter reload is refused, citing the #1896 follow-up", async () => {
    const adapter = new FakeAdapter("discord", "discord:guild1");
    const deps = baseDeps({ adapters: [adapter] });

    const result = await reloadLivePlugin(deps, "discord:guild1");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("1896");
  });

  test("bundle no longer discoverable: refused, old instance untouched", async () => {
    const renderer = new FakeRenderer("acme");
    const handle = rendererHandle(renderer, { bundleName: "acme-bundle" });
    const deps = baseDeps({
      rendererHandles: new Map([["acme", handle]]),
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [], issues: [] }),
    });

    const result = await reloadLivePlugin(deps, "acme");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no longer discoverable");
    expect(renderer.stopCalled).toBe(0);
  });

  test("successful reload: attach-before-detach, old instance stopped after the new one is live", async () => {
    const oldRenderer = new FakeRenderer("acme");
    let oldUnregistered = false;
    const handle = rendererHandle(oldRenderer, {
      bundleName: "acme-bundle",
      unregister: () => { oldUnregistered = true; },
      config: { subscribe: ["local.>"] },
    });

    const fakeBundle = { bundleName: "acme-bundle" } as unknown as DiscoveredBundle;
    let newRenderer: FakeRenderer | undefined;
    const fakePlugin: RendererPlugin = {
      kind: "renderer",
      id: "acme",
      rendererKind: "acme",
      configSchema: { parse: (c: unknown) => c } as never,
      createRenderer: (config: unknown) => {
        newRenderer = new FakeRenderer("acme");
        expect(config).toEqual({ subscribe: ["local.>"] });
        return newRenderer;
      },
    };

    const deps = baseDeps({
      rendererHandles: new Map([["acme", handle]]),
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [fakeBundle], issues: [] }),
      reimportRenderer: async (): Promise<ReimportRendererResult> => ({ ok: true, plugin: fakePlugin }),
    });

    const result = await reloadLivePlugin(deps, "acme");

    expect(result.ok).toBe(true);
    expect(newRenderer).toBeDefined();
    expect(newRenderer?.startCalled).toBe(1);
    // Attach-before-detach: the new instance is live BEFORE the old one is
    // torn down — verified indirectly by both having run and the old
    // instance's unregister/stop firing (order is enforced by the
    // implementation; this asserts the net effect).
    expect(oldUnregistered).toBe(true);
    expect(oldRenderer.stopCalled).toBe(1);
    expect(deps.rendererHandles.get("acme")?.renderer).toBe(newRenderer);
  });

  test("reimport failure leaves the old instance running", async () => {
    const oldRenderer = new FakeRenderer("acme");
    const handle = rendererHandle(oldRenderer, { bundleName: "acme-bundle" });
    const fakeBundle = { bundleName: "acme-bundle" } as unknown as DiscoveredBundle;
    const deps = baseDeps({
      rendererHandles: new Map([["acme", handle]]),
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [fakeBundle], issues: [] }),
      reimportRenderer: async (): Promise<ReimportRendererResult> => ({ ok: false, stage: "import", reason: "boom" }),
    });

    const result = await reloadLivePlugin(deps, "acme");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("boom");
    expect(oldRenderer.stopCalled).toBe(0);
    expect(deps.rendererHandles.get("acme")?.renderer).toBe(oldRenderer);
  });
});

// ─── load ────────────────────────────────────────────────────────────────────

describe("loadLivePlugin", () => {
  test("refuses when the bundle is already live", async () => {
    const renderer = new FakeRenderer("acme");
    const deps = baseDeps({
      rendererHandles: new Map([["acme", rendererHandle(renderer, { bundleName: "acme-bundle" })]]),
    });

    const result = await loadLivePlugin(deps, "acme-bundle");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("already has a live renderer instance");
  });

  test("refuses adapter-kind bundles, citing #1896", async () => {
    const fakeBundle = {
      bundleName: "acme-adapter-bundle",
      manifest: { kind: "adapter", id: "acme" },
    } as unknown as DiscoveredBundle;
    const deps = baseDeps({
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [fakeBundle], issues: [] }),
    });

    const result = await loadLivePlugin(deps, "acme-adapter-bundle");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("1896");
  });

  test("refuses when there is no pending renderers[] entry to construct from", async () => {
    const fakeBundle = {
      bundleName: "acme-bundle",
      manifest: { kind: "renderer", id: "acme" },
    } as unknown as DiscoveredBundle;
    const deps = baseDeps({
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [fakeBundle], issues: [] }),
    });

    const result = await loadLivePlugin(deps, "acme-bundle");

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no pending");
  });

  test("successful load: constructs from the retained raw config, registers, and consumes the skipped entry", async () => {
    const fakeBundle = {
      bundleName: "acme-bundle",
      manifest: { kind: "renderer", id: "acme" },
    } as unknown as DiscoveredBundle;
    let constructedWith: unknown;
    let newRenderer: FakeRenderer | undefined;
    const fakePlugin: RendererPlugin = {
      kind: "renderer",
      id: "acme",
      rendererKind: "acme",
      configSchema: { parse: (c: unknown) => c } as never,
      createRenderer: (config: unknown) => {
        constructedWith = config;
        newRenderer = new FakeRenderer("acme");
        return newRenderer;
      },
    };
    const deps = baseDeps({
      skippedRendererConfigs: new Map([["acme", [{ kind: "acme", subscribe: ["local.>"] }]]]),
      discoverBundles: async (): Promise<DiscoverPluginBundlesResult> => ({ bundles: [fakeBundle], issues: [] }),
      reimportRenderer: async (): Promise<ReimportRendererResult> => ({ ok: true, plugin: fakePlugin }),
    });

    const result = await loadLivePlugin(deps, "acme-bundle");

    expect(result.ok).toBe(true);
    expect(constructedWith).toEqual({ kind: "acme", subscribe: ["local.>"] });
    expect(newRenderer?.startCalled).toBe(1);
    expect(deps.rendererHandles.get("acme")?.renderer).toBe(newRenderer);
    expect(deps.skippedRendererConfigs.has("acme")).toBe(false);
  });
});
