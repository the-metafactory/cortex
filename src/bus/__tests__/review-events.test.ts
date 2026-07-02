/**
 * cortex#237 PR-2 — tests for `review-events.ts` envelope constructors.
 *
 * Coverage axes mirror `dispatch-events.test.ts`:
 *   1. Shape — fields match the spec verbatim, payload extras land in
 *      payload (not envelope top-level), optional fields are omitted
 *      (not `undefined`-valued) when callers don't pass them.
 *   2. Validation — every constructed envelope passes the vendored
 *      myelin schema. Catches regressions where someone adds a field
 *      but forgets to keep the envelope shape (sovereignty, source
 *      pattern, correlation UUID format).
 *   3. Correlation — verdict envelopes echo the REQUEST envelope's `id`
 *      as `correlation_id` (the load-bearing pilot contract per §5.1).
 *   4. Discriminator alignment — verdict builder throws when `kind` and
 *      `payload.verdict` disagree (§6.3 defensive guard).
 *   5. Nak taxonomy — every `DispatchTaskFailedReason` variant round-trips
 *      through the review-flavoured wrapper (cortex#249).
 */

import { describe, expect, test } from "bun:test";
import { canonicalizeForSigning } from "@the-metafactory/myelin/identity";
import { validateEnvelope, type Envelope } from "../myelin/envelope-validator";
import {
  createReviewRequestEvent,
  createReviewTaskFailedEvent,
  createReviewVerdictEvent,
  type ReviewEventSource,
  type ReviewVerdictPayload,
} from "../review-events";

const SOURCE: ReviewEventSource = {
  principal: "metafactory",
  agent: "echo",
  instance: "local",
};

const PILOT_SOURCE: ReviewEventSource = {
  principal: "metafactory",
  agent: "pilot",
  instance: "local",
};

const REQUEST_ENVELOPE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const STARTED_AT = new Date("2026-05-16T09:42:00.000Z");
const FAILED_AT = new Date("2026-05-16T09:42:30.000Z");

// ---------------------------------------------------------------------------
// createReviewRequestEvent
// ---------------------------------------------------------------------------

describe("createReviewRequestEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createReviewRequestEvent({
      source: PILOT_SOURCE,
      flavor: "typescript",
      payload: {
        repo: "the-metafactory/cortex",
        pr: 229,
        reviewer: "echo",
      },
    });
    expect(env.type).toBe("tasks.code-review.typescript");
    expect(env.source).toBe("metafactory.pilot.local");
    expect(env.payload).toMatchObject({
      repo: "the-metafactory/cortex",
      pr: 229,
      reviewer: "echo",
    });
    // Optional fields omitted entirely when not passed
    expect("feature" in env.payload).toBe(false);
    expect("title" in env.payload).toBe(false);
    expect("cycle" in env.payload).toBe(false);
    expect("note" in env.payload).toBe(false);
    // No correlation_id on request envelopes — `id` is the correlation root
    expect(env.correlation_id).toBeUndefined();
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("optional payload fields land in payload when provided", () => {
    const env = createReviewRequestEvent({
      source: PILOT_SOURCE,
      flavor: "typescript",
      payload: {
        repo: "the-metafactory/cortex",
        pr: 229,
        reviewer: "echo",
        feature: "C-237",
        title: "feat(bus): Echo subscribes to tasks.code-review.*",
        cycle: 1,
        note: "second cycle after rebase",
      },
    });
    expect(env.payload).toMatchObject({
      feature: "C-237",
      title: "feat(bus): Echo subscribes to tasks.code-review.*",
      cycle: 1,
      note: "second cycle after rebase",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id (envelope idempotency key)", () => {
    const opts = {
      source: PILOT_SOURCE,
      flavor: "typescript" as const,
      payload: {
        repo: "the-metafactory/cortex",
        pr: 229,
        reviewer: "echo",
      },
    };
    const a = createReviewRequestEvent(opts);
    const b = createReviewRequestEvent(opts);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("all flavor segments build a valid subject suffix", () => {
    const flavors = [
      "generic",
      "typescript",
      "python",
      "rust",
      "go",
      "sql",
      "docs",
      "security",
    ] as const;
    for (const flavor of flavors) {
      const env = createReviewRequestEvent({
        source: PILOT_SOURCE,
        flavor,
        payload: { repo: "x/y", pr: 1, reviewer: "echo" },
      });
      expect(env.type).toBe(`tasks.code-review.${flavor}`);
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("dataResidency override propagates into sovereignty", () => {
    const env = createReviewRequestEvent({
      source: { ...PILOT_SOURCE, dataResidency: "CH" },
      flavor: "typescript",
      payload: { repo: "x/y", pr: 1, reviewer: "echo" },
    });
    expect(env.sovereignty.data_residency).toBe("CH");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("classification=federated opt-in lands on envelope", () => {
    const env = createReviewRequestEvent({
      source: PILOT_SOURCE,
      flavor: "typescript",
      classification: "federated",
      payload: { repo: "x/y", pr: 1, reviewer: "echo" },
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createReviewVerdictEvent
// ---------------------------------------------------------------------------

function makeVerdictPayload(
  overrides: Partial<ReviewVerdictPayload> = {},
): ReviewVerdictPayload {
  return {
    repo: "the-metafactory/cortex",
    pr: 229,
    reviewer: "echo",
    verdict: "changes-requested",
    summary: "verdict: blockers=0 majors=2 nits=3 — request-changes",
    github_review_id: 2459183744,
    github_review_url:
      "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
    submitted_at: "2026-05-16T09:51:30Z",
    commit_id: "abc123def456789",
    findings: { blockers: 0, majors: 2, nits: 3 },
    inline_comments: 5,
    ...overrides,
  };
}

describe("createReviewVerdictEvent", () => {
  test("changes-requested verdict — required fields populated; envelope passes schema validation", () => {
    const payload = makeVerdictPayload();
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "changes-requested",
      correlationId: REQUEST_ENVELOPE_ID,
      payload,
    });
    expect(env.type).toBe("review.verdict.changes-requested");
    expect(env.source).toBe("metafactory.echo.local");
    expect(env.correlation_id).toBe(REQUEST_ENVELOPE_ID);
    expect(env.payload).toMatchObject({
      repo: "the-metafactory/cortex",
      pr: 229,
      reviewer: "echo",
      verdict: "changes-requested",
      summary: payload.summary,
      github_review_id: payload.github_review_id,
      github_review_url: payload.github_review_url,
      submitted_at: payload.submitted_at,
      commit_id: payload.commit_id,
      findings: { blockers: 0, majors: 2, nits: 3 },
      inline_comments: 5,
    });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("approved verdict — type suffix and payload discriminator agree", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({
        verdict: "approved",
        summary: "verdict: blockers=0 majors=0 nits=0 — approve",
        findings: { blockers: 0, majors: 0, nits: 0 },
        inline_comments: 0,
      }),
    });
    expect(env.type).toBe("review.verdict.approved");
    expect((env.payload as { verdict: string }).verdict).toBe("approved");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("commented verdict — type suffix and payload discriminator agree", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "commented",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({
        verdict: "commented",
        summary: "verdict: blockers=0 majors=0 nits=2 — comment-only",
        findings: { blockers: 0, majors: 0, nits: 2 },
        inline_comments: 2,
      }),
    });
    expect(env.type).toBe("review.verdict.commented");
    expect((env.payload as { verdict: string }).verdict).toBe("commented");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("correlation_id matches the request envelope id verbatim", () => {
    // Two verdict envelopes carrying the same correlation_id — pilot's
    // wait-for-verdict groups by this exact value.
    const env1 = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    const env2 = createReviewVerdictEvent({
      source: SOURCE,
      kind: "commented",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "commented" }),
    });
    expect(env1.correlation_id).toBe(REQUEST_ENVELOPE_ID);
    expect(env2.correlation_id).toBe(REQUEST_ENVELOPE_ID);
    // ...but the envelope ids themselves are distinct
    expect(env1.id).not.toBe(env2.id);
  });

  test("compass#95 (replay-fix) — payload carries request_id == correlationId, and it is inside the SIGNED canonical bytes", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    // The SIGNED request-binding: pilot asserts `payload.request_id === awaited
    // correlationId` to defeat replay-rebind (top-level correlation_id is NOT
    // signed). It must equal the request envelope id verbatim.
    expect((env.payload as { request_id?: unknown }).request_id).toBe(
      REQUEST_ENVELOPE_ID,
    );
    // ...and it must land in the canonical bytes the signer commits to — proving
    // an attacker cannot rewrite it without invalidating the signature. (payload
    // ∈ myelin SIGNABLE_FIELDS; correlation_id is deliberately NOT.)
    const canonical = new TextDecoder().decode(
      canonicalizeForSigning(env as unknown as Parameters<typeof canonicalizeForSigning>[0]),
    );
    expect(canonical).toContain(`"request_id":"${REQUEST_ENVELOPE_ID}"`);
    // Guard the asymmetry the fix relies on: correlation_id stays OUT of the
    // signed bytes (that exclusion is exactly why the SIGNED request_id is needed).
    expect(canonical).not.toContain("correlation_id");
  });

  test("each invocation returns a fresh UUID id", () => {
    const opts = {
      source: SOURCE,
      kind: "approved" as const,
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "approved" as const }),
    };
    const a = createReviewVerdictEvent(opts);
    const b = createReviewVerdictEvent(opts);
    expect(a.id).not.toBe(b.id);
  });

  test("throws when kind and payload.verdict disagree (defensive §6.3)", () => {
    expect(() =>
      createReviewVerdictEvent({
        source: SOURCE,
        kind: "approved",
        correlationId: REQUEST_ENVELOPE_ID,
        payload: makeVerdictPayload({ verdict: "commented" }),
      }),
    ).toThrow(/verdict-kind\/payload mismatch/);
  });

  test("classification=federated opt-in lands on envelope", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      classification: "federated",
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("payload.findings is a fresh literal — not aliased to caller's object", () => {
    const findings = { blockers: 1, majors: 2, nits: 3 };
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "changes-requested",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({
        verdict: "changes-requested",
        findings,
      }),
    });
    // Mutating the caller's object MUST NOT leak into the envelope.
    findings.blockers = 99;
    expect((env.payload as { findings: { blockers: number } }).findings.blockers).toBe(1);
  });

  // cortex#502 — response_routing (logical shape) on the verdict.
  test("stamps payload.response_routing (logical shape) when supplied", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      responseRouting: {
        surface: "discord",
        channel: "cortex",
        thread: "cortex/pr/57",
      },
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    expect((env.payload as { response_routing?: unknown }).response_routing).toEqual({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/pr/57",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("stamps response_routing without thread (channel-scope)", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "commented",
      correlationId: REQUEST_ENVELOPE_ID,
      responseRouting: { surface: "discord", channel: "cortex" },
      payload: makeVerdictPayload({ verdict: "commented" }),
    });
    expect((env.payload as { response_routing?: unknown }).response_routing).toEqual({
      surface: "discord",
      channel: "cortex",
    });
  });

  test("omits the response_routing key entirely when not supplied", () => {
    const env = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    expect("response_routing" in (env.payload as object)).toBe(false);
  });

  test("response_routing coexists with the discriminator guard (still throws on mismatch)", () => {
    expect(() =>
      createReviewVerdictEvent({
        source: SOURCE,
        kind: "approved",
        correlationId: REQUEST_ENVELOPE_ID,
        responseRouting: { surface: "discord", channel: "cortex" },
        payload: makeVerdictPayload({ verdict: "commented" }),
      }),
    ).toThrow(/verdict-kind\/payload mismatch/);
  });
});

// ---------------------------------------------------------------------------
// createReviewTaskFailedEvent — nak taxonomy round-trip
// ---------------------------------------------------------------------------

describe("createReviewTaskFailedEvent", () => {
  const baseOpts = {
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "echo",
    startedAt: STARTED_AT,
    failedAt: FAILED_AT,
    errorSummary: "review pipeline failure",
    // Per §5.2: review consumer passes the REQUEST envelope id, not taskId.
    correlationId: REQUEST_ENVELOPE_ID,
  } as const;

  test("policy_denied — wraps dispatch-events.ts builder, preserves payload", () => {
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "policy_denied",
        deny: { code: "unknown_principal", principal: "ghost" },
      },
    });
    expect(env.type).toBe("dispatch.task.failed");
    expect(env.correlation_id).toBe(REQUEST_ENVELOPE_ID);
    const payload = env.payload as {
      reason?: { kind: string; deny?: unknown };
    };
    expect(payload.reason?.kind).toBe("policy_denied");
    expect(payload.reason?.deny).toEqual({
      code: "unknown_principal",
      principal: "ghost",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("cant_do — capability mismatch nak", () => {
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "cant_do",
        detail: "no agent registered for code-review.rust",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("cant_do");
    expect(payload.reason?.detail).toBe(
      "no agent registered for code-review.rust",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("wont_do — sovereignty refusal nak", () => {
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "wont_do",
        detail: "agent sovereignty: frontier model required but agent is selective",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("wont_do");
    expect(payload.reason?.detail).toMatch(/sovereignty/);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("not_now — backpressure nak with retry_after_ms hint", () => {
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "not_now",
        detail: "agent at maxConcurrent",
        retry_after_ms: 15000,
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string; retry_after_ms?: number };
    };
    expect(payload.reason?.kind).toBe("not_now");
    expect(payload.reason?.detail).toBe("agent at maxConcurrent");
    expect(payload.reason?.retry_after_ms).toBe(15000);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("not_now — backpressure nak without retry_after_ms hint", () => {
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "not_now",
        detail: "backpressure",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; retry_after_ms?: number };
    };
    expect(payload.reason?.kind).toBe("not_now");
    expect(payload.reason?.retry_after_ms).toBeUndefined();
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("compliance_block — declared but unwired-in-v1 per §7.4", () => {
    // The builder accepts compliance_block (it's in the union) even though
    // the consumer's nak switch omits it for v1 (Echo cortex#253 R1 Minor-5).
    // This keeps the taxonomy ready when §13.5's attestation schema lands.
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: {
        kind: "compliance_block",
        detail: "STD-EXAMPLE-AI-001 gate: external review not attested",
      },
    });
    const payload = env.payload as {
      reason?: { kind: string; detail?: string };
    };
    expect(payload.reason?.kind).toBe("compliance_block");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("correlation_id defaults to request envelope id (review consumer contract §5.2)", () => {
    // The review consumer MUST pass the request envelope's id explicitly
    // — verify the wrapper honours that override (rather than falling back
    // to taskId as the dispatch.task.* default would).
    const env = createReviewTaskFailedEvent({
      ...baseOpts,
      reason: { kind: "cant_do", detail: "x" },
    });
    expect(env.correlation_id).toBe(REQUEST_ENVELOPE_ID);
    expect(env.correlation_id).not.toBe(TASK_ID);
  });
});

// ---------------------------------------------------------------------------
// Type-level — builders return the canonical Envelope shape
// ---------------------------------------------------------------------------

describe("type-level envelope shape conformance", () => {
  test("request, verdict, and failed builders all return the canonical Envelope type", () => {
    // Compile-time assertions: assigning the builder return to a typed
    // `Envelope` slot exercises the structural type. If the builder
    // returns anything wider, this block fails `tsc --noEmit`.
    const req: Envelope = createReviewRequestEvent({
      source: PILOT_SOURCE,
      flavor: "typescript",
      payload: { repo: "x/y", pr: 1, reviewer: "echo" },
    });
    const verdict: Envelope = createReviewVerdictEvent({
      source: SOURCE,
      kind: "approved",
      correlationId: REQUEST_ENVELOPE_ID,
      payload: makeVerdictPayload({ verdict: "approved" }),
    });
    const failed: Envelope = createReviewTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "echo",
      startedAt: STARTED_AT,
      failedAt: FAILED_AT,
      errorSummary: "x",
      correlationId: REQUEST_ENVELOPE_ID,
      reason: { kind: "cant_do", detail: "x" },
    });
    // Runtime sanity — every Envelope has these top-level fields.
    for (const env of [req, verdict, failed]) {
      expect(typeof env.id).toBe("string");
      expect(typeof env.type).toBe("string");
      expect(typeof env.source).toBe("string");
      expect(typeof env.timestamp).toBe("string");
      expect(env.sovereignty).toBeDefined();
      expect(env.payload).toBeDefined();
    }
  });
});
