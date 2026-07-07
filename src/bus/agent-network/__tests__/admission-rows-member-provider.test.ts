/**
 * MC-A2 (cortex#1276) — tests for the LIVE member-posture admission-rows
 * provider (`createMemberRosterAdmissionProvider`).
 *
 * Hermetic: a real `SU…` stack identity (so the PoP signature actually verifies)
 * + a real Ed25519 registry keypair (so the DD-9 assertion verify is exercised
 * end-to-end), driven over an injected `fetch`. The load-bearing properties:
 *   - PoP-signs the member-read claim with the stack's OWN registered key;
 *   - verifies the registry assertion before trusting a single member (DD-9);
 *   - projects the admitted roster → `ADMITTED` rows, `scope: "complete"`;
 *   - never throws — 401/403 → `unauthorized`, transport/unverifiable →
 *     `unreachable`, no pinned key → `not_configured`.
 */

import { describe, it, expect } from "bun:test";
import { createUser } from "nkeys.js";
import { createMemberRosterAdmissionProvider, type FetchLike } from "../admission-rows-member-provider";
import {
  materialFromSeedString,
  type StackIdentityMaterial,
} from "../../stack-provisioning";
import { canonicalJSON, verifyEd25519 } from "../../../common/registry/signing";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A real stack identity (SU seed + base64 ed25519 pubkey) — PoP verifiable. */
function stackMaterial(): StackIdentityMaterial {
  const kp = createUser();
  return materialFromSeedString(new TextDecoder().decode(kp.getSeed()));
}

/** A real Ed25519 registry keypair for signing DD-9 assertions. */
async function registryKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { privateKey: kp.privateKey, publicKeyB64: bytesToBase64(new Uint8Array(raw)) };
}

/** Wrap a payload in a registry `SignedAssertion` the provider verifies (DD-9). */
async function signAssertion(
  privateKey: CryptoKey,
  registryPubkey: string,
  payload: unknown,
): Promise<unknown> {
  const issued_at = new Date().toISOString();
  const bound = canonicalJSON({ payload, issued_at, registry: registryPubkey });
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(bound),
  );
  return {
    payload,
    issued_at,
    registry: registryPubkey,
    signature: bytesToBase64(new Uint8Array(sig)),
  };
}

/** A `FetchLike` returning a fixed status + json body, capturing the request. */
function fakeFetch(
  status: number,
  body: unknown,
  capture?: (url: string, headers?: Record<string, string>) => void,
): FetchLike {
  return (url, init) => {
    capture?.(url, init?.headers);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
}

describe("createMemberRosterAdmissionProvider — happy path", () => {
  it("PoP-signs the claim, verifies the assertion, and projects ADMITTED rows (scope=complete)", async () => {
    const material = stackMaterial();
    const reg = await registryKeypair();
    const roster = {
      network_id: "research-collab",
      members: [
        { principal_id: "andreas", principal_pubkey: "x", capabilities: [] },
        { principal_id: "jc", principal_pubkey: "y", capabilities: ["code-review.typescript"] },
      ],
    };
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, roster);

    let seenUrl = "";
    let seenHeader: string | undefined;
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example/",
      registryPubkey: reg.publicKeyB64,
      material,
      fetchImpl: fakeFetch(200, assertion, (url, headers) => {
        seenUrl = url;
        seenHeader = headers?.["x-pop-signed"];
      }),
    });

    const res = await provider.readAdmissionRows("research-collab");

    // Hit the member endpoint (not the public /roster).
    expect(seenUrl).toBe("https://registry.example/networks/research-collab/roster/member");

    // The PoP header carries a claim for THIS network + this stack's pubkey, and
    // the signature actually verifies against that pubkey (the authorization).
    expect(seenHeader).toBeDefined();
    const parsed = JSON.parse(seenHeader!) as {
      claim: { network_id: string; peer_pubkey: string; issued_at: string };
      signature: string;
    };
    expect(parsed.claim.network_id).toBe("research-collab");
    expect(parsed.claim.peer_pubkey).toBe(material.pubkeyB64);
    const popValid = await verifyEd25519(
      parsed.claim.peer_pubkey,
      parsed.signature,
      new TextEncoder().encode(canonicalJSON(parsed.claim)),
    );
    expect(popValid).toBe(true);

    // Projection: every roster member → an ADMITTED row, complete scope.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope).toBe("complete");
    // FLG-4 — rows now carry a resolved `authorship` verdict (default "unchecked"
    // when no admin key is pinned + no material on the row). `sealed`/
    // `hub_authorized_at` are omitted here (this fixture emits neither facet).
    expect(res.rows).toEqual([
      { principal_id: "andreas", network_id: "research-collab", status: "ADMITTED", authorship: "unchecked" },
      { principal_id: "jc", network_id: "research-collab", status: "ADMITTED", authorship: "unchecked" },
    ]);
  });

  it("returns an empty (but complete) roster when the network has no admitted members", async () => {
    const reg = await registryKeypair();
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, {
      network_id: "research-collab",
      members: [],
    });
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(200, assertion),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res).toEqual({ ok: true, rows: [], scope: "complete" });
  });
});

describe("createMemberRosterAdmissionProvider — FLG-4 roster-state facets", () => {
  it("parses the additive facets (admission_state / sealed / hub_authorized_at) when the registry emits them", async () => {
    const reg = await registryKeypair();
    const roster = {
      network_id: "research-collab",
      members: [
        {
          principal_id: "andreas",
          principal_pubkey: "x",
          capabilities: [],
          admission_state: "ADMITTED",
          sealed: true,
          hub_authorized_at: "2026-07-08T00:00:00.000Z",
        },
      ],
    };
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, roster);
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(200, assertion),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toEqual({
      principal_id: "andreas",
      network_id: "research-collab",
      status: "ADMITTED",
      sealed: true,
      hub_authorized_at: "2026-07-08T00:00:00.000Z",
      authorship: "unchecked",
    });
  });

  it("#1600 — resolves authorship to 'verified' when the row carries valid material AND an admin key is pinned", async () => {
    // Hub-admin keypair — signs the sealed-row authorship claim.
    const hubAdmin = await registryKeypair();
    const claim = { request_id: "req-1", hub_admin_pubkey: hubAdmin.publicKeyB64, issued_at: "2026-07-08T00:00:00.000Z", nonce: "n1" };
    const claimSig = await crypto.subtle.sign(
      { name: "Ed25519" },
      hubAdmin.privateKey,
      new TextEncoder().encode(canonicalJSON(claim)),
    );
    const claimSigB64 = bytesToBase64(new Uint8Array(claimSig));

    const reg = await registryKeypair();
    const roster = {
      network_id: "research-collab",
      members: [
        {
          principal_id: "andreas",
          principal_pubkey: "x",
          capabilities: [],
          seal_claim: claim,
          seal_signature: claimSigB64,
          sealed_by: hubAdmin.publicKeyB64,
        },
      ],
    };
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, roster);
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      networkAdminPubkey: hubAdmin.publicKeyB64,
      fetchImpl: fakeFetch(200, assertion),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]?.authorship).toBe("verified");
  });

  it("#1600 — authorship stays 'unchecked' when material is present but NO admin key is pinned (never a fabricated pass)", async () => {
    const hubAdmin = await registryKeypair();
    const claim = { request_id: "req-1", hub_admin_pubkey: hubAdmin.publicKeyB64, issued_at: "2026-07-08T00:00:00.000Z", nonce: "n1" };
    const claimSig = await crypto.subtle.sign(
      { name: "Ed25519" },
      hubAdmin.privateKey,
      new TextEncoder().encode(canonicalJSON(claim)),
    );
    const reg = await registryKeypair();
    const roster = {
      network_id: "research-collab",
      members: [
        {
          principal_id: "andreas",
          principal_pubkey: "x",
          capabilities: [],
          seal_claim: claim,
          seal_signature: bytesToBase64(new Uint8Array(claimSig)),
          sealed_by: hubAdmin.publicKeyB64,
        },
      ],
    };
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, roster);
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      // networkAdminPubkey deliberately omitted.
      fetchImpl: fakeFetch(200, assertion),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]?.authorship).toBe("unchecked");
  });
});

describe("createMemberRosterAdmissionProvider — failure mapping (never throws)", () => {
  it("no pinned registry pubkey → not_configured (never trust an unverifiable roster)", async () => {
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      material: stackMaterial(),
      fetchImpl: fakeFetch(200, {}),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_configured");
  });

  it("HTTP 403 (not a member) → unauthorized, a distinct real state", async () => {
    const reg = await registryKeypair();
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(403, { error: "not_a_member" }),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unauthorized");
  });

  it("HTTP 401 (bad signature) → unauthorized", async () => {
    const reg = await registryKeypair();
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(401, { error: "signature_invalid" }),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unauthorized");
  });

  it("HTTP 500 / other → unreachable", async () => {
    const reg = await registryKeypair();
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(500, { error: "boom" }),
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable");
  });

  it("transport throw → unreachable (never propagates)", async () => {
    const reg = await registryKeypair();
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: () => Promise.reject(new Error("network down")),
      logError: () => {},
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable");
  });

  it("a hung read aborts on the timeout signal → unreachable (never stalls /api/networks)", async () => {
    const reg = await registryKeypair();
    // A fetch that rejects with an AbortError when the wired signal fires.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: hangingFetch,
      requestTimeoutMs: 10,
      logError: () => {},
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable");
    expect(res.detail).toContain("timed out");
  });

  it("assertion signed by the WRONG registry key → unreachable (DD-9 reject, payload NOT trusted)", async () => {
    const realReg = await registryKeypair();
    const attacker = await registryKeypair();
    // Attacker signs a roster, but the provider pins the REAL registry pubkey.
    const forged = await signAssertion(attacker.privateKey, attacker.publicKeyB64, {
      network_id: "research-collab",
      members: [{ principal_id: "mallory", principal_pubkey: "z", capabilities: [] }],
    });
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: realReg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(200, forged),
      logError: () => {},
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable");
  });

  it("verified-but-wrong-network payload → unreachable (shape gate)", async () => {
    const reg = await registryKeypair();
    const assertion = await signAssertion(reg.privateKey, reg.publicKeyB64, {
      network_id: "OTHER-network",
      members: [],
    });
    const provider = createMemberRosterAdmissionProvider({
      registryUrl: "https://registry.example",
      registryPubkey: reg.publicKeyB64,
      material: stackMaterial(),
      fetchImpl: fakeFetch(200, assertion),
      logError: () => {},
    });
    const res = await provider.readAdmissionRows("research-collab");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable");
  });
});
