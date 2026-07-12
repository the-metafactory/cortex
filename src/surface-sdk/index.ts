/**
 * cortex#1790 (S5, ADR-0024 D5) — the plugin SDK barrel.
 *
 * `CONTEXT.md` §Adapter/renderer SDK is authoritative vocabulary: "the
 * stable, versioned contract surface a surface plugin compiles against —
 * the one barrel of types (`PlatformAdapter`, `Renderer`, and the
 * envelope/target types they need) plus the version constant the loader
 * gates on. An out-of-tree plugin imports from here and nowhere else in
 * cortex."
 *
 * ## What belongs here (and what doesn't)
 *
 * This barrel re-exports ONLY the shared plugin CONTRACT — the types a
 * plugin author needs to implement `PlatformAdapter` or `Renderer` and to
 * describe either as a `SurfacePlugin` the registry can load. It does NOT
 * re-export cortex's internal implementation machinery (`MyelinRuntime`,
 * `PolicyEngine`, `SystemEventSource`, config/presence types, per-kind
 * renderer config schemas, tap readers, formatting helpers, …) — those are
 * genuine cross-boundary imports the four in-tree adapters and the two
 * in-tree renderers still reach for today (ADR-0024 residual couplings
 * #5–#8/#13), and folding them into "the SDK" would make a breaking change
 * to any of THEM force a plugin-SDK major bump, which is not what D1/D5
 * pin: only a breaking change to `PlatformAdapter`, `Renderer`, or the
 * `SurfacePlugin` descriptor shapes is a major bump. Full decoupling of the
 * in-tree adapters from cortex internals is the S9–S12 extraction work,
 * not this slice.
 *
 * The audit that produced this export list: every `../../` import in
 * `src/adapters/{discord,slack,mattermost,web}/*.ts` and every `../`
 * cross-boundary import in `src/renderers/*.ts`, intersected with the
 * types actually referenced by the `PlatformAdapter` / `Renderer` /
 * `SurfacePlugin` contracts (`adapters/types.ts`, `renderers/types.ts`,
 * `bus/surface-router.ts`'s `SurfaceAdapter`, `bus/myelin/envelope-validator.ts`'s
 * `Envelope`, `adapters/registry.ts`'s descriptor types). See
 * `docs/plugin-sdk.md` for the worked audit command and the full list of
 * cross-boundary imports that were deliberately left OUT.
 *
 * ## Compat rule (ADR-0024 D1, D5 — pinned)
 *
 * `SURFACE_SDK_VERSION` is a single-integer-major semver string. A plugin
 * declares an `sdkRange` (e.g. `"^1"`) in its default-exported
 * `SurfacePlugin`; the S6 loader is the SOLE authoritative gate — it checks
 * `satisfies(SURFACE_SDK_VERSION, plugin.sdkRange)` at `import()` time and
 * refuses a non-satisfying plugin with a `system.error` event, leaving the
 * daemon and every other plugin live. **One SDK, one gate, both kinds**
 * (D5): a breaking change to `PlatformAdapter` OR to `Renderer` bumps the
 * SAME major, even though that conservatively refuses plugins of the
 * *other*, unaffected kind — accepted as coarse-but-honest so two
 * independently-versioned SDKs never reintroduce the two-loaders problem
 * D5 exists to prevent. A `cortex: >=X <Y` range MAY appear in a bundle's
 * `cortex-plugin.yaml` as ADVISORY metadata (arc install may surface it)
 * but is never the load gate — only the running daemon's true
 * `SURFACE_SDK_VERSION` is authoritative.
 *
 * Bumping this value is a disciplined act: a breaking change to
 * `PlatformAdapter`, `Renderer`, `SurfacePlugin`/`AdapterPlugin`/
 * `RendererPlugin`, or any type transitively exported below is a MAJOR
 * bump with a documented plugin-author migration note (OQ5 — SDK changelog
 * ownership, ratified "as recommended", still applies: record the
 * migration in this file's history, not just the commit message).
 */
export const SURFACE_SDK_VERSION = "1.0.0";

// =============================================================================
// Platform adapter contract (src/adapters/types.ts)
// =============================================================================

export type {
  PlatformAdapter,
  InboundMessage,
  InboundAttachment,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "../adapters/types";

// `ContextAttachment` is referenced by `ContextMessage.attachments` and is
// imported directly by adapter context-fetchers (discord/context-fetcher.ts,
// mattermost/context.ts) alongside `ContextMessage` — part of the same
// envelope/target type family, so it travels with it.
export type { ContextAttachment } from "../common/types/context";

// =============================================================================
// Renderer contract (src/renderers/types.ts + the render-target contract)
// =============================================================================

export type { Renderer } from "../renderers/types";

/**
 * The surface-router's render-only subscriber contract — `CONTEXT.md`'s
 * canonical **Render target** (NOT an adapter). The underlying type is still
 * named `SurfaceAdapter` in `bus/surface-router.ts` (a historical misnomer
 * whose full-codebase rename is tracked separately), but the SDK is a NEW
 * versioned public surface with zero consumers, so it ships the canonical
 * name `RenderTarget` from v1 — a later internal rename then never touches
 * this contract, and never forces a cosmetic `SURFACE_SDK_VERSION` major.
 */
export type { SurfaceAdapter as RenderTarget } from "../bus/surface-router";

/** The envelope type both `Renderer.render()` and `RenderTarget.render()`
 *  operate on. */
export type { Envelope } from "../bus/myelin/envelope-validator";

/** `Renderer.kind`'s discriminant — the registered renderer-kind key set
 *  (ADR-0024 D5 turned this from a closed `z.enum` into the registry's key
 *  set; a plugin's `rendererKind` value must be assignable to this type). */
export type { RendererKind } from "../common/types/cortex-config";

// =============================================================================
// Plugin descriptor contract (src/adapters/registry.ts, ADR-0024 D5)
// =============================================================================

export type {
  PluginKind,
  SurfacePlugin,
  AdapterPlugin,
  RendererPlugin,
  SurfaceBindingEntry,
  BindingGroup,
  GatewayConstructBase,
} from "../adapters/registry";
