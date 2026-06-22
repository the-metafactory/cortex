/**
 * The three per-scope review-consumer subject patterns for an agent on a given
 * principal/stack. THE single source of these pattern shapes (cortex#1186):
 * cortex's consumer provisioning (`src/cortex.ts`) and the disjointness test
 * (`review-filter-disjoint.test.ts`) both build from here, so the test proves
 * the REAL filter contract rather than stale hand-copied strings.
 *
 * Disjoint by construction:
 *  - `local.…` vs `federated.…` first tokens can never both match one subject;
 *  - the Direct pattern carries an extra whole-token `*` (the pilot#149
 *    `@{did}`-encoded reviewer segment, spliced after `tasks.`) that the Offer
 *    pattern has no slot for, so a Direct request never matches the Offer
 *    pattern and vice-versa.
 */
export interface ReviewScopePatterns {
  /** Local-scope binding: `local.{principal}.{stack}.tasks.code-review.>`. */
  local: string;
  /** Federated Offer binding: `federated.{principal}.{stack}.tasks.code-review.>`. */
  federatedOffer: string;
  /** Federated Direct binding (extra `@{did}` token): `federated.{principal}.{stack}.tasks.*.code-review.>`. */
  federatedDirect: string;
}

/** Build the per-scope review subject patterns for a principal/stack. */
export function reviewScopePatterns(principal: string, stack: string): ReviewScopePatterns {
  return {
    local: `local.${principal}.${stack}.tasks.code-review.>`,
    federatedOffer: `federated.${principal}.${stack}.tasks.code-review.>`,
    federatedDirect: `federated.${principal}.${stack}.tasks.*.code-review.>`,
  };
}
