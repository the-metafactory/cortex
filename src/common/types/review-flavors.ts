/**
 * Canonical review-flavor vocabulary — the SINGLE source of truth for the
 * `<flavor>` suffix of a `code-review.<flavor>` capability / `tasks.code-
 * review.<flavor>` subject, AND the parser that extracts it.
 *
 * Lives under `src/common/` (shared types/utilities, architecture.md §8): both
 * the config layer (`cortex-config.ts` schema validation) and the bus layer
 * (`reflex-activation-listener.ts`, re-exported via `bus/review-events.ts`)
 * import it, so config never depends on `src/bus/`. Zero imports → no cycle.
 *
 * This is the single source WITHIN cortex, but the flavor set is a cross-repo
 * wire contract: it must stay in lockstep with pilot's `KNOWN_SPECIALIZATIONS`
 * (`design-pilot-restructure.md` §4.1), since pilot is the other producer of
 * `tasks.code-review.<flavor>`. Adding a flavor edits this file AND requires the
 * matching pilot-side update (sage cortex#1185 review).
 *
 * ## Authoritative catalog — flavor → CodeReview workflow / primary lens
 *
 * This table is the SINGLE source the other review files render against:
 * `cortex.yaml.example`'s `code-review.<flavor>` capability catalog (every id
 * MUST be a row here — enforced by `review-flavors-catalog.test.ts`), the
 * `workflowForFlavor` map in `src/runner/review-prompt.ts` (the contractual
 * skill/workflow invocation, compass#96 F3), and the arc-skill-code-review
 * `SKILL.md` routing table (Round-2 skill PR).
 *
 * | flavor            | CodeReview workflow | primary lens emphasis                    |
 * |-------------------|---------------------|------------------------------------------|
 * | `generic`         | FullReview          | all lenses, no language specialisation   |
 * | `typescript`      | FullReview          | Correctness/Types (TypeScript idioms)    |
 * | `python`          | FullReview          | Correctness/Types (Python idioms)        |
 * | `rust`            | FullReview          | Correctness/Types (Rust idioms)          |
 * | `go`              | FullReview          | Correctness/Types (Go idioms)            |
 * | `sql`             | FullReview          | Correctness (queries, migrations)        |
 * | `docs`            | FullReview          | Documentation (specs, design docs)       |
 * | `security`        | SecurityReview      | Security (auth, secrets, OWASP)          |
 * | `confidentiality` | FullReview          | Confidentiality (always-on §4 L3 block)  |
 * | `hardening`       | HardeningReview     | Hardening (defensive boundaries)         |
 * | `skill-quality`   | SkillReview         | Skill quality (AGENTSKILLS.io structure) |
 *
 * `security`, `hardening`, and `skill-quality` name a DEDICATED workflow; every
 * other flavor runs FullReview with its primary-lens emphasis (a `confidentiality`
 * request runs FullReview because the Confidentiality lens is already always-on
 * for every review — compass#96 F3 decision, no separate ConfidentialityReview
 * workflow). `architecture` / `performance` / `ecosystem-compliance` are LENSES
 * inside FullReview, NOT standalone flavors — they are deliberately absent from
 * this catalog (a `code-review.architecture` capability is a phantom).
 */
export const REVIEW_FLAVORS = [
  "generic",
  "typescript",
  "python",
  "rust",
  "go",
  "sql",
  "docs",
  "security",
  // Cross-cutting lens, orthogonal to language — a `code-review.confidentiality`
  // request selects the Confidentiality lens as the PRIMARY lens (compass#89 /
  // design-software-factory-confidentiality.md §4 L3). Kept in lockstep with
  // pilot's `KNOWN_SPECIALIZATIONS.CONFIDENTIALITY`. NOTE: the confidentiality
  // *exposure* instruction is always-on for EVERY flavor in `buildReviewPrompt`;
  // this flavor additionally makes it requestable as the primary lens.
  "confidentiality",
  // compass#96 F16 (WIDEN) — the two flavors whose CodeReview workflows already
  // ship (HardeningReview, SkillReview) but were not bus-reachable as flavors.
  // Adding them makes the `code-review.hardening` / `code-review.skill-quality`
  // capabilities in `cortex.yaml.example` resolve (no phantom) and the catalog
  // table above truthful. Kept in lockstep with pilot's KNOWN_SPECIALIZATIONS.
  "hardening",
  "skill-quality",
] as const;

export type ReviewFlavor = (typeof REVIEW_FLAVORS)[number];

/** True when `flavor` is a known review flavor. */
export function isReviewFlavor(flavor: string): flavor is ReviewFlavor {
  return (REVIEW_FLAVORS as readonly string[]).includes(flavor);
}

/**
 * The `<flavor>` of a `code-review.<flavor>` capability, or undefined when the
 * capability is not a known flavored review capability. The ONE place the
 * `code-review.<flavor>` syntax is parsed — used by both the config schema and
 * the reflex bridge.
 */
export function reviewFlavorOfCapability(capability: string): ReviewFlavor | undefined {
  const flavor = /^code-review\.([a-z][a-z0-9-]*)$/.exec(capability)?.[1];
  return flavor !== undefined && isReviewFlavor(flavor) ? flavor : undefined;
}
