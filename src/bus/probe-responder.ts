/**
 * Federated echo responder — the receive-half of `cortex network ping`
 * (signal#113 P-11 / `docs/design-network-ping.md`, issue #56).
 *
 * This is the **ICMP-analog** of the agent network: a built-in handler that
 * answers a reserved `probe.echo` capability **in the runtime, before any
 * substrate harness runs**. It is recognised by capability and answered
 * inline — NO `claude --print`, NO session, NO Discord post, NO worklog, NO
 * Skill tool. The reply carries the echoed nonce + a server timestamp + the
 * responder version; the requester times the round trip.
 *
 * ## Why a dedicated subscriber (not a dispatch-listener short-circuit)
 *
 * Per the spec §8, the responder may live either as a capability check inside
 * `dispatch-listener.ts` OR (cleaner) as a dedicated responder that subscribes
 * the `tasks.*.probe.echo` pattern alongside the runner. We take the dedicated
 * path: it keeps the probe path side-effect-free and self-contained, avoids
 * restructuring the (large, security-sensitive) dispatch listener, and is
 * symmetric with `ReviewConsumer` / `BusDispatchListener`. The responder
 * registers its own `runtime.onEnvelope` handler + `runtime.subscribe` so its
 * declared interest does not depend on `nats.subjects[]` config.
 *
 * Because the runner's dispatch-listener subscribes `tasks.*.>`, a `probe.echo`
 * envelope ALSO reaches the runner. The runner's `parsePayload` rejects it (a
 * probe has no `task_id`/`agent_id`/`prompt`), so it is dropped there with a
 * "malformed" trace and NEVER spawns a harness — the responder is the only
 * thing that answers. The responder is excluded from any self-capture loop:
 * its OWN reply rides `probe.reply.echo` (a different subtree), and it never
 * answers an envelope whose type is a reply (defensive `probe.echo` match).
 *
 * ## Wire grammar (ADR-0001 / ADR-0002, the 5 FG checks)
 *
 *   REQUEST  (requester → us)
 *     subject     federated.{us}.{our-stack}.tasks.@{enc-did}.probe.echo  (Direct)
 *              or federated.{us}.{our-stack}.tasks.probe.echo             (Offer)
 *     source      {us}.{our-stack}.{sender}        — addresses the TARGET (us)
 *     originator  did:mf:{requester-principal}-{requester-stack}  — the REQUESTER
 *     type        probe.echo / tasks.@{...}.probe.echo
 *
 *   REPLY    (us → requester)        # built-in echo, no LLM
 *     requester = decode(originator.identity)        # NOT the subject, NOT source
 *     subject     federated.{requester}.{req-stack}.probe.reply.echo
 *     source      {requester}.{req-stack}.{responder}   — addresses the REQUESTER
 *     type        probe.reply.echo
 *     payload     { nonce (echoed), server_ts, responder_version, seq? }
 *
 * FG checks: (1) no network on the wire — derived subject carries only
 * identity; (2) subject addresses the target (us) — we subscribe our own
 * `federated.{us}.{stack}.tasks.*.>`; (3) requester rides in
 * `originator.identity` — decoded via `parseRequesterFromOriginator`, never
 * the subject; (4) reply keyed on the requester scope + `peers[]` fail-closed
 * (absent/forged originator OR non-peer ⇒ DROP, no reply); (5) `federated.`
 * throughout.
 *
 * ## No-amplification (SEV-1) — the load-bearing security property
 *
 *   - **Exactly one** bounded reply per accepted request. The reply payload is
 *     a fixed shape (echoed nonce + timestamp + version + optional seq) — no
 *     fan-out, no multi-packet, no payload echo beyond the nonce.
 *   - The reply targets **only** the `originator`-attributed requester scope
 *     (decoded from `originator.identity`) — NEVER an attacker-supplied reply
 *     address, NEVER broadcast. The subject is composed from the decoded
 *     requester, not from anything in the request's subject/source/payload.
 *   - **Fail-closed** on absent/malformed `originator`, a self-loop (requester
 *     == us), or a requester not in any configured `peers[]` — DROP, no reply.
 *   - **Per-source rate-limit** (token bucket per requester principal) so a
 *     flood of probes cannot be turned into a flood of replies aimed at a
 *     victim, and cannot exhaust the responder.
 */

import type { Envelope } from "./myelin/envelope-validator";
import { parseRequesterFromOriginator } from "./review-consumer";
import { resolveSourceNetwork } from "./surface-router";
import { buildBaseEnvelope } from "./envelope-builder";
import type { PolicyFederatedNetwork } from "../common/types/cortex-config";
import type { MyelinRuntime } from "./myelin/runtime";
import type { SystemEventSource } from "./system-events";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reserved probe capability id. The request envelope `type` is either the
 * Offer form `probe.echo` (no `@` assistant segment) or the Direct form
 * `tasks.@{enc-did}.probe.echo`. We match on the `probe.echo` tail of the
 * capability rather than the full type so both Direct and Offer requests are
 * recognised by the same responder.
 */
export const PROBE_ECHO_CAPABILITY = "probe.echo";

/** Reply capability — a distinct subtree so our reply never re-triggers us. */
export const PROBE_REPLY_ECHO_TYPE = "probe.reply.echo";

/**
 * Responder protocol version, surfaced in the reply payload. Lets a requester
 * diagnose `no-responder` (version floor unmet) vs a healthy echo, and is the
 * one mild disclosure the spec §6.4 accepts between mutually-configured peers.
 */
export const RESPONDER_VERSION = "1.0.0";

/**
 * Per-source token-bucket defaults. A probe reply is O(1) and far smaller than
 * a session spawn, so the cap only needs to bound a reflection flood — not
 * throttle legitimate diagnostics. Capacity 20, refill 20 tokens/sec.
 */
export const DEFAULT_RATE_LIMIT_CAPACITY = 20;
export const DEFAULT_RATE_LIMIT_REFILL_PER_SEC = 20;

// ---------------------------------------------------------------------------
// Pure responder decision
// ---------------------------------------------------------------------------

/** The decoded, validated probe-echo request payload (untrusted input). */
export interface ProbeEchoRequestPayload {
  /** Opaque nonce the requester generated; echoed back verbatim. */
  nonce: string;
  /** ISO-8601 send time (informational; RTT is measured on the requester). */
  sent_at?: string;
  /** Optional probe sequence number (`ping -c` style). Echoed back. */
  seq?: number;
}

/** The bounded echo reply payload. Fixed shape — no amplification. */
export interface ProbeEchoReplyPayload {
  /** The requester's nonce, echoed verbatim. */
  nonce: string;
  /** Responder server timestamp (ISO-8601). One-way-delay estimate only. */
  server_ts: string;
  /** Responder protocol version. */
  responder_version: string;
  /** Echoed probe sequence number, when the request carried one. */
  seq?: number;
}

/**
 * Why a probe was dropped without a reply (fail-closed). Surfaced for the
 * stderr audit line so a principal can see "who tried to probe me and why I
 * refused" — the abuse signal of spec §6.5.
 */
export type ProbeDropReason =
  | "not-probe-echo"
  | "no-originator"
  | "self-loop"
  | "non-peer"
  | "bad-payload"
  | "rate-limited";

/** The outcome of evaluating one inbound envelope against the responder. */
export type ProbeResponderDecision =
  | { kind: "drop"; reason: ProbeDropReason; detail?: string }
  | {
      kind: "reply";
      /** Decoded requester principal (from originator) — the reply scope. */
      requesterPrincipal: string;
      /** Decoded requester stack (from originator) — the reply scope. */
      requesterStack: string;
      /** The reply envelope, addressed to the requester. */
      envelope: Envelope;
      /** The reply subject (explicit — `publishOnSubject`). */
      subject: string;
    };

/**
 * Recognise the reserved `probe.echo` capability on an inbound envelope `type`.
 *
 * Accepts both wire forms:
 *   - Offer:  `probe.echo`
 *   - Direct: `tasks.@{enc-did}.probe.echo`  (the runtime publishes the
 *     `@`-bearing subject; the envelope `type` mirrors the capability tail).
 *
 * Rejects the reply type (`probe.reply.echo`) and everything else — so the
 * responder never answers its own reply (loop-safety) nor a chat dispatch.
 */
export function isProbeEcho(type: string): boolean {
  if (type === PROBE_REPLY_ECHO_TYPE) return false;
  // Exact Offer form, or any type whose final two dot-segments are
  // `probe.echo` (Direct form `tasks.@….probe.echo`, or `tasks.probe.echo`).
  if (type === PROBE_ECHO_CAPABILITY) return true;
  return type.endsWith(`.${PROBE_ECHO_CAPABILITY}`);
}

/**
 * Validate the untrusted request payload into a {@link ProbeEchoRequestPayload}
 * or `null`. The nonce is the only required field; it must be a non-empty,
 * bounded string (we echo it back, so we cap its size to keep the reply
 * bounded — no amplification via an oversized nonce).
 */
const MAX_NONCE_LEN = 256;

export function parseProbeEchoRequest(
  envelope: Envelope,
): ProbeEchoRequestPayload | null {
  const p = envelope.payload as
    | Partial<Record<keyof ProbeEchoRequestPayload, unknown>>
    | undefined;
  if (!p) return null;
  if (typeof p.nonce !== "string" || p.nonce.length === 0) return null;
  if (p.nonce.length > MAX_NONCE_LEN) return null;
  const out: ProbeEchoRequestPayload = { nonce: p.nonce };
  if (typeof p.sent_at === "string") out.sent_at = p.sent_at;
  if (typeof p.seq === "number" && Number.isInteger(p.seq)) out.seq = p.seq;
  return out;
}

/**
 * A minimal monotonic-ish clock seam so tests can pin `server_ts` and the rate
 * limiter without touching `Date.now`.
 */
export interface ProbeClock {
  /** Wall-clock ms (for the rate-limit token bucket). */
  nowMs(): number;
  /** ISO-8601 string for the reply `server_ts`. */
  nowIso(): string;
}

export const systemClock: ProbeClock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/**
 * Per-principal token-bucket rate limiter. Pure-ish: state lives in the
 * instance; `take(principal)` returns whether a token was available. One
 * bucket per requester principal so one abusive peer cannot starve another.
 */
export class ProbeRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<
    string,
    { tokens: number; lastMs: number }
  >();

  constructor(
    capacity = DEFAULT_RATE_LIMIT_CAPACITY,
    refillPerSec = DEFAULT_RATE_LIMIT_REFILL_PER_SEC,
  ) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
  }

  /** Attempt to consume a token for `principal`. Returns `true` when allowed. */
  take(principal: string, nowMs: number): boolean {
    const existing = this.buckets.get(principal);
    if (existing === undefined) {
      // First request from this principal: full bucket minus this token.
      this.buckets.set(principal, { tokens: this.capacity - 1, lastMs: nowMs });
      return true;
    }
    // Refill based on elapsed time, capped at capacity.
    const elapsed = Math.max(0, nowMs - existing.lastMs);
    const refilled = Math.min(
      this.capacity,
      existing.tokens + elapsed * this.refillPerMs,
    );
    if (refilled < 1) {
      // No token available — update timestamp so the next call refills from
      // here (don't reset `tokens`, or we'd lose the partial accrual).
      existing.tokens = refilled;
      existing.lastMs = nowMs;
      return false;
    }
    existing.tokens = refilled - 1;
    existing.lastMs = nowMs;
    return true;
  }
}

/**
 * Inputs to the pure responder decision. The runtime side (subscriber) builds
 * these; the decision itself touches no I/O so it is exhaustively testable.
 */
export interface ProbeDecisionInputs {
  /** The receiving stack's source identity (whose principal is "us"). */
  source: SystemEventSource;
  /** The receiving stack's stack slug (the `{stack}` reply segment). */
  stack: string;
  /** Configured federated networks, indexed by id — the `peers[]` gate. */
  federatedNetworksById: Map<string, PolicyFederatedNetwork>;
  /** Rate limiter (per requester principal). */
  rateLimiter: ProbeRateLimiter;
  /** Clock for `server_ts` + rate-limit timing. */
  clock: ProbeClock;
  /**
   * PR #822 NIT-2 — the RESPONDER's OWN data residency, stamped on the reply
   * WE author. Defaults to `"NZ"` (the ecosystem default). Deliberately NOT
   * mirrored from the inbound (requester-supplied) envelope: a reply we
   * originate must carry our own sovereignty, not an attacker-influenced one.
   */
  dataResidency?: string;
}

/**
 * THE responder core: pure decision over one inbound envelope. Returns either
 * a single bounded reply (addressed only to the originator-attributed
 * requester scope) or a fail-closed drop. No side effects.
 *
 * Order of checks (each fail-closed):
 *   1. type is `probe.echo` (not a reply, not a chat dispatch).
 *   2. payload parses (nonce present + bounded).
 *   3. requester decodes from `originator.identity` (absent/malformed ⇒ drop).
 *   4. not a self-loop (requester principal != us).
 *   5. requester principal is a configured `peers[]` member.
 *   6. per-source rate-limit token available.
 *
 * Only after ALL pass do we mint exactly ONE reply, keyed to the requester.
 */
export function decideProbeResponse(
  envelope: Envelope,
  subject: string | undefined,
  inputs: ProbeDecisionInputs,
): ProbeResponderDecision {
  // (1) Capability — only `probe.echo`. Match the type; defensively also
  // require the subject (when present) to be a `tasks.*` subject so a
  // mis-typed envelope on the wrong subject can't sneak through.
  if (!isProbeEcho(envelope.type)) {
    return { kind: "drop", reason: "not-probe-echo", detail: envelope.type };
  }

  // (2) Payload — nonce required + bounded (no amplification via huge nonce).
  const req = parseProbeEchoRequest(envelope);
  if (req === null) {
    return { kind: "drop", reason: "bad-payload" };
  }

  // (3) Requester — decoded from originator.identity ONLY (never the subject,
  // never source). Absent/malformed originator ⇒ fail-closed (FG-4).
  const requester = parseRequesterFromOriginator(envelope);
  if (requester === undefined) {
    return { kind: "drop", reason: "no-originator" };
  }
  const requesterPrincipal = requester.principal;
  // The DID encodes `{principal}-{stack}`; a missing stack segment means a
  // malformed/half-formed identity — fail closed rather than guess `default`.
  if (requester.stack === undefined || requester.stack.length === 0) {
    return { kind: "drop", reason: "no-originator", detail: "no stack in originator" };
  }
  const requesterStack = requester.stack;

  // (4) Self-loop — never answer an envelope that named US as the requester.
  if (requesterPrincipal === inputs.source.principal) {
    return {
      kind: "drop",
      reason: "self-loop",
      detail: `requester principal "${requesterPrincipal}" is this stack`,
    };
  }

  // (5) peers[] membership — the requester principal MUST be a configured peer
  // in some network's peers[]. Fail-closed for an unknown/untrusted peer
  // (FG-4 / ADR-0002 §5 defense-in-depth — the application-layer trust
  // boundary under `signing: off`).
  const resolved = resolveSourceNetwork(
    requesterPrincipal,
    inputs.federatedNetworksById,
  );
  if (resolved === undefined) {
    return {
      kind: "drop",
      reason: "non-peer",
      detail: `requester "${requesterPrincipal}" in no configured peers[]`,
    };
  }

  // (5b) PR #822 NIT-3 — bind the DID-decoded `{principal}/{stack}` to the
  // matched peer's configured `stack_id` BEFORE composing the reply subject.
  // `resolveSourceNetwork` keys on principal alone; the stack comes from the
  // (DID_RE-validated, but otherwise free-form) decoded originator. Requiring
  // an EXACT `{decoded-principal}/{decoded-stack}` === peer.stack_id match
  // closes the latent "reflect onto a peer's unsubscribed stack subject" case:
  // a peer that declared `jc/default` cannot elicit a reply aimed at
  // `jc/some-other-stack`. Fail-closed on mismatch.
  const decodedStackId = `${requesterPrincipal}/${requesterStack}`;
  const matchedPeer = resolved.network.peers.find(
    (p) => p.principal_id === requesterPrincipal && p.stack_id === decodedStackId,
  );
  if (matchedPeer === undefined) {
    return {
      kind: "drop",
      reason: "non-peer",
      detail: `decoded requester stack "${decodedStackId}" matches no configured peer stack_id (principal "${requesterPrincipal}" is a peer, but on a different stack)`,
    };
  }

  // (6) Rate-limit — per requester principal. Bounds a reflection flood.
  if (!inputs.rateLimiter.take(requesterPrincipal, inputs.clock.nowMs())) {
    return {
      kind: "drop",
      reason: "rate-limited",
      detail: `requester "${requesterPrincipal}" exceeded probe rate limit`,
    };
  }

  // All gates passed — mint EXACTLY ONE bounded reply, keyed ONLY to the
  // originator-attributed requester scope. The reply `source` addresses the
  // requester (so `deriveNatsSubject` would also resolve there), and we
  // publish on an explicit `federated.{requester}.{req-stack}.probe.reply.echo`
  // subject (the `probe.reply.echo` type would otherwise derive from `source`
  // — we build it explicitly for clarity + to keep alignment obvious).
  const replyPayload: ProbeEchoReplyPayload = {
    nonce: req.nonce,
    server_ts: inputs.clock.nowIso(),
    responder_version: RESPONDER_VERSION,
    ...(req.seq !== undefined && { seq: req.seq }),
  };

  const replyEnvelope: Envelope = {
    ...buildBaseEnvelope({
      type: PROBE_REPLY_ECHO_TYPE,
      // `source` addresses the REQUESTER's scope (the reply-to), exactly the
      // verdict-back pattern: `{requester-principal}.{requester-stack}.{responder}`.
      source: `${requesterPrincipal}.${requesterStack}.${inputs.source.agent}`,
      ...(envelope.correlation_id !== undefined && {
        correlationId: envelope.correlation_id,
      }),
      sovereignty: {
        classification: "federated",
        // PR #822 NIT-2 — OUR residency, not the inbound (requester-supplied)
        // envelope's. A reply we author carries our own sovereignty.
        data_residency: inputs.dataResidency ?? "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: replyPayload as unknown as Record<string, unknown>,
    }),
    // Our reply is, itself, an attributed federated envelope: we are the
    // originator now. `attribution: "federated"` (the myelin Originator field;
    // the spec's "originator.method = federated" maps to this) marks the claim
    // as relayed cross-principal.
    originator: {
      // TODO(#2034/flag-day): replace this hand-rolled flat-form DID encoder
      // with @the-metafactory/myelin/wire renderDid once RFC-0001 lands
      // (blocked-on #1996/#2016/#2020) — emits the OLD loose grammar; ./wire's
      // class-explicit dot-form is a flag-day change, not a drop-in.
      identity: `did:mf:${inputs.source.principal}-${inputs.stack}`,
      attribution: "federated",
    },
  };

  const replySubject = `federated.${requesterPrincipal}.${requesterStack}.${PROBE_REPLY_ECHO_TYPE}`;

  return {
    kind: "reply",
    requesterPrincipal,
    requesterStack,
    envelope: replyEnvelope,
    subject: replySubject,
  };
}

// ---------------------------------------------------------------------------
// Runtime subscriber
// ---------------------------------------------------------------------------

export interface ProbeResponderOptions {
  runtime: MyelinRuntime;
  /** Receiving stack source identity. `source.principal` is "us". */
  source: SystemEventSource;
  /** Receiving stack slug — the `{stack}` segment we subscribe + reply with. */
  stack: string;
  /** Configured federated networks (the `peers[]` gate). Empty ⇒ never replies. */
  federatedNetworksById: Map<string, PolicyFederatedNetwork>;
  /** Optional rate limiter (defaults to the standard token bucket). */
  rateLimiter?: ProbeRateLimiter;
  /** Optional clock (defaults to the system clock). */
  clock?: ProbeClock;
  /**
   * PR #822 NIT-2 — the responder's OWN data residency, stamped on replies.
   * Defaults to `"NZ"`. `cortex.ts` passes the stack's configured residency.
   */
  dataResidency?: string;
}

export interface ProbeResponder {
  /** Subject pattern this responder subscribes (exposed for tests). */
  readonly subjects: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire the echo responder onto the runtime. Subscribes
 * `federated.{us}.{stack}.tasks.*.>` (the same canonical Tasks-Domain pattern
 * the runner uses, but in the `federated.` scope) and answers any `probe.echo`
 * envelope inline.
 *
 * Dormant when `federatedNetworksById` is empty (no peers ⇒ nothing to answer)
 * OR the runtime is disabled (no NATS). Symmetric with the dispatch-listener:
 * a `runtime.onEnvelope` handler filtered by subject + a `runtime.subscribe`
 * to declare interest.
 */
export function createProbeResponder(
  opts: ProbeResponderOptions,
): ProbeResponder {
  const {
    runtime,
    source,
    stack,
    federatedNetworksById,
    rateLimiter = new ProbeRateLimiter(),
    clock = systemClock,
    dataResidency,
  } = opts;

  // Subscribe our OWN federated tasks subject (FG-2: subject addresses us).
  const pattern = `federated.${source.principal}.${stack}.tasks.*.>`;
  const subjects = [pattern];

  let registration: { unregister: () => void } | null = null;
  interface RuntimeSubscriber {
    stop(): Promise<void>;
  }
  let runtimeSubscribers: RuntimeSubscriber[] = [];

  // PR #822 NIT-4 — per-request idempotency guard. A bounded LRU of recently-
  // answered envelope ids so the SAME request (a redelivery) yields at most
  // ONE reply. Cannot manifest on the current push-mode `runtime.subscribe`
  // (core NATS — no redelivery), but mirrors `review-consumer`'s
  // `deliveryCount > 1` drop for symmetry + future JetStream safety. Bounded
  // (insertion-ordered Map, oldest evicted) so it can't grow unbounded under a
  // probe flood — the rate limiter already caps per-source volume.
  const SEEN_CAP = 4096;
  const seenEnvelopeIds = new Map<string, true>();
  const alreadyAnswered = (id: string): boolean => {
    if (seenEnvelopeIds.has(id)) return true;
    seenEnvelopeIds.set(id, true);
    if (seenEnvelopeIds.size > SEEN_CAP) {
      const oldest = seenEnvelopeIds.keys().next().value;
      if (oldest !== undefined) seenEnvelopeIds.delete(oldest);
    }
    return false;
  };

  const decisionInputs: ProbeDecisionInputs = {
    source,
    stack,
    federatedNetworksById,
    rateLimiter,
    clock,
    ...(dataResidency !== undefined && { dataResidency }),
  };

  const handle = (envelope: Envelope, subject: string): void => {
    // Only our own federated tasks subjects. The runtime fans every envelope
    // to every handler; ignore anything off-pattern.
    if (!subject.startsWith(`federated.${source.principal}.${stack}.tasks.`)) {
      return;
    }
    // Fast pre-filter: only probe.echo types reach the decision. (A chat
    // dispatch on this subject is the runner's concern, not ours.)
    if (!isProbeEcho(envelope.type)) return;

    // PR #822 NIT-4 — drop a redelivered request (same envelope id) BEFORE
    // minting a second reply. Checked after the cheap type pre-filter so a
    // non-probe envelope never pollutes the seen-set.
    if (alreadyAnswered(envelope.id)) {
      process.stderr.write(
        `cortex/probe-responder: DROP reason=redelivery envelope=${envelope.id} subject=${subject}\n`,
      );
      return;
    }

    const decision = decideProbeResponse(envelope, subject, decisionInputs);
    if (decision.kind === "drop") {
      // Audit (spec §6.5) — who probed us + why we refused. Never throws into
      // the fan-out. This is the abuse signal; a dropped probe emits NO reply.
      process.stderr.write(
        `cortex/probe-responder: DROP reason=${decision.reason}` +
          (decision.detail !== undefined ? ` detail=${decision.detail}` : "") +
          ` envelope=${envelope.id} subject=${subject}\n`,
      );
      return;
    }

    // Exactly ONE reply, addressed ONLY to the originator-attributed requester
    // scope. Fire-and-forget publish on the explicit reply subject; a publish
    // failure is logged (never swallowed) and never throws into the fan-out.
    const publish = runtime.publishOnSubject?.(decision.envelope, decision.subject);
    if (publish === undefined) {
      // Runtime cannot publish on an explicit subject (disabled / legacy stub).
      // Drop silently-but-logged — we never guess a derived subject for a
      // cross-principal reply (that could land on the wrong scope).
      process.stderr.write(
        `cortex/probe-responder: runtime lacks publishOnSubject — cannot reply ` +
          `to ${decision.requesterPrincipal}/${decision.requesterStack} ` +
          `(envelope=${envelope.id})\n`,
      );
      return;
    }
    void publish.catch((err: unknown) => {
      process.stderr.write(
        `cortex/probe-responder: reply publish failed for ` +
          `${decision.requesterPrincipal}/${decision.requesterStack} ` +
          `(envelope=${envelope.id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  };

  return {
    subjects,
    async start() {
      if (registration) return;
      // Dormant when no peers are configured: a responder with an empty
      // peers[] gate would drop every probe anyway, so don't even subscribe.
      if (federatedNetworksById.size === 0) {
        process.stderr.write(
          "cortex/probe-responder: no federated networks configured — responder dormant\n",
        );
        return;
      }
      registration = runtime.onEnvelope((envelope, subject) => {
        handle(envelope, subject);
      });
      if (runtime.subscribe) {
        for (const p of subjects) {
          const sub = await runtime.subscribe(p);
          if (sub) runtimeSubscribers.push(sub);
        }
      }
    },
    async stop() {
      if (registration) {
        registration.unregister();
        registration = null;
      }
      const drained = runtimeSubscribers;
      runtimeSubscribers = [];
      await Promise.allSettled(drained.map((s) => s.stop()));
    },
  };
}
