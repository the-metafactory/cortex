/**
 * Shared test helpers — operator-side signing rig + assertion helpers.
 *
 * The tests deliberately mint REAL Ed25519 keypairs via WebCrypto so the
 * full verify path is exercised. Generating a fresh keypair per test
 * isolates state and keeps the suite free of any test-only signing
 * shortcut that might mask a regression in `signing.ts`.
 */

import { canonicalJSON, generateKeypair, signEd25519 } from "../src/signing";
import type { Capability, RegistrationClaim, StackIdentity } from "../src/types";
import { _setNonceCacheForTest, _setStoreForTest } from "../src/store";
import { _resetDerivedPublicKeyForTest } from "../src/index";

export interface OperatorKey {
  privateKeyB64: string;
  publicKeyB64: string;
}

/**
 * Generate a per-test operator keypair. Awaited once per test in
 * beforeEach, then used to sign multiple claims as the test needs.
 */
export async function makeOperatorKey(): Promise<OperatorKey> {
  return generateKeypair();
}

/**
 * Generate the registry's signing key. Returned PKCS#8 base64 +
 * the raw pubkey. Bound into `env` in test setup.
 */
export async function makeRegistryKey(): Promise<{
  signingKey: string;
  publicKey: string;
}> {
  const kp = await generateKeypair();
  return { signingKey: kp.privateKeyB64, publicKey: kp.publicKeyB64 };
}

/** Reset all module-scoped state between tests (store, nonce cache, derived pubkey). */
export function resetStores(): void {
  _setStoreForTest(undefined);
  _setNonceCacheForTest(undefined);
  _resetDerivedPublicKeyForTest();
}

/**
 * Build a signed registration body for the given operator. Default
 * stacks/capabilities are empty; tests override via opts.
 */
export async function makeSignedRegistration(
  operatorId: string,
  opKey: OperatorKey,
  opts: {
    stacks?: StackIdentity[];
    capabilities?: Capability[];
    /** Override issued_at — defaults to now. Useful for skew tests. */
    issuedAt?: string;
    /** Override nonce — defaults to a fresh random. Useful for replay tests. */
    nonce?: string;
    /** Override pubkey in the claim — useful for tampering tests. */
    pubkeyOverride?: string;
  } = {},
): Promise<{ claim: RegistrationClaim; signature: string }> {
  const claim: RegistrationClaim = {
    operator_id: operatorId,
    operator_pubkey: opts.pubkeyOverride ?? opKey.publicKeyB64,
    stacks: opts.stacks ?? [],
    capabilities: opts.capabilities ?? [],
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signEd25519(opKey.privateKeyB64, message);
  return { claim, signature };
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
