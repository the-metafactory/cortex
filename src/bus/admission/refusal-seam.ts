/**
 * RFC-0010 §2.4 — the seam-consistency rule (chartered at RFC-0007 §3, owned by
 * RFC-0010). cortex#2189 / myelin#235 W5.
 *
 * A refusal object (RFC-0010 §2.1: `{ kind, detail?, retry_after_ms? }`) is
 * frequently CO-CARRIED with an RFC-0007 transport token — on
 * `dispatch.task.failed` / `dispatch.task.rejected` lifecycle payloads and on
 * the JetStream `ack`/`nak`/`term` disposition a consumer applies. The two
 * layers explain the same refusal from different planes; this module owns the
 * rule that keeps them coherent:
 *
 *   - **Disposition ALWAYS routes off the transport token** (RFC-0007 §3). The
 *     refusal object explains and hints; it NEVER overrides delivery.
 *   - A **mirror kind** (`cant_do` / `wont_do` / `not_now` / `compliance_block`)
 *     MUST agree with the co-carried token. A mismatched pair is **malformed** —
 *     a producer MUST NOT emit it, and a receiver MUST route on the token and
 *     treat the object as carrying no machine-readable cause (§2.4).
 *   - `policy_denied` is the **non-mirror** kind (RFC-0007 D4 evicted it from
 *     the transport set): permanent, deployed disposition `term` (§2.2/§2.3).
 *   - An **unknown** kind carries no machine-readable cause — the receiver
 *     routes on the token and surfaces `detail` verbatim (§2.2).
 *
 * `checkSeamConsistency` is the RFC §8 conformance operation. It is validated
 * by the `specs/vectors/rate-limit/` seam vectors (`seam/mirror-agreement`,
 * `seam/policy-denied-with-term-disposition`, `seam/mirror-mismatch-malformed`).
 */

/** The four §2.2 mirror kinds — each mirrors an RFC-0007 transport token. */
export type MirrorRefusalKind =
  | "cant_do"
  | "wont_do"
  | "not_now"
  | "compliance_block";

/** The closed §2.2 refusal-kind registry: four mirrors + the non-mirror
 * `policy_denied`. Adding/renaming/removing a member is a wire change (a new
 * RFC + a dual-accept window — the `policy_denied` incident is the precedent). */
export type RefusalKind = MirrorRefusalKind | "policy_denied";

/** The mirror kinds, in registry order. `policy_denied` is deliberately absent
 * — it is the non-mirror kind and is handled separately by the seam rule. */
export const MIRROR_REFUSAL_KINDS: readonly MirrorRefusalKind[] = [
  "cant_do",
  "wont_do",
  "not_now",
  "compliance_block",
];

/** JetStream disposition — the transport token in its delivery-plane flavour. */
export type Disposition = "ack" | "nak" | "term";

/**
 * The RFC-0007 transport token co-carried with a refusal object, in either of
 * its two ratified carriages (RFC-0010 §2.1):
 *   - `finalReason` — the mirror-kind-VALUED lifecycle token (`final_reason` on
 *     the wire): one of the §2.2 kinds.
 *   - `disposition` — the JetStream `ack`/`nak`/`term` a consumer applies.
 */
export type SeamToken =
  | { readonly finalReason: string }
  | { readonly disposition: Disposition };

/** The named warning a receiver emits when it discards a malformed refusal
 * object's cause and routes on the token (§2.4). Stable identifier so consumers
 * and dashboards can key on it. */
export const SEAM_MISMATCH_WARNING = "admission.refusal.seam_mismatch" as const;

export type SeamConsistency =
  | { readonly wellFormed: true }
  | {
      readonly wellFormed: false;
      readonly reason: "seam-mismatch";
      /** The transport token to route on — the object's cause is discarded. */
      readonly routeOn: SeamToken;
      /** The named warning to emit ({@link SEAM_MISMATCH_WARNING}). */
      readonly warning: typeof SEAM_MISMATCH_WARNING;
    };

/** §2.2 registry membership test for a mirror kind. */
export function isMirrorRefusalKind(k: string | undefined): k is MirrorRefusalKind {
  return k !== undefined && (MIRROR_REFUSAL_KINDS as readonly string[]).includes(k);
}

/**
 * The disposition a refusal kind maps to (RFC-0010 §2.2/§2.3, RFC-0007 §5):
 *   - `not_now` is TRANSIENT → `nak` (`term` is FORBIDDEN — a rate limit that
 *     killed work would convert backpressure into data loss, §2.3);
 *   - every permanent kind (`cant_do` / `wont_do` / `compliance_block` /
 *     `policy_denied`) → `term`.
 */
export function dispositionForRefusalKind(kind: RefusalKind): Disposition {
  return kind === "not_now" ? "nak" : "term";
}

function mismatch(token: SeamToken): SeamConsistency {
  return {
    wellFormed: false,
    reason: "seam-mismatch",
    routeOn: token,
    warning: SEAM_MISMATCH_WARNING,
  };
}

/**
 * Check the RFC-0010 §2.4 seam-consistency rule for a refusal object co-carried
 * with a transport token.
 *
 * Returns `{ wellFormed: true }` when the pair is coherent; otherwise
 * `{ wellFormed: false, reason: "seam-mismatch", routeOn, warning }` — the
 * caller MUST route on `routeOn` (the token) and treat the object as carrying no
 * machine-readable cause.
 *
 * @param refusal the refusal object (only `.kind` is consulted — `detail` MUST
 *   NOT drive routing, §2.1).
 * @param token   the co-carried RFC-0007 transport token.
 */
export function checkSeamConsistency(
  refusal: { readonly kind?: string },
  token: SeamToken,
): SeamConsistency {
  const kind = refusal.kind;

  if ("finalReason" in token) {
    // Mirror-kind-valued lifecycle token: a mirror kind MUST equal it exactly.
    if (isMirrorRefusalKind(kind)) {
      return kind === token.finalReason ? { wellFormed: true } : mismatch(token);
    }
    // `policy_denied` is non-mirror — it does not constrain a mirror-valued
    // token (disposition routes off the token, §2.4). An unknown/absent kind
    // carries no machine-readable cause. Both are wire-coherent: nothing to
    // contradict the token.
    return { wellFormed: true };
  }

  // Disposition-valued token (ack | nak | term).
  const disp = token.disposition;
  if (isMirrorRefusalKind(kind)) {
    return disp === dispositionForRefusalKind(kind)
      ? { wellFormed: true }
      : mismatch(token);
  }
  if (kind === "policy_denied") {
    // Permanent; the deployed pairing routes `term` (RFC-0007 D4). Any
    // permanence-matching disposition is well-formed.
    return disp === "term" ? { wellFormed: true } : mismatch(token);
  }
  // Unknown/absent kind: no machine-readable cause — route on the token.
  return { wellFormed: true };
}
