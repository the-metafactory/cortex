/**
 * FLG-4 / #1600 — tests for `verifyRosterAuthorship`, the pure hub-admin
 * authorship check. The security-load-bearing property: the ONLY path to
 * `"verified"` is a REAL Ed25519 verify passing against the PINNED admin key.
 * Everything else is `"unchecked"` (couldn't run) or `"unverifiable"` (ran, did
 * not pass) — never a fabricated pass.
 *
 * Hermetic: a real WebCrypto Ed25519 keypair signs the claim; the check verifies
 * against it end-to-end (no stubbed crypto).
 */

import { describe, it, expect } from "bun:test";
import {
  verifyRosterAuthorship,
  type RosterAuthorshipMaterial,
} from "../roster-authorship";
import { canonicalJSON } from "../../../common/registry/canonical-json";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function keypair(): Promise<{ privateKey: CryptoKey; pubB64: string }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { privateKey: kp.privateKey, pubB64: bytesToBase64(new Uint8Array(raw)) };
}

/** Sign a claim the way the hub-admin does — canonicalJSON(claim), Ed25519. */
async function signClaim(
  privateKey: CryptoKey,
  hubAdminPubkey: string,
  claim: unknown,
): Promise<RosterAuthorshipMaterial> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonicalJSON(claim)),
  );
  return { claim, signature: bytesToBase64(new Uint8Array(sig)), hub_admin_pubkey: hubAdminPubkey };
}

const CLAIM = {
  request_id: "req-abc",
  sealed_secret: "OPAQUE-CIPHERTEXT",
  hub_admin_pubkey: "", // filled below to the real key
  issued_at: "2026-07-08T00:00:00.000Z",
  nonce: "n1",
};

describe("verifyRosterAuthorship (#1600)", () => {
  it("returns 'verified' ONLY when the signature verifies against the pinned admin key", async () => {
    const admin = await keypair();
    const claim = { ...CLAIM, hub_admin_pubkey: admin.pubB64 };
    const material = await signClaim(admin.privateKey, admin.pubB64, claim);

    const result = await verifyRosterAuthorship(material, admin.pubB64);
    expect(result).toBe("verified");
  });

  it("returns 'unverifiable' when the pinned key differs from the claimed admin", async () => {
    const admin = await keypair();
    const otherPinned = await keypair();
    const claim = { ...CLAIM, hub_admin_pubkey: admin.pubB64 };
    const material = await signClaim(admin.privateKey, admin.pubB64, claim);

    // Material asserts `admin`, but we pin a DIFFERENT key — a definitive negative.
    const result = await verifyRosterAuthorship(material, otherPinned.pubB64);
    expect(result).toBe("unverifiable");
  });

  it("returns 'unverifiable' when the signature does not verify (tampered claim)", async () => {
    const admin = await keypair();
    const claim = { ...CLAIM, hub_admin_pubkey: admin.pubB64 };
    const material = await signClaim(admin.privateKey, admin.pubB64, claim);
    // Tamper the claim AFTER signing — same pinned+claimed key, but the signature
    // no longer matches the canonical bytes.
    const tampered: RosterAuthorshipMaterial = {
      ...material,
      claim: { ...claim, sealed_secret: "SWAPPED-CIPHERTEXT" },
    };

    const result = await verifyRosterAuthorship(tampered, admin.pubB64);
    expect(result).toBe("unverifiable");
  });

  it("returns 'unverifiable' for a garbage signature (never throws)", async () => {
    const admin = await keypair();
    const claim = { ...CLAIM, hub_admin_pubkey: admin.pubB64 };
    const material: RosterAuthorshipMaterial = {
      claim,
      signature: "!!!not-base64!!!",
      hub_admin_pubkey: admin.pubB64,
    };
    const result = await verifyRosterAuthorship(material, admin.pubB64);
    expect(result).toBe("unverifiable");
  });

  it("returns 'unchecked' when no admin key is pinned (never verifies against the row's own key)", async () => {
    const admin = await keypair();
    const claim = { ...CLAIM, hub_admin_pubkey: admin.pubB64 };
    const material = await signClaim(admin.privateKey, admin.pubB64, claim);

    expect(await verifyRosterAuthorship(material, undefined)).toBe("unchecked");
    expect(await verifyRosterAuthorship(material, "")).toBe("unchecked");
  });

  it("returns 'unchecked' when the row carries no authorship material (today's live case)", async () => {
    const admin = await keypair();
    const result = await verifyRosterAuthorship(undefined, admin.pubB64);
    expect(result).toBe("unchecked");
  });
});
