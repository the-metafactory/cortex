/**
 * cortex#1793 (S8, ADR-0024 D3) — the LIVE plugin registry `cortex plugin
 * list|unload|reload|load` reads and mutates. Pure, injected-dependency
 * logic: no NATS, no CLI parsing — `src/gateway/plugin-control-server.ts`
 * wires this to the bus-side request/response envelopes
 * (`system.plugin.control-request`/`-response`, `src/bus/system-events.ts`),
 * and `src/cli/cortex/commands/plugin-lib.ts` is the CLI-side caller.
 *
 * ## Scope (deliberately asymmetric — "the renderer half is cheaper")
 *
 * Per ADR-0024's own D3 renderer delta and the S8 issue's scope amendment:
 * per-instance detach for RENDERERS already existed (`SurfaceRouter.register()`
 * returns `{ unregister }`) — the boot loop just discarded it (cortex.ts's
 * renderer loop, fixed alongside this file). ADAPTERS have no per-instance
 * detach outside the (env-gated, off-by-default) `SurfaceGateway` — see
 * `src/gateway/surface-gateway.ts`'s `attachAdapter`/`detachAdapter`.
 *
 * This module reflects that asymmetry honestly rather than faking parity:
 *
 *   - `list` — full support, both kinds, always (read-only).
 *   - `unload` — full support for renderers (always); for adapters, only
 *     when a live {@link SurfaceGateway} is supplied (`CORTEX_GATEWAY=1`).
 *     Without the gateway, a per-stack adapter has no live detach path at
 *     all — refused with a clear reason, never a silent no-op.
 *   - `reload` — full support for a renderer instance that was constructed
 *     from an arc-installed BUNDLE (cache-bust re-`import()`, scratch-
 *     verified working — see `reimportRendererPlugin`'s doc comment in
 *     `src/adapters/loader.ts`). Refused for an IN-TREE renderer (no bundle
 *     to re-import; restart is the only way to pick up code changes) and
 *     for every adapter (adapter re-construction needs the binding-seed +
 *     demux-key inputs `GatewayAdapterFactory` owns today — that shim is
 *     cortex#1896, explicitly out of scope for this slice).
 *   - `load` — full support for a renderer bundle that was DISCOVERED but
 *     not constructed at boot (its `renderers[]` YAML entry's `kind` didn't
 *     resolve because the plugin hadn't loaded yet — `plugins.external` was
 *     off, or the bundle failed a transient gate) — the original raw config
 *     entry cortex.ts retained is reused verbatim, so `load` constructs
 *     EXACTLY what boot would have. Refused for adapters (same #1896
 *     rationale as reload).
 */

import type { PlatformAdapter } from "../adapters/types";
import {
  discoverPluginBundles,
  reimportRendererPlugin,
  type DiscoveredBundle,
  type DiscoverPluginBundlesResult,
  type ReimportRendererResult,
} from "../adapters/loader";
import type { RendererPlugin, SurfacePluginRegistry } from "../adapters/registry";
import type { Renderer } from "../renderers/types";
import type { SurfaceGateway } from "./surface-gateway";

// =============================================================================
// Live-state shapes
// =============================================================================

/**
 * One live renderer instance, tracked from the moment it is registered
 * (boot loop, `load`, or `reload`) until it is torn down (`unload` or the
 * old side of a `reload`). Retains everything a later `reload` needs to
 * reconstruct an equivalent instance: the ORIGINAL parsed config (so reload
 * never re-derives config from scratch) and the bundle it came from
 * (`"in-tree"` for the two permanent contract anchors — the mock adapter has
 * no renderer twin, so in practice `dashboard`/`pagerduty` — per ADR-0024 D2).
 */
export interface RendererHandle {
  renderer: Renderer;
  unregister: () => void;
  /** `"in-tree"` for statically-registered renderers; the arc bundle name
   *  for one loaded via `loadExternalPlugins`/`cortex plugin load`. */
  bundleName: string;
  /** Same as `renderer.kind` — kept alongside so callers don't need the
   *  live `Renderer` object just to build a list row. */
  rendererKind: string;
  /** The parsed config this instance was constructed with. `undefined` only
   *  transiently during construction; every handle in the live map has one. */
  config: unknown;
}

export interface LivePluginRow {
  kind: "adapter" | "renderer";
  /** adapter: `PlatformAdapter.platform`; renderer: `Renderer.kind`. */
  platformOrKind: string;
  instanceId: string;
  bundleName: string;
  running: boolean;
}

export interface MutationResult {
  ok: boolean;
  detail: string;
}

/**
 * A renderer `renderers[]` YAML entry that FAILED to construct at boot
 * (`resolveRendererPluginAndConfig` threw — usually `UnimplementedRendererKindError`
 * because the plugin hadn't loaded into the registry yet). Retained verbatim
 * so `load` can construct EXACTLY what boot would have, once the bundle is
 * actually loadable. Keyed by the raw entry's `kind` in
 * {@link PluginRuntimeDeps.skippedRendererConfigs}.
 */
export type SkippedRendererConfig = unknown;

/**
 * Injected live state + collaborators. Constructed once at boot
 * (`src/cortex.ts`) and handed to every control-request handler — the SAME
 * object every call reads/mutates, so a `list` right after an `unload` sees
 * the change.
 */
export interface PluginRuntimeDeps {
  /** Live reference to cortex.ts's boot-time `adapters` array — NOT a copy. */
  adapters: PlatformAdapter[];
  /** Live reference to the renderer-handle map cortex.ts's renderer boot
   *  loop populates and `load`/`reload`/`unload` mutate in place. */
  rendererHandles: Map<string, RendererHandle>;
  /** `router.register` — used by `load`/`reload` to bind a NEW renderer
   *  instance before the old one (if any) is torn down. */
  router: { register(adapter: Renderer["surfaceConfig"]): { unregister: () => void } };
  /** Present only when `CORTEX_GATEWAY=1` — gates adapter `unload`. */
  gateway?: SurfaceGateway;
  /** Raw `renderers[]` entries that failed to resolve at boot, keyed by the
   *  entry's `kind` — the `load` verb's input. Live reference, mutated by
   *  `load` (matched entries are removed once successfully loaded). */
  skippedRendererConfigs: Map<string, SkippedRendererConfig[]>;
  /** The SAME registry cortex.ts composed at boot — `load` needs it to
   *  resolve a bundle's declared renderer plugin id against what's already
   *  registered (refuses a `load` that would shadow an existing kind). */
  registry: SurfacePluginRegistry;
  /** Forwarded to `discoverPluginBundles`/tests; `undefined` = arc's real
   *  install root. */
  pkgRoot?: string;
  /** Test seam — defaults to the real `discoverPluginBundles`. Production
   *  callers never set this. */
  discoverBundles?: (opts: {
    pkgRoot?: string;
  }) => Promise<DiscoverPluginBundlesResult>;
  /** Test seam — defaults to the real `reimportRendererPlugin`. Production
   *  callers never set this. */
  reimportRenderer?: (
    bundle: DiscoveredBundle,
    opts: { bust: boolean },
  ) => Promise<ReimportRendererResult>;
}

// =============================================================================
// list
// =============================================================================

export function listLivePlugins(deps: PluginRuntimeDeps): LivePluginRow[] {
  const adapterRows: LivePluginRow[] = deps.adapters.map((a) => ({
    kind: "adapter" as const,
    platformOrKind: a.platform,
    instanceId: a.instanceId,
    // S6's loader doesn't thread per-adapter-instance bundle provenance
    // through to `wireSurfaceAdapters`/`SurfaceGateway` yet — every adapter
    // in `list` reports "in-tree" until that's wired (tracked with the same
    // #1896 GatewayAdapterFactory follow-up `reload`/`load` cite for adapters).
    bundleName: "in-tree",
    running: true,
  }));
  const rendererRows: LivePluginRow[] = [...deps.rendererHandles.values()].map((h) => ({
    kind: "renderer" as const,
    platformOrKind: h.rendererKind,
    instanceId: h.renderer.id,
    bundleName: h.bundleName,
    running: true,
  }));
  return [...adapterRows, ...rendererRows];
}

// =============================================================================
// unload
// =============================================================================

export async function unloadLivePlugin(
  deps: PluginRuntimeDeps,
  instanceId: string,
): Promise<MutationResult> {
  const handle = deps.rendererHandles.get(instanceId);
  if (handle) {
    handle.unregister();
    await handle.renderer.stop();
    deps.rendererHandles.delete(instanceId);
    return { ok: true, detail: `renderer "${instanceId}" detached` };
  }

  const adapter = deps.adapters.find((a) => a.instanceId === instanceId);
  if (adapter) {
    if (!deps.gateway) {
      return {
        ok: false,
        detail:
          `adapter "${instanceId}" cannot be unloaded — this daemon is not running with CORTEX_GATEWAY=1. ` +
          `Per-stack adapters constructed by the classic boot path (wireSurfaceAdapters) have no live ` +
          `detach mechanism (ADR-0024 blocker #13); only gateway-attached adapters support runtime unload.`,
      };
    }
    const res = await deps.gateway.detachAdapter(instanceId);
    if (!res.detached) {
      return {
        ok: false,
        detail: `adapter "${instanceId}" was not attached via the gateway — nothing to detach.`,
      };
    }
    return { ok: true, detail: `adapter "${instanceId}" detached` };
  }

  return { ok: false, detail: `no plugin instance "${instanceId}" is currently live` };
}

// =============================================================================
// reload — renderer-only (see module doc)
// =============================================================================

export async function reloadLivePlugin(
  deps: PluginRuntimeDeps,
  instanceId: string,
): Promise<MutationResult> {
  const handle = deps.rendererHandles.get(instanceId);
  if (!handle) {
    const isAdapter = deps.adapters.some((a) => a.instanceId === instanceId);
    if (isAdapter) {
      return {
        ok: false,
        detail:
          `adapter reload is out of scope for this slice — re-constructing an adapter needs the ` +
          `binding-seed + demux-key inputs GatewayAdapterFactory owns today (tracked separately at ` +
          `cortex#1896). Use "cortex plugin unload" + a config-driven restart instead.`,
      };
    }
    return { ok: false, detail: `no plugin instance "${instanceId}" is currently live` };
  }

  if (handle.bundleName === "in-tree") {
    return {
      ok: false,
      detail:
        `renderer "${instanceId}" is in-tree (bundleName "in-tree") — it has no bundle to re-import; ` +
        `a full daemon restart is the only way to pick up code changes to an in-tree renderer.`,
    };
  }

  const discoverBundles = deps.discoverBundles ?? discoverPluginBundles;
  const { bundles, issues } = await discoverBundles({ pkgRoot: deps.pkgRoot });
  const bundle = bundles.find((b) => b.bundleName === handle.bundleName);
  if (!bundle) {
    const issueDetail = issues.find((i) => i.bundleName === handle.bundleName);
    return {
      ok: false,
      detail:
        `bundle "${handle.bundleName}" is no longer discoverable` +
        (issueDetail ? ` (${issueDetail.reason})` : "") +
        ` — reload refused, the old instance is left running.`,
    };
  }

  const reimportRenderer = deps.reimportRenderer ?? reimportRendererPlugin;
  const reimport = await reimportRenderer(bundle, { bust: true });
  if (!reimport.ok) {
    return {
      ok: false,
      detail: `reload failed at ${reimport.stage}: ${reimport.reason} — the old instance is left running.`,
    };
  }

  return attachFreshRendererReplacing(deps, handle, instanceId, reimport.plugin, handle.config, handle.bundleName);
}

// =============================================================================
// load — renderer-only (see module doc)
// =============================================================================

export async function loadLivePlugin(
  deps: PluginRuntimeDeps,
  bundleName: string,
): Promise<MutationResult> {
  const alreadyLive = [...deps.rendererHandles.values()].some((h) => h.bundleName === bundleName);
  if (alreadyLive) {
    return {
      ok: false,
      detail: `bundle "${bundleName}" already has a live renderer instance — use "reload", not "load".`,
    };
  }

  const discoverBundles = deps.discoverBundles ?? discoverPluginBundles;
  const { bundles, issues } = await discoverBundles({ pkgRoot: deps.pkgRoot });
  const bundle = bundles.find((b) => b.bundleName === bundleName);
  if (!bundle) {
    const issueDetail = issues.find((i) => i.bundleName === bundleName);
    return {
      ok: false,
      detail: `bundle "${bundleName}" is not discoverable` + (issueDetail ? ` (${issueDetail.reason})` : "") + ".",
    };
  }
  if (bundle.manifest.kind !== "renderer") {
    return {
      ok: false,
      detail:
        `"cortex plugin load" supports renderer bundles only in this slice — adapter load needs the ` +
        `binding-seed + demux-key inputs GatewayAdapterFactory owns today (cortex#1896). ` +
        `"${bundleName}" declares kind "${bundle.manifest.kind}".`,
    };
  }

  const skippedEntries = deps.skippedRendererConfigs.get(bundle.manifest.id);
  if (!skippedEntries || skippedEntries.length === 0) {
    return {
      ok: false,
      detail:
        `no pending "renderers[]" config entry for kind "${bundle.manifest.id}" — "cortex plugin load" ` +
        `only activates a renderer this stack's cortex.yaml already declares (its boot-time construction ` +
        `failed because the plugin hadn't loaded). Add a "renderers[]" entry of this kind first.`,
    };
  }

  const reimportRenderer = deps.reimportRenderer ?? reimportRendererPlugin;
  const reimport = await reimportRenderer(bundle, { bust: false });
  if (!reimport.ok) {
    return { ok: false, detail: `load failed at ${reimport.stage}: ${reimport.reason}` };
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = reimport.plugin.configSchema.parse(skippedEntries[0]);
  } catch (err) {
    return {
      ok: false,
      detail: `load failed — the retained config entry does not satisfy the bundle's schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = await attachFreshRendererReplacing(
    deps,
    undefined,
    reimport.plugin.id,
    reimport.plugin,
    parsedConfig,
    bundleName,
  );
  if (result.ok) {
    const remaining = skippedEntries.slice(1);
    if (remaining.length > 0) {
      deps.skippedRendererConfigs.set(bundle.manifest.id, remaining);
    } else {
      deps.skippedRendererConfigs.delete(bundle.manifest.id);
    }
  }
  return result;
}

// =============================================================================
// Shared construct → start → attach-before-detach helper
// =============================================================================

/**
 * Construct a NEW renderer from `plugin`/`config`, start it, and register it
 * on the router BEFORE tearing down `oldHandle` (when one is supplied) —
 * ADR-0024 D3's renderer-delta requirement: "attach-before-detach … the
 * router tolerates two targets on the same subjects, and PagerDuty's
 * `dedup_key` absorbs the duplicate. Duplicate delivery is strictly safer
 * than a blind window for a pager." `load` has no old instance
 * (`oldHandle === undefined`) — construct-and-attach only.
 */
async function attachFreshRendererReplacing(
  deps: PluginRuntimeDeps,
  oldHandle: RendererHandle | undefined,
  oldInstanceId: string,
  plugin: RendererPlugin,
  config: unknown,
  bundleName: string,
): Promise<MutationResult> {
  let fresh: Renderer;
  try {
    fresh = plugin.createRenderer(config);
  } catch (err) {
    return {
      ok: false,
      detail:
        `construction of the new instance failed: ${err instanceof Error ? err.message : String(err)}` +
        (oldHandle ? " — the old instance is left running." : ""),
    };
  }
  try {
    await fresh.start();
  } catch (err) {
    return {
      ok: false,
      detail:
        `starting the new instance failed: ${err instanceof Error ? err.message : String(err)}` +
        (oldHandle ? " — the old instance is left running." : ""),
    };
  }

  const newReg = deps.router.register(fresh.surfaceConfig);
  deps.rendererHandles.set(fresh.id, {
    renderer: fresh,
    unregister: newReg.unregister,
    bundleName,
    rendererKind: fresh.kind,
    config,
  });

  if (oldHandle) {
    // Old instance leaves the router's dispatch list BEFORE teardown — no
    // render can observe a half-swapped renderer (ADR-0024 D3).
    oldHandle.unregister();
    try {
      await oldHandle.renderer.stop();
    } catch (err) {
      process.stderr.write(
        `cortex plugin-runtime: old renderer instance "${oldInstanceId}" failed to stop cleanly after reload: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (fresh.id !== oldInstanceId) {
      deps.rendererHandles.delete(oldInstanceId);
    }
    return { ok: true, detail: `renderer "${oldInstanceId}" reloaded from bundle "${bundleName}"` };
  }

  return { ok: true, detail: `renderer "${fresh.id}" loaded from bundle "${bundleName}"` };
}

// Re-exported so `plugin-control-server.ts` can construct discovery-only
// diagnostics without importing loader.ts directly (keeps the loader import
// surface to this one file, mirroring cortex.ts's existing convention).
export type { DiscoveredBundle };
