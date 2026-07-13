/**
 * cortex#1894 (S12b, ADR-0024 §8.1) — `pagerduty`'s `RendererPlugin`.
 *
 * cortex#1894 (S12b MOVE) — this bundle's `cortex-plugin.yaml` declares
 * `kind: renderer`, `id: pagerduty`, `entry: ./src/plugin.ts`, `sdkRange:
 * "^1"`. The default export IS the `SurfacePlugin` (ADR-0024 D1: "sdkRange in
 * its default-exported SurfacePlugin") — cortex's S6 loader reads
 * `defaultExport.sdkRange` at `import()` time to gate compatibility, and
 * requires the DEFAULT export (not a named one) to satisfy the
 * `RendererPlugin` shape (`src/adapters/loader.ts`'s `isRendererPluginShape`).
 *
 * `pagerdutyRendererPlugin.createRenderer`'s body is unchanged from its
 * pre-extraction, in-tree form (`src/renderers/pagerduty.ts`'s
 * `pagerdutyRendererPlugin`) — this slice moved WHERE the renderer + its
 * schema live, not WHAT they construct; behavior is unchanged.
 */

import type { RendererPlugin } from "@the-metafactory/cortex/surface-sdk";
import { PagerDutyRenderer } from "./pagerduty";
import { PagerDutyRendererSchema, type PagerDutyRendererConfig } from "./schema";

export const pagerdutyRendererPlugin: RendererPlugin = {
  kind: "renderer",
  id: "pagerduty",
  rendererKind: "pagerduty",
  // cortex#1789 (S4) — the real per-kind schema, incl. the REQUIRED
  // `routingKey` secret field. `createRenderer` parses the raw entry through
  // this before construction; a Zod validation failure never echoes the
  // rejected value (only the field path + message), so a malformed
  // `routingKey` is never leaked into the thrown error.
  configSchema: PagerDutyRendererSchema,
  createRenderer: (config) => new PagerDutyRenderer(config as PagerDutyRendererConfig),
};

// cortex#1894 (S12b MOVE) — the default export IS the `SurfacePlugin`
// (ADR-0024 D1): cortex's S6 loader reads `mod.default` at `import()` time and
// gates on `defaultExport.sdkRange`. Every adapter bundle hit the miss where
// the loader read `mod.default` but the bundle exported the plugin as a named
// export only; spread the plugin into the default export with `sdkRange`.
export default { ...pagerdutyRendererPlugin, sdkRange: "^1" as const };

// Re-exports so this bundle's tests (and any downstream consumer) can import
// the class + schema without reaching into sibling module paths.
export { PagerDutyRenderer, type PagerDutyRendererOptions } from "./pagerduty";
export {
  PagerDutyRendererSchema,
  RendererVisibilitySchema,
  type PagerDutyRendererConfig,
  type RendererVisibility,
} from "./schema";
