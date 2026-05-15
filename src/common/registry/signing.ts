/**
 * IAW Phase D.4.3 — Ed25519 verify + canonical-JSON primitives for
 * the cortex-side RegistryClient.
 *
 * Deliberately a verify-only mirror of
 * `src/services/network-registry/src/signing.ts`. We do NOT import the
 * service-side module: the registry is a deployable artefact with its
 * own package + tsconfig, and cross-package imports would couple
 * cortex bot's build graph to a sibling deploy target. Both files
 * MUST stay byte-compatible on the canonical-JSON path — that's the
 * cross-checker pair RFC 8785 calls out — and the test suite for the
 * client (and the service) cover this by round-tripping signatures.
 *
 * If the service-side canonicalisation ever changes, this file moves
 * lock-step.
 *
 * Sign is intentionally absent: cortex never signs registry assertions.
 * Only operator-side registration (separate concern, lives elsewhere
 * in the federation tooling) signs.
 */

// =============================================================================
// Canonical JSON — recursive sort-keys, no whitespace.
// =============================================================================

/**
 * Mirror of the registry's `canonicalJSON`. Object keys sorted
 * lexicographically + recursively; `undefined` values skipped (to
 * match `JSON.stringify` behaviour after a parse/stringify round-trip);
 * no whitespace.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]),
  );
  return "{" + parts.join(",") + "}";
}

// =============================================================================
// Base64 helpers — standard alphabet (NOT url-safe).
// =============================================================================

export function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch (err) {
    throw new Error("invalid base64", { cause: err });
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// =============================================================================
// Ed25519 verify (WebCrypto). Never throws — returns false on any
// failure. The registry's signing.ts has identical semantics.
// =============================================================================

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
    // Cast to BufferSource — the lib.dom types for `crypto.subtle` are
    // parameterised over `ArrayBufferLike` in ways that confuse strict
    // mode when `Uint8Array<ArrayBufferLike>` could be backed by either
    // an `ArrayBuffer` or a `SharedArrayBuffer`. At runtime every path
    // in this module produces standard `ArrayBuffer`-backed views.
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sigBytes as BufferSource,
      message as BufferSource,
    );
  } catch (_err) {
    return false;
  }
}
