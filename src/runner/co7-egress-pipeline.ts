/**
 * CO-7 M4 (epic cortex#939) — the **egress-guard pipeline wrapper**.
 *
 * Wires the M4 output egress/leakage check ({@link makeEgressGuard}) onto a
 * review {@link runReviewPipeline}-shaped runner, for a wider-scope
 * (`federated`/`public`) review consumer. The wrapper runs the inner pipeline
 * unchanged, then — BEFORE the consumer publishes the terminal envelope — scans
 * the FREE-TEXT egress (the verdict's presentation/summary, or the prose-fallback
 * presentation) for leakage. On a blocking finding it CONVERTS the terminal into
 * a `compliance_block` failure so the leaking review is **never posted** to the
 * surface.
 *
 * ## Where this sits
 *
 * The review-consumer pipeline produces one of three terminal results
 * (`verdict` / `completed` / `failed` — see `review-pipeline.ts`). The verdict
 * and completed paths carry FREE TEXT that egresses to the surface (the verdict's
 * `payload.presentation` + `summary`, the completed prose `presentation`). M4
 * guards exactly that egress: a `verdict`/`completed` whose free text leaks is
 * rewritten to a `failed` with `compliance_block`. A `failed` terminal is passed
 * through (it does not post a review). The machine-trusted structured fields
 * (verdict kind, finding counts) are not free text and are not scanned.
 *
 * ## Byte-identical local
 *
 * The wrapper is applied ONLY for a wider-scope consumer (the caller passes a
 * non-`local` scope). On `local` the caller does not wrap at all (and the guard
 * itself would no-op anyway), so the local pipeline is byte-identical.
 *
 * ## No empty catch
 *
 * The wrapper does not introduce new failure modes: it reads the inner result
 * and the guard is pure. A scan finding is HANDLED (rewritten to a failed
 * terminal), never swallowed.
 *
 * Pure composition over the injected runner — unit-tested in
 * `__tests__/co7-egress-pipeline.test.ts`.
 *
 * Anchors: docs/design-capability-offering.md §6 (M4) · ADR-0008 DD-CO-6.
 */

import { createReviewTaskFailedEvent } from "../bus/review-events";
import type { OfferScope } from "../common/types/offering";
import { makeEgressGuard } from "./co7-review-hardening";
import {
  extractVerdictPresentation,
  type ReviewPipelineOpts,
  type ReviewPipelineResult,
} from "./review-pipeline";

/**
 * Wrap a review pipeline runner with the M4 egress guard for `scope`.
 *
 * `scope === 'local'` ⇒ returns the inner runner UNCHANGED (byte-identical;
 * never wrap a trusted local review). Wider scope ⇒ returns a runner that scans
 * the terminal's free-text egress and converts a leak to `compliance_block`.
 */
export function withCo7EgressGuard(
  scope: OfferScope,
  inner: (opts: ReviewPipelineOpts) => Promise<ReviewPipelineResult>,
): (opts: ReviewPipelineOpts) => Promise<ReviewPipelineResult> {
  if (scope === "local") return inner;
  const guard = makeEgressGuard(scope);

  return async (opts: ReviewPipelineOpts): Promise<ReviewPipelineResult> => {
    const result = await inner(opts);

    // Only the free-text-bearing terminals egress to the surface.
    const egressText =
      result.kind === "verdict"
        ? extractVerdictPresentation(result.envelope)
        : result.kind === "completed"
          ? result.presentation
          : null; // `failed` posts no review — nothing to guard.

    if (egressText === null) return result;

    const verdict = guard(egressText);
    if (!verdict.block) return result;

    // LEAK DETECTED — rewrite to a permanent compliance_block failure so the
    // review is NOT posted. The reasons name leak CLASSES only (never the
    // matched bytes — see egress-check), so the detail is safe to put on the
    // wire + in stderr.
    const classes = verdict.findings.map((f) => f.kind).join(", ");
    const detail =
      `CO-7 M4 egress guard blocked the review output: potential leakage ` +
      `(${classes}). The review was NOT posted to the surface.`;
    process.stderr.write(
      `cortex/co7-egress: BLOCKED review egress for correlation=${opts.requestEnvelope.id} ` +
        `scope=${scope} — ${verdict.findings.map((f) => f.reason).join("; ")}\n`,
    );
    const envelope = createReviewTaskFailedEvent({
      source: opts.source,
      taskId: crypto.randomUUID(),
      agentId: opts.agentId,
      correlationId: opts.requestEnvelope.id,
      startedAt: new Date(),
      failedAt: new Date(),
      errorSummary: detail,
      reason: { kind: "compliance_block", detail },
      ...(opts.responseRouting !== undefined && { responseRouting: opts.responseRouting }),
      ...(opts.classification !== undefined && { classification: opts.classification }),
    });
    return { kind: "failed", envelope };
  };
}
