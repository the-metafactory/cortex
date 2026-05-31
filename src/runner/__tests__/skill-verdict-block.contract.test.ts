/**
 * cortex#237 PR-8b — round-trip contract test for the skill verdict block.
 *
 * **Purpose.** PR-5 (`src/runner/review-pipeline.ts`) parses a fenced JSON
 * verdict block emitted by the CodeReview skill at the end of its CC output.
 * That parser is the **only** machine-readable handshake between cortex and
 * the skill markdown (`~/.claude/skills/code-review/SKILL.md` — owned by
 * PAI, OUT OF THIS REPO). The schema is documented in
 * `docs/design-capability-dispatch-review-consumer.md` §4.5.
 *
 * If the skill markdown is updated and silently drifts away from the
 * shape PR-5 expects (e.g. a property is renamed, a typo creeps into the
 * verdict enum, a required field disappears), the parser will refuse the
 * block and emit `dispatch.task.failed` with `cant_do` — pilot then
 * stalls and principals have to figure out what changed. This test is the
 * tripwire: it embeds **canonical example outputs that the skill is
 * expected to emit** and round-trips them through the real
 * `runReviewPipeline` to prove the parser still accepts them. When the
 * skill is intentionally updated, the principal updates the fixtures here
 * to match — that's the explicit synchronisation point between the two
 * repos.
 *
 * **What this catches:**
 *   - PR-5 parser regressions (a future refactor narrows the accepted
 *     shape; this test fails before pilot stalls in production).
 *   - Skill drift (the skill markdown is updated; these fixtures no
 *     longer reflect what the skill emits → principal must reconcile).
 *
 * **What this does NOT catch:**
 *   - That the skill ACTUALLY emits these fixtures (the skill lives in
 *     `~/.claude/skills/` and is not exercised here; only the contract
 *     between fixture and parser is exercised).
 *   - End-to-end pipeline behaviour with a real CC binary (PR-9).
 *   - GH-side artefact production (the skill posts the review via
 *     `gh pr review`; that side-effect is not in scope for this parser
 *     contract).
 *
 * **PAI-side action required.** The skill markdown
 * `~/.claude/skills/code-review/SKILL.md` (and the per-workflow files
 * under `Workflows/`) must be updated to emit a fenced ```json block as
 * the FINAL element of the CC response, matching the shape used in the
 * APPROVED_FIXTURE constant below. The principal owns that edit; this
 * test file is purely the cortex-side contract.
 *
 * The fixture style is deliberately CC-prose-shaped (a short summary
 * paragraph above the block) because the parser uses the LAST fenced
 * block — earlier prose / inline JSON / lens-internal scratch output is
 * tolerated, only the terminal block matters.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  createReviewRequestEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "../../bus/review-events";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../../substrates/claude-code/harness";
import type { CCSessionResult } from "../cc-session";
import { runReviewPipeline } from "../review-pipeline";

// ---------------------------------------------------------------------------
// Test scaffolding (matches review-pipeline.test.ts style)
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

function successResult(response: string): CCSessionResult {
  return {
    success: true,
    response,
    exitCode: 0,
    durationMs: 4200,
    sessionId: "session-contract",
  };
}

/**
 * Stub CC session factory — returns the supplied result from `wait()`.
 * Mirrors `review-pipeline.test.ts:fakeFactory` shape so reviewers see a
 * consistent harness across the two files.
 */
function stubFactory(result: CCSessionResult): CCSessionFactory {
  return () => {
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
}

// ---------------------------------------------------------------------------
// Canonical fixtures — these are the skill-emission examples the principal
// must keep in sync with `~/.claude/skills/code-review/SKILL.md`. Each
// fixture is a complete CC-style response: a short prose summary above a
// fenced ```json block. The block is the LAST fenced block in the string
// (per §4.5 last-block-wins).
// ---------------------------------------------------------------------------

/**
 * Fixture 1 — `approved` verdict, zero findings across all severities.
 * Represents the "clean PR" path: skill ran every lens, found nothing
 * actionable, approves via `gh pr review --approve`. This is the SHAPE
 * the principal should paste into the skill markdown's "structured
 * output" section as the worked example.
 */
const APPROVED_FIXTURE = [
  "I've completed the CodeQuality, Security, and Architecture lenses on PR #229.",
  "No blockers, majors, or nits surfaced — the change is tightly scoped, well-tested, and",
  "internally consistent. Submitting an approving GitHub review.",
  "",
  "```json",
  JSON.stringify(
    {
      verdict: "approved",
      summary:
        "verdict: blockers=0 majors=0 nits=0 — recommend: approve. " +
        "Clean change, no findings across CodeQuality / Security / Architecture.",
      github_review_id: 2459200001,
      github_review_url:
        "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459200001",
      submitted_at: "2026-05-17T08:15:42Z",
      commit_id: "d4e5f6a7b8c9012345678901234567890abcdef1",
      findings: { blockers: 0, majors: 0, nits: 0 },
      inline_comments: 0,
    },
    null,
    2,
  ),
  "```",
].join("\n");

/**
 * Fixture 2 — `changes-requested` verdict with findings in every severity.
 * Represents the "real review" path: some non-trivial findings across
 * majors and nits (no blockers, but enough that approval would be
 * irresponsible). Counts are reported aggregated (blockers/majors/nits)
 * — the per-finding file/line/severity/message records live in the
 * inline review comments posted GH-side by the skill (see §4.5).
 */
const CHANGES_REQUESTED_FIXTURE = [
  "I've completed the full review. Two non-blocking maintainability issues and three",
  "nit-level style suggestions surfaced — see inline comments on GitHub. Requesting",
  "changes via `gh pr review --request-changes`.",
  "",
  "```json",
  JSON.stringify(
    {
      verdict: "changes-requested",
      summary:
        "verdict: blockers=0 majors=2 nits=3 — recommend: request-changes. " +
        "Two maintainability concerns (silent catch in pipeline; nullable propagation in adapter) " +
        "and three style nits (naming, doc-comment alignment, redundant guard).",
      github_review_id: 2459200002,
      github_review_url:
        "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459200002",
      submitted_at: "2026-05-17T08:22:11Z",
      commit_id: "d4e5f6a7b8c9012345678901234567890abcdef1",
      findings: { blockers: 0, majors: 2, nits: 3 },
      inline_comments: 5,
    },
    null,
    2,
  ),
  "```",
].join("\n");

/**
 * Fixture 3 — `commented` verdict, informational. Skill found one nit but
 * neither approves nor blocks — leaves the call to the author. The
 * `commented` path is the skill's signal "I have observations, no
 * verdict-level recommendation."
 */
const COMMENTED_FIXTURE = [
  "Review complete. One nit-level naming observation surfaced — not blocking, not",
  "approval-worthy on its own. Submitting an informational `gh pr review --comment`.",
  "",
  "```json",
  JSON.stringify(
    {
      verdict: "commented",
      summary:
        "verdict: blockers=0 majors=0 nits=1 — recommend: comment-only. " +
        "Single naming nit on the new helper; author's call.",
      github_review_id: 2459200003,
      github_review_url:
        "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459200003",
      submitted_at: "2026-05-17T08:27:55Z",
      commit_id: "d4e5f6a7b8c9012345678901234567890abcdef1",
      findings: { blockers: 0, majors: 0, nits: 1 },
      inline_comments: 1,
    },
    null,
    2,
  ),
  "```",
].join("\n");

/**
 * Fixture 4 (NEGATIVE) — typo'd verdict enum (`"approve"` instead of the
 * canonical `"approved"`). Proves the parser enforces the enum and that
 * a careless skill edit (the kind of drift this whole test file exists
 * to catch) collapses to a `cant_do` failure with a useful detail
 * string. If this fixture ever starts producing a `verdict` result, the
 * parser has silently widened its accepted enum and pilot's verdict
 * subject routing will break.
 */
const TYPO_VERDICT_FIXTURE = [
  "All lenses run. Submitting approval.",
  "",
  "```json",
  JSON.stringify(
    {
      verdict: "approve", // ← typo: should be "approved"
      summary: "verdict: blockers=0 majors=0 nits=0 — recommend: approve.",
      github_review_id: 2459200099,
      github_review_url:
        "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459200099",
      submitted_at: "2026-05-17T08:30:00Z",
      commit_id: "d4e5f6a7b8c9012345678901234567890abcdef1",
      findings: { blockers: 0, majors: 0, nits: 0 },
      inline_comments: 0,
    },
    null,
    2,
  ),
  "```",
].join("\n");

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("skill verdict-block contract — positive fixtures round-trip via runReviewPipeline", () => {
  test("Fixture 1 (approved, no findings) parses to review.verdict.approved", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      requestEnvelope: req,
      payload: PAYLOAD,
      agentId: "echo",
      source: SOURCE,
      ccSessionFactory: stubFactory(successResult(APPROVED_FIXTURE)),
      prompt: "/review the-metafactory/cortex#229",
    });

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.approved");
    expect(result.envelope.correlation_id).toBe(req.id);

    const payload = result.envelope.payload;
    expect(payload.verdict).toBe("approved");
    expect(payload.findings).toEqual({ blockers: 0, majors: 0, nits: 0 });
    expect(payload.inline_comments).toBe(0);
    expect(payload.github_review_id).toBe(2459200001);
    expect(payload.commit_id).toBe(
      "d4e5f6a7b8c9012345678901234567890abcdef1",
    );
  });

  test("Fixture 2 (changes-requested, majors+nits) parses with finding counts round-tripped", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      requestEnvelope: req,
      payload: PAYLOAD,
      agentId: "echo",
      source: SOURCE,
      ccSessionFactory: stubFactory(successResult(CHANGES_REQUESTED_FIXTURE)),
      prompt: "/review the-metafactory/cortex#229",
    });

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.changes-requested");
    expect(result.envelope.correlation_id).toBe(req.id);

    const payload = result.envelope.payload;
    expect(payload.verdict).toBe("changes-requested");
    expect(payload.findings).toEqual({ blockers: 0, majors: 2, nits: 3 });
    expect(payload.inline_comments).toBe(5);
    expect(payload.summary).toContain("blockers=0 majors=2 nits=3");
  });

  test("Fixture 3 (commented, single nit) parses to review.verdict.commented", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      requestEnvelope: req,
      payload: PAYLOAD,
      agentId: "echo",
      source: SOURCE,
      ccSessionFactory: stubFactory(successResult(COMMENTED_FIXTURE)),
      prompt: "/review the-metafactory/cortex#229",
    });

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.commented");
    expect(result.envelope.correlation_id).toBe(req.id);

    const payload = result.envelope.payload;
    expect(payload.verdict).toBe("commented");
    expect(payload.findings).toEqual({ blockers: 0, majors: 0, nits: 1 });
    expect(payload.inline_comments).toBe(1);
  });
});

describe("skill verdict-block contract — negative fixture proves enum enforcement", () => {
  test("Fixture 4 (typo verdict 'approve') is rejected as cant_do", async () => {
    const req = makeRequestEnvelope();
    const result = await runReviewPipeline({
      requestEnvelope: req,
      payload: PAYLOAD,
      agentId: "echo",
      source: SOURCE,
      ccSessionFactory: stubFactory(successResult(TYPO_VERDICT_FIXTURE)),
      prompt: "/review the-metafactory/cortex#229",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.envelope.type).toBe("dispatch.task.failed");
    expect(result.envelope.correlation_id).toBe(req.id);

    const payload = result.envelope.payload;
    const reason = payload.reason as { kind: string; detail: string };
    expect(reason.kind).toBe("cant_do");
    // Detail must name the offending field so principals can spot skill drift
    // immediately on the dashboard — not just "schema mismatch".
    expect(reason.detail).toContain("verdict");
  });
});
