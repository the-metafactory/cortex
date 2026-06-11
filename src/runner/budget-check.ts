/**
 * CO-7 M6 (epic cortex#939) — the **BudgetCheck** cost-cap seam for public work.
 *
 * ## The threat (design §6 attack #5, M6, open question 2)
 *
 * Reviewing a stranger's PR costs tokens. An adversary can submit huge or
 * pathological PRs to drain a principal's token budget (resource exhaustion /
 * cost). The design's M6 pairs the (existing CO-4) rate-limit with a **cost cap**
 * — but `BudgetCheck` is a **flagged, stubbed building-block gap** (design §6 M6,
 * open question 2). CO-7 does NOT build the real budget accounting; it builds the
 * SEAM + a FAIL-CLOSED default, and files a follow-up for the real BudgetCheck.
 *
 * ## The fail-closed contract (the security-relevant part)
 *
 * The model is: a public unit of work needs an authority that confirms there is
 * budget for it. Until the real BudgetCheck lands, the ONLY authority that exists
 * is a STATIC per-request cost cap declared in the offering's `limits`
 * (`cost_cents_per_request` — already in CO-1's `PublicLimitsSchema`). The seam
 * therefore resolves like this:
 *
 *   - **No budget authority configured** (no `cost_cents_per_request` on the
 *     public offering's `limits`) ⇒ **REFUSE** (`budgetOk: false`). Public work
 *     does not proceed without a declared cost bound. This is the fail-closed
 *     default the design demands: "public work refuses if no budget authority."
 *   - **A per-request cap is declared** ⇒ the seam admits (`budgetOk: true`)
 *     because the static cap bounds a single request's spend; the REAL
 *     accumulating-spend BudgetCheck (does the principal have budget left across
 *     requests?) is the deferred follow-up. The seam returns `degraded: true` in
 *     this case so the caller can surface that only the static cap — not real
 *     accounting — is enforcing.
 *   - **`local`/`federated`** ⇒ not gated by BudgetCheck (`budgetOk: true`,
 *     `degraded: false`); the cost cap is a `public` floor knob.
 *
 * The seam is the single chokepoint the future real BudgetCheck replaces: when
 * it lands it swaps the body of {@link checkBudget} for real accounting; the
 * call sites (the gate-floor `complianceOk`/budget context) stay unchanged.
 *
 * ## Why this is a GATE, not a stub-open
 *
 * A stub that returned `budgetOk: true` unconditionally would be an
 * insecure-open hole (public work with no cost bound at all). This seam instead
 * REFUSES public work that has no declared cost authority — the deferred infra
 * becomes a safety gate, exactly the CO-7 scope rule. The real accumulating
 * BudgetCheck is tracked in **cortex#977** (it replaces this seam's body; the
 * call sites stay unchanged).
 *
 * Pure + total — unit-tested in `__tests__/budget-check.test.ts`.
 *
 * Anchors: docs/design-capability-offering.md §6 (M6) + open question 2 ·
 *          src/common/types/offering.ts (`PublicLimits.cost_cents_per_request`) ·
 *          ADR-0008 DD-CO-3.
 */

import type { AcceptPolicy, OfferScope } from "../common/types/offering";

/** The result of a budget check. */
export interface BudgetDecision {
  /** Whether budget admits the request. `false` ⇒ refuse (cost/budget bound). */
  budgetOk: boolean;
  /**
   * `true` when admission rests on the STATIC per-request cap only (the real
   * accumulating BudgetCheck is the deferred follow-up). Lets the caller log /
   * surface that budget enforcement is degraded — never silently "fully
   * enforced". `false` for local/federated (not budget-gated) and for the
   * fail-closed refusal.
   */
  degraded: boolean;
  /** A short class-level reason (for logging / the refusal detail). */
  reason: string;
}

/** Extract the public offering's `cost_cents_per_request` cap, if any. */
function costCapCents(accept: AcceptPolicy | undefined): number | undefined {
  if (accept?.kind !== "surface") return undefined;
  return accept.limits?.cost_cents_per_request;
}

/**
 * Resolve the M6 budget check for an offered-capability dispatch, scaled by
 * offer-scope.
 *
 *   - `local` / `federated` → not budget-gated: `{ budgetOk: true, degraded: false }`.
 *   - `public` →
 *       - the public offering declares a `cost_cents_per_request` cap ⇒
 *         `{ budgetOk: true, degraded: true }` (static cap enforces; real
 *         accounting deferred).
 *       - NO cost cap declared ⇒ FAIL-CLOSED `{ budgetOk: false }` (public work
 *         refuses without a budget authority).
 *
 * Pure + total: no I/O, no throw. The real accumulating BudgetCheck (the
 * deferred follow-up) replaces the public branch's body without touching callers.
 */
export function checkBudget(
  scope: OfferScope,
  accept: AcceptPolicy | undefined,
): BudgetDecision {
  if (scope !== "public") {
    return { budgetOk: true, degraded: false, reason: "not budget-gated (non-public scope)" };
  }
  const cap = costCapCents(accept);
  if (cap === undefined) {
    // Fail-closed: no declared budget authority ⇒ public work refuses.
    return {
      budgetOk: false,
      degraded: false,
      reason:
        "public offering declares no cost authority (accept.limits.cost_cents_per_request) — " +
        "fail-closed: public work refuses without a budget bound (design §6 M6; real " +
        "accumulating BudgetCheck is a tracked follow-up)",
    };
  }
  return {
    budgetOk: true,
    degraded: true,
    reason: `static per-request cost cap (${cap} cents) enforces; accumulating BudgetCheck deferred`,
  };
}
