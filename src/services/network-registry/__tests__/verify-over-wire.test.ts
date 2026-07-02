/**
 * C-1414 — converge all signed write routes on verify-over-wire.
 *
 * #832 fixed ONLY the register route to verify the Ed25519 signature over the
 * claim AS RECEIVED (canonicalJSON(signed.claim)) instead of the server's
 * whitelist reconstruction. This converges the remaining signed routes —
 * network-create, admission-decision (admit/reject), sealed-secret, revoke — on
 * the same pattern.
 *
 * The guard each test encodes (mirroring register-canonical-drift.test.ts):
 *   POSITIVE — a claim carrying an EXTRA signed field (a future/forward field the
 *     server's reconstruction does not echo) still VERIFIES. Under the old
 *     verify-over-reconstruction this 401'd (the #825→#832 regression); under
 *     verify-over-wire it passes, because the server canonicalizes the same bytes
 *     the client signed. Validation still ignores the unknown field (never
 *     persisted), so the route reaches its happy path.
 *   NEGATIVE — a claim carrying an extra field that the signature does NOT cover
 *     (signed over the base claim, then the field added to the wire claim) is
 *     REJECTED 401. Tamper-resistance is intact: mutating ANY field after signing
 *     changes the verified bytes.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedAdminRead,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey; // global registry-admin (admit/reject + network-create)
let hubAdmin: PrincipalKey; // hub-admin (sealed-secret + revoke)
let principal: PrincipalKey;

const SEALED = btoa("sealed-leaf-psk-opaque-ciphertext-v1");

async function post(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), env);
}

/** Sign `claim` with `signer` and return the wire envelope, optionally SENDING a
 *  DIFFERENT (tampered) claim than the one signed. */
async function signed(
  claim: Record<string, unknown>,
  signer: PrincipalKey,
  sendInstead?: Record<string, unknown>,
): Promise<{ claim: unknown; signature: string }> {
  const signature = await signEd25519(
    signer.privateKeyB64,
    new TextEncoder().encode(canonicalJSON(claim)),
  );
  return { claim: sendInstead ?? claim, signature };
}

async function registerPending(principalId: string): Promise<AdmissionRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
    networkId: "metafactory",
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);
  const read = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=PENDING`, {
    "x-admin-signed": JSON.stringify(read),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId);
  expect(found).toBeDefined();
  return found!;
}

function decisionClaim(requestId: string, decision: "admit" | "reject"): Record<string, unknown> {
  return {
    request_id: requestId,
    decision,
    admin_pubkey: admin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
}

async function admit(requestId: string): Promise<void> {
  const res = await post(`/admission-requests/${requestId}/admit`, await signed(decisionClaim(requestId, "admit"), admin));
  expect(res.status).toBe(200);
}

function createClaim(networkId: string): Record<string, unknown> {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    admin_pubkey: admin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
}

function sealedClaim(requestId: string): Record<string, unknown> {
  return {
    request_id: requestId,
    sealed_secret: SEALED,
    hub_admin_pubkey: hubAdmin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
}

function revokeClaim(requestId: string): Record<string, unknown> {
  return {
    request_id: requestId,
    hub_admin_pubkey: hubAdmin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  hubAdmin = await makePrincipalKey();
  principal = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    REGISTRY_HUB_ADMIN_PUBKEYS: hubAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// admission-decision (admit / reject) — handleDecision
// =============================================================================

describe("#1414 — admission-decision verifies over the wire", () => {
  test("admit: a claim with an EXTRA signed field verifies (200), not 401", async () => {
    const req = await registerPending("alice");
    const claim = { ...decisionClaim(req.request_id, "admit"), future_field: "forward-compat" };
    const res = await post(`/admission-requests/${req.request_id}/admit`, await signed(claim, admin));
    expect(res.status).toBe(200);
  });

  test("admit: an extra field NOT covered by the signature is rejected (401)", async () => {
    const req = await registerPending("bob");
    const base = decisionClaim(req.request_id, "admit");
    // Sign the base claim, but SEND a claim with an added field → wire bytes differ.
    const res = await post(
      `/admission-requests/${req.request_id}/admit`,
      await signed(base, admin, { ...base, injected: "tamper" }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("signature_invalid");
  });
});

// =============================================================================
// network-create
// =============================================================================

describe("#1414 — network-create verifies over the wire", () => {
  test("a claim with an EXTRA signed field verifies (200), not 401", async () => {
    const claim = { ...createClaim("netpos"), future_field: "forward-compat" };
    const res = await post(`/networks/netpos`, await signed(claim, admin));
    expect(res.status).toBe(201); // created (verify-over-wire accepted the extra signed field)
  });

  test("an extra field NOT covered by the signature is rejected (401)", async () => {
    const base = createClaim("netneg");
    const res = await post(`/networks/netneg`, await signed(base, admin, { ...base, injected: "tamper" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("signature_invalid");
  });
});

// =============================================================================
// sealed-secret (hub-admin write)
// =============================================================================

describe("#1414 — sealed-secret verifies over the wire", () => {
  test("a claim with an EXTRA signed field verifies (200), not 401", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const claim = { ...sealedClaim(req.request_id), future_field: "forward-compat" };
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await signed(claim, hubAdmin));
    expect(res.status).toBe(200);
  });

  test("an extra field NOT covered by the signature is rejected (401)", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const base = sealedClaim(req.request_id);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await signed(base, hubAdmin, { ...base, injected: "tamper" }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("signature_invalid");
  });
});

// =============================================================================
// revoke (hub-admin write)
// =============================================================================

describe("#1414 — revoke verifies over the wire", () => {
  test("a claim with an EXTRA signed field verifies (200), not 401", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const claim = { ...revokeClaim(req.request_id), future_field: "forward-compat" };
    const res = await post(`/admission-requests/${req.request_id}/revoke`, await signed(claim, hubAdmin));
    expect(res.status).toBe(200);
  });

  test("an extra field NOT covered by the signature is rejected (401)", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const base = revokeClaim(req.request_id);
    const res = await post(
      `/admission-requests/${req.request_id}/revoke`,
      await signed(base, hubAdmin, { ...base, injected: "tamper" }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("signature_invalid");
  });
});
