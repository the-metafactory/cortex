/**
 * MIG-7.2d — Renderer factory.
 *
 * cortex#1788 (S3, ADR-0024 D5) — `createRenderer` no longer switches on a
 * closed `RendererKind` enum. It resolves the `("renderer", kind)` entry from
 * the injected `SurfacePluginRegistry` instead — the registry-side twin of
 * `buildGatewayAdapters`' generic loop (`src/gateway/gateway-adapters.ts`).
 * `dashboard` and `pagerduty` register through it exactly as an out-of-tree
 * bundle eventually would (dogfooding, ADR-0024 §3.3); `cli-tail` and
 * `webhook-out` are NOT registered in this slice (S6 owns shipping them as
 * bundles, design-pluggable-adapters.md OQ11) — an unregistered kind hits the
 * SAME `UnimplementedRendererKindError` a config author saw before, so a
 * typo or an unimplemented kind still fails loudly rather than silently
 * producing a no-op renderer.
 *
 * cortex#1789 (S4, ADR-0024 D5) — `createRenderer` now accepts the RAW
 * `renderers[]` entry (`unknown`), not an already-typed `RendererConfig`. It
 * performs the REGISTRY pass itself: resolve `kind` → look up the plugin →
 * parse the raw entry through THAT plugin's `configSchema` (the real,
 * strongly-typed per-kind schema, e.g. `PagerDutyRendererSchema`) → dispatch
 * to `plugin.createRenderer`. This absorbs what used to be a separate
 * `RendererSchema.safeParse(raw)` call at each call site (`cortex.ts`'s
 * renderer boot loop) — `RendererSchema` itself is now only the loose
 * STRUCTURAL schema (`{kind: string, ...}`, see `cortex-config.ts`), so the
 * real per-kind validation has to happen here, where a registry is in hand.
 * {@link resolveRendererPluginAndConfig} exposes the validate-without-
 * construct half for callers (`migrate-config-lib.ts`) that want a validated
 * config WITHOUT building a live renderer instance.
 */

import { RendererSchema, type RendererConfig } from "../common/types/cortex-config";
import type { RendererPlugin, SurfacePluginRegistry } from "../adapters/registry";
import type { Renderer } from "./types";

export type { Renderer } from "./types";
export { DashboardRenderer } from "./dashboard";
export { PagerDutyRenderer } from "./pagerduty";

export class UnimplementedRendererKindError extends Error {
  constructor(kind: string, registry: SurfacePluginRegistry) {
    const installed = registry.listRenderers().map((p) => p.id).sort().join(", ") || "(none)";
    super(
      `cortex-renderers: kind "${kind}" is not registered. Installed renderer kinds: ${installed}. ` +
        `"cli-tail" and "webhook-out" land as bundles (ADR-0024 §8.1 OQ11) — they are not registered ` +
        `in-tree until S6.`,
    );
    this.name = "UnimplementedRendererKindError";
  }
}

/**
 * cortex#1789 (S4) — the REGISTRY pass for a single `renderers[]` entry.
 * Structural validity (`{kind, ...}`) is established by `RendererSchema`
 * (the structural pass) first; this resolves the plugin for `kind` (throwing
 * {@link UnimplementedRendererKindError} with the SAME loudness the old
 * closed enum gave a typo) and parses the RAW entry through that plugin's
 * `configSchema`, returning the plugin alongside the fully-validated,
 * defaults-applied config. Split from {@link createRenderer} so a caller
 * that only wants VALIDATION (no live instance — `migrate-config-lib.ts`'s
 * `buildRenderers`) doesn't have to construct one.
 */
export function resolveRendererPluginAndConfig(
  raw: unknown,
  registry: SurfacePluginRegistry,
): { plugin: RendererPlugin; config: RendererConfig } {
  const entry = RendererSchema.parse(raw);
  const plugin = registry.getRenderer(entry.kind);
  if (!plugin) {
    throw new UnimplementedRendererKindError(entry.kind, registry);
  }
  const config = plugin.configSchema.parse(raw) as RendererConfig;
  return { plugin, config };
}

export function createRenderer(raw: unknown, registry: SurfacePluginRegistry): Renderer {
  const { plugin, config } = resolveRendererPluginAndConfig(raw, registry);
  return plugin.createRenderer(config);
}
