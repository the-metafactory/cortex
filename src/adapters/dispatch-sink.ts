/**
 * cortex#491 — **Dispatch sink** (OUTBOUND, Option B).
 *
 * The outbound half of a platform adapter (CONTEXT.md §Dispatch-sink): it
 * subscribes to the dispatch lifecycle stream
 * (`dispatch.task.{started|completed|failed|aborted}`), filters to the
 * envelopes whose **response routing** (CONTEXT.md §Response-routing)
 * names THIS adapter instance, renders the lifecycle event to text, and
 * delivers it back to the EXACT originating channel/thread via
 * `adapter.postResponse` / `adapter.sendProgress`.
 *
 * The sink keeps NO inbound state — the routing is wire-level. The runner
 * echoes `payload.response_routing` (`{ adapter_instance, channel_id,
 * thread_id? }`) onto every lifecycle envelope (see
 * `src/runner/dispatch-listener.ts` → `echoResponseRouting`); the sink
 * reads it straight off the envelope and posts.
 *
 * ## Single delivery path
 *
 * This consumer is the SOLE deliverer of lifecycle replies. It subscribes
 * via the runtime directly (`runtime.subscribe` + `runtime.onEnvelope`,
 * symmetric with how the runner self-subscribes in cortex#484 Option D),
 * NOT via `surfaceSubjects` on the surface-router. Adding
 * `dispatch.task.*` to a surface adapter's `surfaceSubjects` would be a
 * SECOND, cruder delivery path (it renders the JSON code-block fallback
 * to whatever channel the adapter is bound to) and would double-reply.
 * The render-leak guard `surfaceSubjects: []` stays untouched.
 *
 * ## Text rendering
 *
 * Reuses `formatDispatchLifecycle` from `envelope-renderer.ts` (the
 * cortex#497 renderer) verbatim — one formatter, no reinvented copy. The
 * sink owns delivery + instance targeting; the renderer owns the text.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import { formatDispatchLifecycle } from "./envelope-renderer";
import {
  createRenderDedupe,
  deliverRoutedResponse,
  LIFECYCLE_TYPE_PREFIX,
  readResponseRouting,
} from "./response-routing-delivery";
export { dispatchCorrelationKey } from "./response-routing-delivery";
import type { PlatformAdapter, ResponseTarget } from "./types";

export interface DispatchSinkOptions {
  /**
   * Runtime to subscribe on. The sink uses the SAME `onEnvelope` +
   * `subscribe` primitives the runner uses, so it sees every lifecycle
   * envelope the runner publishes via `runtime.publish`.
   */
  runtime: MyelinRuntime;
  /**
   * Platform adapters whose outbound side this sink drives. The sink
   * matches `response_routing.adapter_instance` against each adapter's
   * `instanceId`; envelopes for an instance NOT in this list are ignored
   * (no cross-instance posting).
   */
  adapters: readonly PlatformAdapter[];
  /**
   * `{principal}` segment of the lifecycle subject. The sink subscribes to
   * `local.{principal}[.{stack}].dispatch.task.>`.
   */
  principal: string;
  /**
   * Optional `{stack}` segment. When the runtime publishes with a stack
   * (the 6-segment grammar), the subscribe pattern must carry it too.
   */
  stack?: string;
  /**
   * a.3d (cortex#524) — MULTIPLE `{stack}` segments. The shared surface
   * gateway serves many bound stacks under ONE principal, so its outbound
   * sink must subscribe to every bound stack's lifecycle subject, not just
   * one. When provided and non-empty, `stacks` takes precedence over `stack`:
   * one subscribe subject is built per DISTINCT entry. An `undefined` entry
   * maps to the 5-segment legacy subject (`local.{principal}.dispatch.task.>`)
   * — the shape a gap-4 binding with no `stack` field publishes on.
   *
   * Single-stack callers (the per-stack `cortex.ts` wiring) keep passing
   * `stack`. Regardless of subject count there is still exactly ONE
   * `onEnvelope` handler, so multiple subjects never double-deliver an
   * envelope; the `adapter_instance` filter remains the sole delivery gate.
   */
  stacks?: readonly (string | undefined)[];
  /**
   * F-1 (cortex#629) — MULTIPLE `(principal, stack)` pairs. When the shared
   * surface gateway serves MORE THAN ONE principal on a shared bus (signing
   * OFF — dev/trusted only), each bound stack's reply lands on ITS OWN
   * principal's namespace, not the gateway principal's. `stacks` (above) is
   * single-principal — it pairs every leaf with the one `principal`. This
   * generalises it: one subscribe subject per DISTINCT `(principal, stack)`
   * pair (`local.{principal}.{stack}.dispatch.task.>`, or the 5-segment
   * `local.{principal}.dispatch.task.>` when `stack` is `undefined`).
   *
   * When provided and non-empty, `principalStacks` takes precedence over BOTH
   * `stacks` and `stack`. The single delivery invariant is unchanged: still
   * exactly ONE `onEnvelope` handler, so multiple subjects never double-deliver
   * — the `adapter_instance` filter remains the sole delivery gate.
   */
  principalStacks?: readonly { principal: string; stack?: string }[];
}

export interface DispatchSink {
  /** Subject pattern(s) the sink subscribes to (exposed for testing). */
  readonly subjects: readonly string[];
  /** Wire up `onEnvelope` + `subscribe`. Idempotent. */
  start(): Promise<void>;
  /** Unregister + drain subscribers. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Build the lifecycle subscribe pattern. `dispatch.task.*` envelopes are
 * `classification: "local"`, so the subject is
 * `local.{principal}[.{stack}].dispatch.task.>` — the `>` wildcard covers
 * every action (`started`/`completed`/`failed`/`aborted`). Mirrors the
 * runner's `canonicalTasksDirectSubject` stack-aware/legacy split so the
 * subscribe side never drifts from the publish side's `deriveNatsSubject`.
 */
function lifecycleSubject(principal: string, stack?: string): string {
  if (stack === undefined) {
    return `local.${principal}.dispatch.task.>`;
  }
  return `local.${principal}.${stack}.dispatch.task.>`;
}

/**
 * De-duplicate a `(string | undefined)[]` of stack tokens, preserving order.
 * `undefined` (the gap-4 / 5-segment case) is its own single bucket, tracked
 * with a boolean so it never collides with any real stack name. Used to fold
 * the gateway's per-binding stacks into one subscribe-subject set.
 */
function distinctStacks(
  stacks: readonly (string | undefined)[],
): (string | undefined)[] {
  const seen = new Set<string>();
  let sawUndefined = false;
  const out: (string | undefined)[] = [];
  for (const s of stacks) {
    if (s === undefined) {
      if (sawUndefined) continue;
      sawUndefined = true;
      out.push(undefined);
      continue;
    }
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * De-duplicate a `(principal, stack)` pair list, preserving order. The
 * `undefined` stack (gap-4 / 5-segment case) is its own bucket PER principal —
 * keyed on a ` `-separated `principal stack` string so it never collides with a
 * real stack name or with another principal's undefined bucket. Used to fold
 * the gateway's per-binding `(principal, stack)` pairs into one subscribe-subject
 * set (F-1 multi-principal — cortex#629).
 */
function distinctPrincipalStacks(
  pairs: readonly { principal: string; stack?: string }[],
): { principal: string; stack?: string }[] {
  const seen = new Set<string>();
  const out: { principal: string; stack?: string }[] = [];
  for (const p of pairs) {
    const key = `${p.principal} ${p.stack ?? "undefined"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Create a dispatch sink. Wires nothing until `start()` is called.
 */
export function createDispatchSink(opts: DispatchSinkOptions): DispatchSink {
  const { runtime, adapters, principal, stack } = opts;
  // Index adapters by instanceId for the response-routing filter.
  const adapterByInstance = new Map<string, PlatformAdapter>(
    adapters.map((a) => [a.instanceId, a]),
  );
  // Subject precedence (most → least specific):
  //   1. `principalStacks` (F-1 multi-principal — cortex#629): one subject per
  //      distinct `(principal, stack)` pair. Each pair carries its OWN principal
  //      segment, so the gateway can subscribe across principals on a shared bus.
  //   2. `stacks` (a.3d gateway multi-stack): many stacks under the ONE
  //      `principal`.
  //   3. `stack` (per-stack `cortex.ts` wiring): the single-subject default.
  // Whichever path is taken, there is exactly ONE `onEnvelope` handler, so the
  // subject COUNT never affects delivery — the `adapter_instance` filter is the
  // sole delivery gate (no double-deliver).
  const subjects =
    opts.principalStacks !== undefined && opts.principalStacks.length > 0
      ? distinctPrincipalStacks(opts.principalStacks).map((p) =>
          lifecycleSubject(p.principal, p.stack),
        )
      : opts.stacks !== undefined && opts.stacks.length > 0
        ? distinctStacks(opts.stacks).map((s) => lifecycleSubject(principal, s))
        : [lifecycleSubject(principal, stack)];

  let registration: { unregister: () => void } | null = null;
  let subscribers: MyelinSubscriber[] = [];

  // cortex#987 — at-most-once render per envelope.id. `onEnvelope` is a
  // global per-delivery fan-out: an external overlapping subscription (a
  // `nats.subjects[]` wildcard that also matches `dispatch.task.>`) delivers
  // the same envelope twice and this handler runs twice — observed live as
  // every chat reply posting twice. Same belt-and-braces the review sink
  // carries. Claimed BEFORE the post (duplicate deliveries land in the same
  // tick); RELEASED on a failed post so redelivery can retry.
  const dedupe = createRenderDedupe();

  /**
   * Deliver one lifecycle envelope. Pure routing + render + post; never
   * throws (the runtime `onEnvelope` fan-out must not see a throw, and a
   * failed delivery for one envelope must not stop the next).
   */
  async function deliver(envelope: Envelope): Promise<void> {
    // Only lifecycle envelopes carry response routing the sink acts on.
    if (!envelope.type.startsWith(LIFECYCLE_TYPE_PREFIX)) return;

    const routing = readResponseRouting(envelope);
    if (routing === null) return; // bus-peer / Offer / malformed — not ours.

    // Instance filter — ignore envelopes routed to OTHER adapter
    // instances. This is what makes multiple sinks (one per adapter
    // instance) safe to run side by side without cross-posting.
    const adapter = adapterByInstance.get(routing.adapter_instance);
    if (adapter === undefined) return;

    const text = formatDispatchLifecycle(envelope);
    if (text === null || text.length === 0) return;

    // Claim only once we know this envelope WOULD post (routing present,
    // instance matched, text non-empty) so non-actionable envelopes don't
    // consume window slots. A second delivery of the same id is a no-op.
    if (!dedupe.claim(envelope.id)) return;

    const target: ResponseTarget = {
      instanceId: routing.adapter_instance,
      channelId: routing.channel_id,
      ...(routing.thread_id !== undefined && { threadId: routing.thread_id }),
    };

    await deliverRoutedResponse({
      envelope,
      adapter,
      target,
      text,
      onError: (err) => {
        // A platform post failure must not crash the fan-out. Log to
        // stderr (per CLAUDE.md no-empty-catch rule) and move on; the
        // dispatch already completed on the bus, only the surface delivery
        // failed (rate limit, deleted channel, etc.). Release the dedupe
        // claim so a redelivery of this envelope can retry the render
        // (sage finding on cortex#988 — a claim that produced no render
        // must not suppress the retry).
        dedupe.release(envelope.id);
        process.stderr.write(
          `cortex: dispatch-sink postResponse failed (instance=${routing.adapter_instance}, ` +
            `channel=${routing.channel_id}, type=${envelope.type}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      },
    });
  }

  return {
    subjects,
    async start() {
      if (registration) return;
      // Register the fan-out handler FIRST so any envelope that arrives
      // synchronously after `subscribe()` is seen. The handler filters by
      // event-type prefix (stack-agnostic) — robust even if a future
      // emit site lands the lifecycle envelope on a slightly different
      // subject shape than the subscribe pattern anticipated.
      registration = runtime.onEnvelope((envelope) => {
        if (!envelope.type.startsWith(LIFECYCLE_TYPE_PREFIX)) return;
        // Fire-and-forget; `deliver` owns its own error boundary.
        void deliver(envelope);
      });
      // Self-subscribe so the sink's declared interest doesn't depend on
      // `nats.subjects[]` in cortex.yaml. `subscribe` is OPTIONAL on the
      // runtime (undefined → stub runtime, stay dormant); `null` return →
      // runtime disabled (no NATS). Both are legitimate dormant states.
      if (runtime.subscribe) {
        for (const pattern of subjects) {
          const sub = await runtime.subscribe(pattern);
          if (sub) subscribers.push(sub);
        }
      }
    },
    async stop() {
      if (!registration) return;
      registration.unregister();
      registration = null;
      const drained = subscribers;
      subscribers = [];
      await Promise.allSettled(drained.map((s) => s.stop()));
    },
  };
}
