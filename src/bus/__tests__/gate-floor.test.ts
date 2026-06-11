/**
 * CO-4 (epic cortex#939) — per-offer-scope gate-floor tests.
 *
 * `gateFloorForScope` is the testable core of CO-4 (ADR-0008 DD-CO-3): the
 * pure function that, given a resolved offering's scope + accept-policy + the
 * stack's signing posture + a per-request context, decides whether an
 * offered-capability dispatch clears the STRUCTURAL gate floor its scope
 * demands — and, on failure, maps to the right refusal taxonomy entry
 * (`policy_denied` / `compliance_block` / `not_now`).
 *
 * The four pinned behaviours (task bar):
 *   1. local        → NO floor (always admit) — byte-identical.
 *   2. federated    → signing ≥ permissive + accept-policy roster check.
 *   3. public       → signing-enforce (bus peers) + compliance + rate + bounded accept.
 *   4. refusal mapping — each failed floor maps to the correct refusal kind.
 *
 * Anchors: docs/design-capability-offering.md §5 · ADR-0008 DD-CO-3 ·
 *          ADR-0010 (the Stage-1 metadata gate this floor enforces) ·
 *          CONTEXT.md §Capability offering / §Dispatch (refusal taxonomy).
 */

import { describe, test, expect } from "bun:test";

import {
  gateFloorForScope,
  type GateFloorContext,
  type GateFloorDecision,
} from "../gate-floor";
import type {
  FederatedAccept,
  PublicAccept,
} from "../../common/types/offering";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const networkAccept: FederatedAccept = {
  kind: "network",
  network: "metafactory-net",
};

const principalsAccept: FederatedAccept = {
  kind: "principals",
  principals: ["jcfischer", "alice"],
};

const publicAccept: PublicAccept = {
  kind: "surface",
  surface: "github",
  predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
  limits: { per_day: 100 },
};

/** A minimal admitting context: signed peer, surface metadata that passes. */
function ctx(overrides: Partial<GateFloorContext> = {}): GateFloorContext {
  return {
    signed: true,
    peerPrincipal: "jcfischer",
    peerInNetwork: true,
    surfaceVerified: true,
    surfacePredicatePassed: true,
    complianceOk: true,
    rateOk: true,
    ...overrides,
  };
}

function admit(d: GateFloorDecision): void {
  expect(d.admit).toBe(true);
}

// ---------------------------------------------------------------------------
// 1. local → no floor (byte-identical)
// ---------------------------------------------------------------------------

describe("gateFloorForScope — local scope (no floor)", () => {
  test("local admits regardless of signing posture", () => {
    for (const signing of ["off", "permissive", "enforce"] as const) {
      admit(gateFloorForScope("local", undefined, signing, ctx({ signed: false })));
    }
  });

  test("local admits even with an empty/hostile context — the home bus IS the floor", () => {
    const d = gateFloorForScope("local", undefined, "off", {
      signed: false,
      peerInNetwork: false,
      surfaceVerified: false,
      surfacePredicatePassed: false,
      complianceOk: false,
      rateOk: false,
    });
    expect(d.admit).toBe(true);
  });

  test("local ignores an (illegal) accept-policy rather than gating on it", () => {
    // The schema forbids a local-only offering carrying an accept; defensively
    // the floor still admits local (it never reads accept for local).
    admit(
      gateFloorForScope("local", networkAccept, "off", ctx({ signed: false })),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. federated → signing ≥ permissive + roster check
// ---------------------------------------------------------------------------

describe("gateFloorForScope — federated scope", () => {
  test("admits when signing is permissive, peer is signed + on the network roster", () => {
    admit(gateFloorForScope("federated", networkAccept, "permissive", ctx()));
  });

  test("admits when signing is enforce (a higher posture than the floor)", () => {
    admit(gateFloorForScope("federated", networkAccept, "enforce", ctx()));
  });

  test("REFUSES policy_denied when signing is off (below the permissive floor)", () => {
    const d = gateFloorForScope("federated", networkAccept, "off", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) {
      expect(d.refusal.kind).toBe("policy_denied");
    }
  });

  test("REFUSES policy_denied when the envelope is unsigned (federated needs proof)", () => {
    const d = gateFloorForScope(
      "federated",
      networkAccept,
      "permissive",
      ctx({ signed: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when the peer is NOT on the network roster", () => {
    const d = gateFloorForScope(
      "federated",
      networkAccept,
      "permissive",
      ctx({ peerInNetwork: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) {
      expect(d.refusal.kind).toBe("policy_denied");
      // The deny payload names the roster miss for audit.
      expect(JSON.stringify((d.refusal as { deny: unknown }).deny)).toContain(
        "roster",
      );
    }
  });

  test("principals accept — admits a named principal, refuses an unnamed one", () => {
    admit(
      gateFloorForScope(
        "federated",
        principalsAccept,
        "permissive",
        ctx({ peerPrincipal: "alice" }),
      ),
    );
    const d = gateFloorForScope(
      "federated",
      principalsAccept,
      "permissive",
      ctx({ peerPrincipal: "mallory" }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  // #968 review nit: a principals accept with an ABSENT peer identity must
  // refuse (default-to-refuse) — an unidentified peer is never "named".
  test("principals accept — refuses an absent peer identity (peerPrincipal undefined)", () => {
    const d = gateFloorForScope(
      "federated",
      principalsAccept,
      "permissive",
      ctx({ peerPrincipal: undefined }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when a federated offering carries no accept (default-deny)", () => {
    const d = gateFloorForScope("federated", undefined, "permissive", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });
});

// ---------------------------------------------------------------------------
// 3. public → enforce + compliance + rate + bounded accept
// ---------------------------------------------------------------------------

describe("gateFloorForScope — public scope", () => {
  test("admits when signing=enforce, surface verified, predicate passed, compliance + rate ok", () => {
    admit(gateFloorForScope("public", publicAccept, "enforce", ctx()));
  });

  test("REFUSES policy_denied when signing is only permissive (public needs enforce)", () => {
    const d = gateFloorForScope("public", publicAccept, "permissive", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when signing is off", () => {
    const d = gateFloorForScope("public", publicAccept, "off", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when the surface is not HMAC-verified (no trust anchor)", () => {
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "enforce",
      ctx({ surfaceVerified: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when the metadata accept-predicate did not pass (bounded accept)", () => {
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "enforce",
      ctx({ surfacePredicatePassed: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES compliance_block when the compliance hook fails", () => {
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "enforce",
      ctx({ complianceOk: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("compliance_block");
  });

  test("REFUSES not_now when the rate-limit gate trips (transient backpressure)", () => {
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "enforce",
      ctx({ rateOk: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) {
      expect(d.refusal.kind).toBe("not_now");
      // not_now carries a retry hint so the requester can back off.
      expect((d.refusal as { retry_after_ms?: number }).retry_after_ms).toBeDefined();
    }
  });

  test("REFUSES policy_denied when a public offering carries no accept (default-deny)", () => {
    const d = gateFloorForScope("public", undefined, "enforce", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("REFUSES policy_denied when a federated accept is paired with a public scope (kind mismatch)", () => {
    const d = gateFloorForScope("public", networkAccept, "enforce", ctx());
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });
});

// ---------------------------------------------------------------------------
// 4. ordering — the most-severe / most-specific refusal wins deterministically
// ---------------------------------------------------------------------------

describe("gateFloorForScope — refusal ordering (deterministic)", () => {
  test("public: signing floor is checked before compliance/rate (structural admission first)", () => {
    // signing off + compliance also failing → the signing/structural refusal
    // (policy_denied) wins; we never reach the compliance hook.
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "off",
      ctx({ complianceOk: false, rateOk: false }),
    );
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("policy_denied");
  });

  test("public: compliance is checked before rate (compliance is permanent, rate is transient)", () => {
    const d = gateFloorForScope(
      "public",
      publicAccept,
      "enforce",
      ctx({ complianceOk: false, rateOk: false }),
    );
    expect(d.admit).toBe(false);
    // Permanent compliance refusal wins over the transient rate refusal so a
    // structurally-forbidden request is not endlessly retried.
    if (!d.admit) expect(d.refusal.kind).toBe("compliance_block");
  });
});
