/**
 * ADR-0015 — Network-admission gate endpoint tests.
 *
 * Drives the new canonical /admission-requests routes via `app.fetch(req, env)`.
 * These routes are the admission gate: PENDING → ADMITTED / REJECTED.
 * The gate controls roster membership, MINTS NOTHING.
 *
 * The legacy /issuance-requests paths (backward-compat transition window) are
 * covered by issuance-requests.test.ts. This file covers the new /admission-requests
 * surface end-to-end.
 *
 * Coverage:
 *   register hook:
 *     - POST /principals/:id/register creates a PENDING admission request
 *     - re-register (same peer_pubkey) is idempotent
 *   admin admit:
 *     - POST /admission-requests/:id/admit (allowlisted admin) → 200 ADMITTED
 *     - admit on already-decided request → 409 already_decided
 *     - forged signature → 401
 *     - non-allowlisted admin → 403
 *     - no admin allowlist → 503 fail-closed
 *     - replayed nonce → 409
 *   admin reject:
 *     - POST /admission-requests/:id/reject (allowlisted admin) → 200 REJECTED
 *     - reject on already-decided request → 409 already_decided
 *   read surface (admin-gated):
 *     - GET /admission-requests?status=PENDING lists pending
 *     - GET /admission-requests?status=ADMITTED lists admitted (not GRANTED)
 *     - GET /admission-requests/:id returns a specific request
 *     - GET /admission-requests/:id → 404 for unknown
 *     - GET reads require admin signature → 503 / 401 / 403
 *   no leaf_package:
 *     - ADMITTED response body has no leaf_package field
 *   clock-skew: issued_at outside window → 400
 *   invalid request_id: slug / uuid / wrong-length → 400
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  randomNonce,
  resetStores,
  makeSignedAdminRead,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
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

async function get(
  path: string,
  e: Env = env,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/**
 * Register a principal and return the admission request created as a side-effect.
 * Uses the admin-gated /admission-requests list surface to retrieve it.
 */
async function registerAndGetRequest(principalId: string): Promise<AdmissionRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);

  const signedRead = await makeSignedAdminRead(admin);
  const listRes = await get(
    `/admission-requests?status=PENDING`,
    env,
    { "x-admin-signed": JSON.stringify(signedRead) },
  );
  expect(listRes.status).toBe(200);
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId);
  expect(found).toBeDefined();
  return found!;
}

/**
 * Build a signed admission decision for the /admission-requests routes.
 * The claim uses "admit"/"reject" (AdmissionDecisionClaim vocabulary, ADR-0015).
 */
async function makeSignedAdmissionDecision(
  requestId: string,
  decision: "admit" | "reject",
  adminKey: PrincipalKey,
  opts: {
    issuedAt?: string;
    nonce?: string;
    signWith?: PrincipalKey;
  } = {},
): Promise<{ claim: { request_id: string; decision: "admit" | "reject"; admin_pubkey: string; issued_at: string; nonce: string }; signature: string }> {
  const claim = {
    request_id: requestId,
    decision,
    admin_pubkey: adminKey.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? adminKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return { claim, signature };
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
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
// Register hook — PENDING admission request created as side-effect
// =============================================================================

describe("POST /principals/:id/register — admission request side-effect", () => {
  test("registration creates a PENDING admission request", async () => {
    const req = await registerAndGetRequest("alice");
    expect(req.status).toBe("PENDING");
    expect(req.principal_id).toBe("alice");
    expect(req.peer_pubkey).toBe(principal.publicKeyB64);
    expect(req.request_id).toBeTruthy();
    expect(req.created_at).toBeTruthy();
    expect(req.granted_by).toBeNull();
  });

  test("re-registration with same peer_pubkey is idempotent (same request_id)", async () => {
    const req1 = await registerAndGetRequest("bob");

    const body2 = await makeSignedRegistration("bob", principal, {
      stacks: [{ stack_id: "bob/main", stack_pubkey: principal.publicKeyB64 }],
    });
    const res2 = await post("/principals/bob/register", body2);
    expect(res2.status).toBe(201);

    const signedRead = await makeSignedAdminRead(admin);
    const listRes = await get(
      `/admission-requests?status=PENDING`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    const list = (await listRes.json()) as AdmissionRequest[];
    const bobRequests = list.filter((r) => r.principal_id === "bob");
    expect(bobRequests.length).toBe(1);
    expect(bobRequests[0]!.request_id).toBe(req1.request_id);
  });

  // cortex#1723 — admission reads DERIVE stack_id from the principal record
  // (peer_pubkey joined against live stacks). Rows never stored it; the
  // custodian seal then defaulted the scoped-user name to "<principal>.default"
  // — the live jc↔andreas mis-seal (a SUB scope the member's real stack can
  // never receive on).
  test("admission reads carry the DERIVED stack_id (list + by-id) (cortex#1723)", async () => {
    const req = await registerAndGetRequest("carol");
    // The list read already carried it (registerAndGetRequest reads the list):
    expect((req as AdmissionRequest & { stack_id?: string }).stack_id).toBe("carol/main");

    // The single-row admin read derives it too.
    const signedRead = await makeSignedAdminRead(admin);
    const byId = await get(
      `/admission-requests/${req.request_id}`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(byId.status).toBe(200);
    const row = (await byId.json()) as AdmissionRequest & { stack_id?: string };
    expect(row.stack_id).toBe("carol/main");
  });

  test("stack_id derivation is fail-safe: no matching live stack ⇒ absent, never 'default' (cortex#1723)", async () => {
    // Register with a DIFFERENT stack pubkey than the admission row's peer
    // pubkey (the row is keyed on stacks[0] here, so register a second stack
    // whose pubkey the row does NOT use — then retire-simulate by asserting the
    // unmatched case directly through the derivation on a mismatched record).
    const req = await registerAndGetRequest("dave");
    const enriched = req as AdmissionRequest & { stack_id?: string };
    // Sanity: dave DID match (same pubkey) — now assert the negative via the
    // exported derivation helper with a mismatched record.
    expect(enriched.stack_id).toBe("dave/main");
    const { deriveAdmissionStackId } = await import("../src/store");
    expect(
      deriveAdmissionStackId(
        { principal_id: "dave", peer_pubkey: "someOtherPubkeyThatMatchesNoStack=" },
        [{ principal_id: "dave", principal_pubkey: "x", stacks: [{ stack_id: "dave/main", stack_pubkey: principal.publicKeyB64 }], capabilities: [], updated_at: "now" }],
      ),
    ).toBeUndefined();
    // Ambiguity (same pubkey on TWO live stacks) is also fail-safe: absent.
    expect(
      deriveAdmissionStackId(
        { principal_id: "dave", peer_pubkey: principal.publicKeyB64 },
        [{
          principal_id: "dave", principal_pubkey: "x", capabilities: [], updated_at: "now",
          stacks: [
            { stack_id: "dave/main", stack_pubkey: principal.publicKeyB64 },
            { stack_id: "dave/lab", stack_pubkey: principal.publicKeyB64 },
          ],
        }],
      ),
    ).toBeUndefined();
  });
});

// =============================================================================
// Admin admit — PENDING → ADMITTED (ADR-0015: no credential minted)
// =============================================================================

describe("POST /admission-requests/:id/admit — happy path", () => {
  test("allowlisted admin can admit a PENDING request → ADMITTED", async () => {
    const req = await registerAndGetRequest("carol");

    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(200);
    const admitted = (await res.json()) as AdmissionRequest;
    expect(admitted.status).toBe("ADMITTED");
    expect(admitted.granted_by).toBe(admin.publicKeyB64);
    expect(admitted.request_id).toBe(req.request_id);
  });

  test("ADMITTED response body has NO leaf_package field (mints nothing)", async () => {
    const req = await registerAndGetRequest("dave");
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // ADR-0015: the admission gate mints nothing — no leaf_package in the response.
    expect(body).not.toHaveProperty("leaf_package");
  });

  test("admitted request is retrievable via GET /admission-requests/:id", async () => {
    const req = await registerAndGetRequest("eve");
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    await post(`/admission-requests/${req.request_id}/admit`, decision);

    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/admission-requests/${req.request_id}`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const record = (await res.json()) as AdmissionRequest;
    expect(record.status).toBe("ADMITTED");
  });
});

// =============================================================================
// Admin reject — PENDING → REJECTED
// =============================================================================

describe("POST /admission-requests/:id/reject — happy path", () => {
  test("allowlisted admin can reject a PENDING request → REJECTED", async () => {
    const req = await registerAndGetRequest("frank");

    const decision = await makeSignedAdmissionDecision(req.request_id, "reject", admin);
    const res = await post(`/admission-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(200);
    const rejected = (await res.json()) as AdmissionRequest;
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.granted_by).toBe(admin.publicKeyB64);
  });
});

// =============================================================================
// CAS guard — already-decided requests cannot be re-decided
// =============================================================================

describe("admit/reject on already-decided request → 409 already_decided", () => {
  test("admitting an already-ADMITTED request → 409", async () => {
    const req = await registerAndGetRequest("grace");
    const d1 = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    await post(`/admission-requests/${req.request_id}/admit`, d1);

    const d2 = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, d2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_decided");
  });

  test("rejecting an already-REJECTED request → 409", async () => {
    const req = await registerAndGetRequest("hank");
    const d1 = await makeSignedAdmissionDecision(req.request_id, "reject", admin);
    await post(`/admission-requests/${req.request_id}/reject`, d1);

    const d2 = await makeSignedAdmissionDecision(req.request_id, "reject", admin);
    const res = await post(`/admission-requests/${req.request_id}/reject`, d2);
    expect(res.status).toBe(409);
  });

  test("admitting an already-REJECTED request → 409", async () => {
    const req = await registerAndGetRequest("ivan");
    const d1 = await makeSignedAdmissionDecision(req.request_id, "reject", admin);
    await post(`/admission-requests/${req.request_id}/reject`, d1);

    const d2 = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, d2);
    expect(res.status).toBe(409);
  });
});

// =============================================================================
// Auth failures — 503 fail-closed / 401 forged-sig / 403 non-allowlisted
// =============================================================================

describe("POST /admission-requests/:id/admit — auth failures", () => {
  test("no admin allowlist configured → 503 fail-closed", async () => {
    const req = await registerAndGetRequest("judy");
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision, unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
  });

  test("forged signature → 401", async () => {
    const req = await registerAndGetRequest("kyle");
    const other = await makePrincipalKey();
    // Claim declares admin.publicKeyB64 but is signed with `other`.
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin, { signWith: other });
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("valid sig from non-allowlisted admin → 403", async () => {
    const req = await registerAndGetRequest("lena");
    const rogue = await makePrincipalKey();
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", rogue);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("replayed nonce → 409", async () => {
    const req = await registerAndGetRequest("mike");
    const nonce = randomNonce();
    const d1 = await makeSignedAdmissionDecision(req.request_id, "admit", admin, { nonce });
    const res1 = await post(`/admission-requests/${req.request_id}/admit`, d1);
    expect(res1.status).toBe(200);

    // Second request for a different request_id (not already_decided), same nonce → 409 nonce_replayed.
    const req2 = await registerAndGetRequest("mike2");
    const d2 = await makeSignedAdmissionDecision(req2.request_id, "admit", admin, { nonce });
    const res2 = await post(`/admission-requests/${req2.request_id}/admit`, d2);
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as { error: string }).error).toBe("nonce_replayed");
  });

  test("issued_at outside skew window → 400", async () => {
    const req = await registerAndGetRequest("nina");
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin, { issuedAt: old });
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(400);
  });

  test("unknown request_id → 404", async () => {
    const nonexistent = "0000000000000000000000000000dead";
    const decision = await makeSignedAdmissionDecision(nonexistent, "admit", admin);
    const res = await post(`/admission-requests/${nonexistent}/admit`, decision);
    expect(res.status).toBe(404);
  });
});

describe("POST /admission-requests/:id/reject — auth failures", () => {
  test("no admin allowlist configured → 503 fail-closed", async () => {
    const req = await registerAndGetRequest("oscar");
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const decision = await makeSignedAdmissionDecision(req.request_id, "reject", admin);
    const res = await post(`/admission-requests/${req.request_id}/reject`, decision, unconfigured);
    expect(res.status).toBe(503);
  });

  test("forged signature → 401", async () => {
    const req = await registerAndGetRequest("pat");
    const other = await makePrincipalKey();
    const decision = await makeSignedAdmissionDecision(req.request_id, "reject", admin, { signWith: other });
    const res = await post(`/admission-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(401);
  });

  test("valid sig from non-allowlisted admin → 403", async () => {
    const req = await registerAndGetRequest("quinn");
    const rogue = await makePrincipalKey();
    const decision = await makeSignedAdmissionDecision(req.request_id, "reject", rogue);
    const res = await post(`/admission-requests/${req.request_id}/reject`, decision);
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Read surface — admin-gated list + single-fetch
// =============================================================================

describe("GET /admission-requests — admin-gated read surface", () => {
  test("GET ?status=PENDING lists pending requests", async () => {
    await registerAndGetRequest("rosa");
    await registerAndGetRequest("sam");

    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/admission-requests?status=PENDING`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as AdmissionRequest[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((r) => r.status === "PENDING")).toBe(true);
  });

  test("GET ?status=ADMITTED lists only admitted requests (not GRANTED)", async () => {
    const req = await registerAndGetRequest("tara");
    const decision = await makeSignedAdmissionDecision(req.request_id, "admit", admin);
    await post(`/admission-requests/${req.request_id}/admit`, decision);

    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/admission-requests?status=ADMITTED`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as AdmissionRequest[];
    expect(list.some((r) => r.request_id === req.request_id)).toBe(true);
    expect(list.every((r) => r.status === "ADMITTED")).toBe(true);
  });

  test("GET /admission-requests/:id returns the specific request", async () => {
    const req = await registerAndGetRequest("uma");
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      `/admission-requests/${req.request_id}`,
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(200);
    const record = (await res.json()) as AdmissionRequest;
    expect(record.request_id).toBe(req.request_id);
    expect(record.status).toBe("PENDING");
  });

  test("GET /admission-requests/:id → 404 for unknown", async () => {
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/admission-requests/0000000000000000000000000000cafe",
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(404);
  });

  test("GET without admin allowlist → 503 fail-closed", async () => {
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    const res = await get("/admission-requests?status=PENDING", unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
  });

  test("GET with forged admin signature → 401", async () => {
    const other = await makePrincipalKey();
    const forgedRead = await makeSignedAdminRead(admin, { signWith: other });
    const res = await get(
      "/admission-requests?status=PENDING",
      env,
      { "x-admin-signed": JSON.stringify(forgedRead) },
    );
    expect(res.status).toBe(401);
  });

  test("GET with non-allowlisted admin → 403", async () => {
    const rogue = await makePrincipalKey();
    const rogueRead = await makeSignedAdminRead(rogue);
    const res = await get(
      "/admission-requests?status=PENDING",
      env,
      { "x-admin-signed": JSON.stringify(rogueRead) },
    );
    expect(res.status).toBe(403);
  });

  test("GET missing admin header → 400", async () => {
    const res = await get("/admission-requests?status=PENDING");
    expect(res.status).toBe(400);
  });

  test("GET with invalid status query param → 400", async () => {
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/admission-requests?status=GRANTED", // old vocab — should fail
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("status query param required");
  });
});

// =============================================================================
// Invalid request_id path param → 400 before body parse or crypto
// =============================================================================

describe("invalid request_id path param → 400 invalid_request_id", () => {
  test("slug (non-hex) request_id → 400 on admit", async () => {
    const decision = await makeSignedAdmissionDecision("not-a-valid-request-id", "admit", admin);
    const res = await post("/admission-requests/not-a-valid-request-id/admit", decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("UUID-with-dashes → 400 on admit", async () => {
    const uuidId = "550e8400-e29b-41d4-a716-446655440000";
    const decision = await makeSignedAdmissionDecision(uuidId, "admit", admin);
    const res = await post(`/admission-requests/${uuidId}/admit`, decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("too-short hex string → 400 on admit (31 chars)", async () => {
    const shortId = "0000000000000000000000000000bea";
    const decision = await makeSignedAdmissionDecision(shortId, "admit", admin);
    const res = await post(`/admission-requests/${shortId}/admit`, decision);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("invalid request_id on GET /:request_id → 400", async () => {
    const signedRead = await makeSignedAdminRead(admin);
    const res = await get(
      "/admission-requests/not-hex-32chars",
      env,
      { "x-admin-signed": JSON.stringify(signedRead) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });
});

// =============================================================================
// Envelope validation — claim must be a non-array object
// =============================================================================

describe("envelope validation — admit claim shape", () => {
  test("array claim → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("val-alice");
    const res = await post(`/admission-requests/${req.request_id}/admit`, {
      claim: [{ decision: "admit" }],
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(400);
  });

  test("missing claim field → 400", async () => {
    const req = await registerAndGetRequest("val-bob");
    const res = await post(`/admission-requests/${req.request_id}/admit`, {
      signature: "aGVsbG8=",
    });
    expect(res.status).toBe(400);
  });

  test("missing signature field → 400", async () => {
    const req = await registerAndGetRequest("val-carol");
    const res = await post(`/admission-requests/${req.request_id}/admit`, {
      claim: { decision: "admit" },
    });
    expect(res.status).toBe(400);
  });

  test("decision field must be 'admit' or 'reject', not 'grant' → 400", async () => {
    // The old vocabulary "grant" is NOT accepted on /admission-requests.
    const req = await registerAndGetRequest("val-dave");
    // Build a signed claim with "grant" as the decision.
    const claim = {
      request_id: req.request_id,
      decision: "grant", // legacy vocab — must be rejected
      admin_pubkey: admin.publicKeyB64,
      issued_at: new Date().toISOString(),
      nonce: randomNonce(),
    };
    const message = new TextEncoder().encode(
      JSON.stringify(Object.fromEntries(Object.entries(claim).sort())),
    );
    const signature = await signEd25519(admin.privateKeyB64, message);
    const res = await post(`/admission-requests/${req.request_id}/admit`, { claim, signature });
    expect(res.status).toBe(400);
  });
});
