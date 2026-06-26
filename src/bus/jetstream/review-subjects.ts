/**
 * The three per-scope review-consumer subject patterns for an agent on a given
 * principal/stack. THE single source of these pattern shapes (cortex#1186):
 * cortex's consumer provisioning (`src/cortex.ts`) and the disjointness test
 * (`review-filter-disjoint.test.ts`) both build from here, so the test proves
 * the REAL filter contract rather than stale hand-copied strings.
 *
 * Disjoint by construction — and now disjoint at the JetStream STREAM-subject
 * level too, not merely for request routing (cortex#1199):
 *  - `local.…` vs `federated.…` first tokens can never both match one subject;
 *  - the Offer pattern ends in a single-token `*` (a `code-review.{flavor}`
 *    capability is exactly `…tasks.code-review.{flavor}` — three task-suffix
 *    tokens; the flavor is one token, `[a-z][a-z0-9-]*`), while the Direct
 *    pattern carries the extra whole-token `*` (the pilot#149 `@{did}`-encoded
 *    reviewer segment) BEFORE `code-review`, so it is four task-suffix tokens.
 *
 * The earlier Offer pattern used a trailing `>` (`…tasks.code-review.>`), which
 * OVERLAPS the Direct `…tasks.*.code-review.>` under JetStream's stream-subject
 * rule (a pathological `tasks.code-review.code-review.x` matches both) even
 * though no real request ever does. JetStream rejects a stream whose subjects
 * overlap, so CODE_REVIEW failed to provision with "subjects overlap" once the
 * Direct pattern (cortex#1186) joined the set. Pinning the Offer to a single
 * trailing `*` makes Offer (3 task tokens) and Direct (4) token-count disjoint —
 * no subject can match both — so the stream provisions and routing is unchanged
 * (every real `code-review.{flavor}` task still matches `…code-review.*`).
 */
export interface ReviewScopePatterns {
  /** Local-scope binding: `local.{principal}.{stack}.tasks.code-review.*` (single-token flavor; `*` not `>` to stay uniform with the Offer family — cortex#1199). */
  local: string;
  /** Federated Offer binding: `federated.{principal}.{stack}.tasks.code-review.*` (single-token flavor; `*` not `>` so it stays JetStream-disjoint from the 4-token Direct pattern — cortex#1199). */
  federatedOffer: string;
  /** Federated Direct binding (extra `@{did}` token): `federated.{principal}.{stack}.tasks.*.code-review.>`. */
  federatedDirect: string;
}

/**
 * The Offer-family task suffix — single-token `*` flavor (cortex#1199). THE one
 * place this literal lives; cortex's offering-pattern call site imports it rather
 * than re-typing the string, so the stream filter can't drift from the consumer
 * patterns (the cortex#1199 review-major).
 */
export const REVIEW_OFFER_TASK_SUFFIX = "tasks.code-review.*";

/** Build the per-scope review subject patterns for a principal/stack. */
export function reviewScopePatterns(principal: string, stack: string): ReviewScopePatterns {
  return {
    local: `local.${principal}.${stack}.${REVIEW_OFFER_TASK_SUFFIX}`,
    federatedOffer: `federated.${principal}.${stack}.${REVIEW_OFFER_TASK_SUFFIX}`,
    federatedDirect: `federated.${principal}.${stack}.tasks.*.code-review.>`,
  };
}
