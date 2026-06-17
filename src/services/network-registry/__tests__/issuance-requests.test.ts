/**
 * O-4a.1 — Issuance-request state machine tests.
 *
 * Drives the full Hono pipeline via `app.fetch(req, env)` so the admin gate,
 * signing path, clock-skew, nonce-replay, and store transitions are all
 * exercised end-to-end. Mirrors the network-create.test.ts style exactly.
 *
 * Coverage:
 *   register hook:
 *     - POST /principals/:id/register creates a PENDING issuance request
 *     - re-register (same peer_pubkey) is idempotent — returns existing row
 *   admin grant:
 *     - POST /issuance-requests/:id/grant (allowlisted admin) → 200 GRANTED
 *     - grant on already-decided request → 409 already_decided
 *     - forged signature → 401
 *     - non-allowlisted admin → 403
 *     - no admin allowlist → 503 fail-closed
 *     - replayed nonce → 409
 *   admin reject:
 *     - POST /issuance-requests/:id/reject (allowlisted admin) → 200 REJECTED
 *     - reject on already-decided request → 409 already_decided
 *   read surface (admin-gated):
 *     - GET /issuance-requests?status=PENDING lists pending requests
 *     - GET /issuance-requests/:id returns a specific request
 *     - GET /issuance-requests/:id → 404 for unknown
 *     - GET reads require admin signature → 503 / 401 / 403 fail-closed
 *   additive: existing principal/network register tests not broken
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedNetworkCreate,
  randomNonce,
  resetStores,
  makeSignedAdminDecision,
  makeSignedAdminRead,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { IssuanceRequest } from "../src/types";

let env: Env;
let admin: PrincipalKey;
let principal: PrincipalKey;

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

async function get(path: string, e: Env = env, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/** Register a principal and return the issuance request created as a side-effect. */
async function registerAndGetRequest(principalId: string): Promise<IssuanceRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);

  // List pending to retrieve the created request.
  const signedRead = await makeSignedAdminRead(admin);
  const listRes = await get(
    `/issuance-requests?status=PENDING`,
    env,
    { "x-admin-signed": JSON.stringify(signedRead) },
  );
  expect(listRes.status).toBe(200);
  const list = (await listRes.json()) as IssuanceRequest[];
  const found = list.find((r) => r.principal_id === principalId);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  principal = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Register hook — PENDING request created as side-effect
// =============================================================================

describe("POST /principals/:id/register — issuance request side-effect", () => {
  test("registration creates a PENDING issuance request for the peer pubkey", async () => {
    const req = await registerAndGetRequest("alice");
    expect(req.status).toBe("PENDING");
    expect(req.principal_id).toBe("alice");
    expect(req.peer_pubkey).toBe(principal.publicKeyB64);
    expect(req.request_id).toBeTruthy();
    expect(req.created_at).toBeTruthy();
    expect(req.updated_at).toBeTruthy();
    expect(req.granted_by).toBeNull();
    expect(req.leaf_package).toBeNull();
  });

  test("re-registration with same peer_pubkey is idempotent (same request_id returned)", async () => {
    const req1 = await registerAndGetRequest("bob");

    // Register again — same principal, same peer_pubkey.
    const body2 = await makeSignedRegistration("bob", principal, {
      stacks: [{ stack_id: "bob/main", stack_pubkey: principal.publicKeyB64 }],
    });
    const res2 = await post("/principals/bob/register", body2);
    expect(res2.status).toBe(201);

    // List pending — should still be exactly one request for bob.
    const signedRead = await makeSignedAdminRead(admin);
    const listRes = await get(
      `/issuance-requests?status=PENDING`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    const list = (await listRes.json()) as IssuanceRequest[];
    const bobRequests = list.filter((r) => r.principal_id === "bob");
    expect(bobRequests.length).toBe(1);
    expect(bobRequests[0]!.request_id).toBe(req1.request_id);
  });

  test("existing register behaviour is preserved (201, signed assertion returned)", async () => {
    const body = await makeSignedRegistration("carol", principal);
    const res = await post("/principals/carol/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payload: { principal_id: string } };
    expect(json.payload.principal_id).toBe("carol");
  });
});

// =============================================================================
// Admin grant — PENDING → GRANTED
// =============================================================================

describe("POST /issuance-requests/:id/grant — happy path", () => {
  test("allowlisted admin can grant a PENDING request", async () => {
    const req = await registerAndGetRequest("dave");

    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(200);
    const granted = (await res.json()) as IssuanceRequest;
    expect(granted.status).toBe("GRANTED");
    expect(granted.granted_by).toBe(admin.publicKeyB64);
    expect(granted.request_id).toBe(req.request_id);
    expect(granted.leaf_package).toBeNull(); // O-4a.2 populates this
  });

  test("granted request is retrievable via GET /issuance-requests/:id", async () => {
    const req = await registerAndGetRequest("eve");
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // Retrieve via admin-gated GET.
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/issuance-requests/${req.request_id}`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const record = (await res.json()) as IssuanceRequest;
    expect(record.status).toBe("GRANTED");
  });
});

// =============================================================================
// Admin reject — PENDING → REJECTED
// =============================================================================

describe("POST /issuance-requests/:id/reject — happy path", () => {
  test("allowlisted admin can reject a PENDING request", async () => {
    const req = await registerAndGetRequest("frank");

    const decision = await makeSignedAdminDecision(req.request_id, "reject", admin);
    const res = await post(`/issuance-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(200);
    const rejected = (await res.json()) as IssuanceRequest;
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.granted_by).toBe(admin.publicKeyB64);
    expect(rejected.request_id).toBe(req.request_id);
  });
});

// =============================================================================
// CAS guard — already-decided requests cannot be re-decided
// =============================================================================

describe("grant/reject on already-decided request → 409", () => {
  test("granting an already-GRANTED request returns 409 already_decided", async () => {
    const req = await registerAndGetRequest("grace");
    const d1 = await makeSignedAdminDecision(req.request_id, "grant", admin);
    await post(`/issuance-requests/${req.request_id}/grant`, d1);

    const d2 = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, d2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_decided");
  });

  test("rejecting an already-REJECTED request returns 409 already_decided", async () => {
    const req = await registerAndGetRequest("hank");
    const d1 = await makeSignedAdminDecision(req.request_id, "reject", admin);
    await post(`/issuance-requests/${req.request_id}/reject`, d1);

    const d2 = await makeSignedAdminDecision(req.request_id, "reject", admin);
    const res = await post(`/issuance-requests/${req.request_id}/reject`, d2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_decided");
  });

  test("granting an already-REJECTED request returns 409 already_decided", async () => {
    const req = await registerAndGetRequest("ivan");
    const d1 = await makeSignedAdminDecision(req.request_id, "reject", admin);
    await post(`/issuance-requests/${req.request_id}/reject`, d1);

    const d2 = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, d2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_decided");
  });
});

// =============================================================================
// Auth failures — same gate as network-create (503 / 401 / 403)
// =============================================================================

describe("POST /issuance-requests/:id/grant — auth failures", () => {
  test("no admin allowlist configured → 503 fail-closed", async () => {
    const req = await registerAndGetRequest("judy");
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision, unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
  });

  test("forged signature → 401", async () => {
    const req = await registerAndGetRequest("kyle");
    const other = await makePrincipalKey();
    // Claim says admin.publicKeyB64 but signed with other key.
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin, { signWith: other });
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("valid sig from non-allowlisted admin → 403", async () => {
    const req = await registerAndGetRequest("lena");
    const rogue = await makePrincipalKey();
    const decision = await makeSignedAdminDecision(req.request_id, "grant", rogue);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("replayed nonce → 409", async () => {
    const req = await registerAndGetRequest("mike");
    const nonce = randomNonce();
    const d1 = await makeSignedAdminDecision(req.request_id, "grant", admin, { nonce });
    const res1 = await post(`/issuance-requests/${req.request_id}/grant`, d1);
    expect(res1.status).toBe(200);

    // Second request for a different request_id (so it's not already_decided),
    // same nonce — must replay-reject.
    const req2 = await registerAndGetRequest("mike2");
    const d2 = await makeSignedAdminDecision(req2.request_id, "grant", admin, { nonce });
    const res2 = await post(`/issuance-requests/${req2.request_id}/grant`, d2);
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as { error: string }).error).toBe("nonce_replayed");
  });

  test("issued_at outside skew window → 400", async () => {
    const req = await registerAndGetRequest("nina");
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin, { issuedAt: old });
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(400);
  });

  test("unknown request_id → 404", async () => {
    const decision = await makeSignedAdminDecision("doesnotexist1234", "grant", admin);
    const res = await post("/issuance-requests/doesnotexist1234/grant", decision);
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// Auth failures — reject path
// =============================================================================

describe("POST /issuance-requests/:id/reject — auth failures", () => {
  test("no admin allowlist configured → 503 fail-closed", async () => {
    const req = await registerAndGetRequest("oscar");
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const decision = await makeSignedAdminDecision(req.request_id, "reject", admin);
    const res = await post(`/issuance-requests/${req.request_id}/reject`, decision, unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
  });

  test("forged signature → 401", async () => {
    const req = await registerAndGetRequest("pat");
    const other = await makePrincipalKey();
    const decision = await makeSignedAdminDecision(req.request_id, "reject", admin, { signWith: other });
    const res = await post(`/issuance-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(401);
  });

  test("valid sig from non-allowlisted admin → 403", async () => {
    const req = await registerAndGetRequest("quinn");
    const rogue = await makePrincipalKey();
    const decision = await makeSignedAdminDecision(req.request_id, "reject", rogue);
    const res = await post(`/issuance-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Read surface — admin-gated list + single-fetch
// =============================================================================

describe("GET /issuance-requests — admin-gated read surface", () => {
  test("GET ?status=PENDING lists pending requests (admin-gated)", async () => {
    await registerAndGetRequest("rosa");
    await registerAndGetRequest("sam");

    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/issuance-requests?status=PENDING`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as IssuanceRequest[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((r) => r.status === "PENDING")).toBe(true);
  });

  test("GET ?status=GRANTED lists only granted requests", async () => {
    const req = await registerAndGetRequest("tara");
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/issuance-requests?status=GRANTED`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as IssuanceRequest[];
    expect(list.some((r) => r.request_id === req.request_id)).toBe(true);
    expect(list.every((r) => r.status === "GRANTED")).toBe(true);
  });

  test("GET /issuance-requests/:id returns the specific request (admin-gated)", async () => {
    const req = await registerAndGetRequest("uma");
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/issuance-requests/${req.request_id}`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const record = (await res.json()) as IssuanceRequest;
    expect(record.request_id).toBe(req.request_id);
    expect(record.status).toBe("PENDING");
  });

  test("GET /issuance-requests/:id → 404 for unknown", async () => {
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/issuance-requests/unknownrequest0000",
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(404);
  });

  test("GET without admin signature → 503 fail-closed when no allowlist configured", async () => {
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const res = await get("/issuance-requests?status=PENDING", unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
  });

  test("GET with forged admin signature → 401", async () => {
    const other = await makePrincipalKey();
    // Build a read claim signed with `other` but claiming to be admin.
    const forgedRead = await makeSignedAdminRead(admin, { signWith: other });
    const res = await get(
      "/issuance-requests?status=PENDING",
      env,
      { "x-admin-signed": JSON.stringify(forgedRead) },
    );
    expect(res.status).toBe(401);
  });

  test("GET with non-allowlisted admin pubkey → 403", async () => {
    const rogue = await makePrincipalKey();
    const rogueRead = await makeSignedAdminRead(rogue);
    const res = await get(
      "/issuance-requests?status=PENDING",
      env,
      { "x-admin-signed": JSON.stringify(rogueRead) },
    );
    expect(res.status).toBe(403);
  });

  test("GET /issuance-requests missing admin header → 400", async () => {
    const res = await get("/issuance-requests?status=PENDING");
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Migration 0004 — SQL shape test (bun:sqlite)
// =============================================================================
