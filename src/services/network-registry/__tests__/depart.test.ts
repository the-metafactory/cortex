/**
 * C-1350 Slice 1 (#1350) — member self-DEPART endpoint
 * `POST /admission-requests/:id/depart`.
 *
 * Trust-path coverage (member-PoP write, promoted from the `/mine` read):
 *   - happy: an ADMITTED member departs their OWN row → 200 DEPARTED, sealed
 *     blob cleared, and the roster (member PoP-read) drops them from members[]
 *   - non-ADMITTED (PENDING / REJECTED / REVOKED) → 409 "already <STATUS>"
 *   - idempotent re-depart of a DEPARTED row → 200
 *   - wrong-member PoP (a different valid key) → 403 + the row stays ADMITTED
 *   - forged signature → 401
 *   - over-wide body (junk keys past the canonical cap) → 401, NEVER 500
 *   - request_id path/body mismatch → 400 ; invalid request_id grammar → 400
 *   - clock skew → 400 ; replayed nonce → 409
 *   - NO admin allowlist is consulted — the own-row check IS the authz (a depart
 *     succeeds with the admin allowlist empty, proving no admin gate)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedAdminRead,
  makeSignedAdminDecision,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import { MAX_CANONICAL_KEYS } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let hubAdmin: PrincipalKey;
let member: PrincipalKey;

async function post(path: string, body: unknown, e: Env = env): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
  );
}

async function get(path: string, headers: Record<string, string> = {}, e: Env = env): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/**
 * Register `principalId` (signed by `pKey`) targeting `networkId`, then ADMIT the
 * resulting PENDING row. After this the row's stored `peer_pubkey` is
 * `pKey.publicKeyB64` and its status is ADMITTED.
 */
async function registerAndAdmit(
  principalId: string,
  pKey: PrincipalKey,
  networkId: string,
): Promise<AdmissionRequest> {
  const reg = await post(
    `/principals/${principalId}/register`,
    await makeSignedRegistration(principalId, pKey, { networkId }),
  );
  expect(reg.status).toBe(201);
  const req = await findRequest(principalId, networkId, "PENDING");
  const decision = await makeSignedAdminDecision(req.request_id, "admit", admin);
  const admitRes = await post(`/admission-requests/${req.request_id}/admit`, decision);
  expect(admitRes.status).toBe(200);
  return req;
}

/** Register-only — leaves a PENDING row. */
async function registerPending(
  principalId: string,
  pKey: PrincipalKey,
  networkId: string,
): Promise<AdmissionRequest> {
  const reg = await post(
    `/principals/${principalId}/register`,
    await makeSignedRegistration(principalId, pKey, { networkId }),
  );
  expect(reg.status).toBe(201);
  return findRequest(principalId, networkId, "PENDING");
}

/** Look up a row by (principal, network) at an expected status via the admin list. */
async function findRequest(
  principalId: string,
  networkId: string,
  status: string,
): Promise<AdmissionRequest> {
  const read = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=${status}`, {
    "x-admin-signed": JSON.stringify(read),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const req = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
  expect(req).toBeDefined();
  return req!;
}

/** Build a signed member-PoP depart envelope. Defaults sign with `member`. */
async function makeDepart(
  requestId: string,
  signer: PrincipalKey,
  opts: {
    principalId?: string;
    issuedAt?: string;
    nonce?: string;
    pubkeyOverride?: string;
    requestIdOverride?: string;
  } = {},
) {
  const claim = {
    request_id: opts.requestIdOverride ?? requestId,
    principal_id: opts.principalId ?? "alice",
    peer_pubkey: opts.pubkeyOverride ?? signer.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

/** Deliver the opaque sealed blob onto the ADMITTED row (hub-admin authority). */
const SEALED = btoa("sealed-leaf-psk-opaque-ciphertext-v1");
async function deliverSealed(requestId: string): Promise<void> {
  const claim = {
    request_id: requestId,
    sealed_secret: SEALED,
    hub_admin_pubkey: hubAdmin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(hubAdmin.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  const res = await post(`/admission-requests/${requestId}/sealed-secret`, { claim, signature });
  expect(res.status).toBe(200);
}

/** Hub-admin revoke of an ADMITTED row → REVOKED. */
async function revoke(requestId: string): Promise<void> {
  const claim = {
    request_id: requestId,
    hub_admin_pubkey: hubAdmin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(hubAdmin.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  const res = await post(`/admission-requests/${requestId}/revoke`, { claim, signature });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  hubAdmin = await makePrincipalKey();
  member = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    REGISTRY_HUB_ADMIN_PUBKEYS: hubAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Happy path — ADMITTED → DEPARTED
// =============================================================================

describe("POST /admission-requests/:id/depart — happy path", () => {
  test("an ADMITTED member departs their OWN row → 200 DEPARTED, sealed blob cleared", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    await deliverSealed(req.request_id);

    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(res.status).toBe(200);
    const departed = (await res.json()) as AdmissionRequest;
    expect(departed.status).toBe("DEPARTED");
    expect(departed.sealed_secret).toBeNull();
  });

  test("a departed member drops out of the network roster (members[])", async () => {
    // alpha + beta both ADMITTED to the network; alpha then departs.
    const alpha = await makePrincipalKey();
    const beta = await makePrincipalKey();
    const alphaReq = await registerAndAdmit("alpha", alpha, "research-collab");
    await registerAndAdmit("beta", beta, "research-collab");

    const depart = await makeDepart(alphaReq.request_id, alpha, { principalId: "alpha" });
    const res = await post(`/admission-requests/${alphaReq.request_id}/depart`, depart);
    expect(res.status).toBe(200);

    // beta (still ADMITTED) reads the roster — alpha is gone, only beta remains.
    const memberRead = {
      network_id: "research-collab",
      peer_pubkey: beta.publicKeyB64,
      issued_at: new Date().toISOString(),
    };
    const sig = await signEd25519(beta.privateKeyB64, new TextEncoder().encode(canonicalJSON(memberRead)));
    const rosterRes = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": JSON.stringify({ claim: memberRead, signature: sig }),
    });
    expect(rosterRes.status).toBe(200);
    const json = (await rosterRes.json()) as { payload: { members: { principal_id: string }[] } };
    const ids = json.payload.members.map((m) => m.principal_id).sort();
    expect(ids).toEqual(["beta"]);
  });

  test("no admin allowlist is consulted — depart succeeds with the admin allowlist EMPTY", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    // Wipe BOTH admin authorities: the own-row PoP check is the ONLY gate.
    const noAdminEnv: Env = { ...env, REGISTRY_ADMIN_PUBKEYS: "", REGISTRY_HUB_ADMIN_PUBKEYS: "" };
    const res = await post(
      `/admission-requests/${req.request_id}/depart`,
      await makeDepart(req.request_id, member),
      noAdminEnv,
    );
    expect(res.status).toBe(200);
    expect((await res.json() as AdmissionRequest).status).toBe("DEPARTED");
  });

  test("idempotent — a second depart of a DEPARTED row → 200 DEPARTED", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const first = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(first.status).toBe(200);
    const second = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(second.status).toBe(200);
    expect((await second.json() as AdmissionRequest).status).toBe("DEPARTED");
  });
});

// =============================================================================
// 409 — cannot depart a row that is not an active admission
// =============================================================================

describe("POST /admission-requests/:id/depart — non-ADMITTED → 409 already <STATUS>", () => {
  test("PENDING row → 409, message names 'already PENDING', row unchanged", async () => {
    const req = await registerPending("alice", member, "metafactory");
    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details: string; current: AdmissionRequest };
    expect(body.error).toBe("not_admitted");
    expect(body.details).toContain("already PENDING");
    expect(body.current.status).toBe("PENDING");
  });

  test("REJECTED row → 409 already REJECTED", async () => {
    const req = await registerPending("alice", member, "metafactory");
    const decision = await makeSignedAdminDecision(req.request_id, "reject", admin);
    expect((await post(`/admission-requests/${req.request_id}/reject`, decision)).status).toBe(200);
    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(res.status).toBe(409);
    expect((await res.json() as { details: string }).details).toContain("already REJECTED");
  });

  test("REVOKED row → 409 already REVOKED (a kicked member cannot 'depart')", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    await revoke(req.request_id);
    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, member));
    expect(res.status).toBe(409);
    expect((await res.json() as { details: string }).details).toContain("already REVOKED");
  });
});

// =============================================================================
// Fail-closed authz + input hardening
// =============================================================================

describe("POST /admission-requests/:id/depart — fail-closed", () => {
  test("wrong-member PoP (a different valid key) → 403 + the row stays ADMITTED", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const stranger = await makePrincipalKey();
    // A perfectly valid PoP signature — but for the WRONG key (not the row owner).
    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, stranger));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("not_row_owner");

    // The row is untouched — still ADMITTED (the owner can still read it as such).
    const still = await findRequest("alice", "metafactory", "ADMITTED");
    expect(still.status).toBe("ADMITTED");
  });

  test("forged signature (claim declares the owner key, signed by another) → 401", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const attacker = await makePrincipalKey();
    // Declares the member's pubkey but is signed by the attacker's key.
    const body = await makeDepart(req.request_id, attacker, { pubkeyOverride: member.publicKeyB64 });
    const res = await post(`/admission-requests/${req.request_id}/depart`, body);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("signature_invalid");
  });

  test("over-wide body (junk keys past the canonical cap) → 401, NEVER 500", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const { claim, signature } = await makeDepart(req.request_id, member);
    const bloated: Record<string, unknown> = { ...claim };
    for (let i = 0; i <= MAX_CANONICAL_KEYS; i++) bloated[`junk${i.toString()}`] = i;
    const res = await post(`/admission-requests/${req.request_id}/depart`, { claim: bloated, signature });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("signature_invalid");
    // And the row is untouched (a hostile body never mutates state).
    const still = await findRequest("alice", "metafactory", "ADMITTED");
    expect(still.status).toBe("ADMITTED");
  });

  test("request_id body/path mismatch → 400", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const other = "abcd1234".repeat(4);
    const body = await makeDepart(req.request_id, member, { requestIdOverride: other });
    const res = await post(`/admission-requests/${req.request_id}/depart`, body);
    expect(res.status).toBe(400);
  });

  test("invalid request_id grammar in the path → 400", async () => {
    const res = await post(`/admission-requests/not!a!valid!id/depart`, await makeDepart("not!a!valid!id", member));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_request_id");
  });

  test("unknown request → 404", async () => {
    const unknown = "deadbeef".repeat(4);
    const res = await post(`/admission-requests/${unknown}/depart`, await makeDepart(unknown, member));
    expect(res.status).toBe(404);
  });

  test("issued_at out of the clock-skew window → 400", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
    const res = await post(
      `/admission-requests/${req.request_id}/depart`,
      await makeDepart(req.request_id, member, { issuedAt: stale }),
    );
    expect(res.status).toBe(400);
  });

  test("replayed nonce (same signed envelope twice) → 409 nonce_replayed", async () => {
    const req = await registerAndAdmit("alice", member, "metafactory");
    const body = await makeDepart(req.request_id, member);
    const first = await post(`/admission-requests/${req.request_id}/depart`, body);
    expect(first.status).toBe(200);
    // Same envelope again — the nonce is burned. (Row is already DEPARTED, but the
    // replay guard fires BEFORE the transition, so this is 409 nonce_replayed.)
    const replay = await post(`/admission-requests/${req.request_id}/depart`, body);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).toBe("nonce_replayed");
  });
});
