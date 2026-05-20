/**
 * cortex#237 PR-6 — `review-consumer.ts`
 *
 * **Integration gate.** Wires PR-1 (pull-mode `MyelinSubscriber`), PR-2
 * (`createReviewVerdictEvent` / `createReviewTaskFailedEvent` builders), and
 * PR-5 (`runReviewPipeline` CC bridge) into a JetStream pull consumer that
 * subscribes to `tasks.code-review.<flavor>` and emits the cortex#248 verdict
 * envelopes back onto the bus. This is the PR that flips Echo from "code
 * lying around" into "Echo answers real `tasks.code-review.*` envelopes."
 *
 * Anchors:
 *   - `docs/design-capability-dispatch-review-consumer.md`
 *       §2.3 — ack/nak/term semantics + redelivery aborted-emit.
 *       §3   — capability-to-agent routing.
 *       §4   — per-envelope pipeline overview.
 *       §5   — correlation_id contract (request envelope id, threaded
 *              through every emitted envelope).
 *       §7   — failure taxonomy + the four-way nak mapping.
 *       §8   — lifecycle envelope co-emission ordering.
 *      §10.1 — PR-6 row (this PR's scope).
 *
 * **Failure-reason → ack/nak/term mapping (the table this module implements):**
 *
 * | Outcome                                          | wire envelope            | JetStream control                  |
 * |--------------------------------------------------|--------------------------|------------------------------------|
 * | verdict (approved/changes-requested/commented)   | `review.verdict.<kind>`  | `ack`                               |
 * | failed/`cant_do` (capability mismatch / bad pl. / chain verify) | `dispatch.task.failed`   | `term(reason.detail)` (permanent)  |
 * | failed/`wont_do` (policy refusal)                | `dispatch.task.failed`   | `term(reason.detail)` (permanent)  |
 * | failed/`policy_denied` (compliance gate)         | `dispatch.task.failed`   | `term(reason.detail)` (permanent)  |
 * | failed/`not_now` (transient / backpressure)      | `dispatch.task.failed`   | `nak(retry_after_ms ?? 0)`         |
 * | failed/`compliance_block` (v1: reserved)         | `dispatch.task.failed`   | `term("v1 does not handle…")`       |
 * | Pipeline throws unexpectedly (defensive)         | `dispatch.task.failed`   | `nak(0)` (transient)               |
 * | Redelivery > 1 (BEFORE pipeline)                 | `dispatch.task.aborted`  | continues; AckDecision per pipeline |
 *
 * **Why ack/term for "permanent" failures look identical on the broker.**
 * JetStream removes the message from the stream in both cases — the
 * difference is observability: `term(reason)` ships a structured reason
 * onto the dead-letter side that operators see in `nats consumer info`
 * + `system.dispatch.dead_letter` envelopes a future tap may project.
 * `nak(delay)` re-queues with an optional backoff hint. We pick term
 * for permanent so dead-letter observability stays meaningful, and nak
 * for transient so pilot can keep its `--wait` budget cooking against
 * the redelivery.
 *
 * **Scope (per task spec + §10.1 PR-6):**
 *   - Subscribes pull-mode to `local.{org}.tasks.code-review.>`.
 *   - Looks up reviewer agent by the `<flavor>` capability segment.
 *   - Enforces per-agent `maxConcurrent` backpressure.
 *   - Hands valid envelopes to `runReviewPipeline` (PR-5).
 *   - Publishes the terminal envelope (verdict or failed) + the
 *     `dispatch.task.completed` co-emission on the verdict path.
 *   - On redelivery > 1 emits `dispatch.task.aborted` per §2.3.
 *   - Drains in-flight reviews on `stop()`.
 *
 * **Anti-scope:**
 *   - NOT a registry — the capability lookup table is built once from the
 *     constructor's `agent` snapshot. Live config reload is a future
 *     concern.
 *   - NOT a renderer — the consumer doesn't talk to surfaces directly;
 *     its emitted lifecycle envelopes flow through the existing
 *     surface-router fan-out.
 *   - NOT a substrate — `runReviewPipeline` (PR-5) owns the CC bridge.
 *   - NOT a capability publisher — that's PR-3 (`capability-registry.ts`).
 *   - NOT modifying the skill — PR-8 territory.
 */

import type { ConsumerMessages, JsMsg } from "nats";
import type { MyelinRuntime } from "./myelin/runtime";
import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinSubscriber } from "./myelin/subscriber";
import type { AckDecision } from "./myelin/subscriber";
import {
  createReviewTaskFailedEvent,
  type DispatchTaskFailedReason,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "./review-events";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskAbortedEvent,
} from "./dispatch-events";
import {
  runReviewPipeline,
  type ReviewPipelineOpts,
  type ReviewPipelineResult,
  type ReviewPolicyCheck,
} from "../runner/review-pipeline";
import type { CCSessionFactory, CCSessionLike } from "../substrates/claude-code/harness";
import { CCSession, type CCSessionOpts } from "../runner/cc-session";
import { attachHeartbeatToCCSession } from "../runner/heartbeat-ticker";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot of cortex.yaml `agents[]` data the consumer needs.
 * Kept narrow so tests can build a fixture without standing up the
 * full Zod-validated `Agent` shape.
 */
export interface ReviewConsumerAgent {
  /** Logical agent id (e.g. `"echo"`). Stamped onto every emitted envelope. */
  id: string;
  /**
   * Capability ids this agent claims, e.g. `["code-review.typescript",
   * "code-review.bun", "code-review.generic"]`. Lookup is by exact match
   * against `code-review.<flavor>` derived from the inbound subject.
   */
  capabilities: readonly string[];
  /**
   * Optional per-agent `maxConcurrent` from `AgentRuntimeSchema` (PR-4).
   * When set, the consumer admits at most `maxConcurrent` in-flight
   * reviews; further envelopes nak `not_now` with a retry hint. When
   * undefined, the agent is treated as unbounded — see §7.3.
   */
  maxConcurrent?: number;
}

/**
 * Build the CC prompt for a single review request. Production callers
 * pass a function that assembles the security preamble + skill
 * invocation + persona prefix; tests pass a deterministic stub.
 *
 * Returning a string (not a {@link CCSessionOpts}) keeps the consumer
 * free of skill-allowlist + cwd + timeout policy — those flow through
 * `sessionOpts` instead. The prompt-builder seam is the natural place
 * for PR-8's structured-verdict instruction to land once it ships.
 */
export type ReviewPromptBuilder = (input: {
  agentId: string;
  payload: ReviewRequestPayload;
}) => string;

/**
 * Outcome of `SignatureVerifier`. Discriminated union so the consumer's
 * call site branches on `valid` without parsing free-form error strings.
 *
 * `reason` carries a human-readable summary destined for both the
 * structured stderr log line and the `dispatch.task.failed` `reason.detail`
 * field — short enough to scan, specific enough that an operator can
 * grep `pilot/cortex stderr` and identify the rejection class without
 * cross-referencing internal tables.
 */
export type SignatureVerifierResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Inbound envelope signature verifier. Optional — when omitted, the
 * consumer skips chain verification entirely (matches pre-cortex#327
 * behaviour; gradual rollout). When provided, the consumer calls it
 * after subject + payload validation but BEFORE the capability gate;
 * a `valid: false` result terminates the envelope as a `cant_do`
 * permanent failure with the verifier's `reason` carried verbatim into
 * the `dispatch.task.failed` envelope's `reason.detail`.
 *
 * Returned as an injectable function (rather than e.g. taking a
 * `TrustResolver` directly) so the consumer stays decoupled from
 * cortex's trust internals — same pattern as {@link ReviewConsumerOpts.pipelineRunner}
 * which decouples from CC-session internals. Production callers in
 * `src/cortex.ts` close over `verifySignedByChain` with the runtime's
 * resolver + receiving agent + operatorId; tests inject stubs that
 * return a literal verdict without standing up a registry.
 *
 * **Why not extend `DispatchTaskFailedReason` with a new `chain_verification_failed`
 * kind.** Adding a wire-level reason class ripples into pilot's CLI
 * exit-code mapping, dispatch-listener's nak-handler, and every
 * subscriber that exhaustively switches on the union. Chain
 * verification is operationally a `cant_do` (permanent, term ack —
 * resigning doesn't help if the receiver doesn't trust the signer),
 * so we reuse `cant_do` with an explicit `detail` prefix `chain verification failed: <reason>`
 * — a small structured-string convention rather than a schema break.
 * If the surface needs to grow beyond detail-string parsing later,
 * promoting to a dedicated kind is the natural follow-up.
 */
export type SignatureVerifier = (envelope: Envelope) => Promise<SignatureVerifierResult>;

/**
 * Construction options. Every dependency is injected — no module-scope
 * singletons, no environment-derived defaults. Production callers wire
 * the real `runtime` + `ccSessionFactory`; tests inject doubles.
 */
export interface ReviewConsumerOpts {
  /** The agent this consumer serves. One consumer per agent (per task spec). */
  agent: ReviewConsumerAgent;
  /** Envelope source (`{org}.{agent}.{instance}`) — same triple used by
   *  `system-events.ts` for `dispatch.task.*` lifecycle envelopes. */
  source: ReviewEventSource;
  /**
   * The myelin runtime — used for `publish` (verdict + failed + lifecycle
   * envelopes). The consumer does NOT use `runtime.onEnvelope` — its
   * inbound stream comes from a dedicated `MyelinSubscriber` in pull
   * mode (see {@link start}).
   */
  runtime: MyelinRuntime;
  /** CC session factory passed straight through to PR-5's pipeline. */
  ccSessionFactory: CCSessionFactory;
  /** Per-request CC prompt builder. See {@link ReviewPromptBuilder}. */
  promptBuilder: ReviewPromptBuilder;
  /**
   * Optional per-request `CCSessionOpts` overrides (cwd, allowedTools,
   * allowedDirs, timeouts). Forwarded to PR-5's pipeline verbatim — the
   * consumer does NOT mutate or default them.
   */
  sessionOpts?: Partial<Omit<CCSessionOpts, "prompt">>;
  /** Optional pre-CC policy check (§7.2). Forwarded to PR-5's pipeline. */
  policyCheck?: ReviewPolicyCheck;
  /**
   * Test seam — the function actually used to run the pipeline. Defaults
   * to PR-5's `runReviewPipeline`. Tests inject a stub that returns a
   * deterministic result without spawning CC.
   */
  pipelineRunner?: (opts: ReviewPipelineOpts) => Promise<ReviewPipelineResult>;
  /**
   * Optional inbound signature-chain verifier (cortex#327). When provided,
   * runs after subject + payload validation but BEFORE the capability
   * gate. A `valid: false` result terminates the envelope as `cant_do`
   * permanent failure (term ack) so a forged or untrusted publisher
   * can't reach the CC subprocess. Omit to disable verification — the
   * pre-#327 behaviour — for operators still rolling out signing.
   *
   * See {@link SignatureVerifier} for the function signature + the
   * design note on why this stays a pluggable closure rather than a
   * `TrustResolver` import.
   */
  signatureVerifier?: SignatureVerifier;
  /**
   * Test seam — clock. Defaults to `() => new Date()`. Tests inject a
   * fixed clock so emitted `startedAt`/`completedAt` are deterministic.
   */
  clock?: () => Date;
}

/**
 * Options for {@link ReviewConsumer.start} when binding to a real
 * JetStream pull consumer. The consumer MUST already exist on the
 * server (this primitive binds, it does NOT provision).
 *
 * The bare `NatsLink` is intentionally NOT exposed here — the consumer
 * routes through {@link MyelinRuntime.subscribePull}, which captures
 * the runtime's private link and threads it into a `MyelinSubscriber`
 * on the caller's behalf. Inverted from the original PR-6 wiring (which
 * required the boot path to plumb a link accessor) per the cortex#290
 * Architect review: the runtime owns connection lifecycle; consumers
 * declare what they want subscribed and the runtime threads the link.
 */
export interface ReviewConsumerStartOpts {
  /** Subject pattern, e.g. `local.{org}.tasks.code-review.>`. */
  pattern: string;
  /** JetStream stream name carrying the bound consumer. */
  stream: string;
  /** Durable consumer name. */
  durable: string;
  /** Optional consume() tuning forwarded to the subscriber. */
  maxMessages?: number;
  expiresMs?: number;
  thresholdMessages?: number;
}

/**
 * Boot/log entries the consumer produces. Surfaced so the boot wiring in
 * `src/cortex.ts` can render a uniform `cortex: review consumer ready for
 * agent={id} flavors=[...]` line without re-deriving the data.
 *
 * `subscribed` distinguishes the two structurally-valid `start()` outcomes
 * (cortex#334): `true` when the pull subscription actually opened on the
 * NATS broker; `false` when `MyelinRuntime.subscribePull` returned null
 * (disabled runtime / empty `nats.subjects` / G-1111 pending). The boot
 * path uses this to log "ready" vs "DORMANT" honestly instead of always
 * claiming readiness while the consumer is silently dormant.
 */
export interface ReviewConsumerStartedInfo {
  agentId: string;
  flavors: readonly string[];
  subscribed: boolean;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Per-agent capability-dispatch review consumer.
 *
 * Lifecycle:
 *
 *   1. `new ReviewConsumer(opts)` — registers handlers; does NOT subscribe.
 *   2. `await consumer.start({ link, ... })` — opens the pull subscription.
 *      OR: tests call `consumer.processEnvelope(env, subject, msg?)`
 *      directly to drive the pipeline without a real NATS connection.
 *   3. `await consumer.stop()` — drains in-flight reviews, stops the
 *      subscription. Idempotent.
 *
 * The split between `processEnvelope` (pure pipeline logic) and `start`
 * (NATS wiring) is the testability seam: `processEnvelope` returns the
 * full `AckDecision` so unit tests can assert ack/nak/term without
 * standing up JetStream.
 */
export class ReviewConsumer {
  readonly agent: ReviewConsumerAgent;
  /** Flavors this consumer answers — derived from agent.capabilities. */
  readonly flavors: readonly string[];

  private readonly source: ReviewEventSource;
  private readonly runtime: MyelinRuntime;
  private readonly ccSessionFactory: CCSessionFactory;
  private readonly promptBuilder: ReviewPromptBuilder;
  private readonly sessionOpts?: Partial<Omit<CCSessionOpts, "prompt">>;
  private readonly policyCheck?: ReviewPolicyCheck;
  private readonly pipelineRunner: (
    opts: ReviewPipelineOpts,
  ) => Promise<ReviewPipelineResult>;
  /** Optional inbound signature verifier (cortex#327). Undefined disables the gate. */
  private readonly signatureVerifier: SignatureVerifier | undefined;
  private readonly clock: () => Date;

  /** Promises for in-flight pipelines so `stop()` can drain. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Lookup `<flavor>` → `code-review.<flavor>` capability membership. */
  private readonly flavorSet: Set<string>;

  private subscriber: MyelinSubscriber | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: ReviewConsumerOpts) {
    this.agent = opts.agent;
    this.source = opts.source;
    this.runtime = opts.runtime;
    this.ccSessionFactory = opts.ccSessionFactory;
    this.promptBuilder = opts.promptBuilder;
    if (opts.sessionOpts !== undefined) {
      this.sessionOpts = opts.sessionOpts;
    }
    if (opts.policyCheck !== undefined) {
      this.policyCheck = opts.policyCheck;
    }
    this.pipelineRunner = opts.pipelineRunner ?? runReviewPipeline;
    this.signatureVerifier = opts.signatureVerifier;
    this.clock = opts.clock ?? (() => new Date());

    this.flavors = deriveFlavors(opts.agent.capabilities);
    this.flavorSet = new Set(this.flavors);
  }

  /**
   * Bind to a JetStream pull consumer and start delivering envelopes
   * into `processEnvelope`. Returns once the underlying subscriber is
   * `ready` (its initial `consume()` round-trip has resolved).
   *
   * The handler returned to `MyelinSubscriber` is async + returns an
   * `AckDecision` — the subscriber's `applyAckDecision` (PR-1 extension)
   * threads ack/nak/term through to the JetStream control surface.
   */
  async start(opts: ReviewConsumerStartOpts): Promise<ReviewConsumerStartedInfo> {
    if (this.subscriber !== null) {
      throw new Error(
        `review-consumer: already started for agent="${this.agent.id}"`,
      );
    }
    const subscribePullOpts: {
      pattern: string;
      stream: string;
      durable: string;
      onEnvelope: (envelope: Envelope, subject: string) => Promise<AckDecision>;
      maxMessages?: number;
      expiresMs?: number;
      thresholdMessages?: number;
    } = {
      pattern: opts.pattern,
      stream: opts.stream,
      durable: opts.durable,
      onEnvelope: async (envelope, subject) =>
        this.processEnvelope(envelope, subject, null),
    };
    if (opts.maxMessages !== undefined) {
      subscribePullOpts.maxMessages = opts.maxMessages;
    }
    if (opts.expiresMs !== undefined) {
      subscribePullOpts.expiresMs = opts.expiresMs;
    }
    if (opts.thresholdMessages !== undefined) {
      subscribePullOpts.thresholdMessages = opts.thresholdMessages;
    }
    // `subscribePull` is OPTIONAL on the MyelinRuntime interface (the
    // additivity constraint per Architect cortex#290 review — legacy
    // fake runtime stubs across the test tree must continue to satisfy
    // `MyelinRuntime` byte-identically). Treat an undefined property
    // the same as a `null` return: the consumer stays dormant.
    const sub = this.runtime.subscribePull
      ? this.runtime.subscribePull(subscribePullOpts)
      : null;
    if (sub === null) {
      // Runtime is disabled (no NATS configured / connect failed /
      // empty subject list) OR the runtime doesn't ship the optional
      // subscribePull helper. Either way this is a structurally-valid
      // no-op for capability-side features — the consumer stays
      // dormant and shutdown drain works against the empty `inFlight`
      // set. The boot path branches its log line on `subscribed: false`
      // so operators see "DORMANT" instead of a misleading "ready"
      // (cortex#334).
      return { agentId: this.agent.id, flavors: this.flavors, subscribed: false };
    }
    this.subscriber = sub;
    await this.subscriber.ready;
    return { agentId: this.agent.id, flavors: this.flavors, subscribed: true };
  }

  /**
   * Drive one envelope through the consumer's pipeline. Public for tests
   * (which call this directly instead of standing up a real subscriber);
   * production code paths arrive via `start()`'s `onEnvelope` handler.
   *
   * `msg` is the JetStream message handle (carries `info.redeliveryCount`
   * for the §2.3 aborted-emit on redelivery > 1). Tests pass `null` to
   * skip the redelivery branch.
   *
   * **Always returns an `AckDecision`** — even on subscription teardown
   * or pipeline-runner throws — so the subscriber can drive ack/nak/term
   * without exception handling. Throws from inside the pipeline are
   * mapped to `nak(0)` (defensive transient) per the spec's failure
   * taxonomy §7.6.
   */
  async processEnvelope(
    envelope: Envelope,
    subject: string,
    msg: JsMsg | null,
  ): Promise<AckDecision> {
    // §2.3 — emit `dispatch.task.aborted` on redelivery > 1, BEFORE
    // re-running the pipeline. Pilot uses the structured aborted signal
    // ("this task is in trouble") to terminate its --wait early rather
    // than letting the worst-case dead-letter window run out. The abort
    // is a courtesy emission — the per-attempt pipeline still runs and
    // emits its own terminal envelope.
    const deliveryCount = redeliveryCountFrom(msg);
    if (deliveryCount > 1) {
      await this.safePublish(
        createDispatchTaskAbortedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt: this.clock(),
          abortedAt: this.clock(),
          reason: `redelivery (attempt ${deliveryCount})`,
        }),
        "dispatch.task.aborted",
      );
      // Note: we continue with pipeline processing. The aborted envelope
      // is advisory; the pipeline's terminal envelope (verdict/failed)
      // remains the load-bearing reply pilot waits on.
    }

    // 1. Validate subject + extract <flavor>.
    const flavor = extractFlavor(envelope, subject);
    if (flavor === null) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `envelope type "${envelope.type}" is not a tasks.code-review.<flavor> request`,
        },
        `unrecognised review subject: ${subject}`,
      );
      return { kind: "term", reason: "non-review subject" };
    }

    // 2. Validate payload shape (cheap — full validation in pipeline).
    const payload = parseReviewRequestPayload(envelope);
    if (payload === null) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: "payload validation failed (missing/invalid repo or pr)",
        },
        `bad payload for ${subject}`,
      );
      return { kind: "term", reason: "payload validation failed" };
    }

    // 2.5. Signature-chain verification gate (cortex#327). Runs after the
    //      cheap structural checks (subject + payload shape) so a
    //      malformed envelope still fails with `cant_do: payload validation`
    //      rather than masquerading as a verify failure — but BEFORE the
    //      capability gate so an unverified envelope can't influence which
    //      agent matters. The verifier is optional (gradual rollout); when
    //      omitted, this block is a no-op.
    //
    //      Failure shape: `cant_do` + `term` ack. Chain rejection is
    //      operationally permanent — resigning the envelope on a retry
    //      doesn't change cortex's trust list or fix tampered bytes.
    //      Detail prefix `chain verification failed:` lets operators grep
    //      stderr / dead-letter for this specific rejection class without
    //      a new wire-level reason kind (see `SignatureVerifier` design
    //      note for the schema-stability rationale).
    if (this.signatureVerifier !== undefined) {
      const verifyResult = await this.signatureVerifier(envelope);
      if (!verifyResult.valid) {
        // Build the failure detail once and thread it through both the
        // emitted envelope's `reason.detail` and the JsMsg term reason
        // so the two stay in lockstep — Sage cycle-1 Maintainability
        // suggestion. Operators reading either the dispatch.task.failed
        // envelope or `nats consumer info`'s dead-letter view see the
        // same string.
        const failureDetail = `chain verification failed: ${verifyResult.reason}`;
        process.stderr.write(
          `cortex/review-consumer: chain verification rejected envelope ${envelope.id} ` +
            `for agent="${this.agent.id}" subject=${subject} — ${verifyResult.reason}\n`,
        );
        await this.publishFailed(
          envelope,
          { kind: "cant_do", detail: failureDetail },
          `chain verification failed for ${subject}`,
        );
        return { kind: "term", reason: failureDetail };
      }
    }

    // 3. Capability routing — does THIS agent claim the requested flavor?
    //    (Or the generic `code-review` capability as a fallback per §3.1.)
    //    Single-agent consumer means routing is binary: claim it or term.
    if (!this.claims(flavor)) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `agent "${this.agent.id}" does not claim code-review.${flavor}`,
        },
        `no capability match for code-review.${flavor}`,
      );
      return { kind: "term", reason: "no capability match" };
    }

    // 4. Concurrency gate (§7.3) — over maxConcurrent → nak `not_now`.
    //    The retry_after_ms hint is a constant 1s; the precise value
    //    doesn't matter operationally (JetStream's own redelivery
    //    schedule wins) but it gives pilot a structured signal.
    if (
      this.agent.maxConcurrent !== undefined &&
      this.inFlight.size >= this.agent.maxConcurrent
    ) {
      const retryAfterMs = 1000;
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: `agent at maxConcurrent (${this.agent.maxConcurrent}) — try again`,
          retry_after_ms: retryAfterMs,
        },
        "review consumer at maxConcurrent",
      );
      return { kind: "nak", delayMs: retryAfterMs };
    }

    // 5. Emit dispatch.task.started — paired with the eventual terminal
    //    (verdict/completed or failed) via correlation_id (§5.1).
    const startedAt = this.clock();
    await this.safePublish(
      createDispatchTaskStartedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId: envelope.id,
        startedAt,
      }),
      "dispatch.task.started",
    );

    // 6. Run the pipeline. Track the promise for `stop()` drain.
    const pipelinePromise = this.runPipeline(envelope, payload, startedAt);
    const tracked: Promise<{ decision: AckDecision }> = pipelinePromise.then(
      (decision) => ({ decision }),
    );
    const drainSentinel = tracked.then(() => undefined);
    this.inFlight.add(drainSentinel);
    try {
      const { decision } = await tracked;
      return decision;
    } finally {
      this.inFlight.delete(drainSentinel);
    }
  }

  /**
   * Stop accepting new envelopes and drain any in-flight pipelines.
   * Idempotent. Concurrent callers receive the same Promise so the
   * shutdown timeout in `cortex.ts` can wait once.
   *
   * The drain awaits every in-flight `processEnvelope` to resolve
   * (which includes publishing the terminal envelope) before resolving
   * the consumer's own stop. Pilot's `--wait` therefore sees the
   * terminal envelope from a review that was mid-flight at SIGTERM
   * instead of a phantom timeout.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      const sub = this.subscriber;
      if (sub) {
        try {
          await sub.stop();
        } catch (err) {
          process.stderr.write(
            `review-consumer: subscriber stop failed for agent=${this.agent.id}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      // Drain in-flight pipelines. `Promise.allSettled` so a single
      // late publish failure doesn't deadlock the drain.
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      }
    })();
    return this.stopPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Capability claim: exact `code-review.<flavor>` or generic `code-review`. */
  private claims(flavor: string): boolean {
    const exact = `code-review.${flavor}`;
    return (
      this.flavorSet.has(flavor) ||
      this.agent.capabilities.includes(exact) ||
      this.agent.capabilities.includes("code-review")
    );
  }

  /**
   * Pipeline executor. Returns the `AckDecision` for the surrounding
   * envelope. Captures pipeline throws and maps to defensive `nak(0)`
   * (transient — operator-recoverable per §7.6).
   *
   * On success/failure result, this method publishes the terminal
   * envelope (verdict or failed) AND, on the verdict path, the
   * co-emitted `dispatch.task.completed` (§8.2 — verdict first, then
   * completed).
   */
  private async runPipeline(
    envelope: Envelope,
    payload: ReviewRequestPayload,
    startedAt: Date,
  ): Promise<AckDecision> {
    if (this.stopped) {
      // Mid-shutdown: don't start new pipeline runs. Nak with a 0 hint
      // so the survivor (or the next boot) picks it up. We still publish
      // the failed envelope so pilot doesn't wait forever.
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: "review consumer is shutting down",
          retry_after_ms: 0,
        },
        "consumer shutting down before pipeline start",
      );
      return { kind: "nak", delayMs: 0 };
    }

    let result: ReviewPipelineResult;
    try {
      const pipelineOpts: ReviewPipelineOpts = {
        requestEnvelope: envelope,
        payload,
        agentId: this.agent.id,
        source: this.source,
        ccSessionFactory: this.ccSessionFactory,
        prompt: this.promptBuilder({
          agentId: this.agent.id,
          payload,
        }),
        ...(this.sessionOpts !== undefined && { sessionOpts: this.sessionOpts }),
        ...(this.policyCheck !== undefined && { policyCheck: this.policyCheck }),
        // cortex#361 — attach a bus-side heartbeat ticker to the CC
        // session so `system.agent.heartbeat` envelopes flow while the
        // review is in flight. The hook keeps `runtime.publish` calls
        // inside the consumer (preserving the pipeline's "never touches
        // MyelinRuntime" contract from `review-pipeline.ts` docs); the
        // pipeline calls `stop()` on the returned handle after
        // `session.wait()` resolves (or rejects).
        onSessionSpawned: (session) =>
          this.attachHeartbeatToSession(session, envelope.id),
      };
      result = await this.pipelineRunner(pipelineOpts);
    } catch (err) {
      // Defensive — `runReviewPipeline` has a non-throwing contract per
      // PR-5's docs, but a future refactor could regress. Map any throw
      // to a §7.6 transient failure so pilot's --wait gets the right
      // exit code (4, retry safe) rather than waiting on a phantom.
      const detail = err instanceof Error ? err.message : String(err);
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: `pipeline threw unexpectedly: ${detail}`,
          retry_after_ms: 0,
        },
        `pipeline runner threw: ${detail}`,
      );
      return { kind: "nak", delayMs: 0 };
    }

    if (result.kind === "verdict") {
      // §8.2 — verdict FIRST, then dispatch.task.completed. Pilot's
      // "first matching event wins" treats the verdict as the primary
      // signal and `completed` as the crash-resilience close.
      await this.safePublish(result.envelope, "review.verdict.*");
      await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt,
          completedAt: this.clock(),
          resultSummary: extractSummary(result.envelope),
        }),
        "dispatch.task.completed",
      );
      return { kind: "ack" };
    }

    // result.kind === "failed" — publish the failed envelope and pick
    // the JetStream control per the four-way nak taxonomy (§7).
    await this.safePublish(result.envelope, "dispatch.task.failed");
    return failedReasonToAckDecision(reasonOf(result.envelope));
  }

  /**
   * Publish a `dispatch.task.failed` envelope built locally — used for
   * the consumer's own pre-pipeline failure branches (bad subject, bad
   * payload, no capability match, concurrency gate). Pipeline-internal
   * failures publish the envelope PR-5 returned.
   *
   * Threads `correlation_id = envelope.id` per §5.2; the cortex-internal
   * `taskId` is a fresh UUID purely for lifecycle stitching.
   */
  private async publishFailed(
    request: Envelope,
    reason: DispatchTaskFailedReason,
    errorSummary: string,
  ): Promise<void> {
    const now = this.clock();
    const failed = createReviewTaskFailedEvent({
      source: this.source,
      taskId: crypto.randomUUID(),
      agentId: this.agent.id,
      correlationId: request.id,
      startedAt: now,
      failedAt: now,
      errorSummary,
      reason,
    });
    await this.safePublish(failed, "dispatch.task.failed");
  }

  /**
   * Publish wrapper — traps and logs publish errors per CLAUDE.md "no
   * empty catch blocks". A failed publish is operationally noisy but
   * must not crash the consumer or prevent the per-envelope handler
   * from returning an `AckDecision`.
   *
   * Defensive assertion (`correlation_id MUST equal request envelope's
   * id`) is the per-task-spec belt-and-braces gate. The pipeline + our
   * own builders should already satisfy this; the assertion catches
   * regressions early rather than producing orphan envelopes pilot
   * silently fails to filter.
   *
   * **SINGLE PUBLISH PATH (cortex#340).** Every lifecycle + verdict
   * envelope ReviewConsumer emits routes through this method —
   * `runtime.publish` is the only legitimate exit. Adding a direct
   * `link.publish` or `nc.publish` call would bypass the error trap
   * AND the recording-runtime test fixture, both of which we rely on
   * for the publish-routing audit covered by parametric tests in
   * `__tests__/review-consumer.test.ts`. If a future feature needs a
   * publish from inside this class, extend `safePublish` rather than
   * introducing a sibling path.
   */
  private async safePublish(
    envelope: Envelope,
    label: string,
  ): Promise<void> {
    try {
      await this.runtime.publish(envelope);
    } catch (err) {
      process.stderr.write(
        `review-consumer: publish failed for ${label} (agent=${this.agent.id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * cortex#361 — attach a `HeartbeatTicker` to a freshly-spawned CC
   * session so `system.agent.heartbeat` envelopes flow on the bus while
   * the review is in flight. Wired from `runPipeline` via the pipeline's
   * `onSessionSpawned` hook.
   *
   * Only attaches when the session is a real `CCSession` (an
   * EventEmitter) — test-stub factories return a plain `{ start, wait }`
   * object without `.on`. The runtime `instanceof` check keeps the path
   * safe for both. Echo cortex#363 major — wiring delegated to
   * `attachHeartbeatToCCSession` so this helper and
   * `DispatchHandler.attachHeartbeatTicker` can't drift.
   */
  private attachHeartbeatToSession(
    session: CCSessionLike,
    correlationId: string,
  ): { stop: () => void } {
    if (!(session instanceof CCSession)) {
      return {
        stop: () => {
          /* test stub session — no ticker was attached */
        },
      };
    }
    return attachHeartbeatToCCSession(session, {
      runtime: this.runtime,
      source: this.source,
      agentId: this.agent.id,
      taskId: correlationId,
      correlationId,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Derive the `<flavor>` set this consumer claims from the agent's
 * `capabilities[]`. Captures both the dotted form (`code-review.X`) and
 * the generic `code-review` claim — generic is a wildcard match against
 * any flavor (per §3.1's "or generic code-review" routing).
 */
export function deriveFlavors(capabilities: readonly string[]): string[] {
  const out: string[] = [];
  for (const cap of capabilities) {
    if (cap === "code-review") {
      out.push("*"); // generic wildcard — surfaced for logging
      continue;
    }
    if (cap.startsWith("code-review.")) {
      out.push(cap.slice("code-review.".length));
    }
  }
  return out;
}

/**
 * Extract `<flavor>` from a `tasks.code-review.<flavor>` envelope's
 * `type` field. Returns `null` if the envelope isn't a review request.
 *
 * The envelope `type` (NOT the wire subject) is the canonical source —
 * the wire subject includes the namespace prefix (`local.{org}.`) and a
 * malformed subject would falsely match a partial slice. Pull-mode
 * subjects pass through as-is in NATS but the type field is what the
 * validator-approved envelope carries.
 */
export function extractFlavor(envelope: Envelope, _subject: string): string | null {
  const t = envelope.type;
  if (!t.startsWith("tasks.code-review.")) return null;
  const flavor = t.slice("tasks.code-review.".length);
  if (flavor.length === 0 || flavor.includes(".")) return null;
  return flavor;
}

/**
 * Sentinel reviewer name for Offer-dispatch envelopes that omit the
 * `reviewer` field. The bus picks the assistant by capability +
 * subject; the reviewer field is informational for surfaces only.
 * Per cortex/CONTEXT.md the receiving being is the **assistant**;
 * this constant stands in when the publisher hasn't named one.
 */
export const OFFER_DISPATCH_REVIEWER = "capability-dispatch";

const SEGMENT_RE = /^[A-Za-z0-9][\w.-]*$/;
const OWNER_REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * Parse a review-request envelope payload into the canonical
 * {@link ReviewRequestPayload}. Two wire shapes are accepted:
 *
 * 1. **Cortex legacy** (`tasks.code-review.<flavor>` builders prior to
 *    cortex#346 / pilot#121): `{ repo: "owner/name", pr: number,
 *    reviewer: string }`.
 * 2. **Pilot / Sage Offer dispatch** (current `pilot request-review
 *    --pr OWNER/REPO#N` shape and Sage's `sage dispatch` envelopes):
 *    `{ owner: string, repo: string, number: number, pr_url?: string }`.
 *    `pr_url` is ignored once `owner`/`repo`/`number` are present.
 *
 * Both shapes normalise to the canonical `{ repo, pr, reviewer }`
 * triple before returning. An empty/absent `reviewer` is treated as
 * an Offer-dispatch signal — the capability + subject pick the
 * **assistant**, and the reviewer field is filled with
 * {@link OFFER_DISPATCH_REVIEWER}. (cortex#384.)
 *
 * Returns `null` on any shape violation. The pipeline (PR-5) trusts
 * an already-parsed payload, so the validation must happen here.
 */
export function parseReviewRequestPayload(
  envelope: Envelope,
): ReviewRequestPayload | null {
  const p = envelope.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;

  let repo: string;
  let pr: number;

  if (typeof p.owner === "string" && typeof p.number === "number") {
    // Pilot/Sage shape — fold `owner` + `repo` into the legacy
    // `owner/name` form before downstream consumers see the payload.
    if (typeof p.repo !== "string") return null;
    if (!SEGMENT_RE.test(p.owner) || !SEGMENT_RE.test(p.repo)) return null;
    repo = `${p.owner}/${p.repo}`;
    pr = p.number;
  } else {
    // Cortex legacy shape.
    if (typeof p.repo !== "string" || !OWNER_REPO_RE.test(p.repo)) return null;
    if (typeof p.pr !== "number") return null;
    repo = p.repo;
    pr = p.pr;
  }

  if (!Number.isInteger(pr) || pr <= 0) return null;

  // Reviewer is informational on Offer dispatch — the capability
  // routes the envelope, not this field. Empty / absent / null all
  // collapse to the OFFER_DISPATCH_REVIEWER sentinel so the downstream
  // payload shape stays uniform.
  const reviewerRaw = p.reviewer;
  let reviewer: string;
  if (reviewerRaw === undefined || reviewerRaw === null || reviewerRaw === "") {
    reviewer = OFFER_DISPATCH_REVIEWER;
  } else if (typeof reviewerRaw === "string") {
    reviewer = reviewerRaw;
  } else {
    return null;
  }

  const out: ReviewRequestPayload = { repo, pr, reviewer };
  if (typeof p.feature === "string") out.feature = p.feature;
  if (typeof p.title === "string") out.title = p.title;
  if (typeof p.cycle === "number" && Number.isInteger(p.cycle)) out.cycle = p.cycle;
  if (typeof p.note === "string") out.note = p.note;
  return out;
}

/**
 * Pull the `summary` field off a verdict envelope for the
 * `dispatch.task.completed`'s `result_summary` (§8.4).
 */
function extractSummary(verdictEnvelope: Envelope): string | undefined {
  const p = verdictEnvelope.payload as { summary?: unknown } | undefined;
  if (!p || typeof p.summary !== "string") return undefined;
  return p.summary;
}

/**
 * Read the `payload.reason` field off a failed envelope. Returns the
 * discriminated reason or undefined.
 */
function reasonOf(failedEnvelope: Envelope): DispatchTaskFailedReason | undefined {
  const p = failedEnvelope.payload as { reason?: unknown } | undefined;
  if (!p?.reason || typeof p.reason !== "object") return undefined;
  return p.reason as DispatchTaskFailedReason;
}

/**
 * Map a `DispatchTaskFailedReason` to the matching JetStream
 * `AckDecision`. The mapping table is the contract this PR locks in
 * for PR-9's e2e tests + pilot's wait-for-verdict exit-code mapping.
 *
 * - `cant_do`          → term (permanent — capability mismatch / bad payload).
 * - `wont_do`          → term (permanent — policy refusal).
 * - `policy_denied`    → term (permanent — compliance gate refused).
 * - `not_now`          → nak with `retry_after_ms` hint (transient).
 * - `compliance_block` → term (v1: per Echo cortex#253 R1 Minor-5,
 *                        consumer omits the dead branch; if it ever
 *                        arrives we term with a clear reason so it
 *                        surfaces in the dead-letter dashboard).
 * - undefined          → ack (defensive — shouldn't happen on a failed
 *                        envelope, but ack-on-unknown is safer than
 *                        nak-loop).
 */
export function failedReasonToAckDecision(
  reason: DispatchTaskFailedReason | undefined,
): AckDecision {
  if (!reason) return { kind: "ack" };
  switch (reason.kind) {
    case "cant_do":
      return { kind: "term", reason: `cant_do: ${reason.detail}` };
    case "wont_do":
      return { kind: "term", reason: `wont_do: ${reason.detail}` };
    case "policy_denied": {
      // The engine's structured deny payload (`reason.deny`) is a
      // free-form record. Summarise its keys for the term reason so
      // operators see WHICH deny path fired (`unknown_principal`,
      // `insufficient_role`, …) without serialising the entire blob into
      // a JetStream control header.
      const denyKeys = Object.keys(reason.deny);
      const summary =
        denyKeys.length > 0 ? denyKeys.join(",") : "(no deny detail)";
      return {
        kind: "term",
        reason: `policy_denied: ${summary}`,
      };
    }
    case "not_now": {
      const out: AckDecision = { kind: "nak" };
      if (reason.retry_after_ms !== undefined) {
        out.delayMs = reason.retry_after_ms;
      }
      return out;
    }
    case "compliance_block":
      return {
        kind: "term",
        reason: "v1 does not handle compliance_block",
      };
  }
}

/**
 * Read JetStream redelivery count from a `JsMsg`. Returns `1` when no
 * msg is supplied (tests / push-mode synthetic paths) so the §2.3
 * "redelivery > 1" guard stays inert. `info.redeliveryCount` is the
 * 1-indexed attempt count; first delivery is `1`, the first redelivery
 * is `2`.
 */
function redeliveryCountFrom(msg: JsMsg | null): number {
  if (!msg) return 1;
  const info = (msg.info as { redeliveryCount?: number } | undefined) ?? undefined;
  if (info && typeof info.redeliveryCount === "number") {
    return info.redeliveryCount;
  }
  return msg.redelivered ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Re-exports — review consumer ergonomics
// ---------------------------------------------------------------------------

export type { AckDecision } from "./myelin/subscriber";
export type { ConsumerMessages, JsMsg };
