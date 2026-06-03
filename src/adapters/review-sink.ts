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
// G-1113.ML.4 — the attention notification stream (system.attention.{opened,resolved}).
const ATTENTION_TYPE_PREFIX = "system.attention.";

/** True for the envelope types the review sink acts on. */
function isReviewSinkType(type: string): boolean {
  return (
    type.startsWith(LIFECYCLE_TYPE_PREFIX) ||
    type.startsWith(VERDICT_TYPE_PREFIX) ||
    type.startsWith(ATTENTION_TYPE_PREFIX)
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
  /**
   * G-1113.ML.4 — destination for attention notifications. Unlike verdicts
   * (which reply to the request's `response_routing`), attention items are
   * unsolicited, so the sink needs a configured channel. When omitted,
   * `system.attention.*` envelopes are ignored (no destination — matching the
   * missing-`response_routing` behaviour for verdicts).
   */
  attentionRouting?: WireLogicalRouting;
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
  // G-1113.ML.4 — also the attention stream (same `local` classification).
  return [`${base}.dispatch.task.>`, `${base}.review.verdict.>`, `${base}.system.attention.>`];
}

/**
 * Render the text for one review-sink envelope. Verdict envelopes render
 * via `formatReviewVerdict` plus a requester ping; lifecycle envelopes
 * render via `formatDispatchLifecycle`. Returns `null` when nothing should
 * be posted.
 */
function renderText(envelope: Envelope): string | null {
  // G-1113.ML.4 — attention notifications render their deterministic
  // `presentation` verbatim (built in code by E.4 / ML.3, never an LLM token).
  // No reviewer mention — an attention item is an unsolicited signal, not a reply.
  if (envelope.type.startsWith(ATTENTION_TYPE_PREFIX)) {
    const presentation =
      typeof envelope.payload.presentation === "string"
        ? envelope.payload.presentation.trim()
        : "";
    return presentation.length > 0 ? presentation : null;
  }
  if (envelope.type.startsWith(VERDICT_TYPE_PREFIX)) {
    // cortex#503 — surfaces render ONLY the deterministic `presentation`
    // markdown when cortex stamped it (verbatim, never a JSON dump). The
    // `formatReviewVerdict` one-liner is the fallback for older verdicts
    // (wire forward-compat) that predate `presentation`. Either way a ping
    // mentions the reviewer so the requester is notified.
    const presentation =
      typeof envelope.payload.presentation === "string"
        ? envelope.payload.presentation.trim()
        : "";
    const body = presentation.length > 0 ? presentation : formatReviewVerdict(envelope);
    if (body === null || body.length === 0) return null;
    // The verdict's `reviewer` is the agent that produced it (e.g. `luna`);
    // a leading `@{reviewer}` is the conventional Discord-style mention.
    const reviewer =
      typeof envelope.payload.reviewer === "string"
        ? envelope.payload.reviewer
        : "";
    return reviewer ? `@${reviewer} ${body}` : body;
  }
  // cortex#503 — the PROSE-FALLBACK completion (agent answered in prose, no
  // structured verdict) emits ONLY a `dispatch.task.completed` carrying the
  // prose in `chat_response`, with NO co-emitted verdict. Render that prose
  // as the terminal reply (markdown, never JSON). `formatDispatchLifecycle`
  // already prefers `chat_response` over `result_summary`, so it returns the
  // full prose here.
  //
  // Double-reply guard (#502 review): a STRUCTURED review co-emits BOTH a
  // `review.verdict.*` (the human-facing terminal reply, handled above) AND a
  // `dispatch.task.completed` whose `result_summary` is just the verdict
  // summary — redundant on a human surface. That completed carries NO
  // `chat_response`, so suppress it; the originating thread gets exactly ONE
  // terminal message. `failed`/`aborted` have no co-emitted verdict, so they
  // remain the terminal reply and still render.
  if (envelope.type === "dispatch.task.completed") {
    const hasProse =
      typeof envelope.payload.chat_response === "string" &&
      envelope.payload.chat_response.trim().length > 0;
    if (!hasProse) return null;
  }
  return formatDispatchLifecycle(envelope);
}

/**
 * The reviewing agent's id, used to author the reply as the reviewer (e.g.
 * `echo`) rather than the first surface-matching adapter. `dispatch.task.*`
 * lifecycle envelopes carry `agent_id` (the executing agent); `review.verdict.*`
 * carries `reviewer` (the agent that produced the verdict). Null when neither
 * is present (the sink then falls back to any surface-matching adapter).
 */
function reviewingAgentId(envelope: Envelope): string | null {
  const p = envelope.payload;
  if (typeof p.agent_id === "string" && p.agent_id.length > 0) return p.agent_id;
  if (typeof p.reviewer === "string" && p.reviewer.length > 0) return p.reviewer;
  return null;
}

/**
 * Create a review sink. Wires nothing until `start()` is called.
 */
export function createReviewSink(opts: ReviewSinkOptions): ReviewSink {
  const { runtime, adapters, principal, stack, attentionRouting } = opts;
  const subjects = reviewSubjects(principal, stack);

  let registration: { unregister: () => void } | null = null;
  let subscribers: MyelinSubscriber[] = [];

  // cortex#491 belt-and-braces — render idempotency keyed by `envelope.id`.
  // The runtime-level subscribe dedupe (cortex#491 in `runtime.ts`) is the
  // primary defence against double-delivery; this second layer guarantees
  // that even an accidental double-delivery from a misconfig (or a future
  // overlapping-pattern path) cannot produce TWO GitHub/Discord renders for
  // one envelope. Bounded so a long-lived sink can't leak: oldest ids evict
  // once the window fills (envelopes arrive in roughly-temporal order, so a
  // genuine duplicate lands well within the window).
  const seenIds = new Set<string>();
  const SEEN_WINDOW = 4096;
  function alreadyRendered(id: string): boolean {
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > SEEN_WINDOW) {
      // Evict the oldest entry (insertion order — Set preserves it).
      const oldest = seenIds.values().next().value;
      if (oldest !== undefined) seenIds.delete(oldest);
    }
    return false;
  }

  /**
   * Resolve a native target for the logical address, PREFERRING the reviewing
   * agent's own adapter so the reply is authored by the reviewer (e.g. Echo)
   * rather than whichever surface-matching adapter is first. All of luna/echo/
   * forge share one Discord guild+channel, so a bare `platform === surface`
   * filter would post Echo's review under Luna's identity. The instanceId
   * convention is `{agent}-{platform}` (MIG-7.2c), so the reviewer's adapter is
   * `{agentId}-{surface}`. Falls back to any surface-matching adapter when the
   * reviewer's adapter isn't present or can't resolve.
   */
  async function resolveTarget(
    routing: WireLogicalRouting,
    agentId: string | null,
  ): Promise<ResponseTarget | null> {
    const onSurface = adapters.filter((a) => a.platform === routing.surface);
    const isReviewerAdapter = (a: (typeof onSurface)[number]): boolean =>
      agentId !== null &&
      (a.instanceId === `${agentId}-${routing.surface}` ||
        a.instanceId.startsWith(`${agentId}-`) ||
        a.instanceId === agentId);
    // Reviewer's adapter(s) first, then the remaining surface-matching ones.
    const ordered = [
      ...onSurface.filter(isReviewerAdapter),
      ...onSurface.filter((a) => !isReviewerAdapter(a)),
    ];
    for (const adapter of ordered) {
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

    // Attention notifications carry no `response_routing` (they're unsolicited);
    // they route to the configured `attentionRouting`. Verdict/lifecycle keep
    // their reply-to routing. An attention envelope MAY still carry its own
    // response_routing (forward-compat) — prefer it when present.
    const routing =
      readLogicalRouting(envelope) ??
      (envelope.type.startsWith(ATTENTION_TYPE_PREFIX) ? attentionRouting ?? null : null);
    if (routing === null) return; // pilot-only / bus-peer / Offer / malformed / unconfigured attention.

    const text = renderText(envelope);
    if (text === null || text.length === 0) return;

    // cortex#491 belt-and-braces — at-most-once render per envelope.id. We
    // mark seen only once we know this envelope WOULD post (routing present,
    // text non-empty) so a non-actionable envelope doesn't consume a window
    // slot. A second delivery of the same id is a silent no-op.
    if (alreadyRendered(envelope.id)) return;

    let target: ResponseTarget | null;
    try {
      target = await resolveTarget(routing, reviewingAgentId(envelope));
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
