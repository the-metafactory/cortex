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
 * onto the dead-letter side that principals see in `nats consumer info`
 * + `system.dispatch.dead_letter` envelopes a future tap may project.
 * `nak(delay)` re-queues with an optional backoff hint. We pick term
 * for permanent so dead-letter observability stays meaningful, and nak
 * for transient so pilot can keep its `--wait` budget cooking against
 * the redelivery.
 *
 * **Scope (per task spec + §10.1 PR-6):**
 *   - Subscribes pull-mode to `local.{principal}.tasks.code-review.>`.
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
import { deriveSubject } from "@the-metafactory/myelin/subjects";
import type { MyelinRuntime } from "./myelin/runtime";
import type { Envelope } from "./myelin/envelope-validator";
import { getActorPrincipal } from "./myelin/envelope-validator";
import { resolveSourceNetwork } from "./surface-router";
import { evaluateSovereignty, type AgentModelClass } from "./sovereignty-gate";
import type { PolicyFederatedNetwork } from "../common/types/cortex-config";
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
  type LogicalResponseRouting,
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
  /**
   * Governance Stage 1b — the kind of model this agent runs (`local-only`
   * | `frontier` | `any`). Consumed by the consumer-side sovereignty gate
   * to refuse a task whose envelope demands a local model when this agent
   * is frontier-capable. Absent → the gate fails closed for local-only
   * tasks (see {@link evaluateSovereignty}).
   */
  modelClass?: AgentModelClass;
}

/**
 * Build the CC prompt for a single review request. Production callers
 * pass a function that assembles the security preamble + skill
 * invocation + assistant prefix; tests pass a deterministic stub.
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
 * field — short enough to scan, specific enough that a principal can
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
 * resolver + receiving agent + principalId; tests inject stubs that
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
  /** Envelope source (`{principal}.{agent}.{instance}`) — same triple used by
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
   * pre-#327 behaviour — for principals still rolling out signing.
   *
   * See {@link SignatureVerifier} for the function signature + the
   * design note on why this stays a pluggable closure rather than a
   * `TrustResolver` import.
   */
  signatureVerifier?: SignatureVerifier;
  /**
   * cortex#686 (ADR 0002) — FEDERATED routing mode. When `true`, the consumer
   * treats every inbound envelope as a cross-principal (federated) review
   * request and routes ALL emitted lifecycle + verdict envelopes back to the
   * REQUESTER's identity on the conformant `federated.{requester-principal}.
   * {requester-stack}.…` grammar, instead of the consumer's own
   * `local.{my-principal}.{my-stack}.…`.
   *
   * **The requester is decoded from `envelope.originator.identity`** (the
   * `did:mf:{requester-principal}-{requester-stack}` DID form per ADR 0002 §1) —
   * NOT from the inbound subject (whose `{principal}.{stack}` segments address
   * the TARGET = this receiving stack, per ADR 0001), and NOT from
   * `envelope.source` (which also addresses the target). Reading the requester
   * off the subject — as cortex#715 originally did — routes every verdict to
   * SELF and the loop never closes (the cortex#686 BLOCKER this rework fixes).
   *
   * The emitted envelopes are stamped `classification: "federated"` and
   * published via {@link MyelinRuntime.publishOnSubject} on the requester-keyed
   * subject; the runtime's `selectLink` resolves the requester principal → leaf
   * from the `peers[]` topology. This is the cortex receiver that closes the
   * cross-principal review loop so the peer's `pilot --wait` resolves.
   *
   * Default `false` → the existing local-consumer behaviour (publish via
   * `runtime.publish`, deriving `local.{my-principal}.{my-stack}.…`),
   * byte-for-byte unchanged.
   */
  federated?: boolean;
  /**
   * cortex#686 (ADR 0002 §5) — the federation peer topology, used by the
   * defense-in-depth `peers[]` membership gate the federated consumer runs
   * BEFORE spawning the reviewer. Resolved from
   * `policy.federated.networks[]` at boot. The gate resolves the REQUESTER
   * principal (from `originator.identity`) against these networks' `peers[]`
   * and fails closed (deny + drop, no CC spawn, no publish) when the requester
   * is not a configured peer.
   *
   * Under `signing: off` this membership check is the application-layer trust
   * boundary; under `enforce` the `signed_by` chain + the (signed) originator
   * field add the crypto check on top. Empty / undefined → no live federated
   * traffic is admitted (a federated consumer with no declared peers denies
   * every requester — fail closed), but in practice the consumer is only wired
   * with `federated: true` when at least one network is configured (see
   * `src/cortex.ts` `federationConfigured`).
   *
   * Only consulted in federated mode; ignored on the local path.
   */
  federatedNetworks?: readonly PolicyFederatedNetwork[];
  /**
   * Governance Stage 1b — when `true`, the consumer-side sovereignty gate
   * HARD-DENIES (term + `dispatch.task.failed` `wont_do`) a claim whose
   * envelope demands a local model while this agent is frontier-capable.
   * When `false`/absent the gate runs in **audit-parity**: it evaluates and
   * logs the verdict to stderr but lets the work proceed.
   *
   * Default `false` because a self-declared `modelClass` is honest-but-
   * spoofable; the hard-deny posture should wait until model class is bound
   * to the signing identity (cortex#327 audit→enforce). Audit-parity ships
   * the evaluation now so the denial rate is observable before it bites.
   */
  sovereigntyEnforce?: boolean;
  /**
   * Test seam — clock. Defaults to `() => new Date()`. Tests inject a
   * fixed clock so emitted `startedAt`/`completedAt` are deterministic.
   */
  clock?: () => Date;
}

/**
 * cortex#686 (ADR 0002) — the requester's `{principal}.{stack}` identity,
 * decoded from the inbound envelope's `originator.identity` DID (the
 * `did:mf:{requester-principal}-{requester-stack}` form = `stack.id` with
 * `/`→`-`). The federated consumer keys every verdict + lifecycle envelope it
 * routes back to this identity so the peer's `pilot --wait` (subscribed on
 * `federated.{its-principal}.{its-stack}.review.verdict.>`) resolves.
 *
 * The requester is the policy actor in `originator`, NOT the subject (which
 * addresses the TARGET) — see {@link parseRequesterFromOriginator}.
 */
export interface FederatedRequester {
  /** Requester principal — the DID body segment BEFORE the FIRST `-`
   *  (principals carry no hyphen). */
  principal: string;
  /** Requester stack — the DID body segment AFTER the first `-` (may itself
   *  contain hyphens, e.g. `meta-factory`). */
  stack?: string;
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
  /** Subject pattern, e.g. `local.{principal}.tasks.code-review.>`. */
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
  /** cortex#686 — federated routing mode (verdict back to the requester). */
  private readonly federated: boolean;
  /**
   * cortex#686 (ADR 0002 §5) — federation peer topology indexed by network id,
   * for the `peers[]` membership gate. Empty in local mode / when no networks
   * are configured.
   */
  private readonly federatedNetworksById: Map<string, PolicyFederatedNetwork>;
  /** Governance Stage 1b — hard-deny on sovereignty mismatch vs. audit-parity. */
  private readonly sovereigntyEnforce: boolean;
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
    this.federated = opts.federated ?? false;
    // cortex#686 (ADR 0002 §5) — index the peer topology by network id once at
    // construction so the consumer-path gate is O(networks) per envelope. Built
    // even in local mode (cheap, empty); only consulted when `federated`.
    this.federatedNetworksById = new Map<string, PolicyFederatedNetwork>();
    for (const network of opts.federatedNetworks ?? []) {
      this.federatedNetworksById.set(network.id, network);
    }
    this.sovereigntyEnforce = opts.sovereigntyEnforce ?? false;
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
      // so principals see "DORMANT" instead of a misleading "ready"
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
    // cortex#502 — read the LOGICAL response routing off the inbound
    // request once and echo it onto every emitted lifecycle + the verdict.
    // Absent (bus-peer / direct-pilot-only / Offer) → undefined → no
    // `response_routing` key on the wire → the review sink ignores the
    // envelopes (the verdict still reaches pilot via correlation_id).
    const responseRouting = readLogicalResponseRouting(envelope) ?? undefined;

    // cortex#836 — the cross-principal TRUST BOUNDARY is per-message and lives in
    // the SUBJECT SCOPE, NOT in the coarse `this.federated` mode flag (see
    // ADR-0001 §scope: `local.` is same-principal, `federated.` is cross-principal).
    //
    // `this.federated` is set for the WHOLE consumer once a stack joins a network
    // (≥1 network configured — see cortex.ts), so it cannot distinguish a local
    // self-dispatch from a federated cross-principal request. Keying the requester
    // parse + deny gate on the per-message subject scope instead means a `local.>`
    // self-dispatch on a network-joined stack bypasses the gate (requester stays
    // `undefined` → local-scope emission, identical to non-federated mode), while a
    // `federated.>` request keeps the FULL gate. Any non-`federated.` scope
    // (`local.`, the near-future `public.`) is fail-safe: it defaults to the local
    // path, never the cross-principal deny gate.
    //
    // SAFE because the leaf's `accept_subjects` is `federated.{me}.{stack}.>` ONLY
    // (built at `src/cli/cortex/commands/network-lib.ts:~290`), so a `local.>`
    // envelope is same-principal-only BY TRANSPORT CONSTRUCTION — a remote peer's
    // leaf cannot deliver one across the boundary. A future reader MUST NOT widen
    // `accept_subjects` to admit `local.>`/`public.>` from a peer without revisiting
    // this gate, or the scope-based trust assumption breaks.
    const isFederatedRequest = subject.startsWith("federated.");

    // cortex#686 (ADR 0002) — in federated mode, derive the REQUESTER
    // `{principal}.{stack}` from the inbound envelope's `originator.identity`
    // ONCE so every emitted envelope routes back to the requester on the
    // conformant `federated.{requester}.{stack}.…` grammar.
    //
    // The requester is the POLICY ACTOR in `originator`, NOT the subject: under
    // ADR 0001 the subject's `{principal}.{stack}` segments address the TARGET
    // (this receiving stack), and `envelope.source` likewise addresses the
    // target. Reading the requester off the subject (the cortex#715 BLOCKER)
    // routes every verdict to SELF and the loop never closes.
    //
    // `undefined` for a LOCAL inbound (cortex#836: a `local.>` self-dispatch has
    // no requester — the requester is self), OR (on the `federated.>` path) when
    // `originator.identity` is absent / malformed. An un-attributable federated
    // request is DENIED + DROPPED by the gate below (we never even reach
    // `safePublish`); the `safePublish` local fall-through remains the
    // belt-and-braces backstop for the non-denied path against a runtime that
    // lacks `publishOnSubject` (a disabled runtime / legacy stub — never a live
    // wire), so a verdict is never guessed onto a cross-principal target.
    const requester =
      this.federated && isFederatedRequest
        ? parseRequesterFromOriginator(envelope)
        : undefined;

    // cortex#686 (ADR 0002 §5) — defense-in-depth `peers[]` gate ON THE CONSUMER
    // PATH. Run the membership check BEFORE spawning the reviewer or emitting
    // anything: the requester principal MUST be a configured peer in some
    // `policy.federated.networks[].peers[]`. A non-peer requester (or a
    // federated request with no resolvable requester) is DENIED and DROPPED —
    // no CC subprocess, no verdict, no lifecycle envelope. Under `signing: off`
    // this membership check is the application-layer trust boundary; under
    // `enforce` the signed_by chain + signed originator add the crypto check.
    //
    // cortex#836 (ADR 0001) — gated on `isFederatedRequest` so it runs ONLY for
    // a `federated.>` inbound (cross-principal). A `local.>` self-dispatch on a
    // network-joined stack bypasses the gate entirely — same-principal traffic
    // never crosses the boundary the gate guards.
    if (this.federated && isFederatedRequest) {
      const denyReason = this.federatedRequesterDenyReason(requester);
      if (denyReason !== null) {
        process.stderr.write(
          `cortex/review-consumer: federated request DENIED (dropped) for ` +
            `agent="${this.agent.id}" subject=${subject} envelope=${envelope.id} — ${denyReason}\n`,
        );
        // Term so JetStream removes the message (permanent — a non-peer
        // requester won't become a peer on redelivery) WITHOUT emitting any
        // verdict/lifecycle envelope to a principal we don't trust.
        return { kind: "term", reason: `federated requester denied: ${denyReason}` };
      }
    }

    // Stamp federated sovereignty on every emitted envelope so the wire is
    // self-consistent with the `federated.*` subject it lands on.
    const classification = requester !== undefined ? "federated" : undefined;

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
          ...(responseRouting !== undefined && { responseRouting }),
          ...(classification !== undefined && { classification }),
        }),
        "dispatch.task.aborted",
        requester,
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
        responseRouting,
        requester,
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
        responseRouting,
        requester,
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
    //      Detail prefix `chain verification failed:` lets principals grep
    //      stderr / dead-letter for this specific rejection class without
    //      a new wire-level reason kind (see `SignatureVerifier` design
    //      note for the schema-stability rationale).
    if (this.signatureVerifier !== undefined) {
      const verifyResult = await this.signatureVerifier(envelope);
      if (!verifyResult.valid) {
        // Build the failure detail once and thread it through both the
        // emitted envelope's `reason.detail` and the JsMsg term reason
        // so the two stay in lockstep — Sage cycle-1 Maintainability
        // suggestion. Principals reading either the dispatch.task.failed
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
          responseRouting,
          requester,
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
        responseRouting,
        requester,
      );
      return { kind: "term", reason: "no capability match" };
    }

    // 3b. Consumer-side sovereignty gate (governance Stage 1b). The envelope
    //     DECLARES model_class / frontier_ok; this is where the consumer
    //     refuses to run a task whose sovereignty its own model class would
    //     violate — confidential payload must not reach a frontier model. The
    //     manifest declares; this gate bites.
    //
    //     Audit-parity by default: evaluate + log, but proceed (a self-declared
    //     modelClass is spoofable until bound to the signing identity,
    //     cortex#327). With sovereigntyEnforce, deny → term + wont_do.
    {
      const sov = evaluateSovereignty(envelope.sovereignty, this.agent.modelClass);
      if (sov.decision === "deny") {
        if (this.sovereigntyEnforce) {
          process.stderr.write(
            `cortex/review-consumer: sovereignty DENIED (enforce) for ` +
              `agent="${this.agent.id}" subject=${subject} envelope=${envelope.id} — ${sov.reason}\n`,
          );
          await this.publishFailed(
            envelope,
            { kind: "wont_do", detail: sov.reason },
            `sovereignty refusal for ${subject}`,
            responseRouting,
            requester,
          );
          return { kind: "term", reason: `wont_do: ${sov.reason}` };
        }
        // Audit-parity: the denial is observable but does not yet bite.
        process.stderr.write(
          `cortex/review-consumer: sovereignty would DENY (audit-parity) for ` +
            `agent="${this.agent.id}" subject=${subject} envelope=${envelope.id} — ${sov.reason}\n`,
        );
      }
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
        responseRouting,
        requester,
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
        ...(responseRouting !== undefined && { responseRouting }),
        ...(classification !== undefined && { classification }),
      }),
      "dispatch.task.started",
      requester,
    );

    // 6. Run the pipeline. Track the promise for `stop()` drain.
    const pipelinePromise = this.runPipeline(
      envelope,
      payload,
      startedAt,
      responseRouting,
      requester,
    );
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

  /**
   * cortex#686 (ADR 0002 §5) — the federated `peers[]` membership gate.
   * Returns a human-readable deny reason when the inbound federated request
   * must be DROPPED, or `null` when it may proceed to the reviewer.
   *
   * Deny when:
   *   1. No requester could be derived from `originator.identity` (absent /
   *      malformed) — we can't name (or trust) the cross-principal source, so
   *      fail closed. (`safePublish` would already fall back to the local path,
   *      but a federated consumer must not even spawn the reviewer for an
   *      un-attributable request.)
   *   2. The requester is THIS receiving stack's own principal — a self-loop
   *      (an envelope that named us as the requester). Drop rather than review
   *      our own request and route the verdict to ourselves.
   *   3. The requester principal resolves to NO configured network's `peers[]`
   *      — an unknown / untrusted peer.
   *
   * Pure-ish (reads only `this.*` config + the argument); no side effects.
   */
  private federatedRequesterDenyReason(
    requester: FederatedRequester | undefined,
  ): string | null {
    if (requester === undefined) {
      return "no requester in originator.identity (absent or malformed)";
    }
    if (requester.principal === this.source.principal) {
      return `self-loop: requester principal "${requester.principal}" is this receiving stack`;
    }
    const resolved = resolveSourceNetwork(
      requester.principal,
      this.federatedNetworksById,
    );
    if (resolved === undefined) {
      return `requester principal "${requester.principal}" is in no configured network's peers[]`;
    }
    return null;
  }

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
   * (transient — principal-recoverable per §7.6).
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
    responseRouting?: LogicalResponseRouting,
    requester?: FederatedRequester,
  ): Promise<AckDecision> {
    // cortex#686 — federated mode stamps every emitted envelope with federated
    // sovereignty so the wire is self-consistent with the requester-keyed
    // `federated.*` subject `safePublish` routes it on.
    const classification = requester !== undefined ? "federated" : undefined;
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
        responseRouting,
        requester,
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
        // cortex#502 — pass the logical routing into the pipeline so the
        // verdict + failed terminal envelopes it builds carry it.
        ...(responseRouting !== undefined && { responseRouting }),
        // cortex#686 — federated reviews stamp the pipeline's terminal
        // (verdict/failed) envelopes with federated sovereignty.
        ...(classification !== undefined && { classification }),
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
        responseRouting,
        requester,
      );
      return { kind: "nak", delayMs: 0 };
    }

    if (result.kind === "verdict") {
      // §8.2 — verdict FIRST, then dispatch.task.completed. Pilot's
      // "first matching event wins" treats the verdict as the primary
      // signal and `completed` as the crash-resilience close.
      await this.safePublish(result.envelope, "review.verdict.*", requester);
      await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt,
          completedAt: this.clock(),
          resultSummary: extractSummary(result.envelope),
          ...(responseRouting !== undefined && { responseRouting }),
          ...(classification !== undefined && { classification }),
        }),
        "dispatch.task.completed",
        requester,
      );
      return { kind: "ack" };
    }

    if (result.kind === "completed") {
      // cortex#503 — PROSE-FALLBACK success. The agent answered in prose
      // (no parseable structured verdict block), so there is NO
      // `review.verdict.<kind>` co-emission — fabricating one would
      // manufacture a verdict cortex cannot stand behind. We publish ONLY a
      // `dispatch.task.completed` carrying the agent's prose so pilot's
      // `--wait` observes a completion (and downgrades to commented/exit-0
      // rather than gating on a phantom timeout), and the review sink renders
      // the prose as markdown to the originating thread.
      //
      // `chatResponse` carries the FULL prose (the surface render); the first
      // line (capped) is the dashboard `result_summary` label.
      await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt,
          completedAt: this.clock(),
          resultSummary: firstLine(result.presentation),
          chatResponse: result.presentation,
          ...(responseRouting !== undefined && { responseRouting }),
          ...(classification !== undefined && { classification }),
        }),
        "dispatch.task.completed",
        requester,
      );
      return { kind: "ack" };
    }

    // result.kind === "failed" — publish the failed envelope and pick
    // the JetStream control per the four-way nak taxonomy (§7).
    await this.safePublish(result.envelope, "dispatch.task.failed", requester);
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
    responseRouting?: LogicalResponseRouting,
    requester?: FederatedRequester,
  ): Promise<void> {
    const now = this.clock();
    // cortex#686 — federated failures declare federated sovereignty so they
    // route back to the requester self-consistently with the subject.
    const classification = requester !== undefined ? "federated" : undefined;
    const failed = createReviewTaskFailedEvent({
      source: this.source,
      taskId: crypto.randomUUID(),
      agentId: this.agent.id,
      correlationId: request.id,
      startedAt: now,
      failedAt: now,
      errorSummary,
      reason,
      // cortex#502 — echo routing so the consumer's own pre-pipeline
      // failures (bad subject/payload, no capability, backpressure) still
      // render to the originating thread.
      ...(responseRouting !== undefined && { responseRouting }),
      ...(classification !== undefined && { classification }),
    });
    await this.safePublish(failed, "dispatch.task.failed", requester);
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
   * `runtime.publish` (local) or `runtime.publishOnSubject` (federated, since
   * cortex#686) are the only legitimate exits. Adding a direct
   * `link.publish` or `nc.publish` call would bypass the error trap
   * AND the recording-runtime test fixture, both of which we rely on
   * for the publish-routing audit covered by parametric tests in
   * `__tests__/review-consumer.test.ts`. If a future feature needs a
   * publish from inside this class, extend `safePublish` rather than
   * introducing a sibling path.
   *
   * cortex#686 — when `requester` is supplied (federated mode), the envelope
   * is published on the REQUESTER-keyed `federated.{requester-principal}.
   * {requester-stack}.{type}` subject via {@link MyelinRuntime.publishOnSubject}
   * (deriving the subject from `envelope.type` + the requester identity decoded
   * from the `did:mf:{principal}-{stack}` originator DID). The
   * runtime's `selectLink` resolves the requester principal → leaf from the
   * `peers[]` topology so the verdict reaches the peer stack's
   * `pilot --wait`. Absent `requester` → the unchanged local
   * `runtime.publish` path (derives `local.{my-principal}.{my-stack}.…`).
   */
  private async safePublish(
    envelope: Envelope,
    label: string,
    requester?: FederatedRequester,
  ): Promise<void> {
    try {
      if (requester !== undefined && this.runtime.publishOnSubject !== undefined) {
        // ADR 0001 — federated subject carries the REQUESTER's identity
        // (`{principal}.{stack}`), NEVER a network id. `deriveSubject` builds
        // the same `{principal}.{stack}` grammar as `local.*`, only the scope
        // prefix differs; routing (which leaf) is resolved from topology by
        // `selectLink`, not from the wire.
        const subject = deriveSubject(
          "federated",
          requester.principal,
          envelope.type,
          requester.stack,
        );
        await this.runtime.publishOnSubject(envelope, subject);
      } else {
        // Local mode, OR federated mode against a runtime that doesn't ship
        // `publishOnSubject`. The latter only happens on a DISABLED runtime
        // (its `publish` is itself a no-op) or a legacy test stub — in both
        // cases falling through here cannot misroute a live federated verdict
        // onto a local subject, because no live publish occurs. Every
        // production (enabled) runtime ships `publishOnSubject`, so federated
        // mode always takes the branch above on the wire.
        await this.runtime.publish(envelope);
      }
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
 * the wire subject includes the namespace prefix (`local.{principal}.`) and a
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
 * cortex#686 (ADR 0002 §1+§3) — decode the REQUESTER's `{principal}.{stack}`
 * identity from an inbound FEDERATED review-request envelope's
 * `originator.identity` DID.
 *
 * **Why `originator`, not the subject or `source`.** Under ADR 0001 a federated
 * subject is `federated.{TARGET-principal}.{TARGET-stack}.tasks.code-review.…`
 * and `deriveNatsSubject` derives that from `envelope.source` — so BOTH the
 * subject's `{principal}.{stack}` segments AND `envelope.source` address the
 * TARGET (this receiving stack), not the requester. Reading the requester off
 * either routes the verdict to SELF and the loop never closes (the cortex#715
 * BLOCKER). ADR 0002 §1 carries the requester in `originator.identity` —
 * "who the signer is acting on behalf of" — a signed/signable field.
 *
 * **Format (ADR 0002 §1, §3): `originator.identity = did:mf:{requester-principal}-{requester-stack}`.**
 * This is the requester stack's canonical signing-DID — exactly `stack.id` with
 * `/`→`-` (cortex `src/cortex.ts:483`: `did:mf:${stack.id.replace("/","-")}`).
 * It is NOT a bare `{principal}/{stack}` slash form: myelin validates
 * `originator.identity` against the `did:mf:<name>` DID grammar, which rejects
 * `/`. The encoder is pilot's `encodeRequesterDid` (pilot#149,
 * `src/bus/publish-review-request.ts`): `did:mf:${principal}-${stack}`; this
 * decoder is its EXACT inverse (lockstep — pilot#149 ↔ cortex#686).
 *
 * **Decode:** require a `did:mf:` prefix, strip it, then split the remainder on
 * the FIRST `-` into `{principal, stack}`. The first-hyphen split rests on the
 * **principal-carries-no-hyphen assumption**: a principal segment is a single
 * `^[a-z][a-z0-9]*$`-style token, while a STACK may itself contain hyphens
 * (e.g. `meta-factory`). So `did:mf:andreas-meta-factory` decodes to principal
 * `andreas` / stack `meta-factory` — the first hyphen separates the two; every
 * later hyphen belongs to the stack. (A principal with a hyphen would be
 * indistinguishable from a stack boundary; the wire grammar forbids it.)
 *
 * Returns `undefined` (→ deny + drop) when there is no `originator` block, the
 * identity is empty, it lacks the `did:mf:` prefix, or the post-prefix body
 * carries no `-` to split principal from stack. The federated consumer then
 * DENIES + DROPS the request (an un-attributable / non-conformant cross-principal
 * source is never reviewed; see {@link ReviewConsumer.federatedRequesterDenyReason}).
 * The bare slash form is NOT accepted — only the DID form is on the wire.
 *
 * Exported for the review-consumer tests.
 */
export function parseRequesterFromOriginator(
  envelope: Envelope,
): FederatedRequester | undefined {
  // getActorPrincipal precedence: originator.identity → originator.principal
  // (deprecated dual-read) → signed_by[0].identity. For a federated dispatch
  // the requester is the originator; the signed_by[0] fallback is the relaying
  // stack, which for a self-signed cross-principal hop is also the requester
  // stack — but we require the originator block to be present so an un-stamped
  // envelope fails closed rather than borrowing the signer as the requester.
  if (envelope.originator === undefined) return undefined;
  const raw = getActorPrincipal(envelope);
  if (raw === undefined || raw.length === 0) return undefined;

  // Require the `did:mf:` method prefix — the wire carries the DID form, never
  // a bare slash form (myelin's DID grammar rejects `/`). Fail closed otherwise.
  const PREFIX = "did:mf:";
  if (!raw.startsWith(PREFIX)) return undefined;
  const body = raw.slice(PREFIX.length);

  // Split on the FIRST hyphen: principal (no hyphen) | stack (may contain
  // hyphens). `did:mf:andreas-meta-factory` → principal `andreas`, stack
  // `meta-factory`. The exact inverse of pilot's
  // `encodeRequesterDid` = `did:mf:${principal}-${stack}` (= stack.id `/`→`-`).
  const hyphen = body.indexOf("-");
  if (hyphen <= 0 || hyphen === body.length - 1) {
    // No hyphen, leading hyphen, or trailing hyphen → can't split an
    // unambiguous {principal}-{stack}. Fail closed.
    return undefined;
  }
  const principal = body.slice(0, hyphen);
  const stack = body.slice(hyphen + 1);
  return { principal, stack };
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
 * Resolve a GitHub PR URL or GitLab MR URL into the canonical
 * `{ repo: "owner/name", pr }` pair. Mirrors sage's `resolvePrRef`
 * receiver contract (sage src/tasks/types.ts) so `sage dispatch`
 * envelopes that carry only `pr_url` parse here.
 *
 * - GitHub: `https://<host>/{owner}/{repo}/pull/{n}`
 * - GitLab: `https://<host>/{project/path}/-/merge_requests/{n}`
 *
 * Returns `null` on any unparseable URL or out-of-range PR number.
 */
function parsePrUrl(
  url: string,
): { repo: string; pr: number; forge: "github" | "gitlab" } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL — caller treats null as a payload-shape violation.
    return null;
  }

  const gh = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
  if (gh) {
    const owner = gh[1];
    const repo = gh[2];
    const n = gh[3];
    if (owner === undefined || repo === undefined || n === undefined) return null;
    if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) return null;
    const pr = Number(n);
    return Number.isInteger(pr) && pr > 0
      ? { repo: `${owner}/${repo}`, pr, forge: "github" }
      : null;
  }

  const gl = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(parsed.pathname);
  if (gl) {
    const projectPath = gl[1];
    const n = gl[2];
    if (projectPath === undefined || n === undefined) return null;
    const pr = Number(n);
    return Number.isInteger(pr) && pr > 0
      ? { repo: projectPath, pr, forge: "gitlab" }
      : null;
  }

  return null;
}

/**
 * Parse a review-request envelope payload into the canonical
 * {@link ReviewRequestPayload}. Two wire shapes are accepted:
 *
 * 1. **Cortex legacy** (`tasks.code-review.<flavor>` builders prior to
 *    cortex#346 / pilot#121): `{ repo: "owner/name", pr: number,
 *    reviewer: string }`.
 * 2. **Pilot / Sage Offer dispatch** (current `pilot request-review
 *    --pr OWNER/REPO#N` shape):
 *    `{ owner: string, repo: string, number: number, pr_url?: string }`.
 *    `pr_url` is ignored once `owner`/`repo`/`number` are present.
 * 3. **Sage dispatch URL-only** (the `sage dispatch` CLI always emits
 *    just `{ pr_url: string }`): owner/repo/pr are resolved out of the
 *    GitHub/GitLab PR URL via {@link parsePrUrl}.
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
  let forge: "github" | "gitlab" | undefined;
  if (p.forge !== undefined) {
    if (p.forge !== "github" && p.forge !== "gitlab") return null;
    forge = p.forge;
  }

  if (typeof p.owner === "string" && typeof p.number === "number") {
    // Pilot/Sage shape — fold `owner` + `repo` into the legacy
    // `owner/name` form before downstream consumers see the payload.
    if (typeof p.repo !== "string") return null;
    if (!SEGMENT_RE.test(p.owner) || !SEGMENT_RE.test(p.repo)) return null;
    repo = `${p.owner}/${p.repo}`;
    pr = p.number;
  } else if (typeof p.repo === "string" && typeof p.pr === "number") {
    // Cortex legacy shape.
    if (!OWNER_REPO_RE.test(p.repo)) return null;
    repo = p.repo;
    pr = p.pr;
  } else if (typeof p.pr_url === "string") {
    // Sage dispatch shape — the `sage dispatch` CLI always sends only
    // `pr_url` (see sage src/tasks/types.ts: the dispatcher knows the
    // full URL, the `owner/repo/number` triple is the optional alt and
    // "the receiver's resolvePrRef handles both"). Resolve owner/repo/pr
    // out of the GitHub/GitLab PR URL here.
    const fromUrl = parsePrUrl(p.pr_url);
    if (fromUrl === null) return null;
    repo = fromUrl.repo;
    pr = fromUrl.pr;
    forge ??= fromUrl.forge;
  } else {
    return null;
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
  // `sage dispatch --post` stamps `post: true` (sage#8: true or omitted,
  // never false). Carry it through so the substrate runner can pass
  // `--post` to the sage subprocess.
  if (p.post === true) out.post = true;
  if (forge !== undefined) out.forge = forge;
  return out;
}

/**
 * cortex#502 — read the LOGICAL response routing off an inbound review
 * request envelope's `payload.response_routing`, or `null` when absent /
 * malformed. The review path uses the platform-neutral logical shape
 * (`{ surface, channel, thread? }`) — distinct from the chat path's
 * snowflake triple. A missing/invalid field is a normal, non-error case
 * (pilot-only / bus-peer / Offer dispatch): the consumer simply omits
 * `response_routing` from every emitted envelope, and the review sink
 * ignores them. The authoritative verdict still reaches pilot via
 * `correlation_id`.
 *
 * `surface` + `channel` are required; `thread` is optional (channel-scope
 * when omitted). Exported for the review-consumer tests.
 */
export function readLogicalResponseRouting(
  envelope: Envelope,
): LogicalResponseRouting | null {
  const raw = (envelope.payload as Record<string, unknown> | undefined)
    ?.response_routing;
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
 * cortex#503 — first non-empty line of the prose-fallback presentation,
 * capped at 1000 chars, for the `dispatch.task.completed` `result_summary`
 * dashboard label. The FULL prose rides `chat_response`; this is only the
 * scannable one-line label. Returns `undefined` for empty/whitespace prose
 * so the completed builder omits `result_summary` rather than emitting an
 * empty string.
 */
function firstLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) return line.slice(0, 1000);
  }
  return undefined;
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
      // principals see WHICH deny path fired (`unknown_principal`,
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
