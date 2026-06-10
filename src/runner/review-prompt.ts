import type { ReviewRequestPayload } from "../bus/review-events";

/**
 * Build the CC-session review prompt (cortex#911).
 *
 * The dispatch prompt used to be bare intent (`Review PR owner/repo#N`) on the
 * theory that the reviewer's persona owns HOW — routing to a CodeReview skill
 * that posts via `gh pr review` and emits the cortex#237 structured verdict
 * block. In practice a thin persona (e.g. sage's) does neither: it reviews in
 * prose and ends "Shall I post this review?" — so the pipeline's
 * `extractVerdictBlock` finds no block (→ `dispatch.task.completed`, no
 * verdict) and nothing reaches the forge.
 *
 * This builder makes the contract explicit in the prompt itself rather than
 * relying solely on persona routing:
 *   1. ALWAYS instruct the terminal fenced ```json verdict block (the pipeline
 *      parses the LAST such block — `extractVerdictBlock` / `parseVerdictBlock`).
 *      The embedded example is VALID JSON (a concrete sample) — the allowed
 *      enum values are stated in prose OUTSIDE the block so a model copying the
 *      "exact shape" can never emit a type-union literal that fails `JSON.parse`.
 *   2. When `payload.post` is set, instruct a non-interactive post via the
 *      forge's review CLI (`gh pr review` for GitHub, `glab` for GitLab) — never
 *      "ask first" — and record the review id/url in the block when the forge
 *      returns them. Otherwise instruct NOT to post (link-less block).
 *
 * Prompt text raises the floor on persona quality; it does not guarantee model
 * compliance. Failure modes are asymmetric: the VERDICT side fails closed (a
 * missing / malformed block → no `review.verdict.*`, only
 * `dispatch.task.completed`), but the POST side does NOT — when `payload.post`
 * is set the reviewer is told to `gh pr review` before emitting the block, so a
 * forge review can persist even if the block is then absent. That's an
 * accepted property (a posted review is recoverable; a dropped verdict is
 * retryable), not a closed failure mode on the forge.
 *
 * Pure + deterministic — unit-tested in `review-prompt.test.ts`.
 */
export function buildReviewPrompt(payload: ReviewRequestPayload): string {
  const ref = `${payload.repo}#${payload.pr}`;

  // The forge CLI to post through. `payload.forge` omitted ⇒ GitHub
  // (pre-sage#43 back-compat). GitLab MRs post via `glab`, not `gh`.
  const forge = payload.forge ?? "github";
  const target = forge === "gitlab" ? "MR" : "PR";
  const postCli = forge === "gitlab" ? "`glab`" : "`gh pr review`";

  const postInstruction = payload.post
    ? [
        `When your review is ready, POST it to the ${target} non-interactively`,
        `via the forge's review CLI (${postCli}; use a comment-level post if the`,
        "forge blocks a self-approve). Do NOT ask for confirmation. If the forge",
        "returns a review/note id and url, record them in `github_review_id` /",
        '`github_review_url`; otherwise leave them `0` / `""`.',
      ].join(" ")
    : [
        `Do NOT post this review. Leave the verdict block's`,
        '`github_review_id` as `0` and `github_review_url` as `""`.',
      ].join(" ");

  return [
    `Review ${target} ${ref}.`,
    "",
    "You MUST end your output with a single fenced ```json verdict block as the",
    "terminal artefact (the cortex review pipeline parses the LAST such block",
    "with JSON.parse, so it MUST be valid JSON). Use this shape, e.g.:",
    "",
    "```json",
    "{",
    '  "verdict": "commented",',
    '  "summary": "<one-line summary of the review>",',
    '  "github_review_id": 0,',
    '  "github_review_url": "",',
    '  "submitted_at": "2026-01-01T00:00:00Z",',
    '  "commit_id": "<PR head commit SHA>",',
    '  "findings": { "blockers": 0, "majors": 0, "nits": 0 },',
    '  "inline_comments": 0',
    "}",
    "```",
    "",
    '`verdict` MUST be exactly one of "approved", "changes-requested", or',
    '"commented". Replace every sample value above with the real value for this',
    "review; all fields are required and the integer fields must be integers.",
    "",
    postInstruction,
  ].join("\n");
}
