/**
 * cortex#237 PR-5 — tests for `review-pipeline.ts`.
 *
 * Coverage axes (mirror dispatch-listener.test.ts's stub-CC pattern):
 *   1. Happy path — each verdict kind (approved, changes-requested,
 *      commented) produces a `review.verdict.<kind>` envelope with the
 *      right subject suffix + payload + correlation_id (echoes the
 *      request envelope's id, per §5.1).
 *   2. Failure taxonomy (§7) — every reason kind this module emits
 *      (`cant_do`, `not_now`, `wont_do`) has a witness test:
 *        - factory throws → `not_now`
 *        - wait() rejects → `not_now`
 *        - session aborted (timeout) → `not_now`
 *        - non-zero exit with no output → `not_now`
 *        - clean exit with no JSON block → `cant_do`
 *        - JSON block present but malformed → `cant_do`
 *        - JSON block parseable but missing/wrong-typed field → `cant_do`
 *        - JSON block has out-of-enum verdict → `cant_do`
 *        - policyCheck refuses → `wont_do`
 *   3. correlation_id contract — every emitted envelope (verdict and
 *      failed) carries `correlation_id == requestEnvelope.id` (NOT the
 *      cortex-internal task UUID; this is the load-bearing pilot
 *      contract per §5.1).
 *   4. Last-block-wins parsing — if the CC stream contains multiple
 *      ```json fences, the LAST one is the verdict (§4.5).
 *   5. Findings/payload echo — the verdict envelope's payload is the
 *      parsed structured block, with reviewer overridden to the actual
 *      agent id (not the request's advisory reviewer).
 *
 * NO real CC process is ever spawned — all tests inject a fake
 * `CCSessionFactory` that returns a deterministic `wait()` result.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { validateEnvelope } from "../../bus/myelin/envelope-validator";
import {
  createReviewRequestEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
  type ReviewVerdictKind,
} from "../../bus/review-events";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../../substrates/claude-code/harness";
import type { CCSessionResult } from "../cc-session";
import {
  runReviewPipeline,
  type ReviewPipelineOpts,
} from "../review-pipeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: ReviewEventSource = {
  org: "metafactory",
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

function makeRequestEnvelope(): Envelope {
  return createReviewRequestEvent({
    source: SOURCE,
    flavor: "typescript",
    payload: PAYLOAD,
  });
}

function buildVerdictBlock(
  verdict: ReviewVerdictKind,
  overrides: Partial<{
    summary: string;
    github_review_id: number;
    github_review_url: string;
    submitted_at: string;
    commit_id: string;
    findings: { blockers: number; majors: number; nits: number };
    inline_comments: number;
  }> = {},
): string {
  const payload = {
    verdict,
    summary:
      overrides.summary ??
      `verdict: blockers=0 majors=2 nits=3 — recommend: ${verdict}`,
    github_review_id: overrides.github_review_id ?? 2459183744,
    github_review_url:
      overrides.github_review_url ??
      "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
    submitted_at: overrides.submitted_at ?? "2026-05-16T09:51:30Z",
    commit_id: overrides.commit_id ?? "a1b2c3d4e5f6789012345678901234567890abcd",
    findings: overrides.findings ?? { blockers: 0, majors: 2, nits: 3 },
    inline_comments: overrides.inline_comments ?? 5,
  };
  return [
    "I have completed my review. Here's the summary:",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

/**
 * Fake CC session factory — captures opts, then resolves `wait()` with
 * the configured result. Mirrors the pattern in
 * `dispatch-listener.test.ts:fakeFactory` so reviewers see a familiar
 * shape.
 */
function fakeFactory(result: CCSessionResult): {
  factory: CCSessionFactory;
  optsCaptured: Parameters<CCSessionFactory>[0][];
} {
  const optsCaptured: Parameters<CCSessionFactory>[0][] = [];
  const factory: CCSessionFactory = (opts) => {
    optsCaptured.push(opts);
    const session: CCSessionLike = {
      start() {
        return session;
      },
      async wait() {
        return result;
      },
    };
    return session;
  };
  return { factory, optsCaptured };
}

/** Factory that throws synchronously — simulates "claude binary not found". */
function throwingFactory(message: string): CCSessionFactory {
  return () => {
    throw new Error(message);
  };
}

/** Factory whose wait() rejects — simulates a mid-stream substrate crash. */
function rejectingFactory(message: string): CCSessionFactory {
  return () => {
    const session: CCSessionLike = {
      start() {
        return session;
      },
      async wait() {
        throw new Error(message);
      },
    };
    return session;
  };
}

function baseOpts(
  factory: CCSessionFactory,
  overrides: Partial<ReviewPipelineOpts> = {},
): ReviewPipelineOpts {
  return {
    requestEnvelope: makeRequestEnvelope(),
    payload: PAYLOAD,
    agentId: "echo",
    source: SOURCE,
    ccSessionFactory: factory,
    prompt: "/review the-metafactory/cortex#229",
    ...overrides,
  };
}

function successResult(response: string): CCSessionResult {
  return {
    success: true,
    response,
    exitCode: 0,
    durationMs: 1234,
    sessionId: "session-abc",
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runReviewPipeline — happy path", () => {
  test("approved → review.verdict.approved envelope, correlation_id echoes request id", async () => {
    const req = makeRequestEnvelope();
    const { factory, optsCaptured } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline({
      ...baseOpts(factory),
      requestEnvelope: req,
    });

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.approved");
    expect(result.envelope.correlation_id).toBe(req.id);
    expect(result.envelope.source).toBe("metafactory.cortex.local");

    // payload echoes the parsed verdict block; reviewer overridden to agentId
    const payload = result.envelope.payload;
    expect(payload.repo).toBe(PAYLOAD.repo);
    expect(payload.pr).toBe(PAYLOAD.pr);
    expect(payload.reviewer).toBe("echo"); // agentId, not PAYLOAD.reviewer (same value here but contract is agentId)
    expect(payload.verdict).toBe("approved");
    expect(payload.github_review_id).toBe(2459183744);
    expect(payload.findings).toEqual({ blockers: 0, majors: 2, nits: 3 });
    expect(payload.inline_comments).toBe(5);

    // CC was invoked with our prompt
    expect(optsCaptured).toHaveLength(1);
    expect(optsCaptured[0]?.prompt).toBe("/review the-metafactory/cortex#229");

    // Envelope passes schema validation
    expect(validateEnvelope(result.envelope).ok).toBe(true);
  });

  test("changes-requested → review.verdict.changes-requested envelope", async () => {
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("changes-requested")),
    );
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.changes-requested");
    const payload = result.envelope.payload;
    expect(payload.verdict).toBe("changes-requested");
  });

  test("commented → review.verdict.commented envelope", async () => {
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("commented")),
    );
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.commented");
    const payload = result.envelope.payload;
    expect(payload.verdict).toBe("commented");
  });

  test("reviewer field on verdict envelope is the agentId, NOT request payload's advisory reviewer", async () => {
    // request payload says reviewer="echo"; we run as agentId="luna" — verdict should say luna
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline(
      baseOpts(factory, { agentId: "luna" }),
    );
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const payload = result.envelope.payload;
    expect(payload.reviewer).toBe("luna");
  });

  test("multiple JSON blocks in stream → last block is the verdict (§4.5)", async () => {
    // Stream has an earlier exploratory block, then the real verdict
    const stream = [
      "Lens 1 scratch output:",
      "```json",
      JSON.stringify({ verdict: "approved", note: "ignore me" }),
      "```",
      "",
      "Final verdict:",
      buildVerdictBlock("changes-requested"),
    ].join("\n");
    const { factory } = fakeFactory(successResult(stream));
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.changes-requested");
  });
});

// ---------------------------------------------------------------------------
// Failure taxonomy (§7)
// ---------------------------------------------------------------------------

describe("runReviewPipeline — failure taxonomy", () => {
  test("factory throws synchronously → not_now (substrate unavailable)", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      ...baseOpts(throwingFactory("claude binary not found in PATH")),
      requestEnvelope: req,
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.envelope.type).toBe("dispatch.task.failed");
    expect(result.envelope.correlation_id).toBe(req.id);
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string; retry_after_ms?: number };
    expect(reason.kind).toBe("not_now");
    expect(reason.detail).toContain("claude binary not found");
    expect(reason.retry_after_ms).toBe(0);
  });

  test("wait() rejects → not_now (mid-stream substrate crash)", async () => {
    const result = await runReviewPipeline(
      baseOpts(rejectingFactory("EPIPE: broken pipe")),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("not_now");
    expect(reason.detail).toContain("EPIPE");
  });

  test("session aborted (inactivity timeout, §7.6) → not_now", async () => {
    // Canonical timeout signature from cc-session.ts: exitCode 1 + aborted true
    const { factory } = fakeFactory({
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 120_000,
      aborted: true,
      abortReason: "timeout",
    });
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("not_now");
    expect(reason.detail).toContain("timeout");
  });

  test("non-zero exit with no captured response → not_now", async () => {
    const { factory } = fakeFactory({
      success: false,
      response: "",
      exitCode: 137,
      durationMs: 50,
    });
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("not_now");
    expect(reason.detail).toContain("137");
  });

  test("clean exit with no JSON block → cant_do (skill broke contract)", async () => {
    const { factory } = fakeFactory(
      successResult("I reviewed the PR but forgot to emit a verdict block."),
    );
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("did not return parseable verdict block");
  });

  test("malformed JSON inside block → cant_do", async () => {
    const stream = [
      "Result:",
      "```json",
      "{ verdict: 'approved' /* not valid JSON: bare keys, single quotes */ }",
      "```",
    ].join("\n");
    const { factory } = fakeFactory(successResult(stream));
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("malformed");
  });

  test("JSON block valid but missing required field → cant_do", async () => {
    const stream = [
      "```json",
      JSON.stringify({ verdict: "approved", summary: "ok" }), // missing github_review_id etc.
      "```",
    ].join("\n");
    const { factory } = fakeFactory(successResult(stream));
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("cant_do");
  });

  test("JSON block with out-of-enum verdict → cant_do", async () => {
    const stream = [
      "```json",
      JSON.stringify({
        verdict: "request-changes", // wrong — spec is "changes-requested"
        summary: "x",
        github_review_id: 1,
        github_review_url: "https://example.com",
        submitted_at: "2026-05-16T00:00:00Z",
        commit_id: "abc",
        findings: { blockers: 0, majors: 0, nits: 0 },
        inline_comments: 0,
      }),
      "```",
    ].join("\n");
    const { factory } = fakeFactory(successResult(stream));
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("verdict");
  });

  test("policyCheck refuses → wont_do (CC never invoked)", async () => {
    const { factory, optsCaptured } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline(
      baseOpts(factory, {
        policyCheck: () => ({
          refuse: true,
          detail: "sovereignty: classification requires frontier; agent forbids",
        }),
      }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("wont_do");
    expect(reason.detail).toContain("sovereignty");
    // CC was not invoked because policy refused upstream of the substrate
    expect(optsCaptured).toHaveLength(0);
  });

  test("policyCheck returning null is the no-op path (CC invoked normally)", async () => {
    const { factory, optsCaptured } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline(
      baseOpts(factory, { policyCheck: () => null }),
    );
    expect(result.kind).toBe("verdict");
    expect(optsCaptured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// correlation_id contract (§5.1)
// ---------------------------------------------------------------------------

describe("runReviewPipeline — correlation_id contract", () => {
  test("verdict envelope carries correlation_id = requestEnvelope.id", async () => {
    const req = makeRequestEnvelope();
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline({
      ...baseOpts(factory),
      requestEnvelope: req,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.correlation_id).toBe(req.id);
  });

  test("failed envelope (cant_do path) carries correlation_id = requestEnvelope.id", async () => {
    const req = makeRequestEnvelope();
    const { factory } = fakeFactory(
      successResult("no block at all"),
    );
    const result = await runReviewPipeline({
      ...baseOpts(factory),
      requestEnvelope: req,
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.envelope.correlation_id).toBe(req.id);
    // Importantly: NOT equal to the cortex-internal task UUID embedded in payload
    const payload = result.envelope.payload;
    expect(payload.task_id).toBeString();
    expect(payload.task_id).not.toBe(req.id);
  });

  test("failed envelope (not_now path) carries correlation_id = requestEnvelope.id", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      ...baseOpts(throwingFactory("substrate unavailable")),
      requestEnvelope: req,
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.envelope.correlation_id).toBe(req.id);
  });

  test("failed envelope (wont_do path) carries correlation_id = requestEnvelope.id", async () => {
    const req = makeRequestEnvelope();
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline({
      ...baseOpts(factory, {
        policyCheck: () => ({ refuse: true, detail: "policy" }),
      }),
      requestEnvelope: req,
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.envelope.correlation_id).toBe(req.id);
  });

  test("two parallel requests with distinct ids produce envelopes with distinct correlation_ids (no crosstalk)", async () => {
    const reqA = makeRequestEnvelope();
    const reqB = makeRequestEnvelope();
    expect(reqA.id).not.toBe(reqB.id); // sanity

    const { factory: factoryA } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const { factory: factoryB } = fakeFactory(
      successResult(buildVerdictBlock("commented")),
    );

    const [resultA, resultB] = await Promise.all([
      runReviewPipeline({
        ...baseOpts(factoryA),
        requestEnvelope: reqA,
      }),
      runReviewPipeline({
        ...baseOpts(factoryB),
        requestEnvelope: reqB,
      }),
    ]);

    expect(resultA.kind).toBe("verdict");
    expect(resultB.kind).toBe("verdict");
    if (resultA.kind !== "verdict" || resultB.kind !== "verdict") return;
    expect(resultA.envelope.correlation_id).toBe(reqA.id);
    expect(resultB.envelope.correlation_id).toBe(reqB.id);
    expect(resultA.envelope.type).toBe("review.verdict.approved");
    expect(resultB.envelope.type).toBe("review.verdict.commented");
  });
});

// ---------------------------------------------------------------------------
// Envelope schema validation (defence-in-depth)
// ---------------------------------------------------------------------------

describe("runReviewPipeline — schema conformance", () => {
  test("verdict envelope passes vendored myelin schema validation", async () => {
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("changes-requested")),
    );
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const validation = validateEnvelope(result.envelope);
    expect(validation.ok).toBe(true);
  });

  test("failed envelope passes vendored myelin schema validation", async () => {
    const result = await runReviewPipeline(
      baseOpts(throwingFactory("missing binary")),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const validation = validateEnvelope(result.envelope);
    expect(validation.ok).toBe(true);
  });
});
