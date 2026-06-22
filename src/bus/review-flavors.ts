/**
 * Canonical review-flavor vocabulary — the SINGLE source of truth for the
 * `<flavor>` suffix of a `code-review.<flavor>` capability / `tasks.code-
 * review.<flavor>` subject.
 *
 * Deliberately a zero-import leaf module so BOTH the bus layer
 * (`review-events.ts`, `reflex-activation-listener.ts`) and the config layer
 * (`common/types/cortex-config.ts`) can import it without a cycle or pulling
 * envelope/runtime code into config validation. Adding a flavor edits ONLY
 * this tuple (sage cortex#1185 review).
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
] as const;

export type ReviewFlavor = (typeof REVIEW_FLAVORS)[number];

/** True when `flavor` is a known review flavor. */
export function isReviewFlavor(flavor: string): flavor is ReviewFlavor {
  return (REVIEW_FLAVORS as readonly string[]).includes(flavor);
}
