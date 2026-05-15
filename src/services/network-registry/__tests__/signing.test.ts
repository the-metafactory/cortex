/**
 * IAW D.4 — Crypto primitive tests.
 *
 * Exercises canonicalJSON determinism, Ed25519 sign/verify round-trip,
 * and the PKCS#8 → raw pubkey derivation used at boot.
 */

import { describe, test, expect } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  canonicalJSON,
  generateKeypair,
  pubkeyFromPkcs8,
  signEd25519,
  verifyEd25519,
} from "../src/signing";

describe("canonicalJSON", () => {
  test("sorts object keys recursively", () => {
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    expect(canonicalJSON(a)).toBe('{"a":2,"b":1,"nested":{"x":2,"y":1}}');
  });

  test("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  test("primitives round-trip", () => {
    expect(canonicalJSON("hi")).toBe('"hi"');
    expect(canonicalJSON(42)).toBe("42");
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(true)).toBe("true");
  });

  test("two equivalent objects produce the same string regardless of input key order", () => {
    const a = { b: 1, a: { z: 1, q: 2 } };
    const b = { a: { q: 2, z: 1 }, b: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("base64 round-trip", () => {
  test("encode/decode is identity", () => {
    const original = new Uint8Array([0, 1, 2, 3, 4, 250, 251, 252]);
    const round = base64ToBytes(bytesToBase64(original));
    expect(round).toEqual(original);
  });

  test("rejects malformed base64", () => {
    expect(() => base64ToBytes("not valid !@#$")).toThrow();
  });
});

describe("Ed25519 sign/verify", () => {
  test("valid signature verifies", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await signEd25519(kp.privateKeyB64, msg);
    expect(await verifyEd25519(kp.publicKeyB64, sig, msg)).toBe(true);
  });

  test("tampered message fails verification", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await signEd25519(kp.privateKeyB64, msg);
    const tampered = new TextEncoder().encode("hellp");
    expect(await verifyEd25519(kp.publicKeyB64, sig, tampered)).toBe(false);
  });

  test("wrong pubkey fails verification", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await signEd25519(kp1.privateKeyB64, msg);
    expect(await verifyEd25519(kp2.publicKeyB64, sig, msg)).toBe(false);
  });

  test("malformed pubkey returns false (does not throw)", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await signEd25519(kp.privateKeyB64, msg);
    expect(await verifyEd25519("not-base64-!!!", sig, msg)).toBe(false);
  });

  test("wrong-length pubkey returns false", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await signEd25519(kp.privateKeyB64, msg);
    // 16 bytes base64
    const shortPub = bytesToBase64(new Uint8Array(16));
    expect(await verifyEd25519(shortPub, sig, msg)).toBe(false);
  });
});

describe("pubkeyFromPkcs8", () => {
  test("derives the same pubkey as generation", async () => {
    const kp = await generateKeypair();
    const derived = await pubkeyFromPkcs8(kp.privateKeyB64);
    // Verify by signing with private key + checking derived pubkey accepts it.
    const msg = new TextEncoder().encode("derive-check");
    const sig = await signEd25519(kp.privateKeyB64, msg);
    expect(await verifyEd25519(derived, sig, msg)).toBe(true);
  });
});
