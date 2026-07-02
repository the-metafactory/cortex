import type { ReviewFlavor, ReviewRequestPayload } from "../bus/review-events";

/**
 * Map a review `<flavor>` to the CodeReview skill **workflow** that the reviewer
 * is contractually instructed to invoke (compass#96 F3). The flavor is the
 * routing authority carried on the `tasks.code-review.<flavor>` subject and
 * stamped onto the payload by the review consumer.
 *
 * The mapping is deliberately small and total, and is the render of the
 * authoritative catalog table in `src/common/types/review-flavors.ts`:
 *   - `security`      → `SecurityReview`
 *   - `hardening`     → `HardeningReview`
 *   - `skill-quality` → `SkillReview`
 *   - `confidentiality` → `FullReview` (the always-on §4 L3 exposure block already
 *     makes the Confidentiality lens primary on every review — compass#96 F3
 *     decision: no separate ConfidentialityReview workflow)
 *   - every language flavor (`typescript`, `python`, `generic`, …) and an
 *     unstamped payload (`flavor === undefined`, e.g. legacy callers) →
 *     `FullReview` (full-coverage; the language is the emphasis, not a workflow).
 *
 * This SUPERSEDES compass#89's `lensForFlavor` (which named a primary *lens*):
 * F3 promotes the directive from "run lens X" to "invoke workflow X", so the
 * reviewer runs the actual CodeReview skill workflow rather than a prose gesture
 * at a lens.
 *
 * GENUINELY exhaustive over `ReviewFlavor | undefined`: every flavor (and the
 * unstamped `undefined`) is an EXPLICIT case, and the `default` branch pins
 * `flavor` to `never`. Adding a 12th flavor to `REVIEW_FLAVORS` without a case
 * here stops compiling (the `never` assignment fails) — the compiler forces the
 * choice rather than letting a new flavor silently fall through to FullReview.
 */
export function workflowForFlavor(flavor: ReviewFlavor | undefined): string {
  switch (flavor) {
    case "security":
      return "SecurityReview";
    case "hardening":
      return "HardeningReview";
    case "skill-quality":
      return "SkillReview";
    // Full-coverage review — the language/generic/docs/confidentiality flavors
    // carry their emphasis as a lens INSIDE FullReview, not a distinct workflow;
    // `confidentiality` runs FullReview because the always-on §4 L3 exposure
    // block already makes its lens primary. `undefined` = legacy/unstamped.
    case undefined:
    case "generic":
    case "typescript":
    case "python":
    case "rust":
    case "go":
    case "sql":
    case "docs":
    case "confidentiality":
      return "FullReview";
    default: {
      // Compile-time exhaustiveness guard (repo idiom, cf. src/renderers/index.ts):
      // if `flavor` is not `never` here, a REVIEW_FLAVORS entry lacks a case above.
      const _exhaustive: never = flavor;
      throw new Error(`unreachable review flavor: ${String(_exhaustive)}`);
    }
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

  // compass#96 F3 — the flavor stamped onto the payload selects the CodeReview
  // skill WORKFLOW the reviewer must invoke. This is a CONTRACTUAL invocation
  // (run this workflow), not a prose gesture at a lens — the reviewer's own
  // `allowedSkills: ['code-review']` pin (buildReviewSessionOpts) makes the
  // Skill tool available for it. Supersedes compass#89's primary-lens directive;
  // the flavor still reaches the prompt, so flavors stay non-identical (drift-1
  // remains pinned shut).
  const workflow = workflowForFlavor(payload.flavor);
  const lensDirective =
    `Invoke the CodeReview skill — **${workflow}** workflow — then emit the ` +
    `verdict block below.`;

  // compass#98 F6 — CONTEXT.md/ADR grounding. Between the lens directive and the
  // exposure block, ground the review in the TARGET repo's own documented
  // architecture. This is the SAME grounding contract the CodeReview skill's
  // ArchitectureDocs carrier and the sage engine implement — ONE contract, THREE
  // carriers; this is cortex's bus-path carrier. The pinned provenance line is
  // byte-identical to the skill + sage carriers so downstream parsers (pilot,
  // dashboard, audit log) grep for ONE shape.
  //
  // Builder stays PURE: it emits the instruction TEXT; the REVIEWER runs the
  // read-only `gh api` fetch at review time. Flavor-independent (fires on every
  // review), so it never affects drift-1.
  //
  // Fetch form is the PIPE-FREE raw-media variant, NOT the ArchitectureDocs
  // `… --jq .content | base64 -d` pipe: a wider-scope review runs under the M2
  // session lockdown whose bash-guard (`rejectsChaining`, bash-guard.hook.ts)
  // DENIES any pipe / redirect OUTRIGHT — before the allowlist is even consulted
  // — so the piped decode would be blocked regardless of the C2 allowlist widen.
  // `-H "Accept: application/vnd.github.raw"` returns the decoded file in a
  // single un-piped GET that the widened allowlist (review-session-lockdown.ts)
  // permits and rejectsChaining allows.
  const groundingInstruction = [
    "Ground this review in the TARGET repo's own documented architecture before",
    "emitting findings. Read-only and best-effort: fetch each of these canonical",
    `docs from ${payload.repo} with a SINGLE un-piped GET —`,
    '`gh api repos/<owner>/<repo>/contents/<path> -H "Accept: application/vnd.github.raw"`',
    "(a non-zero exit means the doc is absent — expected and non-fatal; do NOT",
    "pipe to `base64 -d`, the review session's bash guard forbids pipes):",
    "(1) `CONTEXT.md` — the bounded-context glossary (canonical terms + `_Avoid_`",
    "alias lists); (2) `docs/architecture.md` — the M1–M7 layer model and",
    "componentisation; (3) `compass/ecosystem/CONTEXT-MAP.md` — ecosystem boundary",
    "terms. Cross-check the diff against them: flag any added or renamed symbol",
    "whose normalized token sequence matches a CONTEXT.md `_Avoid_` alias",
    "(camelCase / snake_case / kebab-case / dotted forms are the SAME sequence —",
    "a case- and separator-insensitive match), and any new import that crosses an",
    "M1–M7 layer boundary in the wrong direction (a lower layer importing a higher",
    "one, or an M7 surface taking on an M2–M6 concern). NEVER quote suspected",
    "confidential content — cite each finding by `file:line` and canonical term",
    "only. You MUST include, in the posted review, a one-line provenance string",
    "naming which docs loaded, in this EXACT pinned shape (downstream parsers grep",
    "for the `(loaded)` / `(not-found)` pair — use hyphenated `(not-found)`, never",
    "`(missing)` or `(absent)`):",
    "`architecture-docs: CONTEXT.md (loaded|not-found), docs/architecture.md (loaded|not-found), CONTEXT-MAP.md (loaded|not-found)`.",
  ].join(" ");

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
    groundingInstruction,
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
