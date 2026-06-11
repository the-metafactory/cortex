/**
 * CO-7 (epic cortex#939) — the **review-hardening composer**: the single place
 * the M1/M2/M4/M5/M6 defenses are assembled per offer-scope, so the boot wiring
 * (`src/cortex.ts`) wires ONE helper per scope-bound review consumer instead of
 * threading five mitigations through the construction site.
 *
 * ## What it composes
 *
 *   - **M1** ({@link buildUntrustedReviewPrompt}) — the untrusted-content
 *     boundary in the review prompt. Wider scope ⇒ the hardened prompt; `local`
 *     ⇒ the plain {@link buildReviewPrompt} (byte-identical).
 *   - **M2** ({@link lockdownReviewSessionOpts}) — the least-privilege session.
 *     Wider scope ⇒ the locked opts; `local` ⇒ the baseline (byte-identical).
 *   - **M6 / budget** ({@link checkBudget}) — the fail-closed cost-cap seam,
 *     surfaced as the `complianceOk` boolean the CO-4 gate-floor reads (a
 *     fail-closed budget ⇒ the public floor refuses `compliance_block`). The
 *     CO-4 floor's structural gates (signing/surface/predicate) still run FIRST;
 *     M6 contributes the compliance/budget verdict only.
 *   - **M4** ({@link scanEgress} / {@link egressBlockingFindings}) — the egress
 *     leakage check applied to the review's terminal output BEFORE it posts to a
 *     wider-scope surface. Exposed as {@link makeEgressGuard} so the pipeline /
 *     consumer applies it on the verdict/completed path.
 *
 * ## Byte-identical local (the contract)
 *
 * Every helper here SHORT-CIRCUITS on `scope === 'local'` to the pre-CO-7
 * behaviour: the plain prompt, the baseline session opts, no budget gate
 * (`complianceOk` left as the caller's default), no egress scan. With no
 * `policy.offerings`, every capability resolves `local`, so a stack today wires
 * exactly the pre-CO-7 path and boot is byte-identical. The hardening engages
 * only on the `federated.`/`public.` consumers CO-2 binds once a capability is
 * offered wider.
 *
 * Pure assembly — the heavy lifting lives in the per-mitigation modules; this is
 * the composition seam. Unit-tested in `__tests__/co7-review-hardening.test.ts`.
 *
 * Anchors: docs/design-capability-offering.md §6 (M1–M6) · ADR-0008 DD-CO-6 ·
 *          ADR-0010 · docs/security-co7-redteam-gate.md (M5).
 */

import type { ReviewRequestPayload } from "../bus/review-events";
import type { AcceptPolicy, OfferScope } from "../common/types/offering";
import { buildReviewPrompt } from "./review-prompt";
import { buildUntrustedReviewPrompt } from "./untrusted-content-boundary";
import {
  lockdownReviewSessionOpts,
  type ReviewSessionOpts,
} from "./review-session-lockdown";
import { checkBudget } from "./budget-check";
import {
  egressBlockingFindings,
  scanEgress,
  type EgressFinding,
} from "./egress-check";

/** Map an arbitrary offer-scope to the egress-policy scope union. */
function egressScope(scope: OfferScope): "local" | "federated" | "public" {
  return scope;
}

/**
 * M1 — the scope-aware review prompt builder. `local` ⇒ the plain trusted
 * prompt (byte-identical); wider ⇒ the untrusted-content-boundary prompt.
 */
export function reviewPromptForScope(
  scope: OfferScope,
): (payload: ReviewRequestPayload) => string {
  return scope === "local" ? buildReviewPrompt : buildUntrustedReviewPrompt;
}

/**
 * M2 — the scope-aware session opts. `local` ⇒ baseline unchanged; wider ⇒
 * the least-privilege lockdown. The caller supplies the per-review scratch dir
 * for the wider case (the lockdown confines `allowedDirs` to it).
 */
export function reviewSessionOptsForScope(input: {
  baseline: ReviewSessionOpts;
  scope: OfferScope;
  agentId: string;
  scratchDir?: string;
}): ReviewSessionOpts {
  return lockdownReviewSessionOpts({
    baseline: input.baseline,
    scope: input.scope,
    agentId: input.agentId,
    ...(input.scratchDir !== undefined && { scratchDir: input.scratchDir }),
  });
}

/**
 * M6 — resolve the budget/compliance boolean the CO-4 gate-floor reads as
 * `complianceOk`. For `public`, this is the fail-closed BudgetCheck seam
 * ({@link checkBudget}): a public offering with no declared cost authority ⇒
 * `false` ⇒ the public floor refuses `compliance_block`. For `local`/`federated`
 * the budget gate does not apply, so this returns the caller-supplied
 * `priorComplianceOk` (defaulting to `true`) UNCHANGED — M6 only TIGHTENS, never
 * loosens, the compliance verdict.
 *
 * Returns the verdict plus a `degraded` flag + reason for honest logging.
 */
export function resolveComplianceOk(input: {
  scope: OfferScope;
  accept: AcceptPolicy | undefined;
  /** Any compliance verdict already decided upstream (default `true`). */
  priorComplianceOk?: boolean;
}): { complianceOk: boolean; degraded: boolean; reason: string } {
  const prior = input.priorComplianceOk ?? true;
  const budget = checkBudget(input.scope, input.accept);
  // M6 can only tighten: prior AND budget.
  const complianceOk = prior && budget.budgetOk;
  return {
    complianceOk,
    degraded: budget.degraded,
    reason: budget.budgetOk ? budget.reason : `budget fail-closed: ${budget.reason}`,
  };
}

/** The egress guard verdict. `block` carries the (non-leaking) findings. */
export type EgressGuardResult =
  | { block: false }
  | { block: true; findings: EgressFinding[] };

/**
 * M4 — build the egress guard for a scope. The returned function scans a piece
 * of review output (the prose presentation / chat response that egresses to the
 * surface) and returns whether it must be BLOCKED before posting.
 *
 *   - `local` ⇒ the guard never blocks (trusted; returns `{block:false}` without
 *     scanning — byte-identical).
 *   - `federated`/`public` ⇒ scans via {@link scanEgress} and blocks on the
 *     scope's blocking findings ({@link egressBlockingFindings}).
 *
 * The guard is applied to the OUTPUT a surface would render — the structured
 * verdict's `summary`/`presentation` and the prose-fallback `presentation`. The
 * machine-trusted structured fields (counts, verdict kind) are not free text and
 * are not scanned; the free-text egress is.
 */
export function makeEgressGuard(
  scope: OfferScope,
): (output: string) => EgressGuardResult {
  if (scope === "local") {
    return () => ({ block: false });
  }
  const es = egressScope(scope);
  return (output: string): EgressGuardResult => {
    const scan = scanEgress(output);
    const blocking = egressBlockingFindings(es, scan);
    return blocking.length === 0 ? { block: false } : { block: true, findings: blocking };
  };
}
