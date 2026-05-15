/**
 * IAW D.4 — Ed25519 sign/verify primitives for the network registry.
 *
 * Uses WebCrypto (`crypto.subtle`) so the code runs unchanged on
 * Cloudflare Workers, Bun (tests), and Node 20+. We deliberately do
 * NOT pull in `tweetnacl` / `noble-curves` — WebCrypto's Ed25519
 * support landed in Workers in 2023 and Bun in 2024, and skipping
 * a polyfill keeps the Worker bundle small.
 *
 * Canonical JSON
 * ──────────────
 * Both sides need to agree byte-for-byte on what was signed. We use
 * a recursive sort-keys canonicalisation: object keys are emitted in
 * lexicographic order, arrays preserve their order, no whitespace.
 * This is the same scheme RFC 8785 (JCS) specifies for primitive
 * cases. We do NOT need RFC 8785's full numeric handling because
 * the registry only ever signs strings and small integer-valued
 * timestamps; if that changes, swap in a JCS lib at this seam.
 */

// =============================================================================
// Canonical JSON
// =============================================================================

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * Arrays preserve their order. Throws on cycles (JSON.stringify behaviour).
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  // Mirror JSON.stringify's handling of `undefined`: skip object keys
  // whose value is `undefined`. Without this, a producer that builds a
  // claim by spread-with-optionals (`{ ...base, metadata: undefined }`)
  // would canonicalize differently from the same claim after a
  // round-trip through `JSON.parse(JSON.stringify(...))`, breaking
  // signature verification at the receiver.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
  return "{" + parts.join(",") + "}";
}

// =============================================================================
// Base64 (URL-safe NOT used — operators paste standard base64)
// =============================================================================

export function base64ToBytes(b64: string): Uint8Array {
  // Workers + Bun + modern Node all have atob(). Wrap so a malformed input
  // surfaces as a recognisable Error rather than a DOMException.
  let bin: string;
  try {
    bin = atob(b64);
  } catch (_err) {
    throw new Error("invalid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// =============================================================================
// Ed25519 sign / verify
// =============================================================================

/**
 * Verify an Ed25519 signature.
 *
 * @param pubkeyB64 32-byte raw public key, base64-encoded.
 * @param signatureB64 64-byte raw signature, base64-encoded.
 * @param message Bytes that were signed. Caller is responsible for
 *                canonicalisation (use `canonicalJSON` then TextEncoder).
 *
 * Returns `false` on any failure (bad key, bad signature, crypto error)
 * — we never throw to the caller, because verify failures are part of
 * the normal control flow at the route layer (deny + audit), not
 * exceptional paths.
 */
export async function verifyEd25519(
  pubkeyB64: string,
  signatureB64: string,
  message: Uint8Array,
): Promise<boolean> {
  let pubBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubBytes = base64ToBytes(pubkeyB64);
    sigBytes = base64ToBytes(signatureB64);
  } catch (_err) {
    return false;
  }
  if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, message);
  } catch (_err) {
    return false;
  }
}

/**
 * Sign a message with the registry's Ed25519 private key.
 *
 * @param privateKeyB64 The PKCS#8-encoded Ed25519 private key, base64.
 *                      We use PKCS#8 (not raw 32-byte seed) because
 *                      WebCrypto's `importKey('pkcs8', …)` is the path
 *                      that works uniformly across Workers / Bun / Node.
 *                      Generation helper is provided in this file.
 * @param message Bytes to sign.
 *
 * Returns the 64-byte raw signature, base64-encoded.
 */
export async function signEd25519(
  privateKeyB64: string,
  message: Uint8Array,
): Promise<string> {
  const pkcs8 = base64ToBytes(privateKeyB64);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, message);
  return bytesToBase64(new Uint8Array(sig));
}

/**
 * Derive the raw 32-byte Ed25519 public key from a PKCS#8 private key.
 * Used at boot to surface the registry's pubkey at GET /registry/pubkey
 * without the operator having to maintain two secrets.
 *
 * Approach: import the PKCS#8 key, export it as JWK, then base64-decode
 * the `x` field (which is the raw public key in url-safe base64).
 */
export async function pubkeyFromPkcs8(privateKeyB64: string): Promise<string> {
  const pkcs8 = base64ToBytes(privateKeyB64);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    true, // extractable so we can read .x
    ["sign"],
  );
  // `exportKey("jwk", …)` returns `JsonWebKey` at runtime, but the TS
  // lib types it as `ArrayBuffer | JsonWebKey` because the format
  // parameter is a string literal union. Narrow explicitly.
  const exported = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (typeof exported.x !== "string") {
    throw new Error("exported JWK missing x coordinate");
  }
  // JWK uses base64url; convert to standard base64.
  const b64 = exported.x.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to multiple of 4.
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return padded;
}

/**
 * Generate a fresh Ed25519 keypair (test helper). Returns the PKCS#8
 * private key + the raw public key, both base64-encoded.
 *
 * NOT used at runtime — production deployments provision the registry
 * key out-of-band via `wrangler secret put`. Kept here so tests have a
 * one-call way to mint operator credentials.
 */
export async function generateKeypair(): Promise<{
  privateKeyB64: string;
  publicKeyB64: string;
}> {
  const keypair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // Both formats return ArrayBuffer at runtime, but TS types it as
  // `ArrayBuffer | JsonWebKey` because of the union signature. Cast.
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keypair.privateKey)) as ArrayBuffer;
  const raw = (await crypto.subtle.exportKey("raw", keypair.publicKey)) as ArrayBuffer;
  return {
    privateKeyB64: bytesToBase64(new Uint8Array(pkcs8)),
    publicKeyB64: bytesToBase64(new Uint8Array(raw)),
  };
}
