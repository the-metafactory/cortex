/**
 * CO-1 (epic cortex#939) — capability offering model tests.
 *
 * Mirrors the cortex-config schema test style: schema accept/reject per field,
 * the closed per-scope accept-policy tagged union, the metadata-only public
 * predicate constraint (ADR-0010 DD-CO-8), the cross-offering coherence rules
 * (`superRefineOfferings`: federated-requires-naming = default-deny, scope↔
 * accept agreement, no-duplicate-capability), and the `resolveOffering`
 * default-deny resolver (ADR-0008 DD-CO-1).
 */

import { describe, test, expect } from "bun:test";

import {
  OfferScopeSchema,
  OfferingSchema,
  AcceptPolicySchema,
  PublicPredicateSchema,
  FederatedAcceptSchema,
  PublicAcceptSchema,
  PublicLimitsSchema,
  superRefineOfferings,
  resolveOffering,
  offeringSubjectPatterns,
  type Offering,
  type OfferScope,
} from "../offering";

// =============================================================================
// OfferScope — the trust tier enum
// =============================================================================

describe("OfferScopeSchema", () => {
  test("accepts local, federated, public", () => {
    expect(OfferScopeSchema.parse("local")).toBe("local");
    expect(OfferScopeSchema.parse("federated")).toBe("federated");
    expect(OfferScopeSchema.parse("public")).toBe("public");
  });

  test("rejects an unknown scope", () => {
    expect(() => OfferScopeSchema.parse("internal")).toThrow();
    expect(() => OfferScopeSchema.parse("LOCAL")).toThrow();
  });
});

// =============================================================================
// OfferingSchema — structural per-entry shape
// =============================================================================

describe("OfferingSchema — structural", () => {
  test("accepts a minimal local-only offering (capability + one scope)", () => {
    const o = OfferingSchema.parse({
      capability: "code-review.typescript",
      scopes: ["local"],
    });
    expect(o.capability).toBe("code-review.typescript");
    expect(o.scopes).toEqual(["local"]);
    expect(o.accept).toBeUndefined();
  });

  test("rejects an empty scopes[] (offered nowhere)", () => {
    expect(() =>
      OfferingSchema.parse({ capability: "chat", scopes: [] }),
    ).toThrow();
  });

  test("rejects a malformed capability id (uppercase / whitespace)", () => {
    expect(() =>
      OfferingSchema.parse({ capability: "Code-Review", scopes: ["local"] }),
    ).toThrow();
    expect(() =>
      OfferingSchema.parse({ capability: "code review", scopes: ["local"] }),
    ).toThrow();
  });

  test("rejects unknown keys (strict)", () => {
    expect(() =>
      OfferingSchema.parse({
        capability: "chat",
        scopes: ["local"],
        bogus: true,
      }),
    ).toThrow();
  });

  test("accepts an optional network id of valid grammar", () => {
    const o = OfferingSchema.parse({
      capability: "chat",
      scopes: ["federated"],
      accept: { kind: "network", network: "metafactory-net" },
      network: "metafactory-net",
    });
    expect(o.network).toBe("metafactory-net");
  });
});

// =============================================================================
// AcceptPolicy — the closed per-scope tagged union
// =============================================================================

describe("FederatedAcceptSchema", () => {
  test("accepts {kind:'network'}", () => {
    expect(
      FederatedAcceptSchema.parse({ kind: "network", network: "mf-net" }),
    ).toEqual({ kind: "network", network: "mf-net" });
  });

  test("accepts {kind:'principals'} with ≥1 principal", () => {
    expect(
      FederatedAcceptSchema.parse({ kind: "principals", principals: ["jcfischer"] }),
    ).toEqual({ kind: "principals", principals: ["jcfischer"] });
  });

  test("rejects {kind:'principals'} with an empty list (names nobody)", () => {
    expect(() =>
      FederatedAcceptSchema.parse({ kind: "principals", principals: [] }),
    ).toThrow();
  });

  test("rejects an unknown federated accept kind", () => {
    expect(() =>
      FederatedAcceptSchema.parse({ kind: "anyone" }),
    ).toThrow();
  });
});

describe("AcceptPolicySchema — closed union", () => {
  test("accepts the federated and public variants", () => {
    expect(
      AcceptPolicySchema.parse({ kind: "network", network: "mf-net" }).kind,
    ).toBe("network");
    expect(
      AcceptPolicySchema.parse({
        kind: "surface",
        surface: "github",
        predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
      }).kind,
    ).toBe("surface");
  });

  test("has NO free-form string variant (closed union)", () => {
    // A free-form accept like the old design sketch ('public:rate-limited')
    // must NOT parse — the union is closed on `kind`.
    expect(() => AcceptPolicySchema.parse("public:rate-limited")).toThrow();
    expect(() => AcceptPolicySchema.parse({ kind: "custom-dsl" })).toThrow();
  });
});

// =============================================================================
// Public predicate — METADATA-ONLY (ADR-0010 DD-CO-8)
// =============================================================================

describe("PublicPredicateSchema — metadata-only (ADR-0010 DD-CO-8)", () => {
  test("accepts repo-membership", () => {
    expect(
      PublicPredicateSchema.parse({ kind: "repo-membership", repos: ["the-metafactory/*"] }).kind,
    ).toBe("repo-membership");
  });

  test("accepts sender-allow / sender-block", () => {
    expect(
      PublicPredicateSchema.parse({ kind: "sender-allow", senders: ["octocat"] }).kind,
    ).toBe("sender-allow");
    expect(
      PublicPredicateSchema.parse({ kind: "sender-block", senders: ["bad-actor"] }).kind,
    ).toBe("sender-block");
  });

  test("accepts a rate predicate with ≥1 window", () => {
    expect(
      PublicPredicateSchema.parse({ kind: "rate", per_hour: 10 }).kind,
    ).toBe("rate");
  });

  test("rejects an empty rate predicate (no window)", () => {
    expect(() => PublicPredicateSchema.parse({ kind: "rate" })).toThrow();
  });

  // The HARD enforcement of DD-CO-8: a content-dependent predicate cannot be
  // expressed. There is no `kind` for "description contains X" / "diff matches
  // Y" — so it fails the discriminator. That IS the schema-level forbidding.
  test("REJECTS a content-dependent predicate (description/diff matching)", () => {
    expect(() =>
      PublicPredicateSchema.parse({
        kind: "description-contains",
        value: "please review",
      }),
    ).toThrow();
    expect(() =>
      PublicPredicateSchema.parse({ kind: "diff-matches", pattern: ".*" }),
    ).toThrow();
    expect(() =>
      PublicPredicateSchema.parse({ kind: "body-regex", regex: "trusted" }),
    ).toThrow();
  });

  test("repo-membership requires ≥1 repo glob", () => {
    expect(() =>
      PublicPredicateSchema.parse({ kind: "repo-membership", repos: [] }),
    ).toThrow();
  });
});

describe("PublicAcceptSchema", () => {
  test("accepts {kind:'surface', surface, predicate, limits?}", () => {
    const a = PublicAcceptSchema.parse({
      kind: "surface",
      surface: "github",
      predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
      limits: { per_day: 100, max_concurrent: 2 },
    });
    expect(a.surface).toBe("github");
    expect(a.predicate.kind).toBe("repo-membership");
    expect(a.limits?.per_day).toBe(100);
  });

  test("requires a surface", () => {
    expect(() =>
      PublicAcceptSchema.parse({
        kind: "surface",
        surface: "",
        predicate: { kind: "rate", per_day: 5 },
      }),
    ).toThrow();
  });
});

describe("PublicLimitsSchema", () => {
  test("rejects an empty limits block", () => {
    expect(() => PublicLimitsSchema.parse({})).toThrow();
  });
  test("accepts a single bound", () => {
    expect(PublicLimitsSchema.parse({ per_day: 50 }).per_day).toBe(50);
  });
});

// =============================================================================
// superRefineOfferings — cross-offering coherence rules
// =============================================================================

function offering(o: Offering): Offering {
  return o;
}

describe("superRefineOfferings — coherence", () => {
  test("no issues for a valid local-only offering", () => {
    expect(
      superRefineOfferings([offering({ capability: "chat", scopes: ["local"] })]),
    ).toEqual([]);
  });

  test("DEFAULT-DENY: federated scope with no accept is an issue", () => {
    const issues = superRefineOfferings([
      offering({ capability: "chat", scopes: ["federated"] }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("DEFAULT-DENY");
    expect(issues[0]?.path).toEqual([0, "accept"]);
  });

  test("federated scope WITH a named network accept is clean", () => {
    expect(
      superRefineOfferings([
        offering({
          capability: "chat",
          scopes: ["federated"],
          accept: { kind: "network", network: "mf-net" },
        }),
      ]),
    ).toEqual([]);
  });

  test("federated scope with a PUBLIC accept is a kind-mismatch issue", () => {
    const issues = superRefineOfferings([
      offering({
        capability: "chat",
        scopes: ["federated"],
        accept: {
          kind: "surface",
          surface: "github",
          predicate: { kind: "rate", per_day: 1 },
        },
      }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("requires a federated accept");
  });

  test("public scope with no accept is an issue", () => {
    const issues = superRefineOfferings([
      offering({ capability: "code-review.typescript", scopes: ["public"] }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("two-stage metadata gate");
  });

  test("public scope WITH a surface accept is clean", () => {
    expect(
      superRefineOfferings([
        offering({
          capability: "code-review.typescript",
          scopes: ["public"],
          accept: {
            kind: "surface",
            surface: "github",
            predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
          },
        }),
      ]),
    ).toEqual([]);
  });

  test("local-only offering carrying an accept is an issue", () => {
    const issues = superRefineOfferings([
      offering({
        capability: "chat",
        scopes: ["local"],
        accept: { kind: "network", network: "mf-net" },
      }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("local-only but carries an accept-policy");
  });

  test("federated + public in one offering is rejected (single accept can't serve both)", () => {
    const issues = superRefineOfferings([
      offering({
        capability: "chat",
        scopes: ["federated", "public"],
        accept: { kind: "network", network: "mf-net" },
      }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("both 'federated' and 'public'");
  });

  test("duplicate capability across two offerings is an issue", () => {
    const issues = superRefineOfferings([
      offering({ capability: "chat", scopes: ["local"] }),
      offering({ capability: "chat", scopes: ["local"] }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("already declared at offerings[0]");
    expect(issues[0]?.path).toEqual([1, "capability"]);
  });

  test("batch-emits issues across multiple offenders", () => {
    const issues = superRefineOfferings([
      offering({ capability: "a.one", scopes: ["federated"] }), // no accept
      offering({ capability: "b.two", scopes: ["public"] }), // no accept
    ]);
    expect(issues.length).toBe(2);
  });

  // #962 review nit 3: CONTEXT.md endorses a capability offered at SEVERAL
  // scopes at once. local+federated (local needs no accept, federated names a
  // network) is valid — lock it so a future refactor can't silently reject it.
  test("a local+federated multi-scope offering is valid", () => {
    const issues = superRefineOfferings([
      offering({
        capability: "code-review.typescript",
        scopes: ["local", "federated"],
        accept: { kind: "network", network: "metafactory-net" },
      }),
    ]);
    expect(issues).toEqual([]);
  });

  // #962 review nit 2: the top-level network? and the {kind:'network'} accept's
  // own network are dual-source; the accept's network is authoritative. A
  // divergence is a config error, not a value to merge.
  test("top-level network disagreeing with the accept network is rejected", () => {
    const issues = superRefineOfferings([
      offering({
        capability: "code-review.typescript",
        scopes: ["federated"],
        network: "wrong-net",
        accept: { kind: "network", network: "metafactory-net" },
      }),
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("disagrees with its accept network");
    expect(issues[0]?.path).toEqual([0, "network"]);
  });
});

// =============================================================================
// resolveOffering — the default-deny resolver (ADR-0008 DD-CO-1)
// =============================================================================

describe("resolveOffering — default-deny (ADR-0008 DD-CO-1)", () => {
  test("an unoffered capability resolves to local-only", () => {
    const r = resolveOffering("dev.implement", []);
    expect(r).toEqual({ capability: "dev.implement", scopes: ["local"] });
  });

  test("undefined offerings ⇒ local-only (the byte-identical-boot case)", () => {
    expect(resolveOffering("anything", undefined)).toEqual({
      capability: "anything",
      scopes: ["local"],
    });
  });

  test("a matched offering resolves to its scopes + accept", () => {
    const offerings: Offering[] = [
      offering({
        capability: "code-review.typescript",
        scopes: ["public"],
        accept: {
          kind: "surface",
          surface: "github",
          predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
        },
      }),
    ];
    const r = resolveOffering("code-review.typescript", offerings);
    expect(r.scopes).toEqual(["public"]);
    expect(r.accept?.kind).toBe("surface");
  });

  test("a capability NOT in a non-empty offerings list still resolves local-only", () => {
    const offerings: Offering[] = [
      offering({ capability: "chat", scopes: ["federated"], accept: { kind: "network", network: "mf-net" } }),
    ];
    expect(resolveOffering("dev.implement", offerings)).toEqual({
      capability: "dev.implement",
      scopes: ["local"],
    });
  });

  test("an offering with an empty scopes[] defensively resolves local-only", () => {
    // The schema rejects scopes:[], but the resolver is total and defends a
    // programmatic caller that bypasses parse.
    const offerings = [{ capability: "chat", scopes: [] }] as unknown as Offering[];
    expect(resolveOffering("chat", offerings)).toEqual({
      capability: "chat",
      scopes: ["local"],
    });
  });

  test("returned scopes is a defensive copy (caller cannot mutate the offering)", () => {
    const off = offering({ capability: "chat", scopes: ["federated"], accept: { kind: "network", network: "mf-net" } });
    const r = resolveOffering("chat", [off]);
    r.scopes.push("public");
    expect(off.scopes).toEqual(["federated"]);
  });
});

// =============================================================================
// offeringSubjectPatterns — the CO-2 scope→subject-prefix projection
// =============================================================================
//
// The testable core of CO-2 (cortex#941): given a resolved offering and the
// task-portion of a subject (e.g. `tasks.code-review.>`), produce the set of
// scope-prefixed subject patterns a capability's JetStream consumer binds on.
//
// The headline contract is BYTE-IDENTICAL BOOT: a `local`-only resolution (the
// CO-1 default for every capability) yields EXACTLY the single
// `local.{principal}.{stack}.{taskSuffix}` pattern — character-for-character
// what each consumer builds today. Widening (federated/public) ADDS prefixes;
// it never alters the local one.

describe("offeringSubjectPatterns", () => {
  const PRINCIPAL = "andreas";
  const STACK = "work";

  // The three real task-suffixes the cortex.ts consumers build today, so the
  // byte-identical proof is anchored on the ACTUAL strings in the boot path:
  //   - review:  `tasks.code-review.>` (wildcard family)
  //   - release: `tasks.release.cut`   (exact subject, no wildcard)
  //   - dev:     `tasks.dev.implement` (exact subject, no wildcard)
  const REVIEW_SUFFIX = "tasks.code-review.>";
  const RELEASE_SUFFIX = "tasks.release.cut";
  const DEV_SUFFIX = "tasks.dev.implement";

  describe("local-only (CO-1 default) → byte-identical single pattern", () => {
    test("review suffix → exactly today's local review pattern", () => {
      const resolved = resolveOffering("code-review", undefined);
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`local.${PRINCIPAL}.${STACK}.tasks.code-review.>`]);
    });

    test("release suffix (exact, no wildcard) → exactly today's local release pattern", () => {
      const resolved = resolveOffering("release.cut", undefined);
      expect(
        offeringSubjectPatterns(RELEASE_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`local.${PRINCIPAL}.${STACK}.tasks.release.cut`]);
    });

    test("dev suffix (exact, no wildcard) → exactly today's local dev pattern", () => {
      const resolved = resolveOffering("dev.implement", undefined);
      expect(
        offeringSubjectPatterns(DEV_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`local.${PRINCIPAL}.${STACK}.tasks.dev.implement`]);
    });

    test("an explicitly-local offering resolves the same single local pattern", () => {
      // Resolving a capability whose offering names scopes:['local'] is the same
      // byte-identical result as the default-deny (undefined offerings) path.
      const resolved = resolveOffering("code-review", [
        offering({ capability: "code-review", scopes: ["local"] }),
      ]);
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`local.${PRINCIPAL}.${STACK}.tasks.code-review.>`]);
    });

    test("returns a single-element array (length is exactly 1 for local-only)", () => {
      const resolved = resolveOffering("code-review", undefined);
      const patterns = offeringSubjectPatterns(
        REVIEW_SUFFIX,
        PRINCIPAL,
        STACK,
        resolved,
      );
      expect(patterns).toHaveLength(1);
    });
  });

  describe("federated widening → +federated prefix", () => {
    test("local+federated → the local pattern PLUS the federated pattern", () => {
      const resolved = resolveOffering("code-review", [
        offering({
          capability: "code-review",
          scopes: ["local", "federated"],
          accept: { kind: "network", network: "mf-net" },
        }),
      ]);
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([
        `local.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
        `federated.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
      ]);
    });

    test("federated-only offering → ONLY the federated pattern (no local)", () => {
      // A capability offered federated-only binds federated, NOT local — the
      // scopes[] is authoritative; the helper never silently adds local.
      const resolved = resolveOffering("code-review", [
        offering({
          capability: "code-review",
          scopes: ["federated"],
          accept: { kind: "principals", principals: ["jcfischer"] },
        }),
      ]);
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`federated.${PRINCIPAL}.${STACK}.tasks.code-review.>`]);
    });
  });

  describe("public widening → +public prefix", () => {
    test("local+public → the local pattern PLUS the public pattern", () => {
      const resolved = resolveOffering("code-review", [
        offering({
          capability: "code-review",
          scopes: ["local", "public"],
          accept: {
            kind: "surface",
            surface: "github",
            predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
          },
        }),
      ]);
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([
        `local.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
        `public.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
      ]);
    });
  });

  describe("scope→prefix mapping is correct + ordered", () => {
    test("prefixes are emitted in canonical order local → federated → public", () => {
      // Even if scopes[] arrives in a different order, the output is the
      // canonical trust-ascending order so the bound-subject set is stable
      // (deterministic boot — no order-dependent diff between restarts).
      const resolved = {
        capability: "code-review",
        scopes: ["public", "local", "federated"] as const,
      };
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, {
          capability: resolved.capability,
          scopes: [...resolved.scopes],
        }),
      ).toEqual([
        `local.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
        `federated.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
        `public.${PRINCIPAL}.${STACK}.tasks.code-review.>`,
      ]);
    });

    test("each scope maps to its own prefix with the SAME tail (suffix untouched)", () => {
      const resolved = {
        capability: "release.cut",
        scopes: ["local", "federated"] as OfferScope[],
      };
      const patterns = offeringSubjectPatterns(
        RELEASE_SUFFIX,
        PRINCIPAL,
        STACK,
        resolved,
      );
      // Tail is identical across scopes — only the prefix token differs.
      for (const p of patterns) {
        expect(p.endsWith(`.${PRINCIPAL}.${STACK}.tasks.release.cut`)).toBe(true);
      }
      expect(patterns[0]!.startsWith("local.")).toBe(true);
      expect(patterns[1]!.startsWith("federated.")).toBe(true);
    });
  });

  describe("dedup + defensiveness", () => {
    test("a duplicate scope in scopes[] produces no duplicate pattern", () => {
      const resolved = {
        capability: "code-review",
        scopes: ["local", "local"] as OfferScope[],
      };
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([`local.${PRINCIPAL}.${STACK}.tasks.code-review.>`]);
    });

    test("an empty scopes[] (defensive) yields no patterns", () => {
      // The resolver never returns empty scopes (defaults to ['local']); this
      // guards a programmatic caller that hands a degenerate resolved view.
      const resolved = { capability: "code-review", scopes: [] as OfferScope[] };
      expect(
        offeringSubjectPatterns(REVIEW_SUFFIX, PRINCIPAL, STACK, resolved),
      ).toEqual([]);
    });
  });
});
