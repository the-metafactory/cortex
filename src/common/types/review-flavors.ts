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
