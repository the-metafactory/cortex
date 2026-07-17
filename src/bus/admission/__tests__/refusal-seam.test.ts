/**
 * RFC-0010 §2.4 seam-consistency conformance (cortex#2189 / myelin#235 W5).
 *
 * These cases replay the myelin `specs/vectors/rate-limit/` seam vectors
 * verbatim (ids cited per case) so cortex's `checkSeamConsistency` op is proven
 * conformant with the same fixtures the myelin #239 runner binds. Prose
 * explains; vectors bind (RFC-0010 §8).
 */
import { describe, expect, test } from "bun:test";
import {
  checkSeamConsistency,
  dispositionForRefusalKind,
  isMirrorRefusalKind,
  MIRROR_REFUSAL_KINDS,
  SEAM_MISMATCH_WARNING,
} from "../refusal-seam";

describe("checkSeamConsistency — RFC-0010 §2.4 (vector-conformant)", () => {
  test("seam/mirror-agreement — a mirror kind equals the co-carried token → well-formed", () => {
    // vector: valid.json "seam/mirror-agreement"
    const result = checkSeamConsistency(
      { kind: "not_now" },
      { finalReason: "not_now" },
    );
    expect(result.wellFormed).toBe(true);
  });

  test("seam/policy-denied-with-term-disposition — non-mirror kind pairs with term → well-formed", () => {
    // vector: valid.json "seam/policy-denied-with-term-disposition"
    const result = checkSeamConsistency(
      { kind: "policy_denied" },
      { disposition: "term" },
    );
    expect(result.wellFormed).toBe(true);
  });

  test("seam/mirror-mismatch-malformed — a mirror kind contradicting its token is MALFORMED → route on token", () => {
    // vector: invalid.json "seam/mirror-mismatch-malformed"
    // final_reason: "not_now" vs reason.kind: "cant_do".
    const result = checkSeamConsistency(
      { kind: "cant_do" },
      { finalReason: "not_now" },
    );
    expect(result.wellFormed).toBe(false);
    if (!result.wellFormed) {
      expect(result.reason).toBe("seam-mismatch");
      // §2.4: the receiver MUST route on the transport token, discarding the
      // object's cause — the token, not the object, is authoritative.
      expect(result.routeOn).toEqual({ finalReason: "not_now" });
      expect(result.warning).toBe(SEAM_MISMATCH_WARNING);
    }
  });

  test("disposition flavour: `not_now` MUST route `nak`, never `term` (§2.3 term-forbidden)", () => {
    // A rate limit that terminated work would convert backpressure into data
    // loss — the mismatch the tripwire in `failedReasonToAckDecision` guards.
    const ok = checkSeamConsistency({ kind: "not_now" }, { disposition: "nak" });
    expect(ok.wellFormed).toBe(true);

    const bad = checkSeamConsistency({ kind: "not_now" }, { disposition: "term" });
    expect(bad.wellFormed).toBe(false);
    if (!bad.wellFormed) {
      expect(bad.routeOn).toEqual({ disposition: "term" });
      expect(bad.warning).toBe(SEAM_MISMATCH_WARNING);
    }
  });

  test("permanent mirror kinds map to `term` (cant_do / wont_do / compliance_block)", () => {
    for (const kind of ["cant_do", "wont_do", "compliance_block"] as const) {
      expect(
        checkSeamConsistency({ kind }, { disposition: "term" }).wellFormed,
      ).toBe(true);
      expect(
        checkSeamConsistency({ kind }, { disposition: "nak" }).wellFormed,
      ).toBe(false);
    }
  });

  test("an unknown kind carries no machine-readable cause — never a mismatch, route on token", () => {
    // §2.2 closed registry: an unknown kind is not a crash and cannot contradict
    // the token (it carries nothing) — the receiver routes on the token.
    expect(
      checkSeamConsistency({ kind: "quota_exceeded" }, { finalReason: "not_now" })
        .wellFormed,
    ).toBe(true);
    expect(
      checkSeamConsistency({ kind: "quota_exceeded" }, { disposition: "term" })
        .wellFormed,
    ).toBe(true);
    // An absent kind is likewise no-cause.
    expect(
      checkSeamConsistency({}, { disposition: "nak" }).wellFormed,
    ).toBe(true);
  });

  test("registry + disposition helpers match §2.2/§2.3", () => {
    expect([...MIRROR_REFUSAL_KINDS]).toEqual([
      "cant_do",
      "wont_do",
      "not_now",
      "compliance_block",
    ]);
    expect(isMirrorRefusalKind("policy_denied")).toBe(false);
    expect(isMirrorRefusalKind("not_now")).toBe(true);
    expect(isMirrorRefusalKind(undefined)).toBe(false);
    expect(dispositionForRefusalKind("not_now")).toBe("nak");
    expect(dispositionForRefusalKind("policy_denied")).toBe("term");
    expect(dispositionForRefusalKind("cant_do")).toBe("term");
  });
});
