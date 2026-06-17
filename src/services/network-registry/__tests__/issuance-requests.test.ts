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
import { D1IssuanceRequestStore } from "../src/store";
import { MockD1, asD1 } from "./d1-mock";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

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
    // Must be a valid 32-hex-char id (passes M2 check) but not in the store.
    const nonexistent = "0000000000000000000000000000dead";
    const decision = await makeSignedAdminDecision(nonexistent, "grant", admin);
    const res = await post(`/issuance-requests/${nonexistent}/grant`, decision);
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
    // Must be a valid 32-hex-char id (passes M2 check) but not in the store.
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/issuance-requests/0000000000000000000000000000cafe",
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
// M1 — rate-limit: flood trips 429 on grant/reject handlers
// =============================================================================

describe("M1 — rate-limit: decision flood trips 429", () => {
  test("flooding grant with a valid request_id trips 429 after the register limit", async () => {
    // The "register" bucket allows 5 requests per 60s window (per RATE_LIMITS).
    // Exhaust the bucket then assert the next call returns 429.
    // We use a valid-format but nonexistent request_id so the rate-limit check
    // runs before any store access (the flood-shed path matters, not the outcome).
    const targetId = "aaaa0000bbbb1111cccc2222dddd3333";

    // Reset rate-limit bucket state from beforeEach so this test starts clean.
    _resetRateLimitBucketsForTest();

    // Fire 5 requests (the limit) — all will fail on auth (no valid body) but
    // the rate-limit consumes a token on each.
    for (let i = 0; i < 5; i++) {
      await post(`/issuance-requests/${targetId}/grant`, { claim: {}, signature: "" });
    }

    // The 6th request must be rate-limited before any body parse.
    const res = await post(`/issuance-requests/${targetId}/grant`, {
      claim: {},
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  test("flooding reject with a valid request_id trips 429 after the register limit", async () => {
    const targetId = "eeee4444ffff5555aaaa6666bbbb7777";
    _resetRateLimitBucketsForTest();

    for (let i = 0; i < 5; i++) {
      await post(`/issuance-requests/${targetId}/reject`, { claim: {}, signature: "" });
    }

    const res = await post(`/issuance-requests/${targetId}/reject`, {
      claim: {},
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });
});

// =============================================================================
// M2 — request_id path param validation: 400 before body parse or crypto
// =============================================================================

describe("M2 — invalid request_id path param → 400 invalid_request_id", () => {
  test("slug (non-hex) request_id → 400 on grant", async () => {
    const decision = await makeSignedAdminDecision("not-a-valid-request-id", "grant", admin);
    const res = await post("/issuance-requests/not-a-valid-request-id/grant", decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("UUID-with-dashes request_id → 400 on grant", async () => {
    const uuidId = "550e8400-e29b-41d4-a716-446655440000";
    const decision = await makeSignedAdminDecision(uuidId, "grant", admin);
    const res = await post(`/issuance-requests/${uuidId}/grant`, decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("empty request_id → 400 on reject", async () => {
    // Hono maps an empty path segment to "" which fails isValidRequestId.
    const res = await post("/issuance-requests//reject", { claim: {}, signature: "" });
    // Hono may 404 on unmatched route; either 400 or 404 is acceptable here
    // (the important thing is it never reaches the store).
    expect([400, 404].includes(res.status)).toBe(true);
  });

  test("too-short hex string → 400 on grant (31 chars)", async () => {
    const shortId = "0000000000000000000000000000bea"; // 31 chars
    const decision = await makeSignedAdminDecision(shortId, "grant", admin);
    const res = await post(`/issuance-requests/${shortId}/grant`, decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("too-long hex string → 400 on grant (33 chars)", async () => {
    const longId = "0000000000000000000000000000beef0"; // 33 chars
    const decision = await makeSignedAdminDecision(longId, "grant", admin);
    const res = await post(`/issuance-requests/${longId}/grant`, decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("invalid request_id on GET /:request_id → 400 invalid_request_id", async () => {
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/issuance-requests/not-hex-32chars",
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });
});

// =============================================================================
// M3 — D1 upsertPending is atomic: concurrent inserts never duplicate
// =============================================================================

describe("M3 — D1IssuanceRequestStore.upsertPending is atomic", () => {
  test("concurrent upsertPending calls for the same (principal, peer) return the same row", async () => {
    const shared = new MockD1();
    const store = new D1IssuanceRequestStore(asD1(shared));

    // Simulate two concurrent upsertPending calls arriving before either row exists.
    // In production these race; in the mock the first INSERT wins and the second
    // hits ON CONFLICT DO NOTHING, then both SELECTs return the same row.
    const [r1, r2] = await Promise.all([
      store.upsertPending("principal-x", "pubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "scope.leaf"),
      store.upsertPending("principal-x", "pubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "scope.leaf"),
    ]);

    // Both calls return the same request_id — no duplicate was created.
    expect(r1.request_id).toBe(r2.request_id);
    expect(r1.status).toBe("PENDING");
    expect(r2.status).toBe("PENDING");

    // Only one row exists in the backing store.
    expect(shared.issuanceRequests.size).toBe(1);
  });

  test("upsertPending returns existing row regardless of its status (idempotent after grant)", async () => {
    const shared = new MockD1();
    const store = new D1IssuanceRequestStore(asD1(shared));

    const original = await store.upsertPending(
      "principal-y",
      "pubkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      "scope.leaf",
    );

    // Simulate the request being granted by directly mutating the mock.
    const row = shared.issuanceRequests.get(original.request_id)!;
    shared.issuanceRequests.set(original.request_id, { ...row, status: "GRANTED", granted_by: "admin-key" });

    // A second upsertPending for the same peer returns the existing (now GRANTED) row.
    const second = await store.upsertPending(
      "principal-y",
      "pubkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      "scope.leaf",
    );

    expect(second.request_id).toBe(original.request_id);
    expect(second.status).toBe("GRANTED");
    expect(shared.issuanceRequests.size).toBe(1);
  });
});

// =============================================================================
// N1 — envelope validator rejects array claim + missing fields
// =============================================================================

describe("N1 — validateSignedIssuanceDecision envelope hardening", () => {
  test("array claim → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("n1-alice");
    const res = await post(`/issuance-requests/${req.request_id}/grant`, {
      claim: [{ decision: "grant" }],
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(400);
  });

  test("missing claim field → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("n1-bob");
    const res = await post(`/issuance-requests/${req.request_id}/grant`, {
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(400);
  });

  test("missing signature field → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("n1-carol");
    const res = await post(`/issuance-requests/${req.request_id}/grant`, {
      claim: { decision: "grant" },
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// N2 — CAS fallback uses pre-read existing row (no spurious 404 on D1 transient)
// =============================================================================

describe("N2 — transitionIssuanceRequest CAS uses pre-read row on changes===0", () => {
  test("concurrent grant/reject: second transition throws AlreadyDecidedError with the existing row", async () => {
    const shared = new MockD1();
    const store = new D1IssuanceRequestStore(asD1(shared));

    const row = await store.upsertPending(
      "principal-z",
      "pubkeyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
      "scope.leaf",
    );

    // Grant it once — changes the status in the mock.
    await store.transitionIssuanceRequest(row.request_id, "GRANTED", "admin-pub");

    // Second grant attempt — `existing` is fetched as GRANTED, then changes === 0,
    // so AlreadyDecidedError should be thrown with the existing row (not re-read).
    let caughtStatus: string | undefined;
    try {
      await store.transitionIssuanceRequest(row.request_id, "GRANTED", "admin-pub");
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AlreadyDecidedError") {
        const typed = err as { request: { status: string } };
        caughtStatus = typed.request.status;
      }
    }
    expect(caughtStatus).toBe("GRANTED");
  });
});

// =============================================================================
// Migration 0004 — SQL shape test (bun:sqlite)
// =============================================================================
