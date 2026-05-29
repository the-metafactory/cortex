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
 *        - clean exit with no JSON block → cortex#503 prose-fallback
 *          `{ kind: "completed" }` (NOT `cant_do`; no fabricated verdict)
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
  buildPresentationMarkdown,
  runReviewPipeline,
  type ReviewPipelineOpts,
} from "../review-pipeline";

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

  test("cortex#503 — clean exit with no JSON block → completed prose-fallback (NOT cant_do)", async () => {
    const prose = "I reviewed the PR but answered in prose.\n\nLGTM overall.";
    const { factory } = fakeFactory(successResult(`  ${prose}  \n`));
    const result = await runReviewPipeline(baseOpts(factory));
    // The old hard-fail (cant_do) is gone — the agent completed, in prose.
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // presentation IS the trimmed prose (passthrough, still markdown).
    expect(result.presentation).toBe(prose);
    // No verdict envelope is fabricated; no failed envelope.
    expect(result).not.toHaveProperty("envelope");
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
    // cortex#503 — the no-block path is now a `completed` prose-fallback, so
    // exercise a genuine `cant_do` failure: a present-but-malformed JSON block.
    const malformed = ["```json", "{ not: valid json }", "```"].join("\n");
    const { factory } = fakeFactory(successResult(malformed));
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

// ---------------------------------------------------------------------------
// cortex#361 — `onSessionSpawned` hook (heartbeat wiring seam)
// ---------------------------------------------------------------------------

describe("runReviewPipeline — onSessionSpawned hook", () => {
  test("hook fires on the happy path and the returned handle is stopped", async () => {
    let hookCalled = 0;
    let stopCalled = 0;
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline(
      baseOpts(factory, {
        onSessionSpawned: () => {
          hookCalled += 1;
          return {
            stop: () => {
              stopCalled += 1;
            },
          };
        },
      }),
    );
    expect(result.kind).toBe("verdict");
    expect(hookCalled).toBe(1);
    // The handle's stop() is called from the inner try/finally so it
    // fires whether the verdict parses cleanly or not.
    expect(stopCalled).toBeGreaterThanOrEqual(1);
  });

  test("hook throwing does NOT crash the review", async () => {
    const { factory } = fakeFactory(
      successResult(buildVerdictBlock("approved")),
    );
    const result = await runReviewPipeline(
      baseOpts(factory, {
        onSessionSpawned: () => {
          throw new Error("heartbeat wiring broken");
        },
      }),
    );
    expect(result.kind).toBe("verdict");
  });

  test("hook still gets a stop() call when the session rejects mid-stream", async () => {
    let stopCalled = 0;
    const result = await runReviewPipeline(
      baseOpts(rejectingFactory("nats hiccup"), {
        onSessionSpawned: () => ({
          stop: () => {
            stopCalled += 1;
          },
        }),
      }),
    );
    expect(result.kind).toBe("failed");
    expect(stopCalled).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// cortex#502 — responseRouting threaded onto both terminal envelopes
// ---------------------------------------------------------------------------

describe("runReviewPipeline — responseRouting (cortex#502)", () => {
  const ROUTING = { surface: "discord", channel: "cortex", thread: "cortex/pr/57" };

  test("verdict terminal carries payload.response_routing", async () => {
    const { factory } = fakeFactory(successResult(buildVerdictBlock("approved")));
    const result = await runReviewPipeline({
      ...baseOpts(factory),
      responseRouting: ROUTING,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(
      (result.envelope.payload as { response_routing?: unknown }).response_routing,
    ).toEqual(ROUTING);
    expect(validateEnvelope(result.envelope).ok).toBe(true);
  });

  test("failed terminal carries payload.response_routing", async () => {
    const result = await runReviewPipeline({
      ...baseOpts(throwingFactory("claude binary not found")),
      responseRouting: ROUTING,
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(
      (result.envelope.payload as { response_routing?: unknown }).response_routing,
    ).toEqual(ROUTING);
  });

  test("omitted → no response_routing key on either terminal", async () => {
    const { factory } = fakeFactory(successResult(buildVerdictBlock("approved")));
    const verdict = await runReviewPipeline(baseOpts(factory));
    expect(verdict.kind).toBe("verdict");
    if (verdict.kind === "verdict") {
      expect("response_routing" in (verdict.envelope.payload as object)).toBe(false);
    }
    const failed = await runReviewPipeline(
      baseOpts(throwingFactory("nope")),
    );
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect("response_routing" in (failed.envelope.payload as object)).toBe(false);
    }
  });

  test("pipeline stays non-throwing and never references a runtime", async () => {
    // The opts type has no runtime field — this is a structural guarantee.
    // Assert the happy + failure paths both return (never throw) with routing.
    const { factory } = fakeFactory(successResult(buildVerdictBlock("approved")));
    await expect(
      runReviewPipeline({ ...baseOpts(factory), responseRouting: ROUTING }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// cortex#503 — buildPresentationMarkdown (deterministic, idempotent, no JSON)
// ---------------------------------------------------------------------------

/** Internal VerdictBlock shape, mirrored for the unit tests. */
const SAMPLE_BLOCK = {
  verdict: "changes-requested" as ReviewVerdictKind,
  summary: "Two majors in the auth path; three nits in tests.",
  github_review_id: 2459183744,
  github_review_url:
    "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
  submitted_at: "2026-05-16T09:51:30Z",
  commit_id: "a1b2c3d4e5f6789012345678901234567890abcd",
  findings: { blockers: 1, majors: 2, nits: 3 },
  inline_comments: 5,
};

describe("buildPresentationMarkdown — deterministic markdown, zero LLM tokens", () => {
  test("contains findings counts, 7-char commit, and the github_review_url", () => {
    const md = buildPresentationMarkdown(SAMPLE_BLOCK);
    expect(md).toContain("1 blockers");
    expect(md).toContain("2 majors");
    expect(md).toContain("3 nits");
    expect(md).toContain("5 inline comments");
    expect(md).toContain(SAMPLE_BLOCK.github_review_url);
    // 7-char short commit, NOT the full 40-char SHA.
    expect(md).toContain("a1b2c3d");
    expect(md).not.toContain(SAMPLE_BLOCK.commit_id);
    // The agent's own prose summary is preserved verbatim.
    expect(md).toContain(SAMPLE_BLOCK.summary);
  });

  test("emoji + label by verdict kind", () => {
    expect(buildPresentationMarkdown({ ...SAMPLE_BLOCK, verdict: "approved" })).toContain(
      "✅ Approved",
    );
    expect(
      buildPresentationMarkdown({ ...SAMPLE_BLOCK, verdict: "changes-requested" }),
    ).toContain("🔴 Changes requested");
    expect(
      buildPresentationMarkdown({ ...SAMPLE_BLOCK, verdict: "commented" }),
    ).toContain("💬 Commented");
  });

  test("idempotent — same block in → byte-identical string out", () => {
    const a = buildPresentationMarkdown(SAMPLE_BLOCK);
    const b = buildPresentationMarkdown({
      ...SAMPLE_BLOCK,
      findings: { ...SAMPLE_BLOCK.findings },
    });
    expect(a).toBe(b);
  });

  test("never leaks raw JSON — no payload braces / quoted-key pattern", () => {
    const md = buildPresentationMarkdown(SAMPLE_BLOCK);
    // No JSON object dump (the failure mode the field exists to prevent).
    expect(md).not.toContain('"verdict"');
    expect(md).not.toContain('"findings"');
    expect(md).not.toContain('"github_review_url"');
  });

  test("empty github_review_url → no link line, no dangling commit", () => {
    const md = buildPresentationMarkdown({
      ...SAMPLE_BLOCK,
      github_review_url: "",
    });
    expect(md).not.toContain("Review on GitHub");
    expect(md).not.toContain("a1b2c3d");
  });
});

// ---------------------------------------------------------------------------
// cortex#503 — presentation stamped on the verdict payload
// ---------------------------------------------------------------------------

describe("runReviewPipeline — presentation on the verdict payload", () => {
  test("verdict payload carries deterministic presentation matching the helper", async () => {
    const block = buildVerdictBlock("changes-requested", {
      summary: "Blocking: SQL injection in the search route.",
      commit_id: "deadbeef0000111122223333444455556666aaaa",
      github_review_url: "https://github.com/the-metafactory/cortex/pull/229#r1",
      findings: { blockers: 1, majors: 0, nits: 2 },
      inline_comments: 4,
    });
    const { factory } = fakeFactory(successResult(block));
    const result = await runReviewPipeline(baseOpts(factory));
    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const presentation = result.envelope.payload.presentation;
    expect(typeof presentation).toBe("string");
    expect(presentation as string).toContain("🔴 Changes requested");
    expect(presentation as string).toContain("1 blockers");
    expect(presentation as string).toContain("deadbee"); // 7-char commit
    // verbatim deterministic — recompute and compare.
    expect(presentation).toBe(
      buildPresentationMarkdown({
        verdict: "changes-requested",
        summary: "Blocking: SQL injection in the search route.",
        github_review_id: 2459183744,
        github_review_url: "https://github.com/the-metafactory/cortex/pull/229#r1",
        submitted_at: "2026-05-16T09:51:30Z",
        commit_id: "deadbeef0000111122223333444455556666aaaa",
        findings: { blockers: 1, majors: 0, nits: 2 },
        inline_comments: 4,
      }),
    );
  });
});
