/**
 * MIG-7.2d — Dashboard renderer (in-memory buffer stub).
 *
 * ## SUPERSEDED as the MC feed (ADR-0005 §4, MC-I1.S6 #848)
 *
 * This ring buffer was the MIG-7.13 plan's anticipated bus→MC IPC mechanism:
 * MC was to POLL `getRecent()` and project the recent-envelope window onto the
 * glass. **ADR-0005 §4 demotes that plan.** The bus→MC seam is now a registered
 * surface-router renderer (`src/surface/mc/projection/dispatch-lifecycle-renderer.ts`)
 * doing push-based `project(envelope)` straight into MC rows — no polling, no
 * 1000-envelope bound that drops bursts, no dedup bookkeeping. The ADR records
 * this buffer "survives, if at all, only as the drill-down's recent-raw-envelopes
 * feed."
 *
 * **S6 disposition: RETAINED, not retired.** Verified at S6 time that NOTHING in
 * production reads `getRecent()` (only this file's own tests do) — so the buffer
 * is functionally inert as an MC feed. It is kept rather than removed because:
 *   - it is still a user-facing `renderers:` config `kind: dashboard` in the
 *     `RendererSchema` discriminated union; removing it is a config-breaking
 *     change (a principal carrying `kind: dashboard` would fail to boot), wider
 *     blast radius than the faithful demotion this slice owns; and
 *   - it still satisfies the G-1111 §4.6 fail-safe-pairing rule alongside
 *     `PagerDutyRenderer` (two operationally-distinct sinks on
 *     `local.{principal}.system.>` so a degraded subscription for one doesn't
 *     blind the principal on the other) — retiring it would also need that rule
 *     re-homed.
 * If/when the ADR's "drill-down recent-raw feed" consumer is built it reads off
 * `getRecent()`; until then this is a no-op sink, intentionally.
 *
 * The renderer DOES NOT serve HTTP itself — Mission Control's existing Bun
 * server keeps that concern. Architecture §9.2 makes the dashboard
 * activity-centric, not agent-centric.
 */

import type { Envelope, RenderTarget, RendererPlugin } from "../surface-sdk";
import { DashboardRendererSchema, type DashboardRendererConfig } from "../common/types/cortex-config";
import type { Renderer } from "./types";

export interface DashboardRendererOptions {
  /** Max envelopes retained in the ring buffer. Default 1000 — generous
   *  enough for the dashboard's tail view, small enough to bound memory
   *  at ~few MB even with rich envelopes. */
  bufferSize?: number;
}

export class DashboardRenderer implements Renderer {
  readonly kind = "dashboard" as const;
  readonly id: string;
  readonly subjects: string[];

  private readonly bufferSize: number;
  private buffer: Envelope[] = [];
  private readonly visibility: DashboardRendererConfig["visibility"];

  constructor(config: DashboardRendererConfig, options: DashboardRendererOptions = {}) {
    // cortex#1788 (S3, ADR-0024 OQ10) — `config.id` defaults to `kind`,
    // preserving the pre-OQ10 single-dashboard-per-deployment id exactly
    // when unset. Two `kind: dashboard` entries now need distinct
    // `id:` values in config to avoid colliding in router metrics.
    this.id = config.id ?? "dashboard";
    this.subjects = config.subscribe;
    this.bufferSize = options.bufferSize ?? 1000;
    // IAW Phase A.4 — capture the optional visibility block. Forwarded to
    // the surface-router via `surfaceConfig` so router-side filtering
    // honours principal-declared constraints. Unset means "no filter".
    this.visibility = config.visibility;
  }

  // Renderer interface contract — both methods MUST be Promise<void>.
  // No I/O today, but signature stays for future Mission Control wiring.
  /* eslint-disable @typescript-eslint/require-await */
  async start(): Promise<void> {
    // Buffer is already empty + bounded; no I/O to perform. The lifecycle
    // hook is here for symmetry — Mission Control integration at MIG-7.13
    // will use it to open the HTTP server / WebSocket pump that reads
    // from `getRecent()`.
  }

  async stop(): Promise<void> {
    // Drop the buffer so a subsequent start() doesn't leak prior state.
    // Tests rely on this for clean per-test isolation.
    this.buffer = [];
  }
  /* eslint-enable @typescript-eslint/require-await */

  get surfaceConfig(): RenderTarget {
    return {
      id: this.id,
      subjects: this.subjects,
      // IAW Phase A.4 — only set the visibility field when the principal
      // declared one. Leaving it `undefined` on the adapter means the
      // router's evaluateVisibility short-circuits to "no constraint",
      // matching pre-A.4 behaviour exactly. Spreading conditionally keeps
      // the RenderTarget literal clean.
      ...(this.visibility !== undefined && { visibility: this.visibility }),
      render: (envelope, signal) => this.render(envelope, signal),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async render(envelope: Envelope, _signal?: AbortSignal): Promise<void> {
    // Renderer contract §2: never throw. The push/shift are infallible,
    // but the try-catch + null guard are defense-in-depth so a future
    // change (e.g. structured-clone the envelope to break sharing) that
    // could throw on a malformed payload doesn't poison the router's
    // dispatch loop (Holly cycle 1 W1+W2).
    try {
      // Defense-in-depth: the surface-router validates envelopes before
      // dispatch, but a malformed value sneaking through MUST NOT
      // corrupt the buffer + leak into Mission Control's projection
      // pipeline via getRecent(). Silently drop instead.
      // Defensive null/object check guards against future malformed input
      // even though TS narrows it. Suppress dead-condition on this surface.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (envelope === null || typeof envelope !== "object") return;
      this.buffer.push(envelope);
      if (this.buffer.length > this.bufferSize) {
        // Drop the oldest envelope to maintain the bound. Single shift
        // per overflow is O(n) on the underlying array; if the buffer
        // hot path ever becomes a profile concern we'd switch to a true
        // ring index here, but at 1000-entry default + single-digit
        // envelope rate this is several orders of magnitude below any
        // measurable cost.
        this.buffer.shift();
      }
    } catch (err) {
      console.warn(
        `dashboard-renderer: render() swallowed an error while buffering envelope ${envelope.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Test/integration hook — returns a snapshot of currently-buffered
   *  envelopes (oldest first). Returns a copy so callers can't mutate
   *  the internal buffer. Mission Control's eventual reader will project
   *  off this snapshot. */
  getRecent(): readonly Envelope[] {
    return [...this.buffer];
  }
}

/**
 * cortex#1788 (S3, ADR-0024 D2/OQ8) — `dashboard`'s `RendererPlugin`.
 * `dashboard` is a permanent in-tree contract anchor (never extracts — D2,
 * design-pluggable-adapters.md §7.1): removing `kind: dashboard` from the
 * registered set is config-breaking, and it is one half of the G-1111 §4.6
 * fail-safe pair. It registers through the SAME registry a bundle would
 * (dogfooding, ADR-0024 §3.3) even though it never ships as one.
 */
export const dashboardRendererPlugin: RendererPlugin = {
  kind: "renderer",
  id: "dashboard",
  rendererKind: "dashboard",
  // cortex#1789 (S4) — the real per-kind schema. `createRenderer`
  // (`src/renderers/index.ts`) now parses the RAW `renderers[]` entry
  // through this before construction (registry pass), applying `port`/
  // `subscribe`/`projections` defaults exactly as the old discriminated
  // union did.
  configSchema: DashboardRendererSchema,
  createRenderer: (config) => new DashboardRenderer(config as DashboardRendererConfig),
};
