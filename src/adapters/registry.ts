/**
 * cortex#1788 (S3, ADR-0024 D5 / design-pluggable-adapters.md §3.3) —
 * `SurfacePluginRegistry`.
 *
 * Registry-izes the shared adapter/renderer construction seam. Before this
 * slice, `buildGatewayAdapters` (`src/gateway/gateway-adapters.ts`) hardcoded
 * four per-platform loops against a fixed 4-method `GatewayAdapterFactory`,
 * and `createRenderer` (`src/renderers/index.ts`) switched on a closed
 * `RendererKind` enum. Both are the SAME structural blocker — "adding a
 * plugin means editing code that already exists" — so this registry replaces
 * both with ONE `(kind, id)`-keyed store (ADR-0024 D5: two plugin classes,
 * one loader).
 *
 * ## Scope of THIS slice (S3)
 *
 * S3 registry-izes construction. It does NOT wire the registry into config
 * validation (S4 — `SurfacesSchema`/`RendererSchema` stay exactly as they
 * are; `bindingSchema`/`configSchema` are carried on each plugin so S4 has
 * somewhere to read from, but nothing consumes them yet), does not build the
 * plugin SDK barrel (S5), and does not add boot-time discovery / a compat
 * gate for OUT-OF-TREE bundles (S6). Every plugin registered today is
 * in-tree, registered synchronously at boot (`createDefaultSurfacePluginRegistry`)
 * — the same "dogfooding" pattern ADR-0024 §3.3 describes: extraction later
 * is "delete the in-tree registration + move the module out," not "rewire
 * the core."
 *
 * ## The registry keys plugin CLASSES, not instances
 *
 * `(kind, id)` identifies the *code* — `("adapter", "discord")`,
 * `("renderer", "pagerduty")`. Live *instances* are keyed separately: an
 * adapter instances per binding (`PlatformAdapter.instanceId`), a renderer
 * instances per `renderers[]` entry (`Renderer.id`, defaulting to `kind` —
 * OQ10, see `cortex-config.ts`'s renderer schemas). Two `kind: pagerduty`
 * config entries share ONE registry entry (`("renderer","pagerduty")`) but
 * construct two distinct renderer INSTANCES with distinct `id`s.
 */

import type { PlatformAdapter } from "./types";
import type { Renderer } from "../renderers/types";

export type PluginKind = "adapter" | "renderer";

/**
 * A `surfaces.{platform}[]` entry — `{ agent, stack?, binding }`. Structurally
 * matches every platform's array element in `Surfaces`
 * (`src/common/types/surfaces.ts`); kept loosely typed here (`binding` as a
 * plain record) so the registry has no compile-time dependency on any one
 * platform's Zod-inferred binding shape.
 */
export interface SurfaceBindingEntry {
  readonly agent: string;
  readonly stack?: string;
  readonly binding: Record<string, unknown>;
}

/**
 * One construction group — the binding entries that share ONE live
 * connection, plus the instance id that connection registers under. Mirrors
 * `DiscordTokenGroup` (`src/gateway/discord-token-groups.ts`), generalised:
 * every platform's default (ungrouped) case is a one-entry group whose
 * `instanceId` is `{platform}:{demuxKey(binding)}`; Discord's `groupBindings`
 * returns the token-keyed groups computed today.
 */
export interface BindingGroup {
  readonly entries: readonly SurfaceBindingEntry[];
  readonly instanceId: string;
}

/** The three fields `buildGatewayAdapters`' generic loop threads into
 *  {@link AdapterPlugin.buildGatewayConstructArgs} for every platform. */
export interface GatewayConstructBase {
  readonly instanceId: string;
  readonly source: unknown;
  readonly runtime: unknown;
}

/**
 * Per-platform adapter plugin descriptor. `createAdapter`'s args type is
 * intentionally loose (`Record<string, unknown>`, cast internally to the
 * platform's own Factory-args shape) — the registry stores plugins for every
 * platform in one map, and each platform's construction args genuinely
 * diverge (Discord needs `allowedGuildIds` + `presenceByGuildId`; Slack/
 * Mattermost/Web don't). Each plugin module owns the single internal cast,
 * the same convention `wireSurfaceAdapters` already uses for its concrete-
 * adapter casts (`as DiscordAdapter` etc.) — never unsafe in practice because
 * a plugin is only ever invoked with the args its own call sites build for it.
 */
export interface AdapterPlugin {
  readonly kind: "adapter";
  /** Registry key. Equals `platform`. */
  readonly id: string;
  /** `surfaces.{platform}` key (e.g. "discord"). */
  readonly platform: string;
  /**
   * The schema this platform would contribute to `SurfacesSchema` once S4
   * composes it from the registry instead of 4 hardcoded keys. Carried here
   * so S4 has somewhere to read from — **inert in this slice**:
   * `SurfacesSchema` stays `.strict()` over its 4 hardcoded platform keys
   * (`src/common/types/surfaces.ts:327-341`) until then.
   */
  readonly bindingSchema: unknown;
  /**
   * Binding fields that must be free of unresolved `__ENV__` placeholders
   * before construction (cortex#1209 belt-and-suspenders) — checked against
   * the RAW binding value on every entry in a construction group.
   */
  readonly secretFields: readonly string[];
  /** binding → demux key. Used to build the default `{platform}:{demuxKey}`
   *  instance id when {@link groupBindings} is absent. */
  demuxKey(binding: Record<string, unknown>): string;
  /**
   * Optional: platforms that group multiple bindings onto ONE live
   * connection (Discord's token grouping — one gateway session per bot
   * token, not per guild). Absent = one adapter per binding entry, using
   * `demuxKey` to build the instance id.
   */
  groupBindings?(entries: readonly SurfaceBindingEntry[]): BindingGroup[];
  /**
   * Gateway-path ONLY. `buildGatewayAdapters`' generic loop calls this to
   * turn a raw-binding construction group into {@link createAdapter}'s args.
   * The per-stack boot path (`wireSurfaceAdapters`) NEVER calls this — it
   * already holds a fully-typed presence built from the richer `AgentConfig`
   * shape (`contextDepth`, `enableAgentLog`, `trust`, …) that a raw binding
   * does not carry, and calls {@link createAdapter} directly with its own
   * hand-built args (see `surface-adapter-boot.ts`'s `baseFactoryArgs`).
   */
  buildGatewayConstructArgs(group: BindingGroup, base: GatewayConstructBase): Record<string, unknown>;
  /** Construct (never start) the adapter. */
  createAdapter(args: Record<string, unknown>): PlatformAdapter;
}

/**
 * Per-kind renderer plugin descriptor (ADR-0024 D5). `configSchema` mirrors
 * {@link AdapterPlugin.bindingSchema} — carried for S4, inert until then
 * (`RendererSchema` stays the fixed discriminated union it is today,
 * `src/common/types/cortex-config.ts:1193`).
 */
export interface RendererPlugin {
  readonly kind: "renderer";
  /** Registry key. Equals `rendererKind`. */
  readonly id: string;
  /** `renderers[].kind` discriminant (e.g. "pagerduty"). */
  readonly rendererKind: string;
  /** The config schema this kind would contribute to `RendererSchema` (S4).
   *  Inert in this slice. */
  readonly configSchema: unknown;
  /** Construct (never start) the renderer. */
  createRenderer(config: unknown): Renderer;
}

export type SurfacePlugin = AdapterPlugin | RendererPlugin;

/**
 * `(kind, id)`-keyed registry (ADR-0024 D5, design doc §3.3). Two independent
 * maps keep `getAdapter`/`getRenderer` precisely typed without a runtime
 * kind-narrowing cast at every call site — structurally still "one registry
 * keyed by (kind, id)"; `kind` selects which map, `id` looks up within it.
 */
export class SurfacePluginRegistry {
  private readonly adapterPlugins = new Map<string, AdapterPlugin>();
  private readonly rendererPlugins = new Map<string, RendererPlugin>();

  registerAdapter(plugin: AdapterPlugin): void {
    if (this.adapterPlugins.has(plugin.id)) {
      throw new Error(
        `SurfacePluginRegistry: adapter plugin "${plugin.id}" is already registered`,
      );
    }
    this.adapterPlugins.set(plugin.id, plugin);
  }

  registerRenderer(plugin: RendererPlugin): void {
    if (this.rendererPlugins.has(plugin.id)) {
      throw new Error(
        `SurfacePluginRegistry: renderer plugin "${plugin.id}" is already registered`,
      );
    }
    this.rendererPlugins.set(plugin.id, plugin);
  }

  getAdapter(id: string): AdapterPlugin | undefined {
    return this.adapterPlugins.get(id);
  }

  getRenderer(id: string): RendererPlugin | undefined {
    return this.rendererPlugins.get(id);
  }

  /** Insertion order — `createDefaultSurfacePluginRegistry` registers
   *  discord → slack → mattermost → web, matching the pre-registry
   *  `buildGatewayAdapters`' fixed platform order byte-for-byte. */
  listAdapters(): readonly AdapterPlugin[] {
    return [...this.adapterPlugins.values()];
  }

  listRenderers(): readonly RendererPlugin[] {
    return [...this.rendererPlugins.values()];
  }
}

// =============================================================================
// Default (production) registry — in-tree plugins, dogfooding the registry
// =============================================================================

import { discordAdapterPlugin } from "./discord/plugin";
import { slackAdapterPlugin } from "./slack/plugin";
import { mattermostAdapterPlugin } from "./mattermost/plugin";
import { webAdapterPlugin } from "./web/plugin";
import { dashboardRendererPlugin } from "../renderers/dashboard";
import { pagerdutyRendererPlugin } from "../renderers/pagerduty";

/**
 * Compose ONE registry carrying every in-tree plugin — discord → slack →
 * mattermost → web (adapters, in the pre-registry `buildGatewayAdapters`
 * order) then dashboard → pagerduty (renderers, in the pre-registry
 * `createRenderer` switch order). Boot (`cortex.ts`) calls this ONCE and
 * threads the result to the gateway path (`buildGatewayAdapters`), the
 * per-stack path (`wireSurfaceAdapters`), and the renderer boot loop.
 */
export function createDefaultSurfacePluginRegistry(): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
  registry.registerAdapter(discordAdapterPlugin);
  registry.registerAdapter(slackAdapterPlugin);
  registry.registerAdapter(mattermostAdapterPlugin);
  registry.registerAdapter(webAdapterPlugin);
  registry.registerRenderer(dashboardRendererPlugin);
  registry.registerRenderer(pagerdutyRendererPlugin);
  return registry;
}

// =============================================================================
// Back-compat test seam — `registryFromFactory`
// =============================================================================

/**
 * The pre-registry adapter-construction seam (`src/gateway/gateway-adapters.ts`'s
 * `GatewayAdapterFactory`) — four platform methods, still exported there and
 * still the type a dozen tests build recording/counting fakes against
 * (`gateway-adapters.test.ts`, `start-gateway.test.ts`,
 * `cross-principal-routing.integration.test.ts`, `web-adapter.test.ts`,
 * `surface-adapter-boot.test.ts`). Declared structurally here (not imported)
 * to avoid a dependency cycle with `gateway-adapters.ts`, which imports
 * {@link createDefaultSurfacePluginRegistry} (via `registry.ts` re-exports)
 * for its own default. Each method's param is deliberately `any`, not
 * `Record<string, unknown>` — `gateway-adapters.ts`'s real
 * `GatewayAdapterFactory` types each method's arg with a NARROWER,
 * platform-specific interface (`DiscordFactoryArgs` etc.), and
 * `strictFunctionTypes` contravariance would reject assigning that stricter
 * factory to a `Record<string, unknown>`-param shape. `any` is the standard
 * escape for "adapt an external, more specifically-typed callback shape."
 */
interface LegacyGatewayAdapterFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  discord(args: any): PlatformAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slack(args: any): PlatformAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mattermost(args: any): PlatformAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  web(args: any): PlatformAdapter;
}

/**
 * Adapt a legacy `GatewayAdapterFactory`-shaped fake into a registry whose
 * four adapter plugins delegate `createAdapter` straight to the fake's
 * matching method. Existing test doubles built against the pre-registry
 *4-method interface keep working UNCHANGED — only the one call site that
 * used to pass `{ factory }` now passes `{ registry: registryFromFactory(factory) }`.
 * `demuxKey`/`groupBindings`/`buildGatewayConstructArgs` are borrowed from
 * the real in-tree plugins (grouping/demux logic isn't what these tests
 * fake — only the terminal construction call is).
 */
export function registryFromFactory(factory: LegacyGatewayAdapterFactory): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
  registry.registerAdapter({ ...discordAdapterPlugin, createAdapter: (args) => factory.discord(args) });
  registry.registerAdapter({ ...slackAdapterPlugin, createAdapter: (args) => factory.slack(args) });
  registry.registerAdapter({ ...mattermostAdapterPlugin, createAdapter: (args) => factory.mattermost(args) });
  registry.registerAdapter({ ...webAdapterPlugin, createAdapter: (args) => factory.web(args) });
  registry.registerRenderer(dashboardRendererPlugin);
  registry.registerRenderer(pagerdutyRendererPlugin);
  return registry;
}

/**
 * The inverse of {@link registryFromFactory} — wrap a registry back into the
 * legacy 4-method shape. Lets `wireSurfaceAdapters`
 * (`src/runner/surface-adapter-boot.ts`) accept an explicit `registry` param
 * (cortex.ts's "boot composes the registry once, threads it to both paths")
 * while its internal per-platform descriptors keep calling
 * `factory.discord(args)` / `.slack(args)` / `.mattermost(args)` unchanged —
 * every construction call still ends up at the SAME registry entry either
 * way.
 */
function requireAdapterPlugin(registry: SurfacePluginRegistry, platform: string): AdapterPlugin {
  const plugin = registry.getAdapter(platform);
  if (!plugin) {
    throw new Error(`registryToLegacyFactory: no adapter plugin registered for platform "${platform}"`);
  }
  return plugin;
}

export function registryToLegacyFactory(registry: SurfacePluginRegistry): LegacyGatewayAdapterFactory {
  return {
    discord: (args: Record<string, unknown>) => requireAdapterPlugin(registry, "discord").createAdapter(args),
    slack: (args: Record<string, unknown>) => requireAdapterPlugin(registry, "slack").createAdapter(args),
    mattermost: (args: Record<string, unknown>) => requireAdapterPlugin(registry, "mattermost").createAdapter(args),
    web: (args: Record<string, unknown>) => requireAdapterPlugin(registry, "web").createAdapter(args),
  };
}
