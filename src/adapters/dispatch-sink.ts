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
import type { PlatformAdapter, ResponseTarget } from "./types";

/**
 * Response-routing shape as it appears on a lifecycle envelope's payload
 * (snake_case wire idiom). Structurally the same triple a `ResponseTarget`
 * carries. Mirrors `ResponseRouting` in `src/bus/dispatch-events.ts`; kept
 * local to the sink's parse so the consumer doesn't depend on the runner's
 * publish-side type for a read-only decode.
 */
interface WireResponseRouting {
  adapter_instance: string;
  channel_id: string;
  thread_id?: string;
}

/**
 * Parse `payload.response_routing` into a typed routing record, or `null`
 * when the envelope carried none / it was malformed. Bus-peer and Offer
 * dispatches have no originating surface address, so a missing field is a
 * normal, non-error case — the sink simply ignores those envelopes.
 */
function readResponseRouting(envelope: Envelope): WireResponseRouting | null {
  const raw = envelope.payload.response_routing;
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.adapter_instance !== "string" || typeof r.channel_id !== "string") {
    return null;
  }
  return {
    adapter_instance: r.adapter_instance,
    channel_id: r.channel_id,
    ...(typeof r.thread_id === "string" && { thread_id: r.thread_id }),
  };
}

/** Lifecycle event types the sink delivers. */
const LIFECYCLE_TYPE_PREFIX = "dispatch.task.";

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
 * Create a dispatch sink. Wires nothing until `start()` is called.
 */
export function createDispatchSink(opts: DispatchSinkOptions): DispatchSink {
  const { runtime, adapters, principal, stack } = opts;
  // Index adapters by instanceId for the response-routing filter.
  const adapterByInstance = new Map<string, PlatformAdapter>(
    adapters.map((a) => [a.instanceId, a]),
  );
  const subjects = [lifecycleSubject(principal, stack)];

  let registration: { unregister: () => void } | null = null;
  let subscribers: MyelinSubscriber[] = [];

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

    const target: ResponseTarget = {
      instanceId: routing.adapter_instance,
      channelId: routing.channel_id,
      ...(routing.thread_id !== undefined && { threadId: routing.thread_id }),
    };

    try {
      if (envelope.type === "dispatch.task.started") {
        // A `started` event is a progress/typing indicator, not a final
        // reply — edit-in-place so the terminal `completed`/`failed`
        // reply is the durable message in the channel.
        await adapter.sendProgress(target, text);
        return;
      }
      // `completed` / `failed` / `aborted` — the terminal reply.
      await adapter.postResponse(target, text);
    } catch (err) {
      // A platform post failure must not crash the fan-out. Log to
      // stderr (per CLAUDE.md no-empty-catch rule) and move on; the
      // dispatch already completed on the bus, only the surface delivery
      // failed (rate limit, deleted channel, etc.).
      process.stderr.write(
        `cortex: dispatch-sink postResponse failed (instance=${routing.adapter_instance}, ` +
          `channel=${routing.channel_id}, type=${envelope.type}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
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
