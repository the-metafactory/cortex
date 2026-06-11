/**
 * CO-7 M4 (epic cortex#939) — egress-guard pipeline wrapper tests.
 *
 * Asserts: local returns the inner runner unchanged (byte-identical); a
 * wider-scope verdict whose free-text leaks is rewritten to `compliance_block`
 * (and NOT posted); a clean verdict / completed passes through; a prose-fallback
 * `completed` is guarded; a `failed` terminal passes through (it posts nothing).
 */

import { describe, test, expect } from "bun:test";

import {
  createReviewVerdictEvent,
  type ReviewEventSource,
  type ReviewVerdictPayload,
} from "../../bus/review-events";
import type { ReviewPipelineOpts, ReviewPipelineResult } from "../review-pipeline";
import { withCo7EgressGuard } from "../co7-egress-pipeline";

const source: ReviewEventSource = {
  principal: "andreas",
  agent: "echo",
  instance: "test",
};

function makeOpts(): ReviewPipelineOpts {
  return {
    requestEnvelope: { id: "req-123" } as ReviewPipelineOpts["requestEnvelope"],
    payload: { repo: "the-metafactory/cortex", pr: 7, reviewer: "echo" },
    agentId: "echo",
    source,
    // The wrapper never reaches the factory (the inner runner is fully stubbed),
    // so a throwing stub documents that and fails loud if the contract regresses.
    ccSessionFactory: () => {
      throw new Error("factory should not be called in the wrapper test");
    },
    prompt: "unused",
  };
}

function verdictResult(presentation: string, summary = "ok"): ReviewPipelineResult {
  const payload: ReviewVerdictPayload = {
    repo: "the-metafactory/cortex",
    pr: 7,
    reviewer: "echo",
    verdict: "commented",
    summary,
    github_review_id: 0,
    github_review_url: "",
    submitted_at: "2026-01-01T00:00:00Z",
    commit_id: "abc1234",
    findings: { blockers: 0, majors: 0, nits: 0 },
    inline_comments: 0,
    presentation,
  };
  const envelope = createReviewVerdictEvent({
    source,
    kind: "commented",
    correlationId: "req-123",
    payload,
  });
  return { kind: "verdict", envelope };
}

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("withCo7EgressGuard — local", () => {
  test("returns the inner runner unchanged (same reference)", () => {
    const inner = async () => verdictResult("anything");
    expect(withCo7EgressGuard("local", inner)).toBe(inner);
  });
});

describe("withCo7EgressGuard — wider scope", () => {
  test("a clean verdict passes through unchanged", async () => {
    const clean = verdictResult("### Commented\n\nLGTM, clean diff.");
    const wrapped = withCo7EgressGuard("public", async () => clean);
    const out = await wrapped(makeOpts());
    expect(out.kind).toBe("verdict");
    expect(out).toBe(clean);
  });

  test("a LEAKING verdict is rewritten to compliance_block (not posted)", async () => {
    const leaky = verdictResult(`### Commented\n\nYour token is ${SECRET}`);
    const wrapped = withCo7EgressGuard("public", async () => leaky);
    const out = await wrapped(makeOpts());
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      const reason = (out.envelope.payload as { reason?: { kind?: string } }).reason;
      expect(reason?.kind).toBe("compliance_block");
      // The detail names the leak CLASS, never the secret bytes.
      const detail = (out.envelope.payload as { error_summary?: string }).error_summary;
      expect(detail ?? "").not.toContain(SECRET);
    }
  });

  test("a leaking PROSE-fallback completed is rewritten to compliance_block", async () => {
    const leaky: ReviewPipelineResult = {
      kind: "completed",
      presentation: `Here is my config path ~/.config/cortex/work.yaml`,
    };
    const wrapped = withCo7EgressGuard("public", async () => leaky);
    const out = await wrapped(makeOpts());
    expect(out.kind).toBe("failed");
  });

  test("a clean completed passes through", async () => {
    const clean: ReviewPipelineResult = {
      kind: "completed",
      presentation: "Reviewed in prose: the change looks reasonable.",
    };
    const wrapped = withCo7EgressGuard("public", async () => clean);
    const out = await wrapped(makeOpts());
    expect(out).toBe(clean);
  });

  test("a failed terminal passes through (it posts nothing)", async () => {
    const failed: ReviewPipelineResult = {
      kind: "failed",
      envelope: { id: "x" } as ReviewPipelineResult extends { envelope: infer E }
        ? E
        : never,
    };
    const wrapped = withCo7EgressGuard("public", async () => failed);
    const out = await wrapped(makeOpts());
    expect(out).toBe(failed);
  });

  test("federated scope guards the same way", async () => {
    const leaky = verdictResult(`token ${SECRET}`);
    const wrapped = withCo7EgressGuard("federated", async () => leaky);
    const out = await wrapped(makeOpts());
    expect(out.kind).toBe("failed");
  });
});
