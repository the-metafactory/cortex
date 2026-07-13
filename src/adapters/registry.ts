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
 * ## Scope of THIS slice (S4, cortex#1789)
 *
 * S4 wires the registry into config validation (ADR-0024 D5, SCOPE AMENDED
 * comment on #1789). `bindingSchema`/`configSchema` stop being inert `unknown`
 * placeholders and become real `z.ZodType`s; two-stage validation lands:
 *
 *   1. STRUCTURAL pass (loader, no registry in hand) — `SurfacesSchema`
 *      (`src/common/types/surfaces.ts`) and the renderer entry schema
 *      (`RendererSchema`, `src/common/types/cortex-config.ts`) validate only
 *      the generic shape (`{agent, stack?, binding}` / `{kind, ...}`). A
 *      genuinely unknown platform/kind key is NOT rejected here — it can't
 *      be, structurally, without knowing what's registered.
 *   2. REGISTRY pass (wherever config + registry are both in hand —
 *      `loader.ts`'s `parseSurfaces`/`loadCortexShape` for the default
 *      in-tree registry, `cortex.ts` boot for the live boot registry,
 *      `migrate-config-lib.ts` for the synthesis path) — this file's
 *      {@link resolveAdapterPluginOrThrow} / {@link validateSurfacesAgainstRegistry}
 *      and `src/renderers/index.ts`'s `resolveRendererPluginAndConfig`
 *      resolve the plugin by key and parse the RAW entry against its real
 *      `bindingSchema`/`configSchema`, throwing the same loud "no adapter/
 *      renderer installed for …" shape a typo used to get from `.strict()`/
 *      the closed enum.
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

import type { z } from "zod/v4";

import type { PlatformAdapter } from "./types";
import type { Renderer } from "../renderers/types";
import type { Surfaces } from "../common/types/surfaces";

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

/** The fields `buildGatewayAdapters`' generic loop threads into
 *  {@link AdapterPlugin.buildGatewayConstructArgs} for every platform. */
export interface GatewayConstructBase {
  readonly instanceId: string;
  readonly source: unknown;
  readonly runtime: unknown;
  /**
   * cortex#1794 (S9b) — a host-bound `AdapterPolicyPort` (`surface-sdk`),
   * typed `unknown` here for the SAME reason `source`/`runtime` are: this
   * registry module has no compile-time dependency on `surface-sdk` or
   * `common/policy`, so each plugin's `buildGatewayConstructArgs` casts
   * internally (the convention `AdapterPlugin`'s docstring already
   * establishes for `createAdapter`'s args). Forwarded by both the `web`
   * plugin (`metafactory-cortex-adapter-web`'s `src/plugin.ts`, relocated
   * out-of-tree cortex#1794 S9 MOVE) and the `slack` plugin
   * (`metafactory-cortex-adapter-slack`'s `src/plugin.ts`, cortex#1795 S10).
   */
  readonly policy?: unknown;
  /**
   * cortex#1795 (S10) — a host-bound `AdapterSystemEventPort` (`surface-sdk`),
   * typed `unknown` for the same reason `policy` is. Currently only the
   * slack plugin forwards it.
   */
  readonly systemEvents?: unknown;
  /**
   * cortex#1795 (S10) — the host-bound envelope→markdown renderer (the
   * shared `adapters/envelope-renderer.ts`'s `formatEnvelopeAsMarkdown`),
   * typed `unknown` for the same reason `policy` is. Currently only the
   * slack plugin forwards it.
   */
  readonly formatEnvelope?: unknown;
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
   * cortex#1789 (S4) — the schema this platform's `surfaces.{platform}[].binding`
   * must satisfy. Consumed by {@link resolveAdapterPluginOrThrow} /
   * {@link validateSurfacesAgainstRegistry} (the REGISTRY pass) — the
   * structural pass (`SurfacesSchema`) only checks the generic
   * `{agent, stack?, binding}` shape; this schema is where the real
   * per-platform field validation (required tokens, regex-checked ids, …)
   * happens. For the four in-tree platforms this is the EXACT schema
   * `SurfacesSchema`'s old `.strict()` object used pre-S4
   * (`DiscordBindingSchema`/`SlackBindingSchema`/`MattermostBindingSchema`/
   * `WebBindingSchema`, `src/common/types/surfaces.ts`) — byte-identical
   * validation, only the call site moved.
   */
  readonly bindingSchema: z.ZodType;
  /**
   * cortex#1789 (S4, ADR-0024 D5 scope item 3) — does this platform's
   * `surfaces.{platform}[]` fold into `agents[*].presence.{platform}` at
   * config-compose time (`foldSurfaceBindings`)? `true` for discord/slack/
   * mattermost (a legacy inline-presence shape exists to fold into); `false`
   * for web (there is no legacy web presence shape — the gateway factory
   * consumes `surfaces.web[]` directly). Replaces the hardcoded `PLATFORMS`
   * fold-list constant in `surfaces.ts` — `loader.ts` derives the fold list
   * from `registry.listAdapters().filter(p => p.foldsIntoPresence)` instead
   * of a second list that could drift from the registry.
   */
  readonly foldsIntoPresence: boolean;
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
  /**
   * cortex#1789 (S4) — the schema a `renderers[]` entry of this kind must
   * satisfy. Consumed by `src/renderers/index.ts`'s `resolveRendererPluginAndConfig`
   * (the REGISTRY pass) — the structural pass (`RendererSchema` in
   * `cortex-config.ts`) only checks `{kind, ...}`; this is the real per-kind
   * schema (`DashboardRendererSchema`/`PagerDutyRendererSchema`/etc,
   * `src/common/types/cortex-config.ts`) — byte-identical to what the old
   * discriminated union validated, only the call site moved (and now runs
   * with the RAW entry, so `parse()` still applies field defaults).
   */
  readonly configSchema: z.ZodType;
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
   *  discord → slack → mattermost (in-tree, matching the pre-registry
   *  `buildGatewayAdapters`' fixed platform order byte-for-byte), then
   *  boot's `loadExternalPlugins` appends any loaded external/first-party
   *  bundle plugin (e.g. `web`, cortex#1794 S9 MOVE) in bundle-name-sorted
   *  order. */
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

import { dashboardRendererPlugin } from "../renderers/dashboard";
import { pagerdutyRendererPlugin } from "../renderers/pagerduty";

/**
 * Compose ONE registry carrying every in-tree plugin — dashboard → pagerduty
 * (renderers, in the pre-registry `createRenderer` switch order). Boot
 * (`cortex.ts`) calls this ONCE and threads the result to the gateway path
 * (`buildGatewayAdapters`), the per-stack path (`wireSurfaceAdapters`), and
 * the renderer boot loop.
 *
 * cortex#1794 (S9 MOVE) — `web` is no longer registered here. It extracted to
 * the `metafactory-cortex-adapter-web` bundle (ADR-0024 D2: extraction
 * deletes the in-tree implementation, no fallback copy) and is now loaded at
 * boot by `src/adapters/loader.ts`'s `loadExternalPlugins`, which registers
 * it into this SAME registry instance under the S9a first-party-adapter
 * exemption (cortex declares the bundle in `arc-manifest.yaml`
 * `dependencies:`, so it loads even with `system.plugins.external` off).
 *
 * cortex#1795 (S10 MOVE) — `slack` is no longer registered here either, same
 * fate as `web`: extracted to the `metafactory-cortex-adapter-slack` bundle,
 * loaded by `loadExternalPlugins` under the SAME first-party exemption.
 *
 * cortex#1796 (S11 MOVE) — `mattermost` is no longer registered here
 * either. It extracted to the `metafactory-cortex-adapter-mattermost`
 * bundle, same D2/S9a exemption mechanism as `web`/`slack`.
 *
 * cortex#1797 (S12 MOVE) — `discord` is no longer registered here either —
 * the FOURTH and FINAL in-tree adapter to extract, to the
 * `metafactory-cortex-adapter-discord` bundle, same D2/S9a exemption
 * mechanism. **This function now registers ZERO in-tree adapters.** Every
 * adapter cortex ships is an out-of-tree, first-party bundle loaded by
 * `loadExternalPlugins` — `createDefaultSurfacePluginRegistry` composes only
 * the two in-tree RENDERER plugins (dashboard/pagerduty) plus an empty
 * adapter map for `loadExternalPlugins` to populate.
 *
 * `registry.listAdapters()` therefore returns `[]` right after this function
 * returns, and `["discord","mattermost","slack","web"]` (bundle-name-sorted)
 * once boot's `loadExternalPlugins` call completes — both are correct, just
 * different points in the boot sequence.
 */
export function createDefaultSurfacePluginRegistry(): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
  registry.registerRenderer(dashboardRendererPlugin);
  registry.registerRenderer(pagerdutyRendererPlugin);
  return registry;
}

// =============================================================================
// cortex#1789 (S4) — registry-pass validation (ADR-0024 D5)
// =============================================================================

/**
 * Resolve the `AdapterPlugin` registered for `platform`, or throw the SAME
 * shape of loud, actionable error the pre-S4 `SurfacesSchema.strict()` gave
 * on an unknown top-level key — naming the offending key AND every
 * currently-installed platform, so a typo (`discrod:`) is as debuggable as
 * it was before the schema became structurally permissive.
 */
export function resolveAdapterPluginOrThrow(
  platform: string,
  registry: SurfacePluginRegistry,
): AdapterPlugin {
  const plugin = registry.getAdapter(platform);
  if (!plugin) {
    const installed = registry.listAdapters().map((p) => p.id).sort().join(", ") || "(none)";
    throw new Error(
      `no adapter installed for platform "${platform}" (installed: ${installed}). ` +
        `Check surfaces.${platform} for a typo, or install the plugin that provides it.`,
    );
  }
  return plugin;
}

/**
 * Resolve the `RendererPlugin` registered for `kind`, or throw the SAME loud
 * shape {@link resolveAdapterPluginOrThrow} does for adapters — naming the
 * offending kind AND every currently-installed renderer kind. Used by
 * `src/renderers/index.ts` (`createRenderer` / `resolveRendererPluginAndConfig`)
 * — the renderer-side twin of the adapter registry pass.
 */
export function resolveRendererPluginOrThrow(
  kind: string,
  registry: SurfacePluginRegistry,
): RendererPlugin {
  const plugin = registry.getRenderer(kind);
  if (!plugin) {
    const installed = registry.listRenderers().map((p) => p.id).sort().join(", ") || "(none)";
    throw new Error(
      `no renderer installed for kind "${kind}" (installed: ${installed}). ` +
        `Check renderers[].kind for a typo, or install the plugin that provides it.`,
    );
  }
  return plugin;
}

/**
 * cortex#1789 (S4) — the REGISTRY pass for `surfaces:` bindings. Structural
 * validity (`{agent, stack?, binding}` shape) is already established by
 * `SurfacesSchema` (the structural pass) before this runs; this function
 * checks the two things only a live registry can check:
 *
 *   1. every top-level key names an INSTALLED adapter plugin
 *      ({@link resolveAdapterPluginOrThrow} — same loudness as the old
 *      `.strict()`);
 *   2. every entry's `binding` satisfies THAT plugin's `bindingSchema`
 *      (the exact per-platform field validation `SurfacesSchema`'s old
 *      hardcoded schemas used to do inline).
 *
 * Throws on the first failure — the same fail-fast contract `.strict()` and
 * the per-platform binding schemas had pre-S4. Zod issue messages never
 * include the raw field VALUE (only the path + a static/regex-derived
 * message), so a rejected `token`/`apiToken`/`botToken` binding never echoes
 * the secret into the thrown error.
 *
 * No-op when `surfaces` is `undefined` (no `surfaces:` block declared).
 */
export function validateSurfacesAgainstRegistry(
  surfaces: Surfaces | undefined,
  registry: SurfacePluginRegistry,
): void {
  if (!surfaces) return;
  for (const [platform, entries] of Object.entries(surfaces)) {
    if (!entries) continue;
    const plugin = resolveAdapterPluginOrThrow(platform, registry);
    entries.forEach((entry: { readonly binding: Record<string, unknown> }, index: number) => {
      const result = plugin.bindingSchema.safeParse(entry.binding);
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`surfaces.${platform}[${index}].binding is invalid: ${issues}`);
      }
    });
  }
}

// =============================================================================
// Back-compat test seam — `registryFromFactory`
// =============================================================================

/**
 * The pre-registry adapter-construction seam (`src/gateway/gateway-adapters.ts`'s
 * `GatewayAdapterFactory`) — three platform methods (discord/slack/mattermost;
 * `web` dropped cortex#1794 S9 MOVE — see this file's module-level note), still
 * exported there and still the type a dozen tests build recording/counting
 * fakes against (`gateway-adapters.test.ts`, `start-gateway.test.ts`,
 * `cross-principal-routing.integration.test.ts`,
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
 *
 * `slack` STAYS on this interface post-cortex#1795 (S10 MOVE) — unlike
 * `web`, `wireSurfaceAdapters` (`surface-adapter-boot.ts`) still calls
 * `factory.slack(...)` on the production path via
 * {@link registryToLegacyFactory} below, which is fully registry-driven (no
 * in-tree import). Only {@link registryFromFactory}'s auto-registration of a
 * "slack" entry lost its descriptor-field source — see that function's doc.
 *
 * cortex#1796 (S11 MOVE) — `mattermost` stays a member here too (unlike
 * `web`, which was never part of this interface) because `wireSurfaceAdapters`
 * (`src/runner/surface-adapter-boot.ts`) still has a real per-stack
 * construction call site that calls `factory.mattermost(...)` unconditionally
 * — see {@link registryToLegacyFactory}'s doc for why that stays safe to
 * keep with zero static import of the (now out-of-tree) mattermost plugin.
 *
 * cortex#1797 (S12 MOVE) — `discord` stays a member here too, same reason:
 * `wireSurfaceAdapters` still calls `factory.discord(...)` unconditionally
 * on its per-stack construction path, and {@link registryToLegacyFactory}'s
 * `discord` implementation is (and always was) a pure runtime registry
 * lookup — zero static import of the (now out-of-tree) discord plugin.
 */
interface LegacyGatewayAdapterFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  discord(args: any): PlatformAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slack(args: any): PlatformAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mattermost(args: any): PlatformAdapter;
}

/**
 * Adapt a legacy `GatewayAdapterFactory`-shaped fake into a registry whose
 * adapter plugins delegate `createAdapter` straight to the fake's matching
 * method. Existing test doubles built against the pre-registry 4-method
 * interface keep working UNCHANGED — only the one call site that used to
 * pass `{ factory }` now passes `{ registry: registryFromFactory(factory) }`.
 * `demuxKey`/`groupBindings`/`buildGatewayConstructArgs` are borrowed from
 * the real in-tree plugins (grouping/demux logic isn't what these tests
 * fake — only the terminal construction call is).
 *
 * cortex#1794 (S9 MOVE) — `web` dropped from both the registration loop and
 * {@link LegacyGatewayAdapterFactory} (no in-tree `webAdapterPlugin` to
 * borrow descriptor fields from any more). A test that needs a "web-shaped"
 * fourth platform registers its own stub `AdapterPlugin` directly via
 * `registry.registerAdapter(...)` after calling this function.
 *
 * cortex#1795 (S10 MOVE) — `slack` drops from the REGISTRATION LOOP too
 * (it stays on {@link LegacyGatewayAdapterFactory} itself — see that
 * interface's doc): there is no more in-tree `slackAdapterPlugin` to borrow
 * `bindingSchema`/`demuxKey`/`groupBindings`/`buildGatewayConstructArgs`
 * from. A test that needs a "slack" registry entry (e.g. to exercise
 * `validateSurfacesAgainstRegistry`/demux against `surfaces.slack[]`)
 * registers its own stub `AdapterPlugin` directly via
 * `registry.registerAdapter(...)` after calling this function, same as the
 * `web` workaround above — see `__tests__/registry.test.ts` for an example.
 *
 * cortex#1796 (S11 MOVE) — `mattermost` dropped from the registration loop
 * too, same reason (no in-tree `mattermostAdapterPlugin` descriptor to
 * spread). `mattermost` STAYS on {@link LegacyGatewayAdapterFactory} itself
 * (the fake's shape) — only the auto-registration into the built registry is
 * gone. A test that needs a "mattermost-shaped" or "web-shaped" adapter in
 * the registry it builds registers its own stub `AdapterPlugin` directly via
 * `registry.registerAdapter(...)` after calling this function (see
 * `gateway-adapters.test.ts`'s `mattermostTestPlugin` helper).
 *
 * cortex#1797 (S12 MOVE) — `discord` dropped from the registration loop too,
 * same reason (no in-tree `discordAdapterPlugin` descriptor to spread any
 * more — this function now registers NO adapters at all, only the two
 * in-tree renderers). A test that needs a "discord-shaped" adapter in the
 * registry it builds registers its own stub `AdapterPlugin` directly via
 * `registry.registerAdapter(...)` after calling this function, same as the
 * web/slack/mattermost workaround above.
 */
export function registryFromFactory(_factory: LegacyGatewayAdapterFactory): SurfacePluginRegistry {
  const registry = new SurfacePluginRegistry();
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
 *
 * cortex#1796 (S11 MOVE) — `mattermost`'s implementation below is a PURE
 * runtime `registry.getAdapter("mattermost")` lookup — no static import of
 * the (now out-of-tree) mattermost plugin. In production `cortex.ts` always
 * threads `registry: surfacePluginRegistry` — the SAME registry object
 * `loadExternalPlugins` populated (first-party adapter exemption, mirroring
 * `web`) BEFORE `wireSurfaceAdapters` runs — so this resolves to the real,
 * bundle-loaded mattermost plugin at boot. A caller with no registry (only
 * `factory`/`defaultGatewayAdapterFactory`) never reaches this function.
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
  };
}
