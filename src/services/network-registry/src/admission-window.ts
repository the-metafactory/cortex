/**
 * cortex#2188 / RFC-0006 §7.3 §12 (M13) — the dual-accept window bookkeeping for
 * admission identity-binding.
 *
 * During the M13 window BOTH claim shapes are accepted: a WIDE claim (carrying
 * the `peer_pubkey` / `network_id` identity binding) and a legacy NARROW claim
 * (carrying neither). A narrow claim is still honoured — but it is COUNTED and a
 * deprecation warning is logged, so the eventual require-present flip (make the
 * binding mandatory) can be gated on a ZERO-narrow signal.
 *
 * IMPORTANT: the require-present flip is FUTURE and is NOT performed here. This
 * module only observes. The counter is best-effort in-process observability (it
 * resets with the worker isolate); the authoritative signal for the flip
 * decision is the aggregated deprecation-warning log line, which carries the
 * surface + request id.
 */

/** The identity-binding surfaces that run the dual-accept window. */
export type AdmissionWindowSurface = "decision" | "sealed-secret";

let narrowClaimCount = 0;

/**
 * Record that a NARROW (unbound) claim was accepted on the given surface:
 * increment the window counter and log the deprecation warning. Call ONLY on
 * the authentic + authorised path, after the claim is otherwise honoured.
 */
export function recordNarrowAdmissionClaim(
  surface: AdmissionWindowSurface,
  requestId: string,
): void {
  narrowClaimCount += 1;
  // console.warn is the Cloudflare Workers-native log sink (no process.stderr in
  // workerd). One line per narrow claim so the aggregate is countable for the
  // require-present flip gate.
  console.warn(
    `admission-window: DEPRECATED narrow (unbound) ${surface} claim accepted for ` +
      `request ${requestId} — RFC-0006 §7.3 identity binding (peer_pubkey/network_id) ` +
      `absent. The require-present flip is gated on zero narrow claims (M13). ` +
      `narrow_claim_count=${narrowClaimCount}`,
  );
}

/** Current in-process count of accepted narrow claims (both surfaces). */
export function narrowAdmissionClaimCount(): number {
  return narrowClaimCount;
}

/** Test-only: reset the window counter between cases. */
export function _resetAdmissionWindowForTest(): void {
  narrowClaimCount = 0;
}
