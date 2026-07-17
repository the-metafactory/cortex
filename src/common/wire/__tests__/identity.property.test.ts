/**
 * WP-3 (cortex#1879, epic #1876 Wave 1) — identity + subject invariants, made
 * EXECUTABLE.
 *
 * Two invariants were crystallized with JC/Ivy during the jc-fold debug and, at
 * the time #1879 was filed, lived only as prose in a skill file plus a runtime
 * guard. Prose does not fail CI. This file turns them into property + golden
 * tests over the REAL codec and the REAL producer/consumer subject paths:
 *
 *   - `registry-stack == wire-stack` — the `{principal}/{stack}` a peer's
 *     registry record names must round-trip to the same scope its federated
 *     presence subject carries.
 *   - `stamp-DID class == resolved-identity DID class` — a resolved peer's DID
 *     must be the same CLASS as the DID that stamps its envelopes; the encoding
 *     must never let a `principal` DID collide with a `stack` DID.
 *
 * ## Drift note — re-verified against `origin/main` 2026-07-18
 *
 * The issue's plan predates two facts that changed WHERE the codec lives and
 * WHICH properties are live vs. gated:
 *
 *  1. **WP-2's codec landed in myelin, not cortex.** `@the-metafactory/myelin/
 *     wire/identity` (pinned v0.7.1) is the codec of record — `parseDid`,
 *     `renderDid`, `parseStackId`, `encodeDidSegment`/`decodeDidSegment`,
 *     `classOf`. cortex's `src/common/wire/identity.ts` was never created (the
 *     WP-2 branch was "the right shape in the wrong repo"). So this file imports
 *     `./wire`, not a local module.
 *  2. **That codec is CLASS-EXPLICIT** (`did:mf:{tag}.{seg}...`) — essentially
 *     WP-4 option (C). Under it, a `principal` DID and a `stack` DID differ in
 *     their position-0 class tag and CANNOT collide. So the codec ITSELF is
 *     injective (asserted live below).
 *
 * ## Honesty rail — live vs. todo
 *
 * The injectivity invariant the epic tracks is about cortex's LIVE wire, and
 * cortex still mints the NAIVE `did:mf:{p}-{s}` form (`cortex.ts:1071`,
 * `identity-registry.ts:178`), with the trust-displacement collision held shut
 * only by the runtime guard at `identity-registry.ts:330-343`. WP-4 (#1880 —
 * the encoding DECISION) and WP-5 (migrate the mint sites) are both HELD. So the
 * cortex-side injectivity invariant is KNOWN-VIOLATED today and goes in as a
 * `test.todo` naming WP-4 — never made to pass by weakening it. Alongside it we
 * assert LIVE (a) that the `./wire` class-explicit codec is injective and (b)
 * that the naive encoding demonstrably collides — proving the hazard is real and
 * the todo is not decorative.
 *
 * Everything else — the stack-id / DID / subject-segment round-trips and the
 * producer/consumer accept-list agreement (the #1812 invariant) — is TRUE today
 * and asserted LIVE.
 *
 * Test-only. Zero production source is modified.
 */

import { describe, expect, test } from "bun:test";
import {
  classOf,
  decodeDidSegment,
  encodeDidSegment,
  parseDid,
  parseStackId,
  renderDid,
  type ParseResult,
} from "@the-metafactory/myelin/wire/identity";

import { createAgentOnlineEvent } from "../../../bus/agent-network/builders";
import { deriveAcceptSubjects } from "../../../bus/agent-network/accept-subjects";
import { deriveNatsSubject, type Envelope } from "../../../bus/myelin/envelope-validator";
import { subjectMatches } from "../../../bus/surface-router";

// =============================================================================
// Deterministic generators — no unseeded Math.random(); the seed reproduces
// every counterexample and is printed on failure.
// =============================================================================

/** Fixed base seed. A failure prints it; re-running reproduces byte-for-byte. */
const SEED = 0x1879c0de;

/** mulberry32 — a tiny deterministic PRNG (no dependency, fully reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate ONE valid slug from the REAL alphabet
 * (`STACK_SLUG_RE`/`PRINCIPAL_ID_RE` = `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`): one or
 * more `[a-z][a-z0-9]*` groups joined by single hyphens. Guarantees a
 * leading letter, no underscore/uppercase, no leading/trailing/consecutive
 * hyphen — so it is accepted by the codec by construction, while still routinely
 * emitting hyphen-bearing values (the `andreas-meta-factory` ambiguity class).
 */
function randomSlug(rng: () => number): string {
  const groups = 1 + Math.floor(rng() * 3); // 1..3 hyphen-joined groups
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    const len = 1 + Math.floor(rng() * 5); // 1..5 chars per group
    let seg = LOWER.charAt(Math.floor(rng() * LOWER.length));
    for (let i = 1; i < len; i++) seg += ALNUM.charAt(Math.floor(rng() * ALNUM.length));
    parts.push(seg);
  }
  return parts.join("-");
}

/**
 * Adversarial literals ALWAYS in the corpus: hyphen-bearing values, the
 * `default` sentinel (whose passing is exactly what hid #1812), and the specific
 * `andreas-meta-factory` that collides with `andreas/meta-factory` under the
 * naive encoding.
 */
const ADVERSARIAL = [
  "andreas-meta",
  "meta-factory",
  "a-b-c",
  "default",
  "andreas",
  "jc",
  "andreas-meta-factory",
  "clawbox",
  "sage-host",
  "x",
  "ab",
  "a1",
  "z9-a0",
] as const;

/** Pairs used across the property tests: adversarial cross-slice + random fill. */
function generatePairs(count: number): [string, string][] {
  const rng = mulberry32(SEED);
  const pairs: [string, string][] = [];

  // Anchor the pairs whose behaviour the invariants name explicitly.
  pairs.push(["andreas", "meta-factory"]);
  pairs.push(["jc", "default"]);
  pairs.push(["jc", "clawbox"]);

  // Every adversarial literal exercised as BOTH principal and stack.
  for (const a of ADVERSARIAL) {
    pairs.push([a, "meta-factory"]);
    pairs.push(["andreas", a]);
  }

  // Random fill (hyphen-bearing values appear routinely) up to `count`.
  while (pairs.length < count) pairs.push([randomSlug(rng), randomSlug(rng)]);
  return pairs;
}

/** Independent principal stream for the injectivity cross-product. */
function generatePrincipals(count: number): string[] {
  const rng = mulberry32(SEED ^ 0x5eed);
  const out: string[] = ["andreas-meta-factory", "jc-clawbox", ...ADVERSARIAL];
  while (out.length < count) out.push(randomSlug(rng));
  return out;
}

/** Iterate the pair corpus; on the first failure print seed + counterexample. */
function forEachPair(fn: (p: string, s: string, index: number) => void): void {
  const pairs = generatePairs(256);
  for (let i = 0; i < pairs.length; i++) {
    const [p, s] = pairs[i]!;
    try {
      fn(p, s, i);
    } catch (e) {
      // eslint-disable-next-line no-console -- deliberate: reproduce the failure.
      console.error(
        `[identity.property] FAIL seed=0x${SEED.toString(16)} index=${i} ` +
          `principal=${JSON.stringify(p)} stack=${JSON.stringify(s)}`,
      );
      throw e;
    }
  }
}

/** Narrow a `ParseResult` or fail the test with its reason token. */
function unwrap<T>(r: ParseResult<T>, ctx: string): T {
  if (!r.ok) throw new Error(`${ctx}: codec rejected — reason=${r.reason}`);
  return r.value;
}

// =============================================================================
// Naive encoding mirrors — the LIVE cortex mint sites the epic is about, kept
// here verbatim so the hazard is proven, not asserted. WP-4 (#1880) retires
// these; WP-5 deletes the call sites.
//   stack DID  — cortex.ts:1071            `did:mf:${stack.id.replace("/","-")}`
//   principal  — identity-registry.ts:178  `did:mf:${principalId}`
// =============================================================================

const naiveStackDid = (p: string, s: string): string => `did:mf:${p}-${s}`;
const naivePrincipalDid = (p: string): string => `did:mf:${p}`;

// =============================================================================
// Producer subject — derived through the REAL publish path, not hand-spliced.
// The producer builds a `classification: "federated"` `agent.*` envelope and
// `deriveNatsSubject(envelope, stack)` computes the wire subject on publish.
// =============================================================================

const DUMMY_NKEY = "UTESTNKEYPUB000000000000000000000000000000000000000000";

/** The federated presence subject the producer emits for `(p,s)` on `agent.{action}`. */
function producerPresenceSubject(
  p: string,
  s: string,
  action: "online" | "heartbeat" | "offline" | "capabilities-changed",
): string {
  const online = createAgentOnlineEvent({
    source: { principal: p, stack: s, instance: "local" },
    identity: { nkey_public_key: DUMMY_NKEY, agent_id: "probe", assistant_name: null },
    scope: { principal: p, stack: s },
    capabilities: [],
    startedAt: new Date(0),
    // The federated copy peers fold (G-1114.E.1) — the SOURCE-addressed presence.
    classification: "federated",
  });
  // `deriveNatsSubject` is a pure function of source + classification + type, so
  // the other three presence actions differ ONLY in the trailing `agent.{action}`
  // segment. Override the type to derive each real wire subject faithfully.
  const envelope: Envelope = action === "online" ? online : { ...online, type: `agent.${action}` };
  return deriveNatsSubject(envelope, s);
}

// =============================================================================
// Property 1 — stack-id round-trips (registry-stack == wire-stack, half 1)
// =============================================================================

describe("WP-3 property: stack-id codec round-trips", () => {
  test("parseStackId(`${p}/${s}`) recovers the exact scope for ≥200 pairs incl. hyphen + default", () => {
    let n = 0;
    forEachPair((p, s) => {
      const scope = unwrap(parseStackId(`${p}/${s}`), `parseStackId(${p}/${s})`);
      // `principal`/`stack` are branded (PrincipalId/StackSlug) — coerce to
      // compare against the plain generated strings.
      expect(String(scope.principal)).toBe(p);
      expect(String(scope.stack)).toBe(s);
      n++;
    });
    expect(n).toBeGreaterThanOrEqual(200);
  });
});

// =============================================================================
// Property 2 — DID + subject-segment round-trips (class survives the codec)
// =============================================================================

describe("WP-3 property: DID render/parse + subject-segment round-trips", () => {
  test("renderDid → parseDid preserves class + segments; encode/decode is injective", () => {
    forEachPair((p, s) => {
      // stack DID: did:mf:stack.{p}.{s}
      const stackDid = unwrap(renderDid("stack", p, s), `renderDid(stack,${p},${s})`);
      const parsedStack = unwrap(parseDid(stackDid), `parseDid(${stackDid})`);
      expect(parsedStack.cls).toBe("stack");
      expect(parsedStack.segments).toEqual([p, s]);
      expect(classOf(stackDid)).toBe("stack");

      // principal DID: did:mf:principal.{p}
      const principalDid = unwrap(renderDid("principal", p), `renderDid(principal,${p})`);
      const parsedPrincipal = unwrap(parseDid(principalDid), `parseDid(${principalDid})`);
      expect(parsedPrincipal.cls).toBe("principal");
      expect(parsedPrincipal.segments).toEqual([p]);
      expect(classOf(principalDid)).toBe("principal");

      // The injective ':'→'-', '.'→'--' subject-segment codec round-trips exactly.
      const encoded = unwrap(encodeDidSegment(stackDid), `encodeDidSegment(${stackDid})`);
      const decoded = unwrap(decodeDidSegment(encoded), `decodeDidSegment(${encoded})`);
      expect(decoded).toBe(stackDid);
    });
  });
});

// =============================================================================
// Property 3 — federated presence subject: forward exactness + round-trip
// closure (registry-stack == wire-stack, half 2). Uses the REAL producer path.
// =============================================================================

describe("WP-3 property: federated presence subject round-trips to its scope", () => {
  test("producer subject is exactly federated.{p}.{s}.agent.online and the scope re-derives it", () => {
    forEachPair((p, s) => {
      const subject = producerPresenceSubject(p, s, "online");
      expect(subject).toBe(`federated.${p}.${s}.agent.online`);

      // Recover {p,s} from the wire form. Slugs contain no '.', so splitting the
      // subject is unambiguous — a TEST-LOCAL recovery (myelin's `./wire` has no
      // scope-returning federated-subject parser; a cortex-side `parseFederated
      // Subject` adapter is WP-5's job). Closure: the recovered scope re-derives
      // the identical subject AND round-trips through the real stack-id codec.
      const parts = subject.split(".");
      const recovered = { principal: parts[1]!, stack: parts[2]! };
      expect(recovered.principal).toBe(p);
      expect(recovered.stack).toBe(s);
      expect(producerPresenceSubject(recovered.principal, recovered.stack, "online")).toBe(subject);

      const viaCodec = unwrap(
        parseStackId(`${recovered.principal}/${recovered.stack}`),
        "parseStackId(recovered)",
      );
      expect({ principal: String(viaCodec.principal), stack: String(viaCodec.stack) }).toEqual({
        principal: p,
        stack: s,
      });
    });
  });
});

// =============================================================================
// Property 4 — producer/consumer accept-list AGREEMENT (the #1812 invariant).
// LIVE: `deriveAcceptSubjects(self,[peer])` must contain a pattern that matches
// the subject the presence producer emits for that peer — for EVERY presence
// action, and for `default` AND non-`default` slugs (the `default` case passing
// is what masked #1812 for two days).
// =============================================================================

describe("WP-3 property: deriveAcceptSubjects agrees with the presence producer (#1812)", () => {
  const SELF = { principal: "self-host", stack: "control-plane" } as const;
  const ACTIONS = ["online", "heartbeat", "offline", "capabilities-changed"] as const;

  test("every generated peer's presence subject is matched by the derived accept-list", () => {
    forEachPair((p, s) => {
      const accept = deriveAcceptSubjects(SELF, [{ principal: p, stack: s }]);
      for (const action of ACTIONS) {
        const subject = producerPresenceSubject(p, s, action);
        const matched = accept.some((pattern) => subjectMatches(pattern, subject));
        expect(matched).toBe(true);
      }
    });
  });

  test("the masking case is explicit: agreement holds for BOTH `default` and `meta-factory`", () => {
    for (const stack of ["default", "meta-factory"] as const) {
      const accept = deriveAcceptSubjects(SELF, [{ principal: "jc", stack }]);
      const subject = producerPresenceSubject("jc", stack, "online");
      expect(subject).toBe(`federated.jc.${stack}.agent.online`);
      expect(accept.some((pattern) => subjectMatches(pattern, subject))).toBe(true);
      // The peer subtree is presence-ONLY: a peer-destined dispatch subject must
      // NOT be admitted by the presence widening (least privilege, design §6).
      const dispatch = `federated.jc.${stack}.dispatch.task.assigned`;
      const peerPatterns = accept.filter((pattern) => pattern.includes(`.${stack}.`));
      expect(peerPatterns.some((pattern) => subjectMatches(pattern, dispatch))).toBe(false);
    }
  });
});

// =============================================================================
// Property 5 — INJECTIVITY (the trust-displacement invariant).
//
// LIVE assertions:
//  (a) the `./wire` class-explicit codec is injective — a principal DID can
//      never string-equal a stack DID (their position-0 class tags differ);
//  (b) the NAIVE encoding cortex mints today demonstrably COLLIDES — proving the
//      hazard is real and motivating WP-4.
//
// The cortex-side invariant ("cortex's LIVE minting is injective / the guard at
// identity-registry.ts:330-343 is unreachable") is KNOWN-VIOLATED today and is
// the `test.todo` below — flips live when WP-4 (#1880) lands the encoding.
// =============================================================================

describe("WP-3 property: DID-class injectivity", () => {
  test("LIVE: ./wire class-explicit codec — principalDid(p2) can never equal stackDid(p,s)", () => {
    const principals = generatePrincipals(64);
    forEachPair((p, s) => {
      const stackDid = unwrap(renderDid("stack", p, s), `renderDid(stack,${p},${s})`);
      for (const p2 of principals) {
        const principalDid = unwrap(renderDid("principal", p2), `renderDid(principal,${p2})`);
        // Distinct strings AND distinct classes — the class tag makes it structural.
        expect(principalDid).not.toBe(stackDid);
        expect(classOf(principalDid)).toBe("principal");
        expect(classOf(stackDid)).toBe("stack");
      }
    });
  });

  test("LIVE: the specific `andreas-meta-factory` case is disjoint under the codec", () => {
    const principalDid = unwrap(renderDid("principal", "andreas-meta-factory"), "principal");
    const stackDid = unwrap(renderDid("stack", "andreas", "meta-factory"), "stack");
    expect(principalDid).toBe("did:mf:principal.andreas-meta-factory");
    expect(stackDid).toBe("did:mf:stack.andreas.meta-factory");
    expect(principalDid).not.toBe(stackDid);
  });

  test("LIVE: the NAIVE encoding (cortex.ts:1071 / identity-registry.ts:178) COLLIDES — the hazard is real", () => {
    // This is the trust-displacement surface #1880 exists to close: under the
    // naive `did:mf:{p}-{s}`, a hyphenated principal id maps onto a two-part
    // stack id. Asserted as a REAL equality so the todo below is not decorative.
    expect(naivePrincipalDid("andreas-meta-factory")).toBe(
      naiveStackDid("andreas", "meta-factory"),
    );
    expect(naivePrincipalDid("andreas-meta-factory")).toBe("did:mf:andreas-meta-factory");
  });

  // Gated on WP-4 (#1880): the encoding DECISION is HELD (Andreas + JC), and
  // cortex still mints the naive form (cortex.ts:1071, identity-registry.ts:178)
  // with the collision held shut only by the runtime guard at
  // identity-registry.ts:330-343. This flips live — asserting cortex's LIVE mint
  // is injective and the guard is unreachable — when WP-4 lands the class-
  // explicit encoding and WP-5 migrates the mint sites. NEVER weaken to pass.
  test.todo(
    "WP-3/WP-4 (#1879/#1880): cortex's LIVE DID minting is injective — principalDid(p2) !== stackDid({p,s}) for all inputs incl. 'andreas-meta-factory'; today it mints naive did:mf:{p}-{s} and the collision is held shut by the identity-registry.ts:330-343 guard",
    () => {},
  );
});

// =============================================================================
// Property 6 — GOLDEN TABLE. Exact rendered subject + DID strings for the real
// deployment values. Any silent re-splice of a scope fails a golden here.
// =============================================================================

describe("WP-3 golden: exact wire strings for real deployment values", () => {
  const GOLDEN = [
    { principal: "andreas", stack: "meta-factory" },
    { principal: "jc", stack: "default" },
    { principal: "jc", stack: "clawbox" },
  ] as const;

  for (const { principal, stack } of GOLDEN) {
    describe(`${principal}/${stack}`, () => {
      test("federated presence subjects (real producer path)", () => {
        expect(producerPresenceSubject(principal, stack, "online")).toBe(
          `federated.${principal}.${stack}.agent.online`,
        );
        expect(producerPresenceSubject(principal, stack, "heartbeat")).toBe(
          `federated.${principal}.${stack}.agent.heartbeat`,
        );
      });

      test("stack-id round-trips exactly", () => {
        const scope = unwrap(parseStackId(`${principal}/${stack}`), "golden stack-id");
        expect({ principal: String(scope.principal), stack: String(scope.stack) }).toEqual({
          principal,
          stack,
        });
      });

      test("class-explicit stack DID + injective subject segment (./wire codec)", () => {
        const did = unwrap(renderDid("stack", principal, stack), "golden did");
        expect(did).toBe(`did:mf:stack.${principal}.${stack}`);
        expect(unwrap(encodeDidSegment(did), "golden encode")).toBe(
          `@did-mf-stack--${principal}--${stack}`,
        );
      });

      test("naive current-wire DID (documentary — WP-4/#1880 retires this form)", () => {
        expect(naiveStackDid(principal, stack)).toBe(`did:mf:${principal}-${stack}`);
      });
    });
  }
});
