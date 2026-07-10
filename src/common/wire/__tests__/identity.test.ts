/**
 * WP-2 (cortex#1878) — canonical wire-identity codec.
 *
 * Table-driven happy path + EVERY fail-loud path. The single most important
 * property under test: no input, anywhere, ever yields a fabricated `default`.
 * That fabrication lives today at `federation-reconciler.ts:459` and is the
 * class of bug this module exists to make unrepresentable.
 *
 * Property tests are WP-3. Call-site migration is WP-5.
 */

import { describe, expect, test } from "bun:test";

import {
  AGENT_ID_RE,
  agentDid,
  federatedSubject,
  parseDid,
  parseFederatedSubject,
  parsePrincipalId,
  parseStackId,
  parseStackSlug,
  principalDid,
  PRINCIPAL_ID_RE,
  stackDid,
  stackId,
  STACK_SLUG_RE,
  WIRE_DID_RE,
  WireIdentityError,
} from "../identity.ts";

/** Unwrap an `ok:true` result or fail the test loudly. */
function unwrap<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(`expected ok, got reason="${r.reason}"`);
  return r.value;
}

/**
 * Widen a branded id back to `string` for assertion.
 *
 * This helper has to exist, and that is the point: `expect(principalDid(p))
 * .toBe("did:mf:andreas")` does not typecheck, because a `PrincipalDid` is not
 * a `string` literal. The brand is real, not decorative.
 */
function raw(s: string): string {
  return s;
}

// ---------------------------------------------------------------------------
// parsePrincipalId
// ---------------------------------------------------------------------------

describe("parsePrincipalId", () => {
  const ACCEPT = ["andreas", "jc", "a1", "meta-factory", "a-b-c"];
  const REJECT: [string, string][] = [
    ["", "empty"],
    [" ", "space"],
    ["Andreas", "uppercase"],
    ["1andreas", "leading digit"],
    ["-andreas", "leading hyphen"],
    ["andreas_x", "underscore not permitted for a principal id"],
    ["andreas.x", "dot not permitted"],
    ["andreas/x", "slash"],
    ["did:mf:andreas", "a DID is not a bare principal id"],
  ];

  test.each(ACCEPT)("accepts %p", (s) => {
    expect(raw(unwrap(parsePrincipalId(s)))).toBe(s);
  });

  test.each(REJECT)("rejects %p (%s)", (s) => {
    const r = parsePrincipalId(s);
    expect(r.ok).toBe(false);
  });

  test("the encoded rule is today's PRINCIPAL_ID_RE, not a new invention", () => {
    expect(PRINCIPAL_ID_RE.source).toBe("^[a-z][a-z0-9-]*$");
  });
});

// ---------------------------------------------------------------------------
// parseStackSlug
// ---------------------------------------------------------------------------

describe("parseStackSlug", () => {
  const ACCEPT = ["meta-factory", "work", "a", "a_b", "s1", "meta_factory-2"];
  const REJECT: [string, string][] = [
    ["", "empty"],
    ["Work", "uppercase"],
    ["1work", "leading digit"],
    ["_work", "leading underscore"],
    ["-work", "leading hyphen"],
    ["work.x", "dot would collide with the NATS subject separator"],
    ["work/x", "slash"],
  ];

  test.each(ACCEPT)("accepts %p", (s) => {
    expect(raw(unwrap(parseStackSlug(s)))).toBe(s);
  });

  test.each(REJECT)("rejects %p (%s)", (s) => {
    expect(parseStackSlug(s).ok).toBe(false);
  });

  test("stack slugs permit `_` where principal ids do not — today's asymmetry", () => {
    expect(STACK_SLUG_RE.source).toBe("^[a-z][a-z0-9_-]*$");
    expect(parseStackSlug("a_b").ok).toBe(true);
    expect(parsePrincipalId("a_b").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseStackId — the `default`-fabrication guard
// ---------------------------------------------------------------------------

describe("parseStackId", () => {
  test("parses a well-formed `{principal}/{stack}`", () => {
    const scope = unwrap(parseStackId("andreas/meta-factory"));
    expect(raw(scope.principal)).toBe("andreas");
    expect(raw(scope.stack)).toBe("meta-factory");
  });

  // Every one of these is an input that some site in the tree today would
  // silently resolve to a `default` stack. None may parse here.
  const REJECT: [string, string][] = [
    ["andreas", "no slash — must NOT become andreas/default"],
    ["andreas/", "trailing slash — must NOT become andreas/default"],
    ["/default", "leading slash — empty principal"],
    ["", "empty"],
    ["/", "bare slash"],
    ["//", "double slash"],
    ["andreas//meta", "empty middle segment"],
    ["andreas/meta/factory", "two slashes — ambiguous under first-vs-last split"],
    ["Andreas/meta", "uppercase principal"],
    ["andreas/Meta", "uppercase stack"],
    ["andreas_x/meta", "underscore in principal"],
    ["did:mf:andreas-meta", "a DID is not a stack id"],
  ];

  test.each(REJECT)("rejects %p (%s)", (s) => {
    expect(parseStackId(s).ok).toBe(false);
  });

  test("NO input whatsoever fabricates a `default` stack", () => {
    const inputs = [
      "andreas",
      "andreas/",
      "/default",
      "",
      "/",
      "andreas/meta/factory",
      "default",
      "andreas/default",
    ];
    for (const s of inputs) {
      const r = parseStackId(s);
      if (r.ok) {
        // The ONLY way `default` may appear is if the caller literally wrote it.
        expect(s).toContain(r.value.stack);
        expect(s.endsWith(`/${r.value.stack}`)).toBe(true);
      }
    }
    // The two shapes that most tempt a fallback stay hard failures.
    expect(parseStackId("andreas").ok).toBe(false);
    expect(parseStackId("andreas/").ok).toBe(false);
  });

  test("an explicit `andreas/default` parses as-written (not fabricated)", () => {
    const scope = unwrap(parseStackId("andreas/default"));
    expect(raw(scope.stack)).toBe("default");
  });

  test("rejects a 2-slash id rather than picking first- or last-slash", () => {
    // roster-read.ts splits on the FIRST slash; stack-id.ts's
    // `stackSlugFromStackId` splits on the LAST. They disagree on a 3-segment
    // id. This codec refuses to arbitrate — it fails loud instead.
    const r = parseStackId("andreas/meta/factory");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exactly one");
  });
});

// ---------------------------------------------------------------------------
// Render constructors
// ---------------------------------------------------------------------------

describe("render constructors", () => {
  const scope = {
    principal: unwrap(parsePrincipalId("andreas")),
    stack: unwrap(parseStackSlug("meta-factory")),
  };

  test("stackId round-trips through parseStackId", () => {
    const id = stackId(scope);
    expect(raw(id)).toBe("andreas/meta-factory");
    const back = unwrap(parseStackId(id));
    expect(back).toEqual(scope);
  });

  test("principalDid renders the `did:mf:` form", () => {
    expect(raw(principalDid(scope.principal))).toBe("did:mf:andreas");
  });

  test("stackDid renders `did:mf:{principal}-{stack}`", () => {
    expect(raw(stackDid(scope))).toBe("did:mf:andreas-meta-factory");
  });

  test("agentDid renders + validates against today's AGENT_ID_RE", () => {
    expect(raw(agentDid("echo"))).toBe("did:mf:echo");
    expect(AGENT_ID_RE.source).toBe("^[a-z0-9-]+$");
  });

  test("every rendered DID satisfies the myelin wire grammar", () => {
    expect(WIRE_DID_RE.test(principalDid(scope.principal))).toBe(true);
    expect(WIRE_DID_RE.test(stackDid(scope))).toBe(true);
    expect(WIRE_DID_RE.test(agentDid("echo"))).toBe(true);
  });

  test("agentDid fails loud on an id today's AGENT_ID_RE rejects", () => {
    expect(() => agentDid("Echo")).toThrow(WireIdentityError);
    expect(() => agentDid("")).toThrow(WireIdentityError);
    expect(() => agentDid("ec_ho")).toThrow(WireIdentityError);
  });

  test("stackDid fails loud rather than emitting a `--` DID the wire rejects", () => {
    // `andreas-` is a legal principal id today (trailing hyphen permitted) and
    // `meta` a legal slug — yet `did:mf:andreas--meta` violates WIRE_DID_RE's
    // no-consecutive-hyphen rule. cortex.ts:1024 silently collapses the run;
    // this codec refuses to emit an invalid DID and refuses to mutate the
    // caller's identity behind their back. TODO(WP-4) owns the real encoding.
    const bad = {
      principal: unwrap(parsePrincipalId("andreas-")),
      stack: unwrap(parseStackSlug("meta")),
    };
    expect(() => stackDid(bad)).toThrow(WireIdentityError);
  });
});

// ---------------------------------------------------------------------------
// The compile-time guarantee (the whole point of the branding)
// ---------------------------------------------------------------------------

describe("compile-time guarantee", () => {
  test("a StackDid can never be `===` compared to a PrincipalDid", () => {
    const p = unwrap(parsePrincipalId("andreas"));
    const scope = { principal: p, stack: unwrap(parseStackSlug("meta-factory")) };

    // THE regression guard for the jc-fold bug: this comparison silently
    // returned `false` at runtime and dropped presence. It is now a type error.
    // If this line ever compiles, `tsc` fails on the unused directive and this
    // test file is the thing that catches it.
    // @ts-expect-error — StackDid and PrincipalDid are distinct brands.
    const _never = stackDid(scope) === principalDid(p);

    expect(typeof _never).toBe("boolean");
  });

  test("a StackId cannot be passed where a PrincipalId is expected", () => {
    const scope = {
      principal: unwrap(parsePrincipalId("andreas")),
      stack: unwrap(parseStackSlug("work")),
    };
    // @ts-expect-error — StackId is not a PrincipalId.
    const _did = principalDid(stackId(scope));
    expect(typeof _did).toBe("string");
  });

  test("a raw string cannot be passed where a branded id is expected", () => {
    // @ts-expect-error — unbranded strings must go through a parse constructor.
    const _did = principalDid("andreas");
    expect(typeof _did).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// parseDid — must never guess (WP-4 owns disambiguation)
// ---------------------------------------------------------------------------

describe("parseDid", () => {
  test("rejects anything failing the myelin wire grammar", () => {
    for (const s of ["", "andreas", "did:mf:", "did:mf:1a", "did:mf:a--b", "did:xx:a", "did:mf:A"]) {
      const r = parseDid(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("malformed");
    }
  });

  test("returns `ambiguous` — never a guess — when classes overlap", () => {
    // `did:mf:andreas-meta-factory` is simultaneously a legal principal id
    // (hyphens permitted), a legal agent id, and a legal {p}-{s} stack pair.
    const r = parseDid("did:mf:andreas-meta-factory");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });

  test("a hyphen-free DID is ambiguous between principal and agent", () => {
    // `did:mf:echo` is minted as an AGENT did at dispatch-source-publisher.ts:203
    // and as a PRINCIPAL did at identity-registry.ts:178. Structurally identical.
    const r = parseDid("did:mf:echo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });

  test("well-formed but unclassifiable DIDs fail loud, not silently", () => {
    // `_` and `.` pass WIRE_DID_RE but no identity-class rule admits them.
    for (const s of ["did:mf:a_b", "did:mf:a.b"]) {
      const r = parseDid(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unclassifiable");
    }
  });

  test("parseDid NEVER returns ok:true under today's rules — that is WP-4's forcing function", () => {
    // Documented, deliberate result. Every identity class' rule set overlaps
    // every other's, so no well-formed DID is uniquely classifiable. When WP-4
    // (#1880) picks an encoding, the class predicates change and this test
    // becomes the thing that proves the ambiguity is gone.
    const samples = [
      "did:mf:andreas",
      "did:mf:echo",
      "did:mf:andreas-meta-factory",
      "did:mf:jc-work",
      "did:mf:a1",
    ];
    for (const s of samples) {
      expect(parseDid(s).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Federated subjects
// ---------------------------------------------------------------------------

describe("federated subjects", () => {
  const scope = {
    principal: unwrap(parsePrincipalId("andreas")),
    stack: unwrap(parseStackSlug("meta-factory")),
  };

  test("renders `federated.{principal}.{stack}.{rest}`", () => {
    expect(raw(federatedSubject(scope, "tasks", "code-review"))).toBe(
      "federated.andreas.meta-factory.tasks.code-review",
    );
  });

  test("round-trips through parseFederatedSubject", () => {
    const subject = federatedSubject(scope, "tasks", "code-review");
    const parsed = unwrap(parseFederatedSubject(subject));
    expect(parsed.scope).toEqual(scope);
    expect(parsed.rest).toEqual(["tasks", "code-review"]);
  });

  const REJECT: [string, string][] = [
    ["", "empty"],
    ["federated", "prefix only"],
    ["federated.andreas", "no stack"],
    ["federated.andreas.meta-factory", "no trailing segments"],
    ["local.andreas.meta-factory.tasks", "wrong prefix — `local` is not federated"],
    ["federated..meta-factory.tasks", "empty principal"],
    ["federated.andreas..tasks", "empty stack"],
    ["federated.Andreas.meta-factory.tasks", "uppercase principal"],
    ["federated.andreas.meta-factory.", "empty trailing segment"],
    ["federated.andreas_x.meta.tasks", "underscore in principal"],
  ];

  test.each(REJECT)("rejects %p (%s)", (s) => {
    expect(parseFederatedSubject(s).ok).toBe(false);
  });

  test("federatedSubject fails loud on a segment that would break the subject", () => {
    expect(() => federatedSubject(scope, "")).toThrow(WireIdentityError);
    expect(() => federatedSubject(scope, "a.b")).toThrow(WireIdentityError);
    expect(() => federatedSubject(scope, "*")).toThrow(WireIdentityError);
    expect(() => federatedSubject(scope, ">")).toThrow(WireIdentityError);
    expect(() => federatedSubject(scope)).toThrow(WireIdentityError);
  });
});
