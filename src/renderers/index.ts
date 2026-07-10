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
 */

import type { RendererConfig } from "../common/types/cortex-config";
import type { SurfacePluginRegistry } from "../adapters/registry";
import type { Renderer } from "./types";

export type { Renderer } from "./types";
export { DashboardRenderer } from "./dashboard";
export { PagerDutyRenderer } from "./pagerduty";

export class UnimplementedRendererKindError extends Error {
  constructor(kind: string) {
    super(
      `cortex-renderers: kind "${kind}" is not registered. ` +
        `Only "dashboard" and "pagerduty" are registered in-tree; "cli-tail" and "webhook-out" ` +
        `land as bundles (ADR-0024 §8.1 OQ11).`,
    );
    this.name = "UnimplementedRendererKindError";
  }
}

export function createRenderer(config: RendererConfig, registry: SurfacePluginRegistry): Renderer {
  const plugin = registry.getRenderer(config.kind);
  if (!plugin) {
    throw new UnimplementedRendererKindError(config.kind);
  }
  return plugin.createRenderer(config);
}
