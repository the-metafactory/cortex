/**
 * cortex#1792 (S6) — a structurally VALID `RendererPlugin` whose own `id`
 * ("totally-different-id") disagrees with its manifest's declared id
 * ("id-mismatch-renderer"). Proves the `imported.id !== manifest.id` branch
 * in `loader.ts`'s shape_validate stage actually refuses a real mismatch —
 * the loader.test.ts test that claimed to cover this branch previously only
 * asserted the AGREEING (happy-path) case.
 */

import { z } from "zod/v4";
import type { Envelope, RenderTarget, Renderer, RendererPlugin } from "../../../../surface-sdk";

const IdMismatchConfigSchema = z.object({ kind: z.literal("id-mismatch") }).catchall(z.unknown());

class IdMismatchRenderer implements Renderer {
  readonly kind = "id-mismatch" as const;
  readonly id = "totally-different-id";
  readonly subjects: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  get surfaceConfig(): RenderTarget {
    return {
      id: this.id,
      subjects: this.subjects,
      render: (envelope, signal) => this.render(envelope, signal),
    };
  }

  async render(_envelope: Envelope, _signal?: AbortSignal): Promise<void> {}
}

const idMismatchPlugin: RendererPlugin = {
  kind: "renderer",
  // Deliberately DIFFERENT from the manifest's "id-mismatch-renderer" — the
  // exact disagreement the shape_validate id check must refuse.
  id: "totally-different-id",
  rendererKind: "id-mismatch",
  configSchema: IdMismatchConfigSchema,
  createRenderer: () => new IdMismatchRenderer(),
};

export default idMismatchPlugin;
