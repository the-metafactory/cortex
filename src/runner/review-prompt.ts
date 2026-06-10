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
 * This builder makes the contract explicit in the prompt itself, independent of
 * persona quality:
 *   1. ALWAYS instruct the terminal fenced ```json verdict block (the pipeline
 *      parses the LAST such block — `extractVerdictBlock` / `parseVerdictBlock`).
 *   2. When `payload.post` is set, instruct a non-interactive `gh pr review`
 *      post (— never "ask first") and report the resulting review id/url back
 *      in the block. Otherwise instruct NOT to post (link-less block).
 *
 * Pure + deterministic — unit-tested in `review-prompt.test.ts`.
 */
export function buildReviewPrompt(input: {
  agentId: string;
  payload: ReviewRequestPayload;
}): string {
  const { payload } = input;
  const ref = `${payload.repo}#${payload.pr}`;

  const postInstruction = payload.post
    ? [
        `When your review is ready, POST it to the PR non-interactively with`,
        "`gh pr review` (use `--comment` if GitHub blocks a self-approve /",
        "self-request-changes). Do NOT ask for confirmation — post it, then",
        "report the created review's id and url in the verdict block's",
        "`github_review_id` / `github_review_url` fields.",
      ].join(" ")
    : [
        `Do NOT post this review to the PR. Leave the verdict block's`,
        '`github_review_id` as `0` and `github_review_url` as `""`.',
      ].join(" ");

  return [
    `Review PR ${ref}.`,
    "",
    "You MUST end your output with a single fenced ```json verdict block as the",
    "terminal artefact (the cortex review pipeline parses the LAST such block).",
    "It must match this exact shape:",
    "",
    "```json",
    "{",
    '  "verdict": "approved" | "changes-requested" | "commented",',
    '  "summary": "<one-line summary of the review>",',
    '  "github_review_id": <integer>,',
    '  "github_review_url": "<string>",',
    '  "submitted_at": "<ISO 8601 timestamp>",',
    '  "commit_id": "<PR head commit SHA>",',
    '  "findings": { "blockers": <int>, "majors": <int>, "nits": <int> },',
    '  "inline_comments": <integer>',
    "}",
    "```",
    "",
    postInstruction,
  ].join("\n");
}
