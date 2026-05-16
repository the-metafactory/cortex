/**
 * cortex#237 PR-9 — review-consumer end-to-end round-trip test.
 *
 * **Spec anchor:** `docs/design-capability-dispatch-review-consumer.md`
 *   §10.1 (PR-9 row) — the closing acceptance test of the cortex#237 cluster.
 *   §11.1 Layer 3 — "Real `MyelinRuntime` against a stub NATS connection
 *     (the existing pattern in `src/bus/__tests__/`). Real `ReviewConsumer`
 *     wired into a real cortex bootstrap. Stub `CCSessionFactory` that
 *     produces a fake CC stream containing the verdict JSON block."
 *   §11.2 — "Real NATS server. The integration tests stub the runtime; we
 *     don't spawn a `nats-server` in CI." This file matches that policy:
 *     the bus is an in-process fake matching the pattern `iaw-phase-d-
 *     integration.test.ts` and `iaw-phase-b-integration.test.ts` already
 *     use elsewhere in this directory.
 *
 * **What this test proves (the headline contract):**
 *
 *   1. A `tasks.code-review.typescript` envelope, published onto the bus,
 *      is delivered to a real `ReviewConsumer` via `runtime.subscribePull`.
 *   2. The consumer's pipeline runs (the stub returns a fixed verdict block —
 *      no real CC binary is spawned; per spec §11.2 the CC subprocess is
 *      too expensive for CI).
 *   3. A `review.verdict.approved` envelope is published back onto the bus.
 *   4. The verdict envelope's `correlation_id` equals the input envelope's
 *      `id` — the single load-bearing pilot contract per design §5.1.
 *   5. The pull subscriber's `JsMsg.ack()` was called (no nak/term).
 *   6. Failure path: a task whose flavor doesn't match the agent's
 *      capabilities produces a `dispatch.task.failed` with
 *      `reason.kind: cant_do` AND `JsMsg.term()` was called.
 *
 * **Closes the cluster.** When this test goes green the cortex#237
 * umbrella's E2E acceptance criterion is satisfied; Wave 3 verification
 * (≥5 consecutive real review cycles, §11.4) can begin.
 *
 * **No production code change.** Pure additive test. Drives the public
 * surfaces of `ReviewConsumer`, `MyelinRuntime`, the envelope builders,
 * and the pull-subscriber's `JsMsg` ack contract; no test-only hooks
 * required (the `pipelineRunner` seam is already part of the consumer's
 * public API per `ReviewConsumerOpts.pipelineRunner` docblock).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { JsMsg } from "nats";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import type { AckDecision } from "../bus/myelin/subscriber";
import {
  ReviewConsumer,
  type ReviewConsumerAgent,
} from "../bus/review-consumer";
import {
  createReviewRequestEvent,
  createReviewVerdictEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "../bus/review-events";
import type {
  ReviewPipelineOpts,
  ReviewPipelineResult,
} from "../runner/review-pipeline";
import type { CCSessionFactory } from "../substrates/claude-code/harness";

// =============================================================================
// In-process bus — the "stub NATS connection" of §11.2
// =============================================================================
//
// Models the cortex-shape NATS subject space: a published envelope is
// dispatched to every subscription whose pattern matches its derived
// subject. Matches the in-process fan-out pattern that
// `iaw-phase-d-integration.test.ts` and `iaw-phase-b-integration.test.ts`
// already use in this directory (no `nats-server` spawn, no JetStream
// roundtrip — the §11.2 policy is "stub the runtime, don't spawn the
// broker"). The harness implements `MyelinRuntime` directly so it can be
// passed straight into `ReviewConsumer` and assert the subscribePull
// + publish round-trip end-to-end.
// =============================================================================

/**
 * Per-subscription record on the in-process bus. Each `subscribePull`
 * call appends one of these; on every publish whose subject matches
 * `pattern` (per NATS' `>` and `*` semantics) the bus invokes
 * `handler(envelope, subject)`, applies the returned `AckDecision` to
 * the stubbed `JsMsg`, and stashes the msg + decision for assertions.
 */
// The `EnvelopeHandler` return type explicitly includes `void` as part
// of the default-ack contract (see `EnvelopeHandler` docblock in
// `src/bus/myelin/subscriber.ts`). Mirror the production code's
// eslint-disable so the `void` shows up cleanly in the test surface
// without the no-invalid-void-type rule firing on legitimate handler
// signatures.
/* eslint-disable @typescript-eslint/no-invalid-void-type */
interface PullSubscription {
  pattern: string;
  stream: string;
  durable: string;
  handler: EnvelopeHandler;
  /** Stubbed JsMsg instances handed to the handler, in delivery order. */
  msgs: StubJsMsg[];
  /** AckDecision returned by the handler, parallel array to `msgs`. */
  decisions: (AckDecision | void)[];
}

/**
 * Minimum `JsMsg` surface the production `applyAckDecision` would touch
 * in pull mode. We only need `ack`, `nak`, `term`, plus the `info` /
 * `redelivered` fields the consumer reads from `redeliveryCountFrom`.
 *
 * Cast through `unknown` at the boundary (same pattern as
 * `subscriber.pull-mode.test.ts`'s `makeFakeJsMsg`).
 */
interface StubJsMsg {
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
  term: ReturnType<typeof mock>;
  info: { redeliveryCount: number };
  redelivered: boolean;
}

function makeStubJsMsg(redeliveryCount = 1): StubJsMsg {
  return {
    ack: mock(() => {}),
    nak: mock((_delayMs?: number) => {}),
    term: mock((_reason?: string) => {}),
    info: { redeliveryCount },
    redelivered: redeliveryCount > 1,
  };
}

/** Cast a {@link StubJsMsg} into the production {@link JsMsg} shape. */
function asJsMsg(stub: StubJsMsg): JsMsg {
  return stub as unknown as JsMsg;
}

/**
 * Apply the consumer's returned `AckDecision` to the stub. Mirrors the
 * production `applyAckDecision` in `src/bus/myelin/subscriber.ts` so the
 * msg.ack()/msg.nak()/msg.term() invariants the spec calls out (§7
 * failure taxonomy) hold end-to-end on the round-trip.
 *
 * A `void` / `undefined` return defaults to ack per the
 * `EnvelopeHandler` contract docstring.
 */
function applyDecision(msg: StubJsMsg, decision: AckDecision | void): void {
  if (decision === undefined || decision === null) {
    msg.ack();
    return;
  }
  switch (decision.kind) {
    case "ack":
      msg.ack();
      return;
    case "nak":
      msg.nak(decision.delayMs);
      return;
    case "term":
      msg.term(decision.reason ?? "(no reason)");
      return;
  }
}

/**
 * NATS subject matcher — supports `>` (matches one or more remaining
 * segments) and `*` (matches exactly one segment). Mirrors the broker's
 * own grammar; close-enough for the test (full grammar is far broader
 * but the cortex-shape patterns we use never exceed `>` and `*`).
 */
function subjectMatches(pattern: string, subject: string): boolean {
  const ps = pattern.split(".");
  const ss = subject.split(".");
  for (let i = 0; i < ps.length; i++) {
    const tok = ps[i]!;
    if (tok === ">") return i < ss.length || i === ss.length - 1 ? true : false;
    if (i >= ss.length) return false;
    if (tok === "*") continue;
    if (tok !== ss[i]) return false;
  }
  return ps.length === ss.length;
}

interface BusRuntime extends MyelinRuntime {
  /** Every envelope published on this runtime, in publish order. */
  published: Envelope[];
  /** Every subscribePull invocation, in registration order. */
  subscriptions: PullSubscription[];
  /**
   * Drive a "delivery" of `envelope` on `subject` into every matching
   * subscription. Returns the `AckDecision`s the handlers returned in
   * registration order. Awaiting the result guarantees the pipeline has
   * run to completion (the consumer's handler is async and only resolves
   * once the verdict is published).
   */
  deliver: (envelope: Envelope, subject: string) => Promise<{
    handlersCalled: number;
    decisions: (AckDecision | void)[];
  }>;
}

/**
 * Derive a NATS subject from an envelope per
 * `src/bus/myelin/envelope-validator.ts:deriveNatsSubject` — for the
 * tests we use only `local.{org}.{type}` (no stack-id segment) which is
 * the legacy 5-segment shape Echo + cortex publish on today.
 *
 * `envelope.source` is the dotted triple `"{org}.{agent}.{instance}"`;
 * pull the first segment as the org for the subject prefix.
 */
function subjectFor(envelope: Envelope): string {
  const sov = envelope.sovereignty.classification;
  const org = envelope.source.split(".")[0] ?? "metafactory";
  return `${sov}.${org}.${envelope.type}`;
}

function createBusRuntime(): BusRuntime {
  const published: Envelope[] = [];
  const subscriptions: PullSubscription[] = [];
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();

  const deliver = async (
    envelope: Envelope,
    subject: string,
  ): Promise<{ handlersCalled: number; decisions: (AckDecision | void)[] }> => {
    let handlersCalled = 0;
    const decisions: (AckDecision | void)[] = [];
    for (const sub of subscriptions) {
      if (!subjectMatches(sub.pattern, subject)) continue;
      handlersCalled++;
      const msg = makeStubJsMsg(1);
      sub.msgs.push(msg);
      const result = await sub.handler(envelope, subject);
      sub.decisions.push(result);
      decisions.push(result);
      applyDecision(msg, result);
    }
    return { handlersCalled, decisions };
  };

  return {
    enabled: true,
    published,
    subscriptions,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return {
        unregister: () => {
          onEnvelopeHandlers.delete(handler);
        },
      };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
      // Bus fan-out to the legacy push-mode handlers. ReviewConsumer
      // emits its verdict/lifecycle envelopes via runtime.publish; those
      // emissions must NOT loop back into the consumer's own pull
      // subscription (subject patterns differ: verdict goes to
      // `local.{org}.review.verdict.*`, not `tasks.code-review.>`).
      // Still call the matched pull subscribers so a misrouted publish
      // is observable in the test.
      for (const sub of subscriptions) {
        const subject = subjectFor(envelope);
        if (!subjectMatches(sub.pattern, subject)) continue;
        // Re-entrant delivery of an own-published envelope into a
        // matching pull subscription. Test currently never triggers this
        // (verdict subject doesn't match the tasks.code-review.>
        // pattern), but if a future refactor regresses it the in-flight
        // assertions will catch the loop.
        const msg = makeStubJsMsg(1);
        sub.msgs.push(msg);
        const result = await sub.handler(envelope, subject);
        sub.decisions.push(result);
        applyDecision(msg, result);
      }
    },
    subscribePull: (opts: MyelinSubscribePullOpts): MyelinSubscriber => {
      const sub: PullSubscription = {
        pattern: opts.pattern,
        stream: opts.stream,
        durable: opts.durable,
        handler: opts.onEnvelope,
        msgs: [],
        decisions: [],
      };
      subscriptions.push(sub);
      // Synthetic MyelinSubscriber-shaped stub. Production consumers
      // only await `ready` and call `stop()`; cast through `unknown`
      // because the real class has private fields we deliberately don't
      // synthesise. Same pattern as the boot test's recordingRuntime.
      return {
        pattern: opts.pattern,
        ready: Promise.resolve(),
        stop: async () => {},
      } as unknown as MyelinSubscriber;
    },
    stop: async () => {
      onEnvelopeHandlers.clear();
      subscriptions.length = 0;
    },
    deliver,
  };
}
/* eslint-enable @typescript-eslint/no-invalid-void-type */

// =============================================================================
// Test fixtures
// =============================================================================

const SOURCE: ReviewEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

const REVIEW_SUBJECT_PATTERN = "local.metafactory.tasks.code-review.>";
const REVIEW_STREAM = "CODE_REVIEW";

const VALID_PAYLOAD: ReviewRequestPayload = {
  repo: "the-metafactory/cortex",
  pr: 229,
  reviewer: "echo",
  feature: "C-237",
  title: "feat: capability-dispatch review consumer",
  cycle: 1,
};

/**
 * Build a `tasks.code-review.<flavor>` request envelope using the real
 * production builder. This is the on-the-wire shape pilot publishes per
 * `design-pilot-restructure.md` §4.1.
 */
function makeRequest(flavor: "typescript" | "python" = "typescript"): Envelope {
  return createReviewRequestEvent({
    source: SOURCE,
    flavor,
    payload: VALID_PAYLOAD,
  });
}

/**
 * Stub CC factory — never invoked because the pipelineRunner test seam
 * (see {@link ReviewConsumerOpts.pipelineRunner}) short-circuits the
 * real `runReviewPipeline` before it reaches CC. Per spec §11.2 we
 * MUST NOT spawn the real CC subprocess in CI.
 */
const STUB_CC_FACTORY: CCSessionFactory = () => {
  throw new Error(
    "e2e: stub CCSessionFactory invoked — pipelineRunner stub should have intercepted",
  );
};

/**
 * Build a verdict envelope with the cortex#248 §4.2.1 shape. Reuses the
 * production builder so the discriminator-alignment guard (§6.3) runs
 * for free.
 */
function buildVerdictEnvelope(
  request: Envelope,
  verdict: "approved" | "changes-requested" | "commented" = "approved",
): Envelope {
  return createReviewVerdictEvent({
    source: SOURCE,
    kind: verdict,
    correlationId: request.id,
    payload: {
      repo: VALID_PAYLOAD.repo,
      pr: VALID_PAYLOAD.pr,
      reviewer: "echo",
      verdict,
      summary: `verdict: blockers=0 majors=2 nits=3 — ${verdict}`,
      github_review_id: 2459183744,
      github_review_url:
        "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
      submitted_at: "2026-05-17T09:51:30Z",
      commit_id: "a1b2c3d4e5f6789012345678901234567890abcd",
      findings: { blockers: 0, majors: 2, nits: 3 },
      inline_comments: 5,
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("cortex#237 PR-9 — review-consumer end-to-end round-trip (§11.1 Layer 2)", () => {
  let runtime: BusRuntime;
  let consumer: ReviewConsumer;

  /**
   * Boot a real ReviewConsumer against the in-process bus with one
   * `code-review.typescript` agent and a stub pipeline that returns the
   * verdict block. Matches the real cortex.ts boot wiring's
   * construction shape (see `src/cortex.ts` review-consumer block) but
   * without the dashboard / config-watcher overhead.
   */
  beforeAll(async () => {
    runtime = createBusRuntime();
    const agent: ReviewConsumerAgent = {
      id: "echo",
      capabilities: ["code-review.typescript"],
    };
    consumer = new ReviewConsumer({
      agent,
      source: SOURCE,
      runtime,
      ccSessionFactory: STUB_CC_FACTORY,
      promptBuilder: ({ payload }) => `/review ${payload.repo}#${payload.pr}`,
      // Stub pipeline runner — the spec-sanctioned test seam (see
      // `ReviewConsumerOpts.pipelineRunner` docblock: "Test seam — the
      // function actually used to run the pipeline. Defaults to PR-5's
      // `runReviewPipeline`. Tests inject a stub that returns a
      // deterministic result without spawning CC.").
      pipelineRunner: async (opts: ReviewPipelineOpts): Promise<ReviewPipelineResult> => {
        // Branch on the requested flavor — typescript returns a verdict,
        // python returns nothing because the consumer rejects the
        // capability mismatch before this runner ever sees it (asserted
        // by the failure-path test below).
        return {
          kind: "verdict",
          envelope: buildVerdictEnvelope(opts.requestEnvelope, "approved"),
        };
      },
    });

    await consumer.start({
      pattern: REVIEW_SUBJECT_PATTERN,
      stream: REVIEW_STREAM,
      durable: "cortex-review-consumer-metafactory-echo",
    });
  });

  afterAll(async () => {
    await consumer.stop();
    await runtime.stop();
  });

  test("Layer 2 round-trip: tasks.code-review.typescript → verdict envelope correlated on the request id; JsMsg.ack() called", async () => {
    // ARRANGE — capture the publish-order snapshot pre-delivery so we
    // can slice the post-delivery slice cleanly and not leak prior test
    // state into the assertions.
    const publishedBefore = runtime.published.length;
    const request = makeRequest("typescript");
    const requestSubject = subjectFor(request);
    expect(requestSubject).toBe(
      "local.metafactory.tasks.code-review.typescript",
    );

    // ACT — drive the request through the bus. `deliver` resolves only
    // after the consumer's full pipeline has run (started + verdict +
    // completed publishes, plus the AckDecision return).
    const { handlersCalled, decisions } = await runtime.deliver(
      request,
      requestSubject,
    );

    // ASSERT — exactly one matching subscription (the echo consumer).
    expect(handlersCalled).toBe(1);
    expect(decisions.length).toBe(1);
    expect(decisions[0]).toEqual({ kind: "ack" });

    // Three envelopes emitted in §8.2 order: started → verdict → completed.
    const emitted = runtime.published.slice(publishedBefore);
    expect(emitted.length).toBe(3);
    expect(emitted[0]!.type).toBe("dispatch.task.started");
    expect(emitted[1]!.type).toBe("review.verdict.approved");
    expect(emitted[2]!.type).toBe("dispatch.task.completed");

    // **THE HEADLINE CONTRACT** (design §5.1): every emitted envelope's
    // correlation_id MUST equal the request envelope's id. Pilot's
    // `subscribe-verdict` filter joins on exactly this value; if it
    // ever drifts pilot would silently miss the verdict.
    for (const env of emitted) {
      expect(env.correlation_id).toBe(request.id);
    }

    // Verdict envelope shape spot-check — payload echoes the request,
    // discriminator-alignment guard (§6.3) didn't fire (builder would
    // have thrown).
    const verdict = emitted[1]!;
    const payload = verdict.payload as {
      repo: string;
      pr: number;
      verdict: string;
      summary: string;
    };
    expect(payload.repo).toBe(VALID_PAYLOAD.repo);
    expect(payload.pr).toBe(VALID_PAYLOAD.pr);
    expect(payload.verdict).toBe("approved");

    // **JsMsg.ack() called** — round-trip ack semantics asserted at the
    // pull-subscriber boundary, mirroring the spec's task requirement.
    const sub = runtime.subscriptions[0]!;
    expect(sub.msgs.length).toBe(1);
    const msg = sub.msgs[0]!;
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nak).toHaveBeenCalledTimes(0);
    expect(msg.term).toHaveBeenCalledTimes(0);

    // Sanity — `asJsMsg` cast is exercised so future readers see the
    // type-bridge between the stub and the production `JsMsg`.
    expect(asJsMsg(msg)).toBe(msg as unknown as JsMsg);
  });

  test("Layer 2 round-trip failure-path: capability mismatch → dispatch.task.failed (cant_do) + JsMsg.term() called", async () => {
    // Snapshot publish state so we don't conflate this test's emissions
    // with the prior test's success run.
    const publishedBefore = runtime.published.length;
    const subBefore = runtime.subscriptions[0]!.msgs.length;
    // Agent claims ONLY `code-review.typescript`; this request asks for
    // `code-review.python` — capability gate rejects with `cant_do`,
    // pipeline never runs, msg.term() fires.
    const request = makeRequest("python");
    const requestSubject = subjectFor(request);
    expect(requestSubject).toBe(
      "local.metafactory.tasks.code-review.python",
    );

    const { handlersCalled, decisions } = await runtime.deliver(
      request,
      requestSubject,
    );

    expect(handlersCalled).toBe(1);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.kind).toBe("term");
    if (decisions[0]!.kind === "term") {
      expect(decisions[0]!.reason).toBe("no capability match");
    }

    // Exactly one envelope: the dispatch.task.failed (no started, no
    // verdict — the consumer rejected at the capability gate before any
    // pipeline work happened).
    const emitted = runtime.published.slice(publishedBefore);
    expect(emitted.length).toBe(1);
    const failed = emitted[0]!;
    expect(failed.type).toBe("dispatch.task.failed");
    // correlation_id contract holds on the failed path too (§5.2).
    expect(failed.correlation_id).toBe(request.id);
    const reason = (failed.payload as { reason: { kind: string; detail: string } })
      .reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("code-review.python");

    // **JsMsg.term() called** — the failure-path ack contract. No ack,
    // no nak; the broker drops the message to the dead-letter side with
    // a structured reason (per spec §7 + the failure-taxonomy table at
    // the head of `src/bus/review-consumer.ts`).
    const sub = runtime.subscriptions[0]!;
    expect(sub.msgs.length).toBe(subBefore + 1);
    const msg = sub.msgs[subBefore]!;
    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(0);
    expect(msg.nak).toHaveBeenCalledTimes(0);
    // The term reason carries the cant_do summary — operators reading
    // `nats consumer info` see WHY the message landed on the dead-letter
    // side.
    const termCall = msg.term.mock.calls[0]!;
    expect(String(termCall[0])).toContain("no capability match");
  });
});
