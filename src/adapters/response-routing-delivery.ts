import type { Envelope } from "../bus/myelin/envelope-validator";
import type { ResponseTarget } from "./types";

export const LIFECYCLE_TYPE_PREFIX = "dispatch.task.";
const LIFECYCLE_STARTED_TYPE = "dispatch.task.started";

/**
 * Snowflake response-routing shape as it appears on a lifecycle envelope's
 * payload. Mirrors `ResponseRouting` in `src/bus/dispatch-events.ts`.
 */
export interface WireResponseRouting {
  adapter_instance: string;
  channel_id: string;
  thread_id?: string;
}

/**
 * Logical response-routing shape as it appears on review/attention envelopes.
 * Mirrors `LogicalResponseRouting` in `src/bus/dispatch-events.ts`.
 */
export interface WireLogicalRouting {
  surface: string;
  channel: string;
  thread?: string;
}

/**
 * Parse the chat-path `payload.response_routing` snowflake triple. Missing or
 * malformed routing is normal for bus-peer / Offer dispatches and returns null.
 */
export function readResponseRouting(envelope: Envelope): WireResponseRouting | null {
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

/**
 * Parse the review-path `payload.response_routing` logical address. Missing or
 * malformed routing is normal for pilot-only / Offer dispatches and returns null.
 */
export function readLogicalRouting(envelope: Envelope): WireLogicalRouting | null {
  const raw = envelope.payload.response_routing;
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surface !== "string" || typeof r.channel !== "string") {
    return null;
  }
  return {
    surface: r.surface,
    channel: r.channel,
    ...(typeof r.thread === "string" && { thread: r.thread }),
  };
}

/**
 * cortex#721 - derive the per-dispatch correlation key for progress keying.
 *
 * The lifecycle envelope carries a per-dispatch correlation via
 * `envelope.correlation_id`, with `payload.task_id` as the fallback. Returns
 * undefined only when neither exists, preserving channel-scoped progress.
 */
export function dispatchCorrelationKey(envelope: Envelope): string | undefined {
  if (typeof envelope.correlation_id === "string" && envelope.correlation_id.length > 0) {
    return envelope.correlation_id;
  }
  const taskId = envelope.payload.task_id;
  if (typeof taskId === "string" && taskId.length > 0) return taskId;
  return undefined;
}


/**
 * cortex#987 — bounded at-most-once render guard, shared by the dispatch and
 * review sinks. The runtime-level subscribe dedupe (cortex#491 in
 * `runtime.ts`) deduplicates each consumer's OWN patterns, but `onEnvelope`
 * is a global per-delivery fan-out: any EXTERNAL overlapping subscription
 * (e.g. a `nats.subjects[]` wildcard in `system/system.yaml` that also
 * matches `dispatch.task.>`) makes the runtime receive the envelope twice and
 * invoke every handler twice. This guard makes a sink idempotent per
 * `envelope.id` regardless of how many deliveries occur. Bounded so a
 * long-lived sink can't leak: oldest ids evict once the window fills
 * (envelopes arrive in roughly-temporal order, so a genuine duplicate lands
 * well within the window).
 */
export interface RenderDedupe {
  /**
   * Atomically claim `id`. Returns `true` when this caller owns the render
   * (first claim); `false` when the id was already claimed (duplicate
   * delivery — skip). Claiming BEFORE the async post (rather than marking
   * after success) is load-bearing: duplicate deliveries arrive in the same
   * fan-out tick, so a check-then-mark-after-await pattern would let both
   * pass the check before either marks.
   */
  claim(id: string): boolean;
  /**
   * Release a claimed id after a FAILED delivery, so a later redelivery of
   * the same envelope can retry instead of being suppressed by a claim that
   * never produced a render (sage finding on cortex#988).
   */
  release(id: string): void;
}

export function createRenderDedupe(window = 4096): RenderDedupe {
  const seenIds = new Set<string>();
  return {
    claim(id: string): boolean {
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      if (seenIds.size > window) {
        // Evict the oldest entry (insertion order — Set preserves it).
        const oldest = seenIds.values().next().value;
        if (oldest !== undefined) seenIds.delete(oldest);
      }
      return true;
    },
    release(id: string): void {
      seenIds.delete(id);
    },
  };
}

interface ReplyAdapter {
  sendProgress: (target: ResponseTarget, text: string) => Promise<void>;
  clearProgress: (target: ResponseTarget) => Promise<void>;
  postResponse: (target: ResponseTarget, text: string) => Promise<void>;
}

export interface DeliverRoutedResponseOptions {
  envelope: Envelope;
  adapter: ReplyAdapter;
  target: ResponseTarget;
  text: string;
  onError: (err: unknown) => void;
}

/**
 * Shared delivery policy for response-routed surface replies:
 *
 * - `dispatch.task.started` is a progress update.
 * - every terminal/reply envelope clears the same progress key, then posts.
 * - delivery failures never escape the runtime fan-out.
 */
export async function deliverRoutedResponse(
  opts: DeliverRoutedResponseOptions,
): Promise<void> {
  const { envelope, adapter, target, text, onError } = opts;
  const correlationKey = dispatchCorrelationKey(envelope);
  const progressTarget: ResponseTarget =
    correlationKey !== undefined
      ? { ...target, sessionId: correlationKey }
      : target;

  try {
    if (envelope.type === LIFECYCLE_STARTED_TYPE) {
      await adapter.sendProgress(progressTarget, text);
      return;
    }
    await adapter.clearProgress(progressTarget);
    await adapter.postResponse(target, text);
  } catch (err) {
    onError(err);
  }
}
