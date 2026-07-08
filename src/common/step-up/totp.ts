/**
 * FND-3 (docs/plan-mc-future-state.md §4.0) — RFC 6238 TOTP primitive.
 *
 * Pure, dependency-free (node:crypto only) TOTP so the step-up-MFA seam
 * (`step-up-mfa.ts`) has a self-contained, unit-testable core. RFC 6238 (TOTP)
 * layered over RFC 4226 (HOTP), HMAC-SHA1, 6 digits, 30-second period — the
 * defaults every authenticator app (Google Authenticator, 1Password, Aegis,
 * …) provisions from an `otpauth://totp/…` URI.
 *
 * SECURITY DISCIPLINE (this module):
 *  - `verifyTotp` is **constant-time across the whole accept window**: it
 *    evaluates every candidate step and folds the results with a bitwise OR —
 *    there is no early return that could leak, via timing, which step matched.
 *  - The per-step compare is `crypto.timingSafeEqual` over equal-length code
 *    buffers (never `===` on the decimal strings).
 *  - Nothing here writes to stdout/stderr, the event pipeline, or any log. The
 *    caller is responsible for never emitting the secret or the submitted code.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** RFC 6238 defaults — the shape every authenticator app provisions by default. */
export const TOTP_DEFAULTS = {
  /** Digits in the generated code. 6 is the universal authenticator default. */
  digits: 6,
  /** Time step in seconds. 30 is the universal default. */
  period: 30,
  /**
   * Accept window in steps on EACH side of the current step. ±1 tolerates the
   * client's clock skew / the code being entered right at a boundary while
   * keeping the guessing surface tiny (3 live codes at any instant). The issue
   * pins this to ±1.
   */
  window: 1,
} as const;

/** RFC 4648 base32 alphabet (upper-case, no padding in `otpauth://` secrets). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encode raw bytes to RFC 4648 base32 (no padding). Used to render a freshly
 * generated secret into the `otpauth://` provisioning form. Upper-case,
 * unpadded — the form authenticator apps expect.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return out;
}

/**
 * Decode an RFC 4648 base32 string to bytes. Case-insensitive; tolerates
 * padding (`=`), spaces, and hyphens (authenticator apps and QR-transcribers
 * introduce these). Throws on any character outside the alphabet — a malformed
 * secret must fail loudly at load time, never silently decode to garbage that
 * would make every code mismatch.
 */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[\s-]/g, "");
  if (cleaned.length === 0) {
    throw new Error("base32 secret is empty");
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`invalid base32 character in secret: ${JSON.stringify(ch)}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Generate a cryptographically-random TOTP secret and return it base32-encoded.
 * 20 bytes (160 bits) is the RFC 4226 §4 recommended HMAC-SHA1 key length.
 */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

/** Encode a counter as the 8-byte big-endian buffer HOTP feeds to the HMAC. */
function counterToBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // Counter fits comfortably in the low 32 bits for any realistic time; the
  // high word is written for RFC correctness (it is 0 until year ~2038*2^32).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  return buf;
}

/**
 * RFC 4226 HOTP for a specific counter, rendered as a zero-padded decimal
 * string of `digits` length. Exported for unit tests to pin against the
 * RFC 6238 Appendix-B test vectors.
 */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DEFAULTS.digits,
): string {
  const hmac = createHmac("sha1", Buffer.from(secret));
  hmac.update(counterToBuffer(counter));
  const digest = hmac.digest();
  // Dynamic truncation (RFC 4226 §5.3). readUInt8 returns a number (throws on
  // out-of-range) — the SHA-1 digest is 20 bytes and offset ≤ 15, so
  // offset+3 ≤ 18 is always in range, and we avoid non-null assertions.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary =
    ((digest.readUInt8(offset) & 0x7f) << 24) |
    (digest.readUInt8(offset + 1) << 16) |
    (digest.readUInt8(offset + 2) << 8) |
    digest.readUInt8(offset + 3);
  const mod = 10 ** digits;
  return (binary % mod).toString().padStart(digits, "0");
}

/** The current TOTP time-step for a given wall-clock time (ms since epoch). */
export function totpStep(nowMs: number, period: number = TOTP_DEFAULTS.period): number {
  return Math.floor(nowMs / 1000 / period);
}

/** Options for {@link verifyTotp}. All optional — RFC defaults otherwise. */
export interface VerifyTotpOptions {
  /** Current time in ms since epoch. Injected in tests; defaults to `Date.now()`. */
  nowMs?: number;
  digits?: number;
  period?: number;
  /** Accept window in steps on each side (±). Defaults to {@link TOTP_DEFAULTS.window}. */
  window?: number;
}

/** A submitted code is only ever a fixed-length decimal string. */
function isWellFormedCode(code: string, digits: number): boolean {
  return code.length === digits && /^[0-9]+$/.test(code);
}

/**
 * Constant-time TOTP verification.
 *
 * Returns `true` iff `submitted` matches the code for the current step or any
 * step within ±`window`. The comparison is constant-time in two senses:
 *  1. Every candidate step is evaluated (no early return); the boolean results
 *     are folded with bitwise OR so total work is independent of WHICH step
 *     (if any) matched.
 *  2. Each per-step compare is `crypto.timingSafeEqual` over equal-length
 *     buffers, so it does not leak a matching prefix.
 *
 * A malformed `submitted` (wrong length / non-digit) returns `false` after a
 * dummy compare pass, so a malformed code is not measurably faster to reject
 * than a well-formed wrong one.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  options: VerifyTotpOptions = {},
): boolean {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const period = options.period ?? TOTP_DEFAULTS.period;
  const window = options.window ?? TOTP_DEFAULTS.window;
  const nowMs = options.nowMs ?? Date.now();

  const secret = base32Decode(secretBase32);
  const currentStep = totpStep(nowMs, period);

  const submittedBuf = Buffer.from(submitted, "utf8");
  const wellFormed = isWellFormedCode(submitted, digits);

  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = hotp(secret, currentStep + offset, digits);
    const candidateBuf = Buffer.from(candidate, "utf8");
    // Only compare equal-length buffers (timingSafeEqual throws otherwise).
    // A malformed submission compares against the candidate itself (guaranteed
    // equal length, guaranteed to differ from the attacker's input) so the
    // loop still does the full HMAC work per step.
    const lhs = wellFormed && submittedBuf.length === candidateBuf.length
      ? submittedBuf
      : candidateBuf;
    const dummy = !wellFormed || submittedBuf.length !== candidateBuf.length;
    const eq = timingSafeEqual(lhs, candidateBuf);
    matched = matched || (eq && !dummy);
  }
  return matched;
}

/**
 * Build the `otpauth://totp/…` provisioning URI an authenticator app consumes.
 * NOTE: this URI CONTAINS the secret — it is the enrollment ceremony's
 * one-time display and must NEVER be logged or persisted anywhere but the
 * principal's authenticator. Callers gate its emission accordingly.
 */
export function buildOtpauthUri(params: {
  secretBase32: string;
  issuer: string;
  account: string;
  digits?: number;
  period?: number;
}): string {
  const digits = params.digits ?? TOTP_DEFAULTS.digits;
  const period = params.period ?? TOTP_DEFAULTS.period;
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
