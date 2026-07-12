/**
 * cortex#1792 (S6, ADR-0024 OQ11) — the cli-tail renderer, "born as a
 * bundle." ZERO cortex runtime code: the only cortex-adjacent import below
 * is `import type` from `surface-sdk` — a plugin-author's compile-time
 * contract, erased before this file ever runs (Bun strips `import type`
 * statements entirely). At runtime this module depends on nothing but
 * `zod` (a `peerDependency` any bundle author would declare in their own
 * `package.json`, exactly like a real out-of-tree bundle) and the platform
 * standard library (`process.stdout`).
 *
 * This is the loader's own end-to-end LOAD-path proof (OQ11): discovery
 * finds this manifest, the compat gate checks `sdkRange` against the
 * running `SURFACE_SDK_VERSION`, `import()` loads this module with no
 * cortex-internal dependency at all, the default export is shape-validated
 * as a `RendererPlugin`, and it registers into the live
 * `SurfacePluginRegistry` — proving discover → gate → import → register →
 * render works for a plugin that ships zero cortex code.
 */

import { z } from "zod/v4";
import type { Envelope, RenderTarget, Renderer, RendererPlugin } from "../../../../surface-sdk";

const CliTailFixtureConfigSchema = z.object({
  kind: z.literal("cli-tail"),
  id: z.string().min(1).optional(),
  subscribe: z.array(z.string().min(1)).default(["local.{principal}.>"]),
});

type CliTailFixtureConfig = z.infer<typeof CliTailFixtureConfigSchema>;

class CliTailFixtureRenderer implements Renderer {
  readonly kind = "cli-tail" as const;
  readonly id: string;
  readonly subjects: string[];

  constructor(config: CliTailFixtureConfig) {
    this.id = config.id ?? "cli-tail";
    this.subjects = config.subscribe;
  }

  async start(): Promise<void> {
    // No I/O at start — stdout is always available.
  }

  async stop(): Promise<void> {
    // Nothing to release.
  }

  get surfaceConfig(): RenderTarget {
    return {
      id: this.id,
      subjects: this.subjects,
      render: (envelope, signal) => this.render(envelope, signal),
    };
  }

  async render(envelope: Envelope, _signal?: AbortSignal): Promise<void> {
    // Renderer contract (surface-sdk `Renderer.render`): MUST NOT throw.
    try {
      process.stdout.write(`[cli-tail] ${envelope.type} ${envelope.source}\n`);
    } catch {
      // Swallow — a broken stdout must not poison the surface-router's
      // dispatch loop.
    }
  }
}

const cliTailFixturePlugin: RendererPlugin = {
  kind: "renderer",
  id: "cli-tail",
  rendererKind: "cli-tail",
  configSchema: CliTailFixtureConfigSchema,
  createRenderer: (config) => new CliTailFixtureRenderer(CliTailFixtureConfigSchema.parse(config)),
};

export default cliTailFixturePlugin;
