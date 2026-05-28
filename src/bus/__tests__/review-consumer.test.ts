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
  type ReviewConsumerAgent,
  type ReviewConsumerOpts,
} from "../review-consumer";
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
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const publishOutcomes: { ok: boolean; error?: Error }[] = [];
  let publishCallIndex = 0;
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    publishOutcomes,
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
