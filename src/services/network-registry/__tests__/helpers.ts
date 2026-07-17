/**
 * Shared test helpers — principal-side signing rig + assertion helpers.
 *
 * The tests deliberately mint REAL Ed25519 keypairs via WebCrypto so the
 * full verify path is exercised. Generating a fresh keypair per test
 * isolates state and keeps the suite free of any test-only signing
 * shortcut that might mask a regression in `signing.ts`.
 */

import { canonicalJSON, generateKeypair, signEd25519 } from "../src/signing";
import type { AdmissionDecisionClaim, AdmissionReadClaim, Capability, RegistrationClaim, StackIdentity } from "../src/types";
import { _setNonceCacheForTest, _setStoreForTest, _setIssuanceStoreForTest } from "../src/store";
import { _resetDerivedPublicKeyForTest } from "../src/index";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";
import { _resetAdmissionWindowForTest } from "../src/admission-window";

export interface PrincipalKey {
  privateKeyB64: string;
  publicKeyB64: string;
}

/**
 * Generate a per-test principal keypair. Awaited once per test in
 * beforeEach, then used to sign multiple claims as the test needs.
 */
export async function makePrincipalKey(): Promise<PrincipalKey> {
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

/**
 * Reset all module-scoped state between tests (store, nonce cache, derived
 * pubkey, rate-limit fallback buckets). The rate-limit buckets are module-scoped
 * like the store, so without this reset they'd bleed across tests and a later
 * test could spuriously 429.
 */
export function resetStores(): void {
  _setStoreForTest(undefined);
  _setNonceCacheForTest(undefined);
  _setIssuanceStoreForTest(undefined);
  _resetDerivedPublicKeyForTest();
  _resetRateLimitBucketsForTest();
  _resetAdmissionWindowForTest();
}

/**
 * Build a signed registration body for the given principal. Default
 * stacks/capabilities are empty; tests override via opts.
 *
 * `signWith` (C-787) lets a test sign the claim with a DIFFERENT key than the
 * one the claim declares in `principal_pubkey` — used to exercise the
 * add-stack impersonation rejection (a claim attesting the root pubkey but
 * signed by an attacker's key MUST fail signature verification).
 */
export async function makeSignedRegistration(
  principalId: string,
  pKey: PrincipalKey,
  opts: {
    stacks?: StackIdentity[];
    capabilities?: Capability[];
    /** Override issued_at — defaults to now. Useful for skew tests. */
    issuedAt?: string;
    /** Override nonce — defaults to a fresh random. Useful for replay tests. */
    nonce?: string;
    /** Override pubkey in the claim — useful for tampering tests. */
    pubkeyOverride?: string;
    /** Sign with a DIFFERENT key than `pKey` — forged-signature tests (C-787). */
    signWith?: PrincipalKey;
    /** #825 — optimistic-concurrency CAS token signed into the claim. */
    expectedUpdatedAt?: string;
    /** ADR-0018 Gap-A — target network signed into the claim (pins admission). */
    networkId?: string;
  } = {},
): Promise<{ claim: RegistrationClaim; signature: string }> {
  const claim: RegistrationClaim = {
    principal_id: principalId,
    principal_pubkey: opts.pubkeyOverride ?? pKey.publicKeyB64,
    stacks: opts.stacks ?? [],
    capabilities: opts.capabilities ?? [],
    ...(opts.expectedUpdatedAt !== undefined && { expected_updated_at: opts.expectedUpdatedAt }),
    ...(opts.networkId !== undefined && { network_id: opts.networkId }),
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? pKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
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

// =============================================================================
// ADR-0015 — signed-admin admission decision + read test rig
// =============================================================================

/**
 * Build a signed admin admission decision body for admit/reject.
 * Uses the canonical AdmissionDecisionClaim vocabulary (ADR-0015).
 * Mirrors `makeSignedNetworkCreate` in structure — the admin gate is identical.
 */
export async function makeSignedAdminDecision(
  requestId: string,
  decision: "admit" | "reject",
  adminKey: PrincipalKey,
  opts: {
    issuedAt?: string;
    nonce?: string;
    /** Sign with a DIFFERENT key than the claim declares — forged signature tests. */
    signWith?: PrincipalKey;
    adminPubkeyOverride?: string;
    /** cortex#2188 (M9) — bind peer_pubkey into the signed claim (wide claim). */
    peerPubkey?: string;
    /** cortex#2188 (M9/M12) — bind network_id into the signed claim (wide claim). */
    networkId?: string;
  } = {},
): Promise<{ claim: AdmissionDecisionClaim; signature: string }> {
  const claim: AdmissionDecisionClaim = {
    request_id: requestId,
    decision,
    admin_pubkey: opts.adminPubkeyOverride ?? adminKey.publicKeyB64,
    // Bind identity fields ONLY when supplied — narrow claim otherwise, so the
    // canonical bytes stay stable for the legacy two-field decision claim.
    ...(opts.peerPubkey !== undefined && { peer_pubkey: opts.peerPubkey }),
    ...(opts.networkId !== undefined && { network_id: opts.networkId }),
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? adminKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return { claim, signature };
}

/**
 * Build a signed admin read claim for the x-admin-signed header.
 * No nonce (reads are idempotent). Clock skew applies.
 */
export async function makeSignedAdminRead(
  adminKey: PrincipalKey,
  opts: {
    issuedAt?: string;
    /** Sign with a DIFFERENT key — forged signature test. */
    signWith?: PrincipalKey;
    /** FND-5 — bind an optional network scope into the signed claim. */
    networkId?: string;
  } = {},
): Promise<{ claim: AdmissionReadClaim; signature: string }> {
  const claim: AdmissionReadClaim = {
    admin_pubkey: adminKey.publicKeyB64,
    // Only include network_id when supplied — keeps canonicalJSON stable for the
    // backward-compatible two-field (unscoped, global) read claim.
    ...(opts.networkId !== undefined && { network_id: opts.networkId }),
    issued_at: opts.issuedAt ?? new Date().toISOString(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? adminKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return { claim, signature };
}

// =============================================================================
// #747 — signed-admin network-create test rig
// =============================================================================

/**
 * The admin claim shape carried by `POST /networks/:id` (#747). Mirrors
 * `NetworkCreateClaim` in `../src/validate`.
 */
export interface NetworkCreateClaim {
  network_id: string;
  hub_url: string;
  leaf_port: number;
  admin_pubkey: string;
  issued_at: string;
  nonce: string;
  /** #1321 — optional per-network admin allowlist (comma-separated base64 pubkeys). */
  admin_pubkeys?: string;
}

/**
 * Build a signed network-create body for the given admin key. The admin is
 * just an Ed25519 keypair (the CLI derives it from an nkey seed; here we mint
 * one directly via `makePrincipalKey`). Tests override fields/signing-key to
 * exercise forged-signature / wrong-key / replay paths.
 */
export async function makeSignedNetworkCreate(
  networkId: string,
  adminKey: PrincipalKey,
  opts: {
    hubUrl?: string;
    leafPort?: number;
    issuedAt?: string;
    nonce?: string;
    /** Override the admin_pubkey in the claim — for tampering tests. */
    adminPubkeyOverride?: string;
    /** Sign with a DIFFERENT key than the claim declares — forged signature. */
    signWith?: PrincipalKey;
    /** #1321 — per-network admin allowlist to bootstrap (comma-separated base64). */
    adminPubkeys?: string;
    /** #1598 — hub-mode / resolver-mode attestation on the claim. */
    hubMode?: "operator" | "simple";
    resolverMode?: "nats" | "memory";
  } = {},
): Promise<{ claim: NetworkCreateClaim; signature: string }> {
  const claim: NetworkCreateClaim = {
    network_id: networkId,
    hub_url: opts.hubUrl ?? "tls://hub.meta-factory.ai:7422",
    leaf_port: opts.leafPort ?? 7422,
    admin_pubkey: opts.adminPubkeyOverride ?? adminKey.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
    // Only include admin_pubkeys when supplied — keeps canonicalJSON stable for
    // the existing #747 tests that sign a claim without the field.
    ...(opts.adminPubkeys !== undefined && { admin_pubkeys: opts.adminPubkeys }),
    ...(opts.hubMode !== undefined && { hub_mode: opts.hubMode }),
    ...(opts.resolverMode !== undefined && { resolver_mode: opts.resolverMode }),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? adminKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return { claim, signature };
}
