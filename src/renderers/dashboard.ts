/**
 * MIG-7.2d — Dashboard renderer (in-memory buffer stub).
 *
 * Architecture §9.2 makes the dashboard activity-centric, not agent-centric.
 * The eventual Mission Control v3 surface (under `src/surface/mc/`) reads
 * from a stream of recent bus envelopes and projects them into
 * Kanban/inbox/status-banner views. Full Mission Control integration
 * lands at MIG-7.13 (integration test) when cortex.ts wires MC into the
 * top-level startup.
 *
 * For this slice the dashboard renderer is the *sink* that satisfies the
 * G-1111 §4.6 fail-safe rule's pairing requirement alongside
 * `PagerDutyRenderer` — operationally distinct platform classes both
 * subscribed to `local.{principal}.system.>` so a degraded NATS subscription
 * for one doesn't blind the principal on the other.
 *
 * Implementation: a bounded ring buffer over the last N envelopes the
 * router delivered. Tests probe `getRecent()` to assert the renderer is
 * actually receiving; Mission Control's projection pipeline will graduate
 * the buffer to a richer data structure at MIG-7.13.
 *
 * The renderer DOES NOT serve HTTP itself — Mission Control's existing
 * Bun server keeps that concern. Wiring is one direction only: cortex.ts
 * registers the renderer with the surface-router; MC's server (a separate
 * Bun process today, an in-process module post-MIG-7.13) reads the buffer
 * out of process when it lands.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../bus/surface-router";
import type { DashboardRendererConfig } from "../common/types/cortex-config";
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
    // Single dashboard per cortex deployment; the bare kind is a stable
    // surface-router id without needing per-port disambiguation.
    this.id = "dashboard";
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

  get surfaceConfig(): SurfaceAdapter {
    return {
      id: this.id,
      subjects: this.subjects,
      // IAW Phase A.4 — only set the visibility field when the principal
      // declared one. Leaving it `undefined` on the adapter means the
      // router's evaluateVisibility short-circuits to "no constraint",
      // matching pre-A.4 behaviour exactly. Spreading conditionally keeps
      // the SurfaceAdapter literal clean.
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
