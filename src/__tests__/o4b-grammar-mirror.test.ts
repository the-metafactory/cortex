/**
 * O-4a.2 / O-4b grammar anti-drift test.
 *
 * The registry package (`src/services/network-registry`) mirrors two regex
 * predicates from `src/common/nats/leaf-remote-renderer.ts` so it can
 * validate leaf packages without a cross-package import:
 *
 *   isNkeyAccountPubkeyRegistry  ↔  isNkeyAccountPubkey
 *     (NATS nkey-U account pubkey grammar: /^A[A-Z2-7]{55}$/)
 *
 *   isNscJwtShapeRegistry  ↔  isNscJwtShape
 *     (NSC JWT shape: /^eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/)
 *
 * This test imports BOTH sides and asserts identical results for a shared
 * set of known-good and known-bad vectors. A regex change in either module
 * that isn't reflected in the other will break this test before it causes
 * a silent validation mismatch in production.
 *
 * Test vectors are the SAME as in:
 *   src/services/network-registry/__tests__/o4a2-package.test.ts
 */

import { describe, test, expect } from "bun:test";
// O-4b canonical source (leaf-remote-renderer.ts) — the reference grammar.
import { isNkeyAccountPubkey, isNscJwtShape } from "../common/nats/leaf-remote-renderer";
// Registry mirror — must produce identical results for every vector.
import {
  isNkeyAccountPubkeyRegistry,
  isNscJwtShapeRegistry,
} from "../services/network-registry/src/validate";

// =============================================================================
// Shared test vectors (same set as o4a2-package.test.ts)
// =============================================================================

const NKEY_VECTORS: { label: string; value: string; expected: boolean }[] = [
  {
    // A prefix + 55 base32 chars = 56 total — matches /^A[A-Z2-7]{55}$/
    label: "known-good nkey-U (56 chars, A prefix, base32)",
    value: "AABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
    expected: true,
  },
  {
    label: "too short (6 chars)",
    value: "ABCDEF",
    expected: false,
  },
  {
    label: "wrong prefix (starts with B)",
    value: "BABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
    expected: false,
  },
  {
    label: "lowercase (invalid base32 for nkey)",
    value: "aabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw",
    expected: false,
  },
  {
    label: "empty string",
    value: "",
    expected: false,
  },
  {
    label: "too long (57 chars)",
    value: "AABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX",
    expected: false,
  },
];

const JWT_VECTORS: { label: string; value: string; expected: boolean }[] = [
  {
    label: "known-good 3-segment base64url JWT starting with eyJ",
    value: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl",
    expected: true,
  },
  {
    label: "only one segment (no dots)",
    value: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ",
    expected: false,
  },
  {
    label: "too many segments (4 parts)",
    value: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl.extra",
    expected: false,
  },
  {
    label: "does not start with eyJ",
    value: "BAAAAD.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl",
    expected: false,
  },
  {
    label: "empty string",
    value: "",
    expected: false,
  },
  {
    label: "plain ASCII text (not a JWT)",
    value: "not-a-jwt",
    expected: false,
  },
];

// =============================================================================
// Cross-module anti-drift assertions
// =============================================================================

describe("isNkeyAccountPubkey ↔ isNkeyAccountPubkeyRegistry — grammar anti-drift", () => {
  for (const { label, value, expected } of NKEY_VECTORS) {
    test(`${label} → ${expected.toString()}`, () => {
      expect(isNkeyAccountPubkey(value)).toBe(expected);
      expect(isNkeyAccountPubkeyRegistry(value)).toBe(expected);
    });
  }
});

describe("isNscJwtShape ↔ isNscJwtShapeRegistry — grammar anti-drift", () => {
  for (const { label, value, expected } of JWT_VECTORS) {
    test(`${label} → ${expected.toString()}`, () => {
      expect(isNscJwtShape(value)).toBe(expected);
      expect(isNscJwtShapeRegistry(value)).toBe(expected);
    });
  }
});
