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
 * Cortex never signs REGISTRY assertions (the `SignedAssertion` wrapper the
 * registry itself produces and this file only verifies, via
 * `verifyEd25519`/`verifySignedAssertion`) — that key lives solely on the
 * registry side. `signAdminRequest` below is a DIFFERENT concern: the
 * principal-side admin-request signing that proves possession of an admin
 * key to the registry (the `x-admin-signed` header / decision-body wire
 * contract, cortex#1517). It used to be hand-rolled at every call site;
 * consolidated here (S3, epic #1514) so the sign+serialize step has exactly
 * one implementation.
 */

// =============================================================================
// Canonical JSON — the ONE shared source (#1416). Previously a hand-maintained
// mirror of the registry's copy; both now import + re-export the single pure-TS
// canonicaliser at `./canonical-json` so they cannot drift (a drift silently
// re-opened a signature-bytes mismatch → self-inflicted 401 on one path). Depth
// (#832) + width/size (#1418) caps live there. Re-exported here so every
// existing importer of this module keeps working unchanged.
// =============================================================================

import {
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_KEYS,
  MAX_CANONICAL_ARRAY_LEN,
  MAX_CANONICAL_NODES,
  CanonicalDepthError,
  CanonicalWidthError,
  canonicalJSON,
} from "./canonical-json";

// A real (non-forwarding) import — `signAdminRequest` below needs a local
// `canonicalJSON` binding to call; `export { x } from "./mod"` alone would not
// give this file one. Re-exported immediately below so every existing
// importer of this module keeps working unchanged.
export {
  MAX_CANONICAL_DEPTH,
  MAX_CANONICAL_KEYS,
  MAX_CANONICAL_ARRAY_LEN,
  MAX_CANONICAL_NODES,
  CanonicalDepthError,
  CanonicalWidthError,
  canonicalJSON,
};

// cortex#1517 (S3) — `signAdminRequest` signs with the SAME PKCS#8 bridge the
// CLI/bus admin-signing call sites already use (`bus/stack-provisioning.ts`).
// This is a genuine two-file import cycle (`stack-provisioning.ts` imports
// `canonicalJSON` from here) — safe because both sides only touch the
// cross-imported binding inside function bodies, never at module-eval time.
import { signClaimWithSeed } from "../../bus/stack-provisioning";

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

// =============================================================================
// cortex#1517 (S3, epic #1514) — admin-request signing (client → registry).
// =============================================================================

/**
 * Sign an admin-request `claim` for the registry's `x-admin-signed` wire
 * contract: `canonicalJSON(claim)` → Ed25519-sign with the admin/hub-admin
 * seed → package as `{ claim, signature }`. This is the ONE implementation of
 * that sign+serialize step; every call site (read claims → the `x-admin-signed`
 * header, write claims → the POST body) builds its own `claim` shape and hands
 * it here unchanged — this function does not know or care which claim shape it
 * signs.
 *
 * Generic over the claim's own type so a caller with a narrowly-typed return
 * (e.g. `{ claim: AdmissionDecisionClaim; signature: string }`) gets that type
 * back without a cast.
 *
 * `JSON.stringify(await signAdminRequest(seed, claim))` is byte-identical to
 * the `JSON.stringify({ claim, signature })` every hand-rolled copy produced —
 * same key order (`claim` then `signature`), same canonical-JSON signing input.
 */
export async function signAdminRequest<T extends Record<string, unknown>>(
  seed: string,
  claim: T,
): Promise<{ claim: T; signature: string }> {
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(seed, message);
  return { claim, signature };
}
