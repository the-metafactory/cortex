/**
 * MIG-7.2d — Renderer interface (architecture §9.2).
 *
 * Renderers are non-agent-bound surfaces that project bus state to humans
 * (dashboards), out-of-band notification targets (PagerDuty), or external
 * systems (generic webhooks). Distinct from presence adapters: renderers
 * subscribe and present; they never publish on the bus as a side effect
 * of rendering (architecture §9.3 coupling rule).
 *
 * A `Renderer` extends the `SurfaceAdapter` contract (`id` + `subjects` +
 * `render`) with a lifecycle pair (`start`/`stop`) so cortex.ts can bring
 * each instance up alongside the platform adapters and tear them down at
 * shutdown.
 *
 * The G-1111 §4.6 fail-safe rule requires ≥2 distinct platform classes
 * covering `local.{principal}.system.>` — dashboard + pagerduty is the
 * "recommended pair" the plan-cortex-migration.md §4 MIG-7.2d step calls
 * for. cli-tail and webhook-out kinds round out the discriminated union
 * for v1 completeness, though only dashboard + pagerduty are implemented
 * in this slice; the other two are scheduled for follow-on iterations
 * once a real cortex deployment surfaces the need.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../bus/surface-router";
import type { RendererKind } from "../common/types/cortex-config";

/**
 * A non-agent-bound surface that subscribes to bus subjects and projects
 * envelopes into a sink (UI, external API, log stream). Implementations
 * MUST satisfy three contracts:
 *
 *   1. `start()` is idempotent and synchronous-or-fast. Heavy I/O at
 *      construction is fine; lifecycle hooks should not block cortex
 *      startup for more than a few hundred ms.
 *   2. `render()` MUST NOT throw. Failed delivery logs + drops; the
 *      surface-router wraps every `render()` in a per-call timeout +
 *      `Promise.allSettled` regardless, but renderers carry the moral
 *      obligation to not poison the dispatch path.
 *   3. `render()` MUST NOT publish on the bus as a side effect.
 *      Operator-input emitted from a renderer (e.g., a dashboard
 *      "approve" click) goes through the bus as a logical envelope
 *      from the operator, not from any agent (architecture §9.3).
 *
 * **Renderers are static across hot-reload.** Unlike platform adapters
 * (which carry an `updateConfig(BotConfig)` hook that the
 * `ConfigWatcher` invokes on bot.yaml changes), renderers have no
 * config-update surface. A change to `renderers[]` — adding a
 * pagerduty integration, rotating a routing key, expanding the
 * dashboard subscription set — requires a cortex restart to take
 * effect. This is intentional for the v1 slice: a renderer's
 * resources (HTTP clients, ring buffers, subscriptions) are scoped to
 * its lifetime, and the failure modes of partial hot-reload (a
 * routing key swap mid-flight) are easier to reason about with a
 * full stop/start cycle. A future iteration MAY add an
 * `updateConfig(RendererConfig)` hook if the operator-visible cost of
 * the restart proves too high (Holly cycle 1 W3).
 */
export interface Renderer {
  /** Discriminator matching `RendererKind`. */
  readonly kind: RendererKind;
  /** Stable identifier, used in surface-router metrics + error reporting. */
  readonly id: string;
  /** NATS subject patterns this renderer wants to receive. Empty means
   *  the surface-router never invokes `render()`. */
  readonly subjects: string[];
  /** Bring the renderer to a state where `render()` calls can succeed.
   *  May open HTTP clients, allocate buffers, register internal handlers.
   *  Idempotent. */
  start(): Promise<void>;
  /** Tear down resources. After `stop()`, `render()` calls SHOULD be no-ops
   *  rather than throw — adapter-lifecycle race conditions are common at
   *  shutdown and an error here would pollute the shutdown log. */
  stop(): Promise<void>;
  /** Project a single envelope onto the renderer's sink. The surface-router
   *  wraps this call with a timeout + isolation; implementations focus on
   *  the projection, not the dispatch plumbing. */
  render(envelope: Envelope, signal?: AbortSignal): Promise<void>;
  /** Return the `SurfaceAdapter` face the surface-router consumes. Wired
   *  exactly once at startup via `router.register(renderer.surfaceConfig)`. */
  readonly surfaceConfig: SurfaceAdapter;
}
