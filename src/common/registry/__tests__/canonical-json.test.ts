/**
 * C-1416 / #1418 — the single shared canonicalJSON module.
 *
 * Locks three things:
 *   1. ROUND-TRIP IDENTITY — the shared canonicaliser emits the EXACT bytes the
 *      two hand-maintained mirrors emitted (asserted against known-good literals
 *      + against a JSON.parse(JSON.stringify(...)) round-trip). This is the
 *      regression guard: any future change to the byte output trips these.
 *   2. NO-DRIFT — the registry-side `signing.ts` and the common-side `signing.ts`
 *      now re-export the SAME function reference from `./canonical-json`, so they
 *      are literally identical (===) and cannot diverge (#1416).
 *   3. THE PRE-AUTH GUARDS — depth (#832) + width/size (#1418) caps throw, and
 *      never fire for legit-sized input (so byte output is unchanged).
 */

import { describe, test, expect } from "bun:test";
import {
  canonicalJSON,
  CanonicalDepthError,
  CanonicalWidthError,
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_KEYS,
  MAX_CANONICAL_ARRAY_LEN,
  MAX_CANONICAL_NODES,
} from "../canonical-json";
import * as commonSigning from "../signing";
import * as registrySigning from "../../../services/network-registry/src/signing";

// =============================================================================
// 1. Round-trip identity — known-good bytes (unchanged by the refactor)
// =============================================================================

describe("canonicalJSON — byte-exact output (round-trip identity)", () => {
  test("primitives match JSON.stringify", () => {
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(42)).toBe("42");
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON("x")).toBe('"x"');
  });

  test("object keys sorted lexicographically, no whitespace", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("undefined-valued keys skipped (JSON.stringify parity)", () => {
    expect(canonicalJSON({ a: 1, c: undefined, b: 2 })).toBe('{"a":1,"b":2}');
  });

  test("arrays preserve order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  test("nested structure: recursive sort, arrays in order", () => {
    expect(canonicalJSON({ z: { y: 2, x: 1 }, a: [{ k: "v" }, 1] })).toBe(
      '{"a":[{"k":"v"},1],"z":{"x":1,"y":2}}',
    );
  });

  test("a realistic registration-claim shape → stable bytes", () => {
    const claim = {
      principal_id: "andreas",
      principal_pubkey: "PUBKEY==",
      stacks: [{ stack_id: "andreas/work" }, { stack_id: "andreas/research" }],
      capabilities: [{ id: "code-review.typescript" }],
      issued_at: "2026-07-03T00:00:00.000Z",
      nonce: "abc123",
    };
    // Keys sorted: capabilities, issued_at, nonce, principal_id, principal_pubkey, stacks.
    expect(canonicalJSON(claim)).toBe(
      '{"capabilities":[{"id":"code-review.typescript"}],' +
        '"issued_at":"2026-07-03T00:00:00.000Z","nonce":"abc123",' +
        '"principal_id":"andreas","principal_pubkey":"PUBKEY==",' +
        '"stacks":[{"stack_id":"andreas/work"},{"stack_id":"andreas/research"}]}',
    );
  });

  test("output is invariant under JSON parse/stringify round-trip", () => {
    const battery: unknown[] = [
      { b: 1, a: 2, nested: { d: 4, c: 3 } },
      [1, { y: 2, x: 1 }, "s"],
      { list: [3, 2, 1], flag: true, name: "n" },
      "plain string",
      { unicode: "ünïcødé", "quote\"key": 1 },
    ];
    for (const v of battery) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(v));
      expect(canonicalJSON(roundTripped)).toBe(canonicalJSON(v));
    }
  });
});

// =============================================================================
// 2. No-drift — both signing.ts re-export the SAME function
// =============================================================================

describe("canonicalJSON — the two mirrors can no longer drift (#1416)", () => {
  test("registry-side and common-side re-exports are the SAME reference", () => {
    expect(registrySigning.canonicalJSON).toBe(commonSigning.canonicalJSON);
    expect(registrySigning.canonicalJSON).toBe(canonicalJSON);
    expect(registrySigning.MAX_CANONICAL_DEPTH).toBe(commonSigning.MAX_CANONICAL_DEPTH);
    expect(registrySigning.CanonicalDepthError).toBe(commonSigning.CanonicalDepthError);
  });

  test("both produce identical bytes across a battery (belt-and-suspenders)", () => {
    const battery: unknown[] = [
      { b: 1, a: 2 },
      [{ k: "v" }, 1, "x"],
      { stacks: [{ stack_id: "p/s" }], nonce: "n", issued_at: "t" },
    ];
    for (const v of battery) {
      expect(registrySigning.canonicalJSON(v)).toBe(commonSigning.canonicalJSON(v));
    }
  });
});

// =============================================================================
// 3. Depth cap (#832)
// =============================================================================

/** Build an object nested `k` levels deep around a primitive. */
function nest(k: number): unknown {
  let inner: unknown = 0;
  for (let i = 0; i < k; i++) inner = { n: inner };
  return inner;
}

describe("canonicalJSON — depth cap (#832)", () => {
  test(`at the limit (${MAX_CANONICAL_DEPTH.toString()}) → OK`, () => {
    expect(() => canonicalJSON(nest(MAX_CANONICAL_DEPTH))).not.toThrow();
  });

  test(`over the limit (${(MAX_CANONICAL_DEPTH + 1).toString()}) → CanonicalDepthError`, () => {
    expect(() => canonicalJSON(nest(MAX_CANONICAL_DEPTH + 1))).toThrow(CanonicalDepthError);
  });
});

// =============================================================================
// 4. Width / size caps (#1418) — the pre-auth DoS guards
// =============================================================================

describe("canonicalJSON — width/size caps (#1418)", () => {
  test(`object with ${MAX_CANONICAL_KEYS.toString()} keys → OK; +1 → CanonicalWidthError`, () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: MAX_CANONICAL_KEYS }, (_, i) => [`k${i.toString()}`, i]),
    );
    expect(() => canonicalJSON(atLimit)).not.toThrow();

    const overLimit = Object.fromEntries(
      Array.from({ length: MAX_CANONICAL_KEYS + 1 }, (_, i) => [`k${i.toString()}`, i]),
    );
    expect(() => canonicalJSON(overLimit)).toThrow(CanonicalWidthError);
  });

  test(`array of length ${MAX_CANONICAL_ARRAY_LEN.toString()} → OK; +1 → CanonicalWidthError`, () => {
    const atLimit = Array.from({ length: MAX_CANONICAL_ARRAY_LEN }, (_, i) => i);
    expect(() => canonicalJSON(atLimit)).not.toThrow();

    const overLimit = Array.from({ length: MAX_CANONICAL_ARRAY_LEN + 1 }, (_, i) => i);
    expect(() => canonicalJSON(overLimit)).toThrow(CanonicalWidthError);
  });

  test("distributed structure over the TOTAL node budget → CanonicalWidthError", () => {
    // Each container stays UNDER its per-node cap, but the aggregate blows the
    // MAX_CANONICAL_NODES budget — the vector the per-node caps alone miss.
    const outerLen = 4000; // < MAX_CANONICAL_ARRAY_LEN
    const innerLen = 60; // < MAX_CANONICAL_ARRAY_LEN
    // outerLen + outerLen*innerLen = 4000 + 240000 = 244000 > MAX_CANONICAL_NODES.
    expect(outerLen + outerLen * innerLen).toBeGreaterThan(MAX_CANONICAL_NODES);
    const wide = Array.from({ length: outerLen }, () =>
      Array.from({ length: innerLen }, (_, i) => i),
    );
    expect(() => canonicalJSON(wide)).toThrow(CanonicalWidthError);
  });

  test("legit-sized claim (well under every cap) never throws + round-trips", () => {
    const claim = {
      principal_id: "andreas",
      principal_pubkey: "PUBKEY==",
      stacks: Array.from({ length: 20 }, (_, i) => ({ stack_id: `andreas/s${i.toString()}` })),
      capabilities: Array.from({ length: 20 }, (_, i) => ({ id: `cap.${i.toString()}` })),
      metadata: { a: 1, b: 2, c: 3 },
      issued_at: "2026-07-03T00:00:00.000Z",
      nonce: "abc123",
    };
    expect(() => canonicalJSON(claim)).not.toThrow();
    const roundTripped: unknown = JSON.parse(JSON.stringify(claim));
    expect(canonicalJSON(roundTripped)).toBe(canonicalJSON(claim));
  });
});
