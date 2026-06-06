/**
 * S1 (#735) — DD-8 pubkey-encoding bridge tests.
 *
 * Round-trips a KNOWN ed25519 key between the two surfaces: config/peers
 * nkey-U (`U…`) ↔ registry base64 raw. A real NKey from `@nats-io/nkeys`
 * grounds the test in the actual codec the rest of cortex uses, not a
 * hand-built fixture.
 */

import { describe, expect, test } from "bun:test";
import { createUser } from "@nats-io/nkeys";

import { base64PubkeyToNkey, nkeyToBase64Pubkey } from "../encoding";

describe("DD-8 pubkey encoding bridge", () => {
  test("round-trips a known key: nkey-U → base64 → nkey-U", () => {
    // A real user NKey gives us a known-good `U…` pubkey.
    const kp = createUser();
    const nkeyU = kp.getPublicKey();
    expect(nkeyU).toMatch(/^U[A-Z2-7]{55}$/);

    const base64 = nkeyToBase64Pubkey(nkeyU);
    expect(base64).toBeDefined();
    expect(base64).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    const backToNkey = base64PubkeyToNkey(base64!);
    expect(backToNkey).toBe(nkeyU);
  });

  test("round-trips the other direction: base64 → nkey-U → base64", () => {
    const kp = createUser();
    const base64 = nkeyToBase64Pubkey(kp.getPublicKey());
    expect(base64).toBeDefined();

    const nkeyU = base64PubkeyToNkey(base64!);
    expect(nkeyU).toBeDefined();
    expect(nkeyU).toMatch(/^U[A-Z2-7]{55}$/);

    const back = nkeyToBase64Pubkey(nkeyU!);
    expect(back).toBe(base64);
  });

  test("base64PubkeyToNkey rejects a non-base64-Ed25519 string", () => {
    expect(base64PubkeyToNkey("not-base64!!!")).toBeUndefined();
    // Right alphabet, wrong length (not 44 chars / not 32 raw bytes).
    expect(base64PubkeyToNkey("AAAA")).toBeUndefined();
  });

  test("base64PubkeyToNkey rejects a 44-char base64 that decodes to != 32 bytes", () => {
    // 44 base64 chars but the regex requires the 43+`=` 32-byte shape; a
    // value that is structurally base64 but not a 32-byte key is rejected.
    // (All-`A` 43 chars + `=` decodes to 32 zero bytes — that IS 32 bytes and
    // is a structurally-valid key, so use a clearly-wrong padding shape.)
    expect(base64PubkeyToNkey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBeUndefined();
  });

  test("nkeyToBase64Pubkey rejects a malformed nkey", () => {
    expect(nkeyToBase64Pubkey("not-an-nkey")).toBeUndefined();
  });
});
