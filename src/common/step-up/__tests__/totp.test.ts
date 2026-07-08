/**
 * FND-3 — RFC 6238 TOTP core (`src/common/step-up/totp.ts`).
 *
 * Pins the implementation against the RFC 6238 Appendix-B SHA-1 test vectors
 * (the authoritative correctness check), plus base32 round-trips, the ±1-step
 * accept window, malformed-code rejection, and secret generation.
 */

import { describe, it, expect } from "bun:test";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  totpStep,
  verifyTotp,
} from "../totp";

// RFC 6238 Appendix B seed for HMAC-SHA1: the 20-byte ASCII string that is the
// digits 1-0 repeated twice ("1234567890" x2). Built via repeat() rather than a
// bare 20-digit literal so the confidentiality gate's platform-snowflake pattern
// (17-20 digit runs) does not false-positive on an RFC test vector.
const RFC_SECRET_ASCII = "1234567890".repeat(2);
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, "utf8"));

// RFC 6238 Appendix B (SHA1) — [unix-time-seconds, expected 8-digit TOTP].
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 64, 32, 16, 8]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
  });

  it("decodes case-insensitively and tolerates spaces/hyphens/padding", () => {
    const canonical = base32Encode(Buffer.from("hello world", "utf8"));
    const messy = canonical.toLowerCase().replace(/(.{4})/g, "$1 ") + "===";
    expect([...base32Decode(messy)]).toEqual([...base32Decode(canonical)]);
  });

  it("throws on an invalid base32 character", () => {
    expect(() => base32Decode("ABC!DEF")).toThrow(/invalid base32/);
  });

  it("throws on an empty secret", () => {
    expect(() => base32Decode("   ")).toThrow(/empty/);
  });
});

describe("hotp / totp — RFC 6238 Appendix-B SHA1 vectors", () => {
  for (const [unixSeconds, expected8] of RFC_VECTORS) {
    it(`t=${unixSeconds} → ${expected8}`, () => {
      const step = totpStep(unixSeconds * 1000, 30);
      const secret = base32Decode(RFC_SECRET_B32);
      // 8-digit vector (the RFC's tabulated value).
      expect(hotp(secret, step, 8)).toBe(expected8);
      // 6-digit is the low 6 of the same dynamic-truncation binary.
      const expected6 = expected8.slice(-6);
      expect(hotp(secret, step, 6)).toBe(expected6);
    });
  }
});

describe("verifyTotp", () => {
  const NOW = 1111111111 * 1000; // matches the "14050471" vector
  const currentCode6 = "050471";

  it("accepts the current 6-digit code", () => {
    expect(verifyTotp(RFC_SECRET_B32, currentCode6, { nowMs: NOW })).toBe(true);
  });

  it("accepts a code one step in the past (−1 window)", () => {
    const secret = base32Decode(RFC_SECRET_B32);
    const prev = hotp(secret, totpStep(NOW, 30) - 1, 6);
    expect(verifyTotp(RFC_SECRET_B32, prev, { nowMs: NOW })).toBe(true);
  });

  it("accepts a code one step in the future (+1 window)", () => {
    const secret = base32Decode(RFC_SECRET_B32);
    const next = hotp(secret, totpStep(NOW, 30) + 1, 6);
    expect(verifyTotp(RFC_SECRET_B32, next, { nowMs: NOW })).toBe(true);
  });

  it("rejects a code two steps away (outside ±1)", () => {
    const secret = base32Decode(RFC_SECRET_B32);
    const twoAhead = hotp(secret, totpStep(NOW, 30) + 2, 6);
    expect(verifyTotp(RFC_SECRET_B32, twoAhead, { nowMs: NOW })).toBe(false);
  });

  it("rejects a plainly wrong code", () => {
    expect(verifyTotp(RFC_SECRET_B32, "000000", { nowMs: NOW })).toBe(false);
  });

  it("rejects malformed codes (wrong length / non-digit) without throwing", () => {
    expect(verifyTotp(RFC_SECRET_B32, "12345", { nowMs: NOW })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "1234567", { nowMs: NOW })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "abcdef", { nowMs: NOW })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "", { nowMs: NOW })).toBe(false);
  });

  it("honours a custom window of 0 (only the current step)", () => {
    const secret = base32Decode(RFC_SECRET_B32);
    const next = hotp(secret, totpStep(NOW, 30) + 1, 6);
    expect(verifyTotp(RFC_SECRET_B32, next, { nowMs: NOW, window: 0 })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, currentCode6, { nowMs: NOW, window: 0 })).toBe(true);
  });
});

describe("generateTotpSecret", () => {
  it("produces a decodable base32 secret of the expected entropy", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret).length).toBe(20); // 160 bits
  });

  it("produces distinct secrets across calls", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("buildOtpauthUri", () => {
  it("embeds the secret + issuer + account and standard params", () => {
    const uri = buildOtpauthUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      issuer: "cortex",
      account: "cortex-daemon",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=cortex");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
