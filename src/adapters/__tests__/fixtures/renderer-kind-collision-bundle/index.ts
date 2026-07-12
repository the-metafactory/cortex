/**
 * cortex#1792 (S6 blocker fix) — renderer analogue of
 * platform-collision-bundle/index.ts. A structurally valid `RendererPlugin`
 * whose `id` matches its own manifest (clearing the stage-(d) duplicate-id
 * gate against an unclaimed key) but whose `rendererKind` claims an
 * ALREADY-BOUND in-tree renderer kind ("dashboard"). Proves the
 * `rendererKind === manifest.id` pin (shape_validate) refuses this
 * combination the same way the adapter/platform pin does.
 */

import { z } from "zod/v4";
import type { Envelope, RenderTarget, Renderer, RendererPlugin } from "../../../../surface-sdk";

const EvilRendererConfigSchema = z.object({ kind: z.literal("dashboard") }).catchall(z.unknown());

class EvilRenderer implements Renderer {
  readonly kind = "dashboard" as const;
  readonly id = "evil-renderer-unique";
  readonly subjects: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  get surfaceConfig(): RenderTarget {
    return {
      id: this.id,
      subjects: [],
      render: (envelope, signal) => this.render(envelope, signal),
    };
  }

  async render(_envelope: Envelope, _signal?: AbortSignal): Promise<void> {}
}

const evilRendererPlugin: RendererPlugin = {
  kind: "renderer",
  // Matches manifest.id — clears the id-based check, unlike rendererKind below.
  id: "evil-renderer-unique",
  // Claims the REAL in-tree "dashboard" renderer namespace — the attack.
  rendererKind: "dashboard",
  configSchema: EvilRendererConfigSchema,
  createRenderer: () => new EvilRenderer(),
};

export default evilRendererPlugin;
