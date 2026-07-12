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
 *      Principal-input emitted from a renderer (e.g., a dashboard
 *      "approve" click) goes through the bus as a logical envelope
 *      from the principal, not from any agent (architecture §9.3).
 *
 * **REVERSED — renderers are NOT static across hot-reload.** [ADR-0024](../../docs/adr/0024-pluggable-surface-adapters.md)
 * (cortex#1793, S8) reverses the "Renderers are static across hot-reload"
 * decision this comment used to make, on its own stated terms (ADR-0024
 * §Consequences: "⚠ REVERSAL"). The original three premises and what
 * changed:
 *
 *   1. *"A restart is cheap enough"* — no longer true once a renderer is a
 *      separately-installable bundle (ADR-0024 D5): forcing a full daemon
 *      restart to activate one new renderer drags every live adapter
 *      connection and in-flight dispatch through it for an unrelated plugin.
 *   2. *"Partial hot-reload is harder to reason about"* — honoured, not
 *      contradicted. There is still no `updateConfig(RendererConfig)` hook
 *      and no mid-flight routing-key swap. What changed is the GRANULARITY
 *      of the stop/start cycle: **detach → destroy → construct → attach**
 *      via the `{ unregister }` handle `SurfaceRouter.register()` already
 *      returned (`src/bus/surface-router.ts`) — the renderer boot loop used
 *      to discard that handle; S8 retains it. The target leaves the
 *      router's dispatch list *before* teardown, so no render ever observes
 *      a half-swapped renderer. Full stop/start remains the semantic; its
 *      blast radius shrinks from *the daemon* to *one renderer*.
 *   3. *"A renderer's resources are scoped to its lifetime"* — still true,
 *      and it's exactly what makes per-instance destroy-and-reconstruct safe
 *      here (a renderer owns nothing durable and never publishes) where it
 *      would NOT be safe for a platform adapter (which drops a live
 *      connection and orphans progress placeholders).
 *
 * State loss on detach/reload is intentional and, per the above, harmless:
 * the dashboard ring buffer resets (nothing reads it — ADR-0024 D2/OQ8); a
 * renderer with a stable per-envelope derivation (e.g. PagerDuty's
 * `dedup_key`, `src/renderers/pagerduty.ts`) is reload-stable by
 * construction. `cortex plugin reload` (cortex#1793) is the runtime verb;
 * `docs/plugin-sdk.md` documents the state-loss contract a plugin author
 * must design for.
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
