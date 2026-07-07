/**
 * FLG-4 / §3.5 / #1600 (docs/plan-mc-future-state.md §3.5, §4.D) — the
 * **hub-admin authorship check** for a member's sealed roster row.
 *
 * The R1-anchor finding #1600: *"member never checks admin authorship on the
 * sealed row"*. The glass trust plane must SURFACE and VERIFY the hub-admin
 * `{claim, signature}` that was posted alongside a member's sealed secret
 * (`network secret add-member` → `POST /admission-requests/:id/sealed-secret`,
 * signed by the hub-admin — see `network-secret-adapters.ts` `buildLiveSealDeliveryPort`)
 * against the **pinned** network-admin pubkey, BEFORE the glass presents the row
 * as trustworthy. The honesty invariant (plan §3.5, invariant "truth-not-theater"):
 * **never render "verified" without actually running the check.**
 *
 * This module is the PURE verification primitive. It is deliberately tiny,
 * side-effect-free (one WebCrypto verify), and never-throws — so it is trivially
 * unit-testable and safe to call from the never-throw admission-read path.
 *
 * ## The three honest outcomes (never a fourth, never a fabricated pass)
 *
 *   - `"verified"`      — authorship material is present, a pinned network-admin
 *                         pubkey is configured, the claim asserts THAT admin, and
 *                         the Ed25519 signature over `canonicalJSON(claim)`
 *                         verifies. This is the ONLY path that returns verified,
 *                         and it requires the real signature check to pass.
 *   - `"unverifiable"`  — material is present but the check does NOT pass: the
 *                         claimed admin pubkey differs from the pinned one, or the
 *                         signature fails to verify. A NEGATIVE result — the row's
 *                         authorship is asserted but wrong/mismatched. Surfaced,
 *                         never hidden.
 *   - `"unchecked"`     — the check could not be RUN: no pinned network-admin
 *                         pubkey is configured, or the row carries no authorship
 *                         material (today the registry does not yet persist the
 *                         hub-admin `{claim, signature}` on the row — see the
 *                         residual-risk note in the FLG-4 PR). Distinct from
 *                         `unverifiable`: "we didn't check" ≠ "we checked and it
 *                         failed". The glass presents it as an honest gap, not a
 *                         pass and not a failure.
 *
 * ## Why not fold `unchecked` into `unverifiable`
 *
 * Collapsing "couldn't check" into "check failed" would either over-warn (a
 * correctly-sealed row with no pinned key looks compromised) or, worse, tempt a
 * consumer to treat the absence of a negative as a positive. Keeping the third
 * state forces the UI to say exactly what is true: verified, contradicted, or
 * not-yet-checkable.
 */

import { verifyEd25519 } from "../../common/registry/signing";
import { canonicalJSON } from "../../common/registry/canonical-json";

/**
 * The hub-admin authorship material carried alongside a member's sealed row —
 * the signed claim + signature the hub-admin posted with the sealed secret
 * (`sealed-secret` route claim: `{ request_id, sealed_secret, hub_admin_pubkey,
 * issued_at, nonce }`, signed with the hub-admin seed). Present ONLY when the
 * read surfaces it; today's registry member-read does not (residual risk).
 *
 * The `sealed_secret` field of the original claim is deliberately NOT required
 * here — a consumer verifying authorship must be able to pass the claim WITHOUT
 * re-transiting the sealed ciphertext (secret-material discipline, invariant 6).
 * Whatever claim object is passed is canonicalised + verified verbatim; the
 * caller is responsible for handing over the SAME claim bytes that were signed.
 */
export interface RosterAuthorshipMaterial {
  /**
   * The hub-admin's signed claim object, verbatim as it was signed (verified via
   * `canonicalJSON(claim)`). Opaque here — the caller supplies the exact bytes.
   */
  claim: unknown;
  /** Base64 Ed25519 signature over `canonicalJSON(claim)`. */
  signature: string;
  /** Base64 Ed25519 pubkey the claim asserts authorship for (the hub-admin key). */
  hub_admin_pubkey: string;
}

/**
 * The resolved authorship verdict for a roster row — the honest tri-state above.
 * Stable, non-localized tokens (safe for `data-*` attributes + tests).
 */
export type RosterAuthorship = "verified" | "unverifiable" | "unchecked";

/**
 * Verify a member row's hub-admin authorship against the PINNED network-admin
 * pubkey (#1600). Never throws — a malformed claim / bad base64 / crypto failure
 * all resolve to `"unverifiable"` (a definitive negative), never a thrown error
 * and never a silent pass.
 *
 * Fail-closed by construction: the ONLY branch that returns `"verified"` is the
 * one where a real Ed25519 verify PASSES against the pinned key. Every other
 * path is `unchecked` (couldn't run) or `unverifiable` (ran, did not pass).
 *
 * @param material            The row's authorship material, or `undefined` when
 *                            the read carries none → `"unchecked"`.
 * @param pinnedAdminPubkey   The base64 network-admin pubkey pinned in config, or
 *                            `undefined`/empty when none is configured →
 *                            `"unchecked"` (we refuse to verify against an
 *                            unpinned/attacker-suppliable key — the pin is the
 *                            trust anchor, mandatory + fail-closed per §3.5).
 */
export async function verifyRosterAuthorship(
  material: RosterAuthorshipMaterial | undefined,
  pinnedAdminPubkey: string | undefined,
): Promise<RosterAuthorship> {
  // No pinned trust anchor ⇒ we cannot verify authorship against anything
  // trustworthy. Never verify against the pubkey the row itself supplies (that
  // would let a forged row assert its own authorship). Honest "unchecked".
  if (pinnedAdminPubkey === undefined || pinnedAdminPubkey === "") {
    return "unchecked";
  }
  // No material on the row ⇒ nothing to check (today's common live case — the
  // registry does not yet persist the hub-admin {claim,signature}). "unchecked",
  // NOT "unverifiable": we did not run a check that failed.
  if (material === undefined) {
    return "unchecked";
  }
  // The claim must assert authorship for the SAME admin we pinned. A claim signed
  // by (and asserting) a DIFFERENT key than the pinned network-admin is a
  // definitive negative — the row's authorship does not match the trusted admin.
  if (material.hub_admin_pubkey !== pinnedAdminPubkey) {
    return "unverifiable";
  }
  // Run the real signature check over the canonical claim bytes. verifyEd25519
  // is itself never-throw (returns false on any malformed input), so this is the
  // complete decision: pass ⇒ verified, fail ⇒ unverifiable.
  const message = new TextEncoder().encode(canonicalJSON(material.claim));
  const ok = await verifyEd25519(pinnedAdminPubkey, material.signature, message);
  return ok ? "verified" : "unverifiable";
}
