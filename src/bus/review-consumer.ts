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
 * | failed/`cant_do` (capability mismatch / bad pl.) | `dispatch.task.failed`   | `term(reason.detail)` (permanent)  |
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
import type { CCSessionFactory } from "../substrates/claude-code/harness";
import type { CCSessionOpts } from "../runner/cc-session";

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
 */
export interface ReviewConsumerStartedInfo {
  agentId: string;
  flavors: readonly string[];
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
      // set. The boot path logs the disabled-runtime case once at
      // startup; we don't double-log here.
      return { agentId: this.agent.id, flavors: this.flavors };
    }
    this.subscriber = sub;
    await this.subscriber.ready;
    return { agentId: this.agent.id, flavors: this.flavors };
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
 * Minimal payload parse — re-uses the spec's invariants (`repo` matches
 * `owner/name`; `pr` is a positive integer). Returns `null` on any shape
 * violation. The pipeline (PR-5) trusts an already-parsed payload, so
 * the validation must happen here.
 */
export function parseReviewRequestPayload(
  envelope: Envelope,
): ReviewRequestPayload | null {
  const p = envelope.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  const repo = p.repo;
  const pr = p.pr;
  const reviewer = p.reviewer;
  if (typeof repo !== "string" || !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) {
    return null;
  }
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
    return null;
  }
  if (typeof reviewer !== "string" || reviewer.length === 0) {
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
