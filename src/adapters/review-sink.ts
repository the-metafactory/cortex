/**
 * cortex#502 — **Review sink** (OUTBOUND).
 *
 * The review-path analogue of the cortex#491/#498 dispatch sink. It is the
 * outbound half of a platform adapter for the capability-dispatch review
 * pipeline: it subscribes to BOTH the review lifecycle stream
 * (`dispatch.task.{started|completed|failed|aborted}`) AND the load-bearing
 * verdict stream (`review.verdict.{approved|changes-requested|commented}`),
 * filters to the envelopes whose echoed **logical response routing**
 * (`payload.response_routing` = `{ surface, channel, thread? }`) names a
 * surface THIS sink drives, resolves the logical address to a native target
 * via `adapter.resolveLogicalTarget`, renders the event to text, and posts
 * it back to the originating channel/thread.
 *
 * ## Logical vs snowflake routing (the #502 divergence)
 *
 * The chat dispatch sink (#498) reads a Discord-snowflake triple
 * (`{ adapter_instance, channel_id, thread_id }`) and posts directly. The
 * review sink reads a platform-NEUTRAL logical triple
 * (`{ surface, channel, thread? }` — repo short name + `{repo}/{type}/{n}`
 * entity key per the channel-routing SOP) and asks each adapter to map it
 * to native via `resolveLogicalTarget`. The wire never carries a snowflake,
 * so the same envelope routes on Discord/Mattermost/Slack unchanged — each
 * adapter owns its own name→primitive mapping at the sink.
 *
 * ## Surface filter (no cross-surface posting)
 *
 * There is no `adapter_instance` on the review wire. The sink filters by
 * `response_routing.surface` matching an adapter's `platform`; a surface no
 * driven adapter matches is ignored (mirrors the chat sink's instance
 * filter). The SOP guarantees one logical channel per repo, so a
 * surface + channel-name match is unambiguous.
 *
 * ## Single delivery path
 *
 * This consumer is the SOLE deliverer of review replies. It subscribes via
 * the runtime directly (`runtime.subscribe` + `runtime.onEnvelope`,
 * symmetric with the runner and the chat sink), NOT via `surfaceSubjects`.
 * Adding `review.verdict.*` / `dispatch.task.*` to a surface adapter's
 * `surfaceSubjects` would be a SECOND, double-replying path.
 *
 * ## Best-effort delivery
 *
 * Surface replies are best-effort / at-most-once by design (a dropped
 * Discord post must never block the bus). Durability of the AUTHORITATIVE
 * verdict is owned by pilot's `correlation_id` subscription, not the sink.
 * Same never-throw error boundary as the dispatch sink.
 *
 * ## Text rendering
 *
 * Reuses `formatReviewVerdict` (verdict one-liner) and
 * `formatDispatchLifecycle` (started/failed/aborted) from
 * `envelope-renderer.ts` — one formatter family, no reinvented copy.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import {
  formatDispatchLifecycle,
  formatReviewVerdict,
} from "./envelope-renderer";
import type { PlatformAdapter, ResponseTarget } from "./types";

/**
 * The logical response-routing shape as it appears on a review envelope's
 * payload. Mirrors `LogicalResponseRouting` in `src/bus/dispatch-events.ts`;
 * kept local to the sink's parse so the consumer doesn't depend on the
 * publish-side type for a read-only decode.
 */
interface WireLogicalRouting {
  surface: string;
  channel: string;
  thread?: string;
}

/**
 * Parse `payload.response_routing` into a typed logical routing record, or
 * `null` when the envelope carried none / it was malformed. Bus-peer /
 * pilot-only / Offer dispatches have no originating surface address, so a
 * missing field is a normal, non-error case — the sink ignores those.
 */
function readLogicalRouting(envelope: Envelope): WireLogicalRouting | null {
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

const LIFECYCLE_TYPE_PREFIX = "dispatch.task.";
const VERDICT_TYPE_PREFIX = "review.verdict.";

/** True for the envelope types the review sink acts on. */
function isReviewSinkType(type: string): boolean {
  return (
    type.startsWith(LIFECYCLE_TYPE_PREFIX) || type.startsWith(VERDICT_TYPE_PREFIX)
  );
}

export interface ReviewSinkOptions {
  /**
   * Runtime to subscribe on. The sink uses the SAME `onEnvelope` +
   * `subscribe` primitives the runner uses, so it sees every lifecycle +
   * verdict envelope the review consumer publishes via `runtime.publish`.
   */
  runtime: MyelinRuntime;
  /**
   * Platform adapters whose outbound side this sink drives. The sink
   * filters `response_routing.surface` against each adapter's `platform`
   * and asks the matching adapter to `resolveLogicalTarget`; envelopes for
   * a surface no adapter drives are ignored (no cross-surface posting).
   */
  adapters: readonly PlatformAdapter[];
  /**
   * `{principal}` segment of the subjects. The sink subscribes to
   * `local.{principal}[.{stack}].dispatch.task.>` AND
   * `local.{principal}[.{stack}].review.verdict.>`.
   */
  principal: string;
  /** Optional `{stack}` segment (the 6-segment grammar). */
  stack?: string;
}

export interface ReviewSink {
  /** Subject pattern(s) the sink subscribes to (exposed for testing). */
  readonly subjects: readonly string[];
  /** Wire up `onEnvelope` + `subscribe`. Idempotent. */
  start(): Promise<void>;
  /** Unregister + drain subscribers. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Build the two subscribe patterns (lifecycle + verdict). Both envelope
 * families are `classification: "local"`, so the subjects are
 * `local.{principal}[.{stack}].dispatch.task.>` and
 * `local.{principal}[.{stack}].review.verdict.>`. Mirrors the runner /
 * dispatch-sink stack-aware/legacy split so the subscribe side never drifts
 * from the publish side's subject derivation.
 */
function reviewSubjects(principal: string, stack?: string): string[] {
  const base = stack === undefined ? `local.${principal}` : `local.${principal}.${stack}`;
  return [`${base}.dispatch.task.>`, `${base}.review.verdict.>`];
}

/**
 * Render the text for one review-sink envelope. Verdict envelopes render
 * via `formatReviewVerdict` plus a requester ping; lifecycle envelopes
 * render via `formatDispatchLifecycle`. Returns `null` when nothing should
 * be posted.
 */
function renderText(envelope: Envelope): string | null {
  if (envelope.type.startsWith(VERDICT_TYPE_PREFIX)) {
    const verdictLine = formatReviewVerdict(envelope);
    if (verdictLine === null || verdictLine.length === 0) return null;
    // Ping the deliverable agent back so the requester is notified. The
    // verdict's `reviewer` is the agent that produced it (e.g. `luna`);
    // a leading `@{reviewer}` is the conventional Discord-style mention.
    const reviewer =
      typeof envelope.payload.reviewer === "string"
        ? envelope.payload.reviewer
        : "";
    return reviewer ? `@${reviewer} ${verdictLine}` : verdictLine;
  }
  // Double-reply guard (#502 review): on the review path a successful review
  // co-emits BOTH `review.verdict.*` (the human-facing terminal reply, handled
  // above) AND `dispatch.task.completed` (whose `result_summary` is just the
  // verdict summary — redundant on a human surface, though load-bearing for the
  // dashboard sink). Suppress `completed` here so the originating thread gets
  // exactly ONE terminal message. `failed`/`aborted` have no co-emitted verdict,
  // so they remain the terminal reply and still render.
  if (envelope.type === "dispatch.task.completed") return null;
  return formatDispatchLifecycle(envelope);
}

/**
 * Create a review sink. Wires nothing until `start()` is called.
 */
export function createReviewSink(opts: ReviewSinkOptions): ReviewSink {
  const { runtime, adapters, principal, stack } = opts;
  const subjects = reviewSubjects(principal, stack);

  let registration: { unregister: () => void } | null = null;
  let subscribers: MyelinSubscriber[] = [];

  /**
   * Resolve the first adapter that drives `surface` to a native target for
   * the logical address, or `null` when no adapter drives the surface / the
   * address can't be resolved. The first adapter whose `resolveLogicalTarget`
   * returns non-null wins; an adapter returns `null` for a surface it
   * doesn't drive, so iterating is the surface filter.
   */
  async function resolveTarget(
    routing: WireLogicalRouting,
  ): Promise<ResponseTarget | null> {
    for (const adapter of adapters) {
      // Cheap pre-filter: only ask adapters whose platform matches the
      // surface. (resolveLogicalTarget also guards internally, but this
      // avoids a wasted async call per non-matching adapter.)
      if (adapter.platform !== routing.surface) continue;
      const target = await adapter.resolveLogicalTarget({
        surface: routing.surface,
        channel: routing.channel,
        ...(routing.thread !== undefined && { thread: routing.thread }),
      });
      if (target !== null) return target;
    }
    return null;
  }

  /**
   * Deliver one review envelope. Pure routing + resolve + render + post;
   * never throws (the runtime `onEnvelope` fan-out must not see a throw,
   * and a failed delivery for one envelope must not stop the next).
   */
  async function deliver(envelope: Envelope): Promise<void> {
    if (!isReviewSinkType(envelope.type)) return;

    const routing = readLogicalRouting(envelope);
    if (routing === null) return; // pilot-only / bus-peer / Offer / malformed.

    const text = renderText(envelope);
    if (text === null || text.length === 0) return;

    let target: ResponseTarget | null;
    try {
      target = await resolveTarget(routing);
    } catch (err) {
      // A resolve failure (e.g. a thread-create API error) must not crash
      // the fan-out. Log and drop this delivery.
      process.stderr.write(
        `cortex: review-sink resolveLogicalTarget failed (surface=${routing.surface}, ` +
          `channel=${routing.channel}, type=${envelope.type}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    // No adapter drives this surface, or the channel/thread didn't resolve.
    if (target === null) return;

    // Pick the right adapter (by instanceId) to post through.
    const adapter = adapters.find((a) => a.instanceId === target.instanceId);
    if (adapter === undefined) return;

    try {
      if (envelope.type === "dispatch.task.started") {
        // `started` is a progress/typing indicator (e.g. "Echo is
        // reviewing…"), not a final reply — edit-in-place so the terminal
        // verdict/failed reply is the durable message.
        await adapter.sendProgress(target, text);
        return;
      }
      // Verdict / completed / failed / aborted — the terminal reply.
      await adapter.postResponse(target, text);
    } catch (err) {
      // A platform post failure must not crash the fan-out (per CLAUDE.md
      // no-empty-catch rule). The review already completed on the bus;
      // only the surface delivery failed (rate limit, deleted channel,
      // etc.). The authoritative verdict still reached pilot via
      // correlation_id.
      process.stderr.write(
        `cortex: review-sink postResponse failed (surface=${routing.surface}, ` +
          `channel=${routing.channel}, type=${envelope.type}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    subjects,
    async start() {
      if (registration) return;
      // Register the fan-out handler FIRST so any envelope arriving
      // synchronously after `subscribe()` is seen. The handler filters by
      // event-type prefix (stack-agnostic) for robustness against subject-
      // shape drift.
      registration = runtime.onEnvelope((envelope) => {
        if (!isReviewSinkType(envelope.type)) return;
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
