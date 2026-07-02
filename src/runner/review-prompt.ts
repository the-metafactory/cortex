import type { ReviewFlavor, ReviewRequestPayload } from "../bus/review-events";

/**
 * Map a review `<flavor>` to the CodeReview skill lens that runs as the
 * PRIMARY lens for the review (compass#89 drift-1 fix). The flavor is the
 * routing authority carried on the `tasks.code-review.<flavor>` subject and
 * stamped onto the payload by the review consumer.
 *
 * The mapping is deliberately small and total: only `security` and
 * `confidentiality` name a dedicated primary lens; every other flavor
 * (`typescript`, `python`, `generic`, …) and an unstamped payload
 * (`flavor === undefined`, e.g. legacy callers) fall through to the
 * full-coverage `FullReview` lens. The full flavor→workflow catalog
 * (`hardening`→HardeningReview, `skill-quality`→SkillReview, …) is F3's
 * scope (compass#96); this map is the minimum that makes the two shipped
 * dedicated lenses reachable and pins drift-1 shut.
 */
export function lensForFlavor(flavor: ReviewFlavor | undefined): string {
  switch (flavor) {
    case "security":
      return "Security";
    case "confidentiality":
      return "Confidentiality";
    default:
      return "FullReview";
  }
}

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

  // drift-1 fix (compass#89): the flavor stamped onto the payload selects the
  // PRIMARY lens. Before this the flavor never reached the prompt, so every
  // flavor produced a byte-identical review (the flavor-inert SEV-1).
  const lens = lensForFlavor(payload.flavor);
  const lensDirective =
    `Run the CodeReview skill's **${lens}** lens as the primary lens for this review.`;

  // ALWAYS-ON exposure + confidentiality instruction — appended for EVERY
  // flavor (design-software-factory-confidentiality.md §4 L3: "Confidentiality
  // runs on every review of an exposed repo regardless of flavor"). The builder
  // stays PURE: it emits the instruction; the REVIEWER performs the runtime
  // `gh` check. Exposure detection FAILS CLOSED — unknown/error ⇒ EXPOSED.
  const exposureInstruction = [
    "Before reviewing, determine the target repo's exposure: run",
    `\`gh repo view ${payload.repo} --json visibility\`. Treat the repo as`,
    "EXPOSED if it is public OR if that command errors, rate-limits, or returns",
    "an unknown/empty visibility (fail closed — never assume private). On an",
    "EXPOSED repo you MUST additionally run the CodeReview skill's",
    "**Confidentiality** lens (checks C1–C6: real orgs/people as content;",
    "deployment fragments in shippable paths; real identities in",
    "seeds/fixtures/migrations; live platform IDs; identity-embedding",
    "codes/acronyms; private→public content lifts). NEVER quote suspected",
    "confidential content anywhere (review body, verdict block, worklog) —",
    "report each finding by category and `file:line` only, never the literal",
    "value.",
  ].join(" ");

  return [
    `Review ${target} ${ref}.`,
    "",
    lensDirective,
    "",
    exposureInstruction,
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
    '  "inline_comments": 0,',
    '  "confidentiality_lens_ran": false',
    "}",
    "```",
    "",
    '`verdict` MUST be exactly one of "approved", "changes-requested", or',
    '"commented". Replace every sample value above with the real value for this',
    "review; all fields are required and the integer fields must be integers.",
    "Set `confidentiality_lens_ran` to `true` when you ran the Confidentiality",
    "lens (you MUST run it — and therefore set `true` — on an EXPOSED repo),",
    "`false` only when the repo is confirmed non-exposed and you did not run it.",
    "",
    postInstruction,
  ].join("\n");
}
