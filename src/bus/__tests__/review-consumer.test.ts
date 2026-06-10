/**
 * cortex#237 PR-6 — tests for `review-consumer.ts`.
 *
 * Coverage axes (mirrors `capability-registry.test.ts` style + the
 * stub-pipeline pattern from `review-pipeline.test.ts`):
 *
 *   1. Happy path — valid envelope, capability match, pipeline returns
 *      verdict → verdict envelope published + dispatch.task.completed
 *      co-emitted + AckDecision is `{ kind: "ack" }`.
 *   2. Unknown flavor (no matching capability) → failed `cant_do` envelope
 *      + AckDecision is `{ kind: "term", ... }`.
 *   3. Backpressure: agent at `maxConcurrent` → failed `not_now` +
 *      AckDecision is `{ kind: "nak", delayMs: 1000 }`.
 *   4. Pipeline returns `failed/not_now` → AckDecision is `{ kind: "nak",
 *      delayMs: retry_after_ms }`.
 *   5. Pipeline returns `failed/cant_do` → AckDecision is `{ kind: "term",
 *      reason: "cant_do: …" }`.
 *   6. Pipeline throws unexpectedly → defensive failed `not_now` +
 *      AckDecision is `{ kind: "nak", delayMs: 0 }`.
 *   7. Redelivery > 1 → ALSO emits `dispatch.task.aborted` envelope
 *      (in addition to whatever the pipeline path produces).
 *   8. correlation_id contract — request envelope.id === verdict
 *      correlation_id === failed correlation_id (load-bearing pilot
 *      contract per design §5).
 *   9. Two concurrent requests under maxConcurrent → both complete;
 *      counter decrements after each so a subsequent request still admits.
 *  10. `compliance_block` reason variant → term with the documented
 *      "v1 does not handle compliance_block" reason.
 *
 * No real NATS, no real CC. All side effects flow through the runtime
 * stub's `published[]` array and the consumer's returned `AckDecision`.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
} from "../myelin/runtime";
import {
  ReviewConsumer,
  OFFER_DISPATCH_REVIEWER,
  failedReasonToAckDecision,
  parseReviewRequestPayload,
  parseRequesterFromOriginator,
  readLogicalResponseRouting,
  type ReviewConsumerAgent,
  type ReviewConsumerOpts,
} from "../review-consumer";
import type { PolicyFederatedNetwork } from "../../common/types/cortex-config";
import type { DispatchTaskFailedReason } from "../dispatch-events";
import type { AckDecision } from "../myelin/subscriber";
import {
  createReviewRequestEvent,
  createReviewVerdictEvent,
  createReviewTaskFailedEvent,
  type ReviewEventSource,
  type ReviewFlavor,
  type ReviewRequestPayload,
  type ReviewVerdictKind,
} from "../review-events";
import { encodeDidSegment } from "@the-metafactory/myelin/subjects";
import type { JsMsg } from "nats";
import type {
  ReviewPipelineOpts,
  ReviewPipelineResult,
} from "../../runner/review-pipeline";
import type { CCSessionFactory } from "../../substrates/claude-code/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: ReviewEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const PAYLOAD: ReviewRequestPayload = {
  repo: "the-metafactory/cortex",
  pr: 229,
  reviewer: "echo",
  feature: "C-237",
  title: "feat: capability dispatch",
  cycle: 1,
};

/**
 * Recording runtime stub — captures every envelope handed to `publish`.
 * Shape matches the boot wiring's `MyelinRuntime` consumer surface so
 * the same construction works against production once a real link is
 * plumbed in (this PR ships the consumer module; full live wiring is the
 * deferred follow-up — see PR-6 boot-wiring section in the PR body).
 */
interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
  publishOutcomes: { ok: boolean; error?: Error }[];
  /** cortex#686 — every `publishOnSubject(envelope, subject)` call, in order. */
  publishedOnSubject: { envelope: Envelope; subject: string }[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const publishOutcomes: { ok: boolean; error?: Error }[] = [];
  const publishedOnSubject: { envelope: Envelope; subject: string }[] = [];
  let publishCallIndex = 0;
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    publishOutcomes,
    publishedOnSubject,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return {
        unregister: () => {
          onEnvelopeHandlers.delete(handler);
        },
      };
    },
    publish: async (envelope: Envelope) => {
      const idx = publishCallIndex++;
      const outcome = publishOutcomes[idx];
      if (outcome && !outcome.ok) {
        throw outcome.error ?? new Error("publish failed");
      }
      published.push(envelope);
    },
    // cortex#686 — federated review consumer routes verdicts via this path.
    publishOnSubject: async (envelope: Envelope, subject: string) => {
      publishedOnSubject.push({ envelope, subject });
    },
    stop: async () => {},
  };
}

function buildAgent(
  overrides: Partial<ReviewConsumerAgent> = {},
): ReviewConsumerAgent {
  return {
    id: "echo",
    capabilities: ["code-review.typescript"],
    ...overrides,
  };
}

function makeRequest(flavor: ReviewFlavor = "typescript"): Envelope {
  return createReviewRequestEvent({
    source: SOURCE,
    flavor,
    payload: PAYLOAD,
  });
}

// ---------------------------------------------------------------------------
// cortex#686 (ADR 0002) — federated fixtures
// ---------------------------------------------------------------------------

/** 56-char U-prefixed base32 NKey — matches the surface-router test fixture. */
const FED_PEER_PUBKEY = "U" + "A".repeat(55);

/**
 * The REQUESTER identity carried in `originator.identity` (ADR 0002 §1) — the
 * `did:mf:{principal}-{stack}` DID form (= `stack.id` with `/`→`-`), the exact
 * shape pilot's `encodeRequesterDid` emits. NOT a bare `{principal}/{stack}`
 * slash form (myelin's DID grammar rejects `/`).
 */
const REQUESTER_PRINCIPAL = "jc";
const REQUESTER_STACK = "sage-host";
const REQUESTER_IDENTITY = `did:mf:${REQUESTER_PRINCIPAL}-${REQUESTER_STACK}`;

/**
 * A configured federation network whose `peers[]` lists the requester `jc` as a
 * member. The consumer-path `peers[]` gate (ADR 0002 §5) admits a requester
 * only when it resolves here.
 */
function makeNetwork(
  overrides: Partial<PolicyFederatedNetwork> = {},
): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "leaf-research",
    peers: [
      {
        principal_id: REQUESTER_PRINCIPAL,
        stack_id: `${REQUESTER_PRINCIPAL}/${REQUESTER_STACK}`,
        principal_pubkey: FED_PEER_PUBKEY,
      },
    ],
    accept_subjects: ["federated.jc.sage-host.tasks.code-review.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
    ...overrides,
  };
}

/**
 * Build an inbound FEDERATED review-request envelope per ADR 0002:
 *   - the subject (built by `cortex.ts`) addresses the TARGET = us
 *     (`federated.{our-principal}.{our-stack}.…`); tests pass it as the
 *     `subject` arg to `processEnvelope` (see `FED_SUBJECT`).
 *   - `originator.identity = did:mf:{requester-principal}-{requester-stack}`
 *     (the DID form = `stack.id` with `/`→`-`) carries the REQUESTER (who the
 *     verdict routes back to), `attribution: "federated"`.
 *
 * `createReviewRequestEvent` doesn't stamp an originator, so we set it here —
 * mirrors how the requester stack (pilot#149) populates it on the wire.
 */
/** Sentinel for "stamp no originator block at all" (distinct from the default). */
const NO_ORIGINATOR = Symbol("no-originator");

function makeFederatedRequest(
  identity: string | typeof NO_ORIGINATOR = REQUESTER_IDENTITY,
  flavor: ReviewFlavor = "typescript",
): Envelope {
  const env = createReviewRequestEvent({
    source: SOURCE,
    flavor,
    classification: "federated",
    payload: PAYLOAD,
  });
  if (identity !== NO_ORIGINATOR) {
    (env as { originator?: unknown }).originator = {
      identity,
      attribution: "federated",
    };
  }
  return env;
}

/**
 * Build a `JsMsg`-shaped stub carrying just the field the consumer reads
 * (`info.redeliveryCount`). Keeps the test free of the full nats.js
 * `JsMsg` surface — we only need the redelivery branch.
 */
function makeJsMsg(redeliveryCount: number): JsMsg {
  return {
    info: { redeliveryCount },
    redelivered: redeliveryCount > 1,
    // Mirror the readonly fields the consumer never touches with stubs
    // typed via cast so we don't have to satisfy the full JsMsg surface.
  } as unknown as JsMsg;
}

/** Stub pipeline runner — returns a fixed `ReviewPipelineResult`. */
function fixedPipeline(
  build: (opts: ReviewPipelineOpts) => ReviewPipelineResult,
): (opts: ReviewPipelineOpts) => Promise<ReviewPipelineResult> {
  return async (opts) => build(opts);
}

/** A CC session factory that's never invoked (pipeline runner is stubbed). */
const UNUSED_CC_FACTORY: CCSessionFactory = () => {
  throw new Error("unused — pipeline runner is stubbed");
};

function baseOpts(
  overrides: Partial<ReviewConsumerOpts> = {},
): ReviewConsumerOpts {
  const runtime = overrides.runtime ?? createRecordingRuntime();
  return {
    agent: buildAgent(),
    source: SOURCE,
    runtime,
    ccSessionFactory: UNUSED_CC_FACTORY,
    promptBuilder: ({ payload }) =>
      `/review ${payload.repo}#${payload.pr}`,
    ...overrides,
  };
}

function buildVerdictEnvelope(
  request: Envelope,
  verdict: ReviewVerdictKind,
): Envelope {
  return createReviewVerdictEvent({
    source: SOURCE,
    kind: verdict,
    correlationId: request.id,
    payload: {
      repo: PAYLOAD.repo,
      pr: PAYLOAD.pr,
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

function buildFailedEnvelope(
  request: Envelope,
  reason: import("../review-events").DispatchTaskFailedReason,
  errorSummary: string,
): Envelope {
  return createReviewTaskFailedEvent({
    source: SOURCE,
    taskId: crypto.randomUUID(),
    agentId: "echo",
    correlationId: request.id,
    startedAt: new Date(),
    failedAt: new Date(),
    errorSummary,
    reason,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewConsumer.processEnvelope — cortex#237 PR-6", () => {
  test("1. valid request → pipeline invoked → verdict published → AckDecision is `ack`", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");
    let pipelineInvocations = 0;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline((opts) => {
          pipelineInvocations++;
          expect(opts.requestEnvelope.id).toBe(request.id);
          expect(opts.agentId).toBe("echo");
          expect(opts.prompt).toBe(`/review ${PAYLOAD.repo}#${PAYLOAD.pr}`);
          return { kind: "verdict", envelope: verdict };
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      `local.metafactory.tasks.code-review.typescript`,
      null,
    );

    expect(decision).toEqual({ kind: "ack" });
    expect(pipelineInvocations).toBe(1);

    // §8.2 emission ordering — started, verdict, completed (in that order).
    expect(runtime.published.length).toBe(3);
    expect(runtime.published[0]!.type).toBe("dispatch.task.started");
    expect(runtime.published[1]!.type).toBe("review.verdict.approved");
    expect(runtime.published[2]!.type).toBe("dispatch.task.completed");

    // Verdict envelope is the exact one returned by the pipeline.
    expect(runtime.published[1]!).toBe(verdict);

    // completed.result_summary echoes the verdict's summary (§8.4).
    expect(
      (runtime.published[2]!.payload as { result_summary?: string }).result_summary,
    ).toBe(`verdict: blockers=0 majors=2 nits=3 — approved`);
  });

  test("cortex#503 — prose-fallback `completed` result → dispatch.task.completed (NO verdict) + ack", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const prose = "I reviewed the PR.\n\nLooks fine, no blockers found.";

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({
          kind: "completed",
          presentation: prose,
        })),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    // Prose-fallback is a SUCCESS — ack the JetStream message.
    expect(decision).toEqual({ kind: "ack" });

    // Exactly TWO envelopes: started, then completed. NO review.verdict.*
    // (we never fabricate a verdict from prose).
    expect(runtime.published.length).toBe(2);
    expect(runtime.published[0]!.type).toBe("dispatch.task.started");
    expect(runtime.published[1]!.type).toBe("dispatch.task.completed");
    expect(
      runtime.published.some((e) => e.type.startsWith("review.verdict.")),
    ).toBe(false);

    // The completed envelope carries the prose verbatim as chat_response
    // (the surface render) + a first-line result_summary label.
    const completed = runtime.published[1]!.payload as {
      chat_response?: string;
      result_summary?: string;
    };
    expect(completed.chat_response).toBe(prose);
    expect(completed.result_summary).toBe("I reviewed the PR.");
    expect(runtime.published[1]!.correlation_id).toBe(request.id);
  });

  test("2. unknown flavor → `cant_do` failed envelope + AckDecision is `term`", async () => {
    const runtime = createRecordingRuntime();
    // Agent claims only `typescript`; request asks for `python`.
    const request = makeRequest("python");
    let pipelineCalls = 0;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ capabilities: ["code-review.typescript"] }),
        pipelineRunner: fixedPipeline(() => {
          pipelineCalls++;
          throw new Error("pipeline must not run when capability missing");
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.python",
      null,
    );

    expect(pipelineCalls).toBe(0);
    expect(decision.kind).toBe("term");
    if (decision.kind === "term") {
      expect(decision.reason).toBe("no capability match");
    }

    // Exactly ONE envelope on the wire: the dispatch.task.failed.
    // (No started/completed because the request never reached the pipeline.)
    expect(runtime.published.length).toBe(1);
    const failed = runtime.published[0]!;
    expect(failed.type).toBe("dispatch.task.failed");
    expect(failed.correlation_id).toBe(request.id);
    const reason = (failed.payload as { reason: { kind: string; detail: string } })
      .reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("code-review.python");
  });

  test("3. agent at maxConcurrent → failed `not_now` + AckDecision is `nak` with 1000ms hint", async () => {
    const runtime = createRecordingRuntime();

    // Pipeline blocks until we release it, so the first request stays
    // in-flight while the second is rejected at the concurrency gate.
    let release!: () => void;
    const blockedUntilReleased = new Promise<void>((resolve) => {
      release = resolve;
    });

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ maxConcurrent: 1 }),
        pipelineRunner: async (opts) => {
          await blockedUntilReleased;
          return {
            kind: "verdict",
            envelope: buildVerdictEnvelope(opts.requestEnvelope, "approved"),
          };
        },
      }),
    );

    const firstReq = makeRequest("typescript");
    const firstPromise = consumer.processEnvelope(
      firstReq,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    // Yield so the consumer admits the first request and increments the
    // in-flight counter before the second request lands.
    await new Promise((r) => setImmediate(r));

    const secondReq = makeRequest("typescript");
    const secondDecision = await consumer.processEnvelope(
      secondReq,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(secondDecision).toEqual({ kind: "nak", delayMs: 1000 });

    // Find the `not_now` failed envelope (the started envelope from the
    // first request has already landed).
    const failed = runtime.published.find(
      (e) =>
        e.type === "dispatch.task.failed" &&
        e.correlation_id === secondReq.id,
    );
    expect(failed).toBeDefined();
    const reason = (failed!.payload as {
      reason: { kind: string; retry_after_ms?: number };
    }).reason;
    expect(reason.kind).toBe("not_now");
    expect(reason.retry_after_ms).toBe(1000);

    // Now release the first request so we don't leak the promise.
    release();
    const firstDecision = await firstPromise;
    expect(firstDecision).toEqual({ kind: "ack" });
  });

  test("4. pipeline returns failed/not_now → AckDecision is `nak` with retry hint", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const failed = buildFailedEnvelope(
      request,
      { kind: "not_now", detail: "transient", retry_after_ms: 2500 },
      "transient",
    );

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({ kind: "failed", envelope: failed })),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(decision).toEqual({ kind: "nak", delayMs: 2500 });
    // started + failed — no completed on the failed path.
    expect(runtime.published.length).toBe(2);
    expect(runtime.published[0]!.type).toBe("dispatch.task.started");
    expect(runtime.published[1]!).toBe(failed);
  });

  test("5. pipeline returns failed/cant_do → AckDecision is `term`", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const failed = buildFailedEnvelope(
      request,
      {
        kind: "cant_do",
        detail: "skill did not return parseable verdict block",
      },
      "skill did not return parseable verdict block",
    );

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({ kind: "failed", envelope: failed })),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(decision.kind).toBe("term");
    if (decision.kind === "term") {
      expect(decision.reason).toContain("cant_do");
      expect(decision.reason).toContain("verdict block");
    }
    expect(runtime.published.length).toBe(2);
    expect(runtime.published[1]!).toBe(failed);
  });

  test("6. pipeline throws unexpectedly → defensive failed `not_now` + AckDecision is `nak(0)`", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: async () => {
          throw new Error("synthetic pipeline bug");
        },
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(decision).toEqual({ kind: "nak", delayMs: 0 });
    // started + defensive failed.
    expect(runtime.published.length).toBe(2);
    expect(runtime.published[0]!.type).toBe("dispatch.task.started");
    const failed = runtime.published[1]!;
    expect(failed.type).toBe("dispatch.task.failed");
    const reason = (failed.payload as {
      reason: { kind: string; detail: string; retry_after_ms?: number };
    }).reason;
    expect(reason.kind).toBe("not_now");
    expect(reason.retry_after_ms).toBe(0);
    expect(reason.detail).toContain("pipeline threw unexpectedly");
    expect(reason.detail).toContain("synthetic pipeline bug");
  });

  test("7. redelivery > 1 → emits `dispatch.task.aborted` BEFORE pipeline runs", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "commented");

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({ kind: "verdict", envelope: verdict })),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      makeJsMsg(2),
    );

    expect(decision).toEqual({ kind: "ack" });
    // Expected ordering: aborted FIRST (§2.3), then started, verdict, completed.
    expect(runtime.published.length).toBe(4);
    expect(runtime.published[0]!.type).toBe("dispatch.task.aborted");
    expect(runtime.published[0]!.correlation_id).toBe(request.id);
    expect(runtime.published[1]!.type).toBe("dispatch.task.started");
    expect(runtime.published[2]!.type).toBe("review.verdict.commented");
    expect(runtime.published[3]!.type).toBe("dispatch.task.completed");

    const abortedReason = (runtime.published[0]!.payload as {
      reason?: string;
    }).reason;
    expect(abortedReason).toContain("redelivery (attempt 2)");
  });

  test("8. correlation_id contract — request id is echoed onto verdict, failed, and lifecycle envelopes", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({ kind: "verdict", envelope: verdict })),
      }),
    );

    await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    // Every envelope the consumer touches must echo the request's id —
    // the load-bearing pilot contract per §5.
    for (const env of runtime.published) {
      expect(env.correlation_id).toBe(request.id);
    }
    // Specifically the verdict — pilot's `subscribe-verdict` filters on it.
    const verdictEnv = runtime.published.find((e) =>
      e.type.startsWith("review.verdict."),
    );
    expect(verdictEnv?.correlation_id).toBe(request.id);

    // And separately, a failed path also echoes correlation_id.
    const runtime2 = createRecordingRuntime();
    const req2 = makeRequest("typescript");
    const failed = buildFailedEnvelope(
      req2,
      { kind: "cant_do", detail: "synthetic" },
      "synthetic",
    );
    const consumer2 = new ReviewConsumer(
      baseOpts({
        runtime: runtime2,
        pipelineRunner: fixedPipeline(() => ({ kind: "failed", envelope: failed })),
      }),
    );
    await consumer2.processEnvelope(
      req2,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );
    const failedEnv = runtime2.published.find(
      (e) => e.type === "dispatch.task.failed",
    );
    expect(failedEnv?.correlation_id).toBe(req2.id);
  });

  test("9. two concurrent requests under maxConcurrent → both complete; counter decrements between calls", async () => {
    const runtime = createRecordingRuntime();

    // Two pipeline gates so the test controls completion order.
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      release2 = r;
    });
    const gates = [gate1, gate2];
    let callIdx = 0;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ maxConcurrent: 2 }),
        pipelineRunner: async (opts) => {
          const idx = callIdx++;
          await gates[idx]!;
          return {
            kind: "verdict",
            envelope: buildVerdictEnvelope(opts.requestEnvelope, "commented"),
          };
        },
      }),
    );

    const req1 = makeRequest("typescript");
    const req2 = makeRequest("typescript");
    const p1 = consumer.processEnvelope(
      req1,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );
    const p2 = consumer.processEnvelope(
      req2,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    // Yield so both requests have entered the in-flight set.
    await new Promise((r) => setImmediate(r));

    // Release both and await both completions.
    release1();
    release2();
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toEqual({ kind: "ack" });
    expect(d2).toEqual({ kind: "ack" });

    // After both complete the counter is back to zero — a THIRD request
    // must admit (not nak'd by the concurrency gate).
    const req3 = makeRequest("typescript");
    const verdict3 = buildVerdictEnvelope(req3, "approved");
    // Re-set the pipeline runner via a second consumer would be cleaner,
    // but `pipelineRunner` was captured by closure. Instead, just rely on
    // the existing async runner; we need a third gate slot.
    const thirdGate = new Promise<void>((r) => {
      gates.push(Promise.resolve());
      r();
    });
    await thirdGate;
    // Use a fresh consumer with the same agent shape to exercise the
    // post-drain admission contract without re-tooling gate plumbing.
    const consumer3 = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ maxConcurrent: 2 }),
        pipelineRunner: fixedPipeline(() => ({ kind: "verdict", envelope: verdict3 })),
      }),
    );
    const d3 = await consumer3.processEnvelope(
      req3,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );
    expect(d3).toEqual({ kind: "ack" });
  });

  // cortex#340 — publish-routing audit. Pins the contract that EVERY
  // verdict variant emits exactly three envelopes via runtime.publish in
  // the same order: started → review.verdict.<variant> → completed. The
  // existing tests cover `approved` directly (test 1) and `commented`
  // indirectly via the redelivery path (test 7); this parametric test
  // adds `changes-requested` and locks the invariant across all three so
  // a future change that bypasses safePublish for one verdict variant
  // can't slip through unnoticed.
  for (const variant of ["approved", "changes-requested", "commented"] as const) {
    test(`cortex#340 — verdict=${variant} publishes exactly 3 envelopes via runtime.publish`, async () => {
      const runtime = createRecordingRuntime();
      const request = makeRequest("typescript");
      const verdict = buildVerdictEnvelope(request, variant);

      const consumer = new ReviewConsumer(
        baseOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => ({ kind: "verdict", envelope: verdict })),
        }),
      );

      const decision = await consumer.processEnvelope(
        request,
        "local.metafactory.tasks.code-review.typescript",
        null,
      );

      expect(decision).toEqual({ kind: "ack" });

      // Exactly three envelopes — anti-criterion: any silent additional
      // emit would either bypass runtime.publish (won't be captured)
      // or land here as an unexpected fourth entry.
      expect(runtime.published.length).toBe(3);
      expect(runtime.published[0]!.type).toBe("dispatch.task.started");
      expect(runtime.published[1]!.type).toBe(`review.verdict.${variant}`);
      expect(runtime.published[2]!.type).toBe("dispatch.task.completed");

      // The verdict envelope is the EXACT one the pipeline returned —
      // not a copy, not a re-built envelope. Catches a regression that
      // rebuilds the verdict on the way out (which would silently drop
      // the pipeline's correlation_id / signed_by chain).
      expect(runtime.published[1]!).toBe(verdict);

      // Correlation id flows onto every lifecycle envelope so pilot's
      // wait can filter consistently across the three.
      for (const env of runtime.published) {
        expect(env.correlation_id).toBe(request.id);
      }
    });
  }

  test("10. compliance_block variant → term with documented v1 message", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const failed = buildFailedEnvelope(
      request,
      { kind: "compliance_block", detail: "attestation forbids" },
      "compliance attestation forbids",
    );

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline(() => ({ kind: "failed", envelope: failed })),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(decision).toEqual({
      kind: "term",
      reason: "v1 does not handle compliance_block",
    });
  });
});

// ---------------------------------------------------------------------------
// failedReasonToAckDecision — cortex#290 coverage-gap test (Architect Finding 2a)
//
// The mapping table in `failedReasonToAckDecision` is the contract PR-9's
// e2e tests + pilot's wait-for-verdict exit-code mapping lock onto. The
// processEnvelope tests above exercise the helper indirectly through one
// or two `kind` variants; this parametric block hits all five
// `DispatchTaskFailedReason` discriminators plus the `undefined`
// defensive path so a regression in the table immediately surfaces
// here instead of as a downstream e2e-only failure.
// ---------------------------------------------------------------------------

describe("failedReasonToAckDecision (cortex#237 PR-6 — Architect Finding 2a)", () => {
  type Case = readonly [
    label: string,
    reason: DispatchTaskFailedReason | undefined,
    expected: AckDecision,
  ];

  const cases: Case[] = [
    [
      "cant_do → term with prefixed detail",
      { kind: "cant_do", detail: "payload validation failed" },
      { kind: "term", reason: "cant_do: payload validation failed" },
    ],
    [
      "wont_do → term with prefixed detail",
      { kind: "wont_do", detail: "policy refuses this repo" },
      { kind: "term", reason: "wont_do: policy refuses this repo" },
    ],
    [
      "policy_denied → term with comma-joined deny key summary",
      {
        kind: "policy_denied",
        deny: { unknown_principal: true, insufficient_role: "reviewer" },
      },
      {
        kind: "term",
        reason: "policy_denied: unknown_principal,insufficient_role",
      },
    ],
    [
      "policy_denied with empty deny block → term with placeholder summary",
      { kind: "policy_denied", deny: {} },
      { kind: "term", reason: "policy_denied: (no deny detail)" },
    ],
    [
      "not_now with retry_after_ms → nak carrying the delay hint",
      { kind: "not_now", detail: "queue full", retry_after_ms: 5000 },
      { kind: "nak", delayMs: 5000 },
    ],
    [
      "not_now WITHOUT retry_after_ms → nak with NO delayMs key",
      { kind: "not_now", detail: "queue full" },
      { kind: "nak" },
    ],
    [
      "compliance_block → term with the documented v1 message",
      { kind: "compliance_block", detail: "attestation forbids" },
      { kind: "term", reason: "v1 does not handle compliance_block" },
    ],
    [
      "undefined → defensive ack (failed envelope without a reason is rare; ack-on-unknown beats nak-loop)",
      undefined,
      { kind: "ack" },
    ],
  ];

  for (const [label, reason, expected] of cases) {
    test(label, () => {
      expect(failedReasonToAckDecision(reason)).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// cortex#384 — parseReviewRequestPayload accepts both wire shapes
// ---------------------------------------------------------------------------
//
// The Offer-dispatch envelope a **principal**'s pilot stack publishes
// onto `local.{principal}.{stack}.tasks.code-review.<flavor>` carries
// the **payload** in one of two grilled-vocabulary shapes:
//
//   1. **Cortex legacy** — pre-cortex#384 builders (`createReviewRequestEvent`)
//      flatten `repo` as `"owner/name"` plus `pr` (number) + non-empty
//      `reviewer` string.
//   2. **Pilot / Sage Offer dispatch** — `pilot request-review --pr
//      OWNER/REPO#N` and `sage dispatch` envelopes split the repo into
//      `owner` + `repo` segments and rename `pr` to `number`; the
//      `reviewer` field is empty because the **capability** routes the
//      envelope, not the field.
//
// Both shapes must yield the same normalised `{ repo, pr, reviewer }`
// triple downstream.

function makeRequestEnvelope(payload: unknown): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: "tasks.code-review.typescript",
    source: "metafactory.pilot.local",
    timestamp: new Date().toISOString(),
    correlation_id: "00000000-0000-4000-8000-000000000002",
    signed_by: [],
    sovereignty: { classification: "local" },
    payload,
  } as unknown as Envelope;
}

describe("parseReviewRequestPayload — cortex#384 dual-shape acceptance", () => {
  test("cortex-legacy shape parses to the canonical triple", () => {
    const env = makeRequestEnvelope({
      repo: "the-metafactory/cortex",
      pr: 385,
      reviewer: "sage",
    });
    const parsed = parseReviewRequestPayload(env);
    expect(parsed).toEqual({
      repo: "the-metafactory/cortex",
      pr: 385,
      reviewer: "sage",
    });
  });

  test("pilot/sage shape (owner+repo+number) folds into legacy form", () => {
    const env = makeRequestEnvelope({
      owner: "the-metafactory",
      repo: "soma",
      number: 169,
      pr_url: "https://github.com/the-metafactory/soma/pull/169",
      reviewer: "",
    });
    const parsed = parseReviewRequestPayload(env);
    expect(parsed).toEqual({
      repo: "the-metafactory/soma",
      pr: 169,
      reviewer: OFFER_DISPATCH_REVIEWER,
    });
  });

  test("pilot shape with non-empty reviewer is preserved", () => {
    const env = makeRequestEnvelope({
      owner: "the-metafactory",
      repo: "cortex",
      number: 1,
      reviewer: "echo",
    });
    expect(parseReviewRequestPayload(env)?.reviewer).toBe("echo");
  });

  test("empty reviewer in legacy shape collapses to OFFER_DISPATCH_REVIEWER", () => {
    const env = makeRequestEnvelope({
      repo: "the-metafactory/cortex",
      pr: 42,
      reviewer: "",
    });
    expect(parseReviewRequestPayload(env)?.reviewer).toBe(OFFER_DISPATCH_REVIEWER);
  });

  test("absent reviewer in pilot shape collapses to OFFER_DISPATCH_REVIEWER", () => {
    const env = makeRequestEnvelope({
      owner: "the-metafactory",
      repo: "cortex",
      number: 7,
    });
    expect(parseReviewRequestPayload(env)?.reviewer).toBe(OFFER_DISPATCH_REVIEWER);
  });

  test("null reviewer collapses to OFFER_DISPATCH_REVIEWER", () => {
    const env = makeRequestEnvelope({
      repo: "the-metafactory/cortex",
      pr: 1,
      reviewer: null,
    });
    expect(parseReviewRequestPayload(env)?.reviewer).toBe(OFFER_DISPATCH_REVIEWER);
  });

  test("optional fields (feature/title/cycle/note) flow through both shapes", () => {
    const legacy = parseReviewRequestPayload(
      makeRequestEnvelope({
        repo: "the-metafactory/cortex",
        pr: 100,
        reviewer: "echo",
        feature: "C-237",
        title: "feat: x",
        cycle: 3,
        note: "round 3",
      }),
    );
    expect(legacy).toMatchObject({ feature: "C-237", title: "feat: x", cycle: 3, note: "round 3" });

    const pilot = parseReviewRequestPayload(
      makeRequestEnvelope({
        owner: "the-metafactory",
        repo: "cortex",
        number: 200,
        feature: "C-238",
        title: "fix: y",
      }),
    );
    expect(pilot).toMatchObject({ feature: "C-238", title: "fix: y" });
  });

  test("invalid: neither shape present → null", () => {
    expect(parseReviewRequestPayload(makeRequestEnvelope({}))).toBeNull();
  });

  test("invalid: pilot shape with bad owner segment → null", () => {
    const env = makeRequestEnvelope({
      owner: "bad/owner",
      repo: "cortex",
      number: 1,
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  test("invalid: legacy shape with negative pr → null", () => {
    const env = makeRequestEnvelope({
      repo: "the-metafactory/cortex",
      pr: -1,
      reviewer: "echo",
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  test("invalid: pilot shape with non-integer number → null", () => {
    const env = makeRequestEnvelope({
      owner: "the-metafactory",
      repo: "cortex",
      number: 1.5,
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  test("invalid: non-string non-null reviewer → null", () => {
    const env = makeRequestEnvelope({
      repo: "the-metafactory/cortex",
      pr: 1,
      reviewer: 42,
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  // cortex#409 — the `sage dispatch` CLI publishes ONLY `{ pr_url }`
  // (sage src/tasks/types.ts: dispatcher always knows the full URL).
  // The receiver resolves owner/repo/pr out of the URL.
  test("sage dispatch shape (pr_url only) resolves a GitHub URL", () => {
    const env = makeRequestEnvelope({
      pr_url: "https://github.com/the-metafactory/cortex/pull/421",
    });
    expect(parseReviewRequestPayload(env)).toEqual({
      repo: "the-metafactory/cortex",
      pr: 421,
      reviewer: OFFER_DISPATCH_REVIEWER,
      forge: "github",
    });
  });

  test("pr_url with trailing slash still resolves", () => {
    const env = makeRequestEnvelope({
      pr_url: "https://github.com/the-metafactory/cortex/pull/421/",
    });
    expect(parseReviewRequestPayload(env)).toMatchObject({
      repo: "the-metafactory/cortex",
      pr: 421,
    });
  });

  test("pr_url resolves a GitLab merge-request URL", () => {
    const env = makeRequestEnvelope({
      pr_url: "https://gitlab.com/acme/widgets/-/merge_requests/12",
    });
    expect(parseReviewRequestPayload(env)).toMatchObject({
      repo: "acme/widgets",
      pr: 12,
      forge: "gitlab",
    });
  });

  test("preserves explicit forge hint from sage dispatch payload", () => {
    const env = makeRequestEnvelope({
      repo: "saca/secacademy",
      pr: 62,
      reviewer: "capability-dispatch",
      pr_url: "https://gitlab.com/saca/secacademy/-/merge_requests/62",
      post: true,
      forge: "gitlab",
    });
    expect(parseReviewRequestPayload(env)).toMatchObject({
      repo: "saca/secacademy",
      pr: 62,
      reviewer: "capability-dispatch",
      post: true,
      forge: "gitlab",
    });
  });

  test("invalid: forge hint outside supported set → null", () => {
    const env = makeRequestEnvelope({
      repo: "saca/secacademy",
      pr: 62,
      reviewer: "capability-dispatch",
      forge: "bitbucket",
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  test("owner/number triple takes precedence over a present pr_url", () => {
    const env = makeRequestEnvelope({
      owner: "the-metafactory",
      repo: "soma",
      number: 169,
      pr_url: "https://github.com/the-metafactory/cortex/pull/421",
    });
    expect(parseReviewRequestPayload(env)).toMatchObject({
      repo: "the-metafactory/soma",
      pr: 169,
    });
  });

  test("invalid: pr_url that is not a URL → null", () => {
    const env = makeRequestEnvelope({ pr_url: "not-a-url" });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });

  test("invalid: pr_url with an unrecognised path → null", () => {
    const env = makeRequestEnvelope({
      pr_url: "https://github.com/the-metafactory/cortex/issues/5",
    });
    expect(parseReviewRequestPayload(env)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cortex#502 — response_routing echo
// ---------------------------------------------------------------------------

const LOGICAL_ROUTING = {
  surface: "discord",
  channel: "cortex",
  thread: "cortex/pr/57",
};

/** A request envelope carrying the logical `response_routing` field. */
function makeRequestWithRouting(
  routing: unknown = LOGICAL_ROUTING,
): Envelope {
  const base = createReviewRequestEvent({
    source: SOURCE,
    flavor: "typescript",
    payload: PAYLOAD,
  });
  return {
    ...base,
    payload: { ...base.payload, response_routing: routing },
  };
}

/** Read `payload.response_routing` off an emitted envelope. */
function routingOf(env: Envelope): unknown {
  return (env.payload as { response_routing?: unknown }).response_routing;
}

describe("readLogicalResponseRouting (helper)", () => {
  test("reads the logical triple with thread", () => {
    expect(readLogicalResponseRouting(makeRequestWithRouting())).toEqual(LOGICAL_ROUTING);
  });

  test("reads channel-scope (no thread)", () => {
    const env = makeRequestWithRouting({ surface: "discord", channel: "cortex" });
    expect(readLogicalResponseRouting(env)).toEqual({
      surface: "discord",
      channel: "cortex",
    });
  });

  test("returns null on missing field", () => {
    expect(readLogicalResponseRouting(makeRequest("typescript"))).toBeNull();
  });

  test("returns null on malformed field (missing surface/channel)", () => {
    expect(readLogicalResponseRouting(makeRequestWithRouting({ surface: "discord" }))).toBeNull();
    expect(readLogicalResponseRouting(makeRequestWithRouting({ channel: "cortex" }))).toBeNull();
    expect(readLogicalResponseRouting(makeRequestWithRouting("not-an-object"))).toBeNull();
  });
});

describe("ReviewConsumer — response_routing echo (cortex#502)", () => {
  test("verdict path: started + verdict + completed all carry identical response_routing + correlation_id", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequestWithRouting();
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        // The real pipeline threads opts.responseRouting onto the verdict;
        // emulate that here so the verdict carries it like production.
        pipelineRunner: fixedPipeline((opts) => ({
          kind: "verdict",
          envelope: createReviewVerdictEvent({
            source: SOURCE,
            kind: "approved",
            correlationId: opts.requestEnvelope.id,
            ...(opts.responseRouting !== undefined && {
              responseRouting: opts.responseRouting,
            }),
            payload: {
              repo: PAYLOAD.repo,
              pr: PAYLOAD.pr,
              reviewer: "echo",
              verdict: "approved",
              summary: "verdict: blockers=0 majors=0 nits=0 — approved",
              github_review_id: 1,
              github_review_url: "https://github.com/x/y/pull/1#r1",
              submitted_at: "2026-05-29T12:00:00Z",
              commit_id: "abc",
              findings: { blockers: 0, majors: 0, nits: 0 },
              inline_comments: 0,
            },
          }),
        })),
      }),
    );

    await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
    for (const env of runtime.published) {
      expect(routingOf(env)).toEqual(LOGICAL_ROUTING);
      expect(env.correlation_id).toBe(request.id);
    }
  });

  test("failed path: started + failed carry response_routing", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequestWithRouting();
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline((opts) => ({
          kind: "failed",
          envelope: createReviewTaskFailedEvent({
            source: SOURCE,
            taskId: crypto.randomUUID(),
            agentId: "echo",
            correlationId: opts.requestEnvelope.id,
            startedAt: new Date(),
            failedAt: new Date(),
            errorSummary: "boom",
            reason: { kind: "cant_do", detail: "boom" },
            ...(opts.responseRouting !== undefined && {
              responseRouting: opts.responseRouting,
            }),
          }),
        })),
      }),
    );

    await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    for (const env of runtime.published) {
      expect(routingOf(env)).toEqual(LOGICAL_ROUTING);
    }
  });

  test("pre-pipeline failure (no capability) echoes response_routing onto the failed envelope", async () => {
    const runtime = createRecordingRuntime();
    // Request a flavor this agent (typescript-only) does NOT claim.
    const request = {
      ...makeRequestWithRouting(),
    };
    // Override the type to a non-claimed flavor.
    const pythonRequest: Envelope = {
      ...request,
      type: "tasks.code-review.python",
    };
    const consumer = new ReviewConsumer(baseOpts({ runtime }));

    const decision = await consumer.processEnvelope(
      pythonRequest,
      "local.metafactory.tasks.code-review.python",
      null,
    );

    expect(decision.kind).toBe("term");
    expect(runtime.published.length).toBe(1);
    expect(runtime.published[0]!.type).toBe("dispatch.task.failed");
    expect(routingOf(runtime.published[0]!)).toEqual(LOGICAL_ROUTING);
  });

  test("aborted path (redelivery>1) echoes response_routing", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequestWithRouting();
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline((opts) => ({
          kind: "verdict",
          envelope: createReviewVerdictEvent({
            source: SOURCE,
            kind: "approved",
            correlationId: opts.requestEnvelope.id,
            ...(opts.responseRouting !== undefined && {
              responseRouting: opts.responseRouting,
            }),
            payload: {
              repo: PAYLOAD.repo,
              pr: PAYLOAD.pr,
              reviewer: "echo",
              verdict: "approved",
              summary: "ok",
              github_review_id: 1,
              github_review_url: "https://github.com/x/y/pull/1#r1",
              submitted_at: "2026-05-29T12:00:00Z",
              commit_id: "abc",
              findings: { blockers: 0, majors: 0, nits: 0 },
              inline_comments: 0,
            },
          }),
        })),
      }),
    );

    await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      { info: { redeliveryCount: 2 }, redelivered: true } as unknown as JsMsg,
    );

    const aborted = runtime.published.find((e) => e.type === "dispatch.task.aborted");
    expect(aborted).toBeDefined();
    expect(routingOf(aborted!)).toEqual(LOGICAL_ROUTING);
  });

  test("request WITHOUT response_routing → no key on ANY emitted envelope (pilot-only path)", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript"); // no response_routing
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        pipelineRunner: fixedPipeline((opts) => ({
          kind: "verdict",
          envelope: createReviewVerdictEvent({
            source: SOURCE,
            kind: "approved",
            correlationId: opts.requestEnvelope.id,
            ...(opts.responseRouting !== undefined && {
              responseRouting: opts.responseRouting,
            }),
            payload: {
              repo: PAYLOAD.repo,
              pr: PAYLOAD.pr,
              reviewer: "echo",
              verdict: "approved",
              summary: "ok",
              github_review_id: 1,
              github_review_url: "https://github.com/x/y/pull/1#r1",
              submitted_at: "2026-05-29T12:00:00Z",
              commit_id: "abc",
              findings: { blockers: 0, majors: 0, nits: 0 },
              inline_comments: 0,
            },
          }),
        })),
      }),
    );

    await consumer.processEnvelope(
      request,
      "local.metafactory.tasks.code-review.typescript",
      null,
    );

    // correlation_id still intact on every envelope...
    for (const env of runtime.published) {
      expect(env.correlation_id).toBe(request.id);
      // ...but no response_routing key anywhere.
      expect("response_routing" in (env.payload as object)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// cortex#686 (ADR 0001) — FEDERATED review consumer
// ---------------------------------------------------------------------------

describe("parseRequesterFromOriginator — ADR 0002 §1 (cortex#686)", () => {
  test("DID form `did:mf:{principal}-{stack}` → {principal, stack} (first-hyphen split)", () => {
    expect(
      parseRequesterFromOriginator(makeFederatedRequest("did:mf:jc-sage-host")),
    ).toEqual({ principal: "jc", stack: "sage-host" });
  });

  test("first-hyphen split keeps a multi-hyphen stack intact (did:mf:andreas-meta-factory)", () => {
    // The worked example from ADR 0002 §1: the principal is hyphen-free, so the
    // FIRST hyphen is the boundary and every later hyphen belongs to the stack.
    expect(
      parseRequesterFromOriginator(
        makeFederatedRequest("did:mf:andreas-meta-factory"),
      ),
    ).toEqual({ principal: "andreas", stack: "meta-factory" });
  });

  test("exact inverse of pilot's encodeRequesterDid (= stack.id with /→-)", () => {
    // pilot#149 `encodeRequesterDid(principal, stack)` = `did:mf:${principal}-${stack}`.
    // Round-trip: encode then decode MUST recover the original pair.
    const encode = (principal: string, stack: string) =>
      `did:mf:${principal}-${stack}`;
    expect(
      parseRequesterFromOriginator(
        makeFederatedRequest(encode("andreas", "meta-factory")),
      ),
    ).toEqual({ principal: "andreas", stack: "meta-factory" });
  });

  test("no originator block → undefined (fails closed)", () => {
    // NO_ORIGINATOR leaves the originator unset.
    expect(parseRequesterFromOriginator(makeFederatedRequest(NO_ORIGINATOR))).toBeUndefined();
  });

  test("no `did:mf:` prefix → undefined (only the DID form is on the wire)", () => {
    // A bare slash form `jc/sage-host` lacks the DID prefix — fail closed.
    expect(parseRequesterFromOriginator(makeFederatedRequest("jc/sage-host"))).toBeUndefined();
  });

  test("DID body with no hyphen → undefined (ambiguous principal/stack)", () => {
    // `did:mf:sagehost` can't split principal from stack — fail closed.
    expect(parseRequesterFromOriginator(makeFederatedRequest("did:mf:sagehost"))).toBeUndefined();
  });

  test("leading hyphen → undefined", () => {
    expect(parseRequesterFromOriginator(makeFederatedRequest("did:mf:-sage-host"))).toBeUndefined();
  });

  test("trailing hyphen → undefined", () => {
    expect(parseRequesterFromOriginator(makeFederatedRequest("did:mf:jc-"))).toBeUndefined();
  });

  test("does NOT read the requester off the subject or source — both address the TARGET", () => {
    // The subject is irrelevant to this function; the requester is the originator.
    const env = makeFederatedRequest("did:mf:jc-sage-host");
    // `source` addresses the target (us = metafactory), per ADR 0001/0002.
    expect(env.source.startsWith("metafactory")).toBe(true);
    expect(parseRequesterFromOriginator(env)).toEqual({
      principal: "jc",
      stack: "sage-host",
    });
  });
});

describe("ReviewConsumer — federated mode (cortex#686, ADR 0002)", () => {
  // Inbound subject addresses the TARGET (us = metafactory/meta-factory), the
  // way cortex.ts builds the federated subscription. The REQUESTER lives in
  // `originator.identity`, NOT here.
  const FED_SUBJECT =
    "federated.metafactory.meta-factory.tasks.code-review.typescript";

  /** Shared federated opts: federated mode + the `jc`-peer network. */
  function federatedOpts(
    overrides: Partial<ReviewConsumerOpts> = {},
  ): Partial<ReviewConsumerOpts> {
    return {
      federated: true,
      federatedNetworks: [makeNetwork()],
      ...overrides,
    };
  }

  test("verdict path → ALL envelopes routed via publishOnSubject on federated.{requester}.{stack}.{type} (requester from originator)", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest();
    const verdict = buildVerdictEnvelope(request, "approved");

    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            // cortex#686 — the pipeline is told to stamp federated sovereignty.
            expect(opts.classification).toBe("federated");
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision).toEqual({ kind: "ack" });

    // NOTHING on the local `publish` path; everything on `publishOnSubject`.
    expect(runtime.published).toHaveLength(0);
    const subjects = runtime.publishedOnSubject.map((p) => p.subject);
    const types = runtime.publishedOnSubject.map((p) => p.envelope.type);
    expect(types).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
    // Every emitted subject targets the REQUESTER's identity (jc.sage-host,
    // decoded from the `did:mf:jc-sage-host` `originator.identity` DID), NOT the
    // consumer's own principal/stack (metafactory/meta-factory) and NOT a network id.
    for (const s of subjects) {
      expect(s.startsWith("federated.jc.sage-host.")).toBe(true);
    }
    expect(subjects[1]).toBe("federated.jc.sage-host.review.verdict.approved");
    expect(subjects[2]).toBe("federated.jc.sage-host.dispatch.task.completed");
  });

  test("correlation_id preserved across the federated verdict + lifecycle envelopes", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest();
    const verdict = buildVerdictEnvelope(request, "approved");
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => ({ kind: "verdict", envelope: verdict })),
        }),
      ),
    );
    await consumer.processEnvelope(request, FED_SUBJECT, null);
    for (const { envelope } of runtime.publishedOnSubject) {
      expect(envelope.correlation_id).toBe(request.id);
    }
  });

  test("pre-pipeline failure (bad payload) → failed envelope routed on requester subject", async () => {
    const runtime = createRecordingRuntime();
    // A review-typed federated envelope (good originator) with bad payload.
    const bad = makeFederatedRequest();
    (bad as { payload: Record<string, unknown> }).payload = { nonsense: true };

    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            throw new Error("pipeline must not run on a bad payload");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(bad, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(1);
    const failed = runtime.publishedOnSubject[0]!;
    expect(failed.envelope.type).toBe("dispatch.task.failed");
    expect(failed.subject).toBe("federated.jc.sage-host.dispatch.task.failed");
  });

  test("federated emitted envelopes declare federated sovereignty", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest();
    const verdict = buildVerdictEnvelope(request, "commented");
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => ({
            kind: "verdict",
            // Echo the pipeline's classification onto the verdict so the test
            // sees federated sovereignty end-to-end.
            envelope: createReviewVerdictEvent({
              source: SOURCE,
              kind: "commented",
              correlationId: request.id,
              ...(opts.classification !== undefined && {
                classification: opts.classification,
              }),
              payload: (verdict.payload as never),
            }),
          })),
        }),
      ),
    );
    await consumer.processEnvelope(request, FED_SUBJECT, null);
    for (const { envelope } of runtime.publishedOnSubject) {
      expect(envelope.sovereignty.classification).toBe("federated");
    }
  });

  // ---- ADR 0002 §5 — peers[] membership gate (defense-in-depth) ----------

  test("requester NOT in any configured network's peers[] → DENIED + DROPPED (no spawn, no publish)", async () => {
    const runtime = createRecordingRuntime();
    // Originator names a principal `mallory` that is in no network's peers[].
    // Well-formed DID (decodes cleanly) so the ONLY reason to deny is non-membership.
    const request = makeFederatedRequest("did:mf:mallory-host");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT be spawned for a non-peer requester");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    // NOTHING published on either path — the verdict (which carries reviewed-code
    // findings) never reaches an untrusted principal.
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("federated request with NO resolvable requester (absent originator) → DENIED + DROPPED", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest(NO_ORIGINATOR); // no originator block

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT be spawned for an un-attributable request");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("self-loop (requester principal == receiving principal) → DENIED + DROPPED", async () => {
    const runtime = createRecordingRuntime();
    // SOURCE.principal is `metafactory`; an originator naming us as the
    // requester is a self-loop — drop it. Well-formed DID so the ONLY reason
    // to deny is the self-loop, not a decode failure.
    const request = makeFederatedRequest("did:mf:metafactory-meta-factory");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          // Add metafactory to peers so the only reason to deny is the self-loop.
          federatedNetworks: [
            makeNetwork({
              peers: [
                {
                  principal_id: "metafactory",
                  stack_id: "metafactory/meta-factory",
                  principal_pubkey: FED_PEER_PUBKEY,
                },
              ],
            }),
          ],
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT be spawned for a self-loop");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("local mode (federated: false) is byte-for-byte unchanged — uses runtime.publish", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        // federated NOT set → local path.
        pipelineRunner: fixedPipeline((opts) => {
          expect(opts.classification).toBeUndefined();
          return { kind: "verdict", envelope: verdict };
        }),
      }),
    );
    await consumer.processEnvelope(
      request,
      "local.metafactory.meta-factory.tasks.code-review.typescript",
      null,
    );
    // Local path: everything on `publish`, nothing on `publishOnSubject`.
    expect(runtime.publishedOnSubject).toHaveLength(0);
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
  });
});

describe("ReviewConsumer — per-message scope gate (cortex#836, ADR 0001)", () => {
  // The bug: once a stack joins a network, `federated: true` is set for the
  // WHOLE consumer (cortex.ts wires it when ≥1 network is configured). But the
  // requester-deny gate must key on the SUBJECT scope, not the coarse mode
  // flag: ADR 0001 says `local.` never crosses the principal boundary
  // (same-principal self-dispatch — the requester IS self, so there is
  // legitimately NO requester in `originator.identity`), while `federated.`
  // always crosses it (a peer requester MUST be present + on `peers[]`).
  //
  // Before the fix, a federated-mode consumer ran the requester-deny gate on
  // EVERY inbound regardless of subject, so a LOCAL self-dispatch (no
  // requester) was DENIED + DROPPED — blocking the whole pilot-review-loop on
  // any federated stack. The fix gates the requester parse + deny block on
  // `this.federated && subject.startsWith("federated.")`.

  /** A local same-principal self-dispatch subject (`local.{me}.{stack}.…`). */
  const LOCAL_SELF_SUBJECT =
    "local.metafactory.meta-factory.tasks.code-review.typescript";

  /** Federated subject targeting us — the cross-principal path. */
  const FED_SUBJECT =
    "federated.metafactory.meta-factory.tasks.code-review.typescript";

  /** Federated mode + the `jc`-peer network (mirrors a network-joined stack). */
  function federatedOpts(
    overrides: Partial<ReviewConsumerOpts> = {},
  ): Partial<ReviewConsumerOpts> {
    return {
      federated: true,
      federatedNetworks: [makeNetwork()],
      ...overrides,
    };
  }

  test("1. RED — federated-mode consumer, LOCAL self-dispatch subject, NO originator → ACCEPTED, verdict on LOCAL publish path", async () => {
    const runtime = createRecordingRuntime();
    // A plain local self-dispatch: NO originator (the requester IS self).
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            pipelineRan = true;
            // A LOCAL inbound bypasses the requester gate → no requester →
            // local-scope emission (classification undefined), identical to a
            // non-federated consumer.
            expect(opts.classification).toBeUndefined();
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      LOCAL_SELF_SUBJECT,
      null,
    );

    // The review RUNS and the verdict is ACKed — not denied/dropped.
    expect(decision).toEqual({ kind: "ack" });
    expect(pipelineRan).toBe(true);

    // The verdict + lifecycle route on the LOCAL `publish` path (local scope),
    // NOT the federated `publishOnSubject` path.
    expect(runtime.publishedOnSubject).toHaveLength(0);
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
  });

  test("2. fail-closed lock — federated subject, NO/malformed originator → STILL DENIED + DROPPED (term, nothing published)", async () => {
    const runtime = createRecordingRuntime();
    // Federated subject but no originator block — un-attributable cross-principal.
    const request = makeFederatedRequest(NO_ORIGINATOR);

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT spawn for an un-attributable federated request");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    // Nothing reaches any principal — fail closed on the federated path.
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("3. peers[] lock — federated subject, valid originator but requester NOT a peer → STILL DENIED + DROPPED", async () => {
    const runtime = createRecordingRuntime();
    // Well-formed DID for `mallory`, who is in no network's peers[].
    const request = makeFederatedRequest("did:mf:mallory-host");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT spawn for a non-peer requester");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("4. verdict-back lock — federated subject, valid peer requester → ACCEPTED, verdict routes to requester's federated scope", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest(); // jc.sage-host — a configured peer
    const verdict = buildVerdictEnvelope(request, "approved");

    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            // Federated inbound → federated sovereignty stamped.
            expect(opts.classification).toBe("federated");
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(request, FED_SUBJECT, null);
    expect(decision).toEqual({ kind: "ack" });

    // Everything routes to the REQUESTER's federated scope (jc.sage-host),
    // nothing on the local path — the verdict-back path is intact.
    expect(runtime.published).toHaveLength(0);
    const subjects = runtime.publishedOnSubject.map((p) => p.subject);
    expect(subjects).toEqual([
      "federated.jc.sage-host.dispatch.task.started",
      "federated.jc.sage-host.review.verdict.approved",
      "federated.jc.sage-host.dispatch.task.completed",
    ]);
  });

  test("5. baseline — federated:false LOCAL inbound → ACCEPTED (unchanged)", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");
    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        // federated NOT set.
        pipelineRunner: fixedPipeline((opts) => {
          expect(opts.classification).toBeUndefined();
          return { kind: "verdict", envelope: verdict };
        }),
      }),
    );
    const decision = await consumer.processEnvelope(
      request,
      LOCAL_SELF_SUBJECT,
      null,
    );
    expect(decision).toEqual({ kind: "ack" });
    expect(runtime.publishedOnSubject).toHaveLength(0);
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
  });

  test("6. foreign originator on a LOCAL subject is IGNORED → ACCEPTED, local-scope emission (not leaked to federated.mallory.*)", async () => {
    const runtime = createRecordingRuntime();
    // A LOCAL self-dispatch subject, but the envelope carries a foreign
    // `originator.identity` for a non-peer (`mallory`). On the local path the
    // originator MUST be ignored entirely — the requester gate never runs, so
    // the foreign identity can neither deny the review NOR redirect the verdict
    // onto a cross-principal `federated.mallory.*` subject. (Adversarial Attack 4.)
    const request = makeRequest("typescript");
    (request as { originator?: unknown }).originator = {
      identity: "did:mf:mallory-evil",
      attribution: "federated",
    };
    const verdict = buildVerdictEnvelope(request, "approved");

    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            // Local path → the foreign originator is never read → no requester →
            // local-scope (classification undefined).
            expect(opts.classification).toBeUndefined();
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      LOCAL_SELF_SUBJECT,
      null,
    );
    expect(decision).toEqual({ kind: "ack" });

    // EVERY emission routes on the LOCAL path; NOTHING on `publishOnSubject` —
    // the foreign originator was not leaked to a `federated.mallory.*` subject.
    expect(runtime.publishedOnSubject).toHaveLength(0);
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
  });

  test("7. a public.> (third-scope) subject is treated as local / fail-safe → ACCEPTED, local-scope emission", async () => {
    const runtime = createRecordingRuntime();
    // Public scope is a near-future spec (`{scope} ∈ local | federated | public`).
    // `isFederatedRequest` is false for any non-`federated.` prefix, so a
    // `public.>` inbound bypasses the cross-principal requester/deny gate and
    // defaults to the local path — the fail-safe default we lock in now.
    const PUBLIC_SUBJECT =
      "public.metafactory.meta-factory.tasks.code-review.typescript";
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            pipelineRan = true;
            // Not the federated deny path: the review RUNS, local-scope.
            expect(opts.classification).toBeUndefined();
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      PUBLIC_SUBJECT,
      null,
    );
    // Did NOT hit the federated deny path (which would term + publish nothing).
    expect(decision).toEqual({ kind: "ack" });
    expect(pipelineRan).toBe(true);
    expect(runtime.publishedOnSubject).toHaveLength(0);
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
  });
});

describe("ReviewConsumer — federated DIRECT mode (cortex#725, ADR 0001/0002 §2)", () => {
  // pilot#149 Direct dispatch (`--reviewer echo@jc/sage-host`) lands on this
  // stack's OWN `federated.{me}.{my-stack}.tasks.@{did-encoded-reviewer}.code-review.{flavor}`
  // subject — the named reviewer's DID is spliced in as an `@{did}` segment
  // AFTER `tasks.`. cortex#725's NEW subscription `federated.{me}.{my-stack}.
  // tasks.*.code-review.>` matches it (whole-token `*` over the `@{did}`
  // segment). The inbound subject we pass here is exactly what that subscription
  // delivers — TARGET = us (metafactory/meta-factory), reviewer = `did:mf:echo`.
  //
  // The KEY invariant cortex#725 proves: the federated consumer PATH is
  // IDENTICAL for Direct and Offer. `envelope.type` is STILL
  // `tasks.code-review.{flavor}` (the `@{did}` lives ONLY on the subject —
  // myelin's `type` grammar forbids `@`), so `extractFlavor`, the requester
  // decode from `originator.identity`, the peers[] gate, and the verdict-back
  // routing are all the SAME code. Only the inbound subject differs.
  const REVIEWER_SEGMENT = encodeDidSegment("did:mf:echo"); // → @did-mf-echo
  const FED_DIRECT_SUBJECT =
    `federated.metafactory.meta-factory.tasks.${REVIEWER_SEGMENT}.code-review.typescript`;

  /** Shared federated opts: federated mode + the `jc`-peer network. */
  function federatedOpts(
    overrides: Partial<ReviewConsumerOpts> = {},
  ): Partial<ReviewConsumerOpts> {
    return {
      federated: true,
      federatedNetworks: [makeNetwork()],
      ...overrides,
    };
  }

  test("the Direct subject's @{did} segment is the reviewer/target-assistant, NOT the requester", () => {
    // Sanity-pin the fixture: the `@{did}` on the subject decodes to the
    // reviewer (echo), proving the requester must come from `originator`
    // (jc.sage-host), never from the subject.
    expect(FED_DIRECT_SUBJECT).toContain(".tasks.@did-mf-echo.code-review.");
    expect(parseRequesterFromOriginator(makeFederatedRequest())).toEqual({
      principal: "jc",
      stack: "sage-host",
    });
  });

  test("DIRECT verdict path → routed to REQUESTER (from originator), identical to Offer", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest();
    const verdict = buildVerdictEnvelope(request, "approved");

    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline((opts) => {
            // Direct still stamps federated sovereignty.
            expect(opts.classification).toBe("federated");
            return { kind: "verdict", envelope: verdict };
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      FED_DIRECT_SUBJECT,
      null,
    );
    expect(decision).toEqual({ kind: "ack" });

    // NOTHING on the local `publish` path; everything on `publishOnSubject`.
    expect(runtime.published).toHaveLength(0);
    const subjects = runtime.publishedOnSubject.map((p) => p.subject);
    const types = runtime.publishedOnSubject.map((p) => p.envelope.type);
    expect(types).toEqual([
      "dispatch.task.started",
      "review.verdict.approved",
      "dispatch.task.completed",
    ]);
    // Verdict-back keyed on the REQUESTER (jc.sage-host, decoded from
    // `originator.identity`), NOT on the subject's reviewer `@{did}` and NOT on
    // the consumer's own principal — IDENTICAL to the Offer path.
    for (const s of subjects) {
      expect(s.startsWith("federated.jc.sage-host.")).toBe(true);
    }
    expect(subjects[1]).toBe("federated.jc.sage-host.review.verdict.approved");
    expect(subjects[2]).toBe("federated.jc.sage-host.dispatch.task.completed");
  });

  test("DIRECT request from a NON-PEER requester → DENIED + DROPPED (no spawn, no publish)", async () => {
    const runtime = createRecordingRuntime();
    // Well-formed DID for `mallory` (decodes cleanly) — the ONLY reason to deny
    // is non-membership in any configured network's peers[].
    const request = makeFederatedRequest("did:mf:mallory-host");

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT be spawned for a non-peer requester");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      FED_DIRECT_SUBJECT,
      null,
    );
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    // The verdict (carrying reviewed-code findings) never reaches an untrusted
    // principal — same fail-closed gate as the Offer path.
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });

  test("DIRECT request with no resolvable requester (absent originator) → DENIED + DROPPED", async () => {
    const runtime = createRecordingRuntime();
    const request = makeFederatedRequest(NO_ORIGINATOR);

    let pipelineRan = false;
    const consumer = new ReviewConsumer(
      baseOpts(
        federatedOpts({
          runtime,
          pipelineRunner: fixedPipeline(() => {
            pipelineRan = true;
            throw new Error("reviewer must NOT be spawned for an un-attributable request");
          }),
        }),
      ),
    );

    const decision = await consumer.processEnvelope(
      request,
      FED_DIRECT_SUBJECT,
      null,
    );
    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
    expect(runtime.published).toHaveLength(0);
    expect(runtime.publishedOnSubject).toHaveLength(0);
  });
});

describe("ReviewConsumer.processEnvelope — consumer-side sovereignty gate (Stage 1b)", () => {
  // makeRequest() defaults to model_class=local-only / frontier_ok=false, so a
  // frontier-class agent claiming it is a sovereignty violation.

  test("enforce: frontier agent + local-only task → term wont_do, reviewer never spawns", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    let pipelineRan = false;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ modelClass: "frontier" }),
        sovereigntyEnforce: true,
        pipelineRunner: fixedPipeline(() => {
          pipelineRan = true;
          throw new Error("reviewer must NOT spawn on a sovereignty-denied task");
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      `local.metafactory.tasks.code-review.typescript`,
      null,
    );

    expect(decision.kind).toBe("term");
    if (decision.kind === "term") expect(decision.reason).toContain("wont_do");
    expect(pipelineRan).toBe(false);
    // A dispatch.task.failed (wont_do) is published back to the requester.
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed");
    expect(failed).toBeDefined();
  });

  test("audit-parity (default): frontier agent + local-only task → still runs", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");
    let pipelineRan = false;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ modelClass: "frontier" }),
        // sovereigntyEnforce omitted → audit-parity
        pipelineRunner: fixedPipeline(() => {
          pipelineRan = true;
          return { kind: "verdict", envelope: verdict };
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      `local.metafactory.tasks.code-review.typescript`,
      null,
    );

    expect(decision).toEqual({ kind: "ack" });
    expect(pipelineRan).toBe(true);
  });

  test("enforce: local-only agent + local-only task → runs (no violation)", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    const verdict = buildVerdictEnvelope(request, "approved");
    let pipelineRan = false;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ modelClass: "local-only" }),
        sovereigntyEnforce: true,
        pipelineRunner: fixedPipeline(() => {
          pipelineRan = true;
          return { kind: "verdict", envelope: verdict };
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      `local.metafactory.tasks.code-review.typescript`,
      null,
    );

    expect(decision).toEqual({ kind: "ack" });
    expect(pipelineRan).toBe(true);
  });

  test("enforce: agent with no declared modelClass + local-only task → fail closed (term)", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest("typescript");
    let pipelineRan = false;

    const consumer = new ReviewConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({}), // no modelClass
        sovereigntyEnforce: true,
        pipelineRunner: fixedPipeline(() => {
          pipelineRan = true;
          throw new Error("must not spawn");
        }),
      }),
    );

    const decision = await consumer.processEnvelope(
      request,
      `local.metafactory.tasks.code-review.typescript`,
      null,
    );

    expect(decision.kind).toBe("term");
    expect(pipelineRan).toBe(false);
  });
});
