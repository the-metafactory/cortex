/**
 * cortex#1482 (epic #1479, join-3) — pubkey-normalize util tests.
 *
 * Round-trips REAL nkeys (via `@nats-io/nkeys`, the same codec the rest of
 * cortex trusts) between the nkey and base64 encodings, proves
 * representation-agnostic equality, and proves the module never hand-waves a
 * garbage input into a false positive.
 */

import { describe, expect, test } from "bun:test";
import { createAccount, createUser } from "@nats-io/nkeys";

import {
  detectPubkey,
  looksLikeNkeyRole,
  samePubkey,
  toBase64Pubkey,
  toNkeyPubkey,
} from "../pubkey-normalize";

describe("detectPubkey", () => {
  test("detects a real user nkey", () => {
    const nkeyU = createUser().getPublicKey();
    const detected = detectPubkey(nkeyU);
    expect(detected?.encoding).toBe("nkey");
    expect(detected?.role).toBe("user");
    expect(detected?.raw.length).toBe(32);
  });

  test("detects a real account nkey", () => {
    const nkeyA = createAccount().getPublicKey();
    const detected = detectPubkey(nkeyA);
    expect(detected?.encoding).toBe("nkey");
    expect(detected?.role).toBe("account");
  });

  test("detects a base64 pubkey (no role)", () => {
    const b64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    const detected = detectPubkey(b64);
    expect(detected?.encoding).toBe("base64");
    expect(detected?.role).toBeUndefined();
  });

  test("rejects non-pubkey garbage", () => {
    expect(detectPubkey("not-a-pubkey")).toBeUndefined();
    expect(detectPubkey("")).toBeUndefined();
    expect(detectPubkey("AAAA")).toBeUndefined();
  });

  test("rejects an nkey-shaped string with a bad checksum", () => {
    // Grammar-valid (A + 55 base32 chars) but not a real, checksum-valid key.
    expect(detectPubkey("A" + "B".repeat(55))).toBeUndefined();
  });

  test("trims surrounding whitespace", () => {
    const nkeyU = createUser().getPublicKey();
    expect(detectPubkey(`  ${nkeyU}\n`)?.encoding).toBe("nkey");
  });
});

describe("toBase64Pubkey — NKEY -> base64 and passthrough", () => {
  test("converts a real user nkey to base64", () => {
    const kp = createUser();
    const nkeyU = kp.getPublicKey();
    const b64 = toBase64Pubkey(nkeyU);
    expect(b64).toBeDefined();
    expect(b64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test("converts a real account nkey to base64 too (base64 carries no role)", () => {
    const nkeyA = createAccount().getPublicKey();
    expect(toBase64Pubkey(nkeyA)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test("round-trips an already-base64 pubkey byte-identically", () => {
    const b64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    expect(toBase64Pubkey(b64)).toBe(b64);
  });

  test("undefined for garbage", () => {
    expect(toBase64Pubkey("not-a-pubkey")).toBeUndefined();
  });
});

describe("toNkeyPubkey — base64 -> NKEY, passthrough, and role refusal", () => {
  test("converts a base64 pubkey to the requested role", () => {
    const b64 = Buffer.from(new Uint8Array(32)).toString("base64");
    const asAccount = toNkeyPubkey(b64, "account");
    expect(asAccount).toMatch(/^A[A-Z2-7]{55}$/);
    const asUser = toNkeyPubkey(b64, "user");
    expect(asUser).toMatch(/^U[A-Z2-7]{55}$/);
  });

  test("round-trips base64 -> nkey -> base64 for a real key", () => {
    const kp = createUser();
    const nkeyU = kp.getPublicKey();
    const b64 = toBase64Pubkey(nkeyU)!;
    const backToNkey = toNkeyPubkey(b64, "user");
    expect(backToNkey).toBe(nkeyU);
  });

  test("passes through an nkey already of the requested role, VERBATIM (grammar-only, no checksum re-derivation)", () => {
    // A deliberately-fake (checksum-invalid) but grammar-valid account nkey —
    // the exact style used across the existing --hub-account test fixtures.
    const fakeAccount = "A" + "D".repeat(55);
    expect(toNkeyPubkey(fakeAccount, "account")).toBe(fakeAccount);
  });

  test("REFUSES to re-role a real nkey of the OTHER role", () => {
    const nkeyU = createUser().getPublicKey();
    expect(toNkeyPubkey(nkeyU, "account")).toBeUndefined();
    const nkeyA = createAccount().getPublicKey();
    expect(toNkeyPubkey(nkeyA, "user")).toBeUndefined();
  });

  test("undefined for garbage", () => {
    expect(toNkeyPubkey("not-a-pubkey", "account")).toBeUndefined();
  });
});

describe("samePubkey — representation-agnostic equality", () => {
  test("true for the SAME key across nkey and base64 encodings", () => {
    const kp = createUser();
    const nkeyU = kp.getPublicKey();
    const b64 = toBase64Pubkey(nkeyU)!;
    expect(samePubkey(nkeyU, b64)).toBe(true);
    expect(samePubkey(b64, nkeyU)).toBe(true);
  });

  test("true for the SAME raw bytes even across DIFFERENT roles (role-blind by design)", () => {
    // Manually encode the identical 32 raw bytes as both a user and an
    // account nkey — samePubkey compares key MATERIAL, not role.
    const raw = new Uint8Array(32).fill(3);
    const b64 = Buffer.from(raw).toString("base64");
    const asUser = toNkeyPubkey(b64, "user")!;
    const asAccount = toNkeyPubkey(b64, "account")!;
    expect(samePubkey(asUser, asAccount)).toBe(true);
  });

  test("false for two DIFFERENT keys", () => {
    const a = createUser().getPublicKey();
    const b = createUser().getPublicKey();
    expect(samePubkey(a, b)).toBe(false);
  });

  test("false (never throws) when either side isn't a recognizable pubkey", () => {
    const nkeyU = createUser().getPublicKey();
    expect(samePubkey(nkeyU, "garbage")).toBe(false);
    expect(samePubkey("garbage", "also-garbage")).toBe(false);
  });
});

describe("looksLikeNkeyRole — grammar-only hint (tolerates a bad checksum)", () => {
  test("true for a real account nkey", () => {
    expect(looksLikeNkeyRole(createAccount().getPublicKey(), "account")).toBe(true);
  });

  test("true for a shape-valid but checksum-invalid account nkey (the fixture style used elsewhere)", () => {
    expect(looksLikeNkeyRole("A" + "D".repeat(55), "account")).toBe(true);
  });

  test("false for the wrong role or non-nkey input", () => {
    expect(looksLikeNkeyRole(createUser().getPublicKey(), "account")).toBe(false);
    expect(looksLikeNkeyRole("not-a-pubkey", "account")).toBe(false);
  });
});
