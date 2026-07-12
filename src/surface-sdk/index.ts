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

// Local (non-re-exporting) type import — `AdapterPolicyPort` below needs
// `InboundMessage`/`AccessDecision` in scope; the `export type {...} from`
// statement above re-exports them but does not bind a local name.
import type { InboundMessage, AccessDecision } from "../adapters/types";

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

// =============================================================================
// Host-injected policy port (cortex#1794 S9b — ADR-0024 D5 extraction lane)
// =============================================================================

/**
 * cortex#1794 (S9b) — the narrow, TYPE-ONLY behavioral contract an adapter
 * uses to authorise an inbound message, in place of importing cortex's
 * `PolicyEngine` / `PlatformPrincipalIndex` / `PrincipalRegistry`
 * (`common/policy`) directly. Those three types are cortex-internal runtime
 * machinery — genuinely out of scope for the SDK barrel (same reasoning as
 * `MyelinRuntime`/`SystemEventSource`, see the module doc above) — so rather
 * than re-export them, the SDK exposes only the SHAPE an adapter needs: given
 * an inbound message (or a `(platform, platformId)` pair), decide access.
 *
 * The host binds both closures over its real `PolicyEngine` + index +
 * registry at adapter-construction time (`adapters/plugin-support.ts`'s
 * `buildAdapterPolicyPort`, cortex-side) and hands the bound port through
 * `AdapterPlugin.createAdapter`'s `args` — the adapter body never imports
 * `common/policy` itself, so it stays compilable against `surface-sdk` alone
 * whether it lives in-tree or, after extraction, in its own package. This is
 * a dependency-inversion PORT (Hexagonal architecture sense), not a data
 * type: no `PolicyEngine`-shaped value crosses the barrel, only a bound
 * behavior.
 *
 * First consumer: `WebAdapterInfra.policy`, originally at cortex's
 * `src/adapters/web/index.ts` — relocated cortex#1794 (S9 MOVE) to the
 * `metafactory-cortex-adapter-web` bundle's `src/index.ts`, which now
 * imports this port from a vendored copy of this barrel (see that repo's
 * `src/vendor/surface-sdk.ts`). Discord/Slack/Mattermost still import
 * `common/policy` directly — their dependency-inversion pass is a later
 * slice (cortex#1896).
 */
export interface AdapterPolicyPort {
  /** Resolve `msg` to an `AccessDecision` via the host's bound policy engine
   *  (mirrors `common/policy`'s `resolvePolicyAccess`). */
  resolveAccess(msg: InboundMessage): AccessDecision;
  /** Whether `(platform, platformId)` maps to a principal holding the
   *  `operator` capability (mirrors `common/policy`'s `isOperatorPrincipal`). */
  isOperatorPrincipal(platform: string, platformId: string): boolean;
}
