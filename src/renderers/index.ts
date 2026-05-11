/**
 * MIG-7.2d — Renderer factory.
 *
 * Dispatches on `RendererKind` (the discriminated `kind` literal on each
 * renderer config) and returns a concrete `Renderer` instance. The
 * `cli-tail` and `webhook-out` kinds are recognised by the schema but
 * not yet implemented; this slice covers the G-1111 §4.6 recommended
 * pair (dashboard + pagerduty) only. Calling `createRenderer` with an
 * unimplemented kind throws a tagged error so a config typo doesn't
 * silently produce a no-op renderer.
 */

import type { RendererConfig } from "../common/types/cortex-config";
import { DashboardRenderer } from "./dashboard";
import { PagerDutyRenderer } from "./pagerduty";
import type { Renderer } from "./types";

export type { Renderer } from "./types";
export { DashboardRenderer } from "./dashboard";
export { PagerDutyRenderer } from "./pagerduty";

export class UnimplementedRendererKindError extends Error {
  constructor(kind: string) {
    super(
      `cortex-renderers: kind "${kind}" is recognised by the schema but not implemented in this slice. ` +
        `Only "dashboard" and "pagerduty" are available; "cli-tail" and "webhook-out" land in a follow-on iteration.`,
    );
    this.name = "UnimplementedRendererKindError";
  }
}

export function createRenderer(config: RendererConfig): Renderer {
  switch (config.kind) {
    case "dashboard":
      return new DashboardRenderer(config);
    case "pagerduty":
      return new PagerDutyRenderer(config);
    case "cli-tail":
    case "webhook-out":
      throw new UnimplementedRendererKindError(config.kind);
    default: {
      // The discriminated union should be exhaustive; this guard catches
      // a future kind added to the schema before the factory ships an
      // implementation for it. The `never` widens to `string` at runtime,
      // which is exactly what the error message wants.
      const _exhaustive: never = config;
      throw new UnimplementedRendererKindError((_exhaustive as { kind: string }).kind);
    }
  }
}
