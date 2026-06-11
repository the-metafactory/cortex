/**
 * CO-4 (epic cortex#939) — admission-wiring tests.
 *
 * Pins the `resolveOffering` → `gateFloorForScope` composition, with the
 * load-bearing BYTE-IDENTICAL-LOCAL contract front and centre: with no offering
 * (or a local offering) a `local` dispatch admits unconditionally, reading
 * NONE of the floor context — exactly today's home-bus admission.
 *
 * Anchors: docs/design-capability-offering.md §9-CO-4 · ADR-0008 DD-CO-3.
 */

import { describe, test, expect } from "bun:test";

import { admitOfferedDispatch } from "../admit-offered-dispatch";
import type { GateFloorContext } from "../gate-floor";
import type { Offering } from "../../common/types/offering";

/** A hostile context: nothing passes. Proves local NEVER reads it. */
const hostileCtx: GateFloorContext = {
  signed: false,
  peerInNetwork: false,
  surfaceVerified: false,
  surfacePredicatePassed: false,
  complianceOk: false,
  rateOk: false,
};

/** A fully-admitting context for federated/public happy paths. */
function okCtx(overrides: Partial<GateFloorContext> = {}): GateFloorContext {
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

// ---------------------------------------------------------------------------
// Byte-identical-local
// ---------------------------------------------------------------------------

describe("admitOfferedDispatch — byte-identical local", () => {
  test("no offerings + local arrival ⇒ admit, ignoring a hostile context", () => {
    const d = admitOfferedDispatch({
      capability: "dev.implement",
      offerings: undefined,
      arrivedScope: "local",
      signing: "off",
      ctx: hostileCtx,
    });
    expect(d.admit).toBe(true);
  });

  test("an explicit local-only offering + local arrival ⇒ admit (hostile ctx)", () => {
    const offerings: Offering[] = [{ capability: "dev.implement", scopes: ["local"] }];
    const d = admitOfferedDispatch({
      capability: "dev.implement",
      offerings,
      arrivedScope: "local",
      signing: "off",
      ctx: hostileCtx,
    });
    expect(d.admit).toBe(true);
  });

  test("a capability offered wider STILL admits a local-arriving dispatch (local is in scope)", () => {
    // Offered federated, but the dispatch arrived on a local subject → the
    // local floor applies (no extra floor) — widening doesn't break the home bus.
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["local", "federated"],
        accept: { kind: "network", network: "metafactory-net" },
      },
    ];
    const d = admitOfferedDispatch({
      capability: "code-review.typescript",
      offerings,
      arrivedScope: "local",
      signing: "off",
      ctx: hostileCtx,
    });
    expect(d.admit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope-admission (defence-in-depth)
// ---------------------------------------------------------------------------

describe("admitOfferedDispatch — scope-admission", () => {
  test("a dispatch arriving at a scope the capability is NOT offered at ⇒ policy_denied", () => {
    // Offered local-only (default) but arrived public → not exposed at public.
    const d = admitOfferedDispatch({
      capability: "dev.implement",
      offerings: undefined,
      arrivedScope: "public",
      signing: "enforce",
      ctx: okCtx(),
    });
    expect(d.admit).toBe(false);
    if (!d.admit) {
      expect(d.refusal.kind).toBe("policy_denied");
      expect(JSON.stringify((d.refusal as { deny: unknown }).deny)).toContain(
        "scope_admission",
      );
    }
  });

  test("federated arrival for a federated offering, roster admits ⇒ admit", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["federated"],
        accept: { kind: "network", network: "metafactory-net" },
      },
    ];
    const d = admitOfferedDispatch({
      capability: "code-review.typescript",
      offerings,
      arrivedScope: "federated",
      signing: "permissive",
      ctx: okCtx(),
    });
    expect(d.admit).toBe(true);
  });

  test("public arrival for a public offering, full floor cleared ⇒ admit", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["public"],
        accept: {
          kind: "surface",
          surface: "github",
          predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
        },
      },
    ];
    const d = admitOfferedDispatch({
      capability: "code-review.typescript",
      offerings,
      arrivedScope: "public",
      signing: "enforce",
      ctx: okCtx(),
    });
    expect(d.admit).toBe(true);
  });

  test("public arrival, rate tripped ⇒ not_now (transient) flows through the wiring", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["public"],
        accept: {
          kind: "surface",
          surface: "github",
          predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
        },
      },
    ];
    const d = admitOfferedDispatch({
      capability: "code-review.typescript",
      offerings,
      arrivedScope: "public",
      signing: "enforce",
      ctx: okCtx({ rateOk: false }),
    });
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.refusal.kind).toBe("not_now");
  });
});
