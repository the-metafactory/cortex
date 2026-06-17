/**
 * O-4a.2 — Leaf package record + serve (PoP peer read) tests.
 *
 * Coverage:
 *
 * Grammar anti-drift vectors (O-4b mirror check):
 *   - isNkeyAccountPubkeyRegistry / isNscJwtShapeRegistry use the same
 *     grammar as O-4b's isNkeyAccountPubkey / isNscJwtShape. This test
 *     asserts known-good and known-bad vectors against BOTH sides of the
 *     mirror so a future regex change in either module trips a test failure
 *     before it causes a silent mismatch.
 *
 * validateGrantLeafPackage:
 *   - valid minimal package (no SYS account)
 *   - valid package with SYS account
 *   - valid package with endpoint
 *   - rejects credsPath (secret field)
 *   - rejects any field containing "seed" / "secret" / "private"
 *   - rejects malformed operatorJwt
 *   - rejects malformed account (not nkey-U)
 *   - rejects malformed accountJwt
 *   - rejects half-specified SYS account (systemAccount without systemAccountJwt)
 *   - rejects half-specified SYS account (systemAccountJwt without systemAccount)
 *
 * Grant with package (admin path):
 *   - POST /issuance-requests/:id/grant with leaf_package stores package
 *   - returned request carries leaf_package JSON
 *   - grant without package still works (leaf_package remains null)
 *   - grant with credsPath in package → 400 validation_failed
 *   - grant with malformed account → 400 validation_failed
 *   - existing O-4a.1 grant tests are NOT broken (additive)
 *
 * Peer PoP package fetch (GET /issuance-requests/:id/package):
 *   - peer with correct key fetches package from GRANTED request → 200
 *   - peer request on PENDING request → 409 not_granted
 *   - peer request on REJECTED request → 409 not_granted
 *   - peer request with wrong key → 403 wrong_key
 *   - peer request with forged signature → 401 signature_invalid
 *   - peer request on nonexistent request_id → 404 not_found
 *   - peer request on GRANTED request with no package → 404 package_not_ready
 *   - missing x-peer-signed header → 400
 *   - admin pubkey CANNOT fetch via peer PoP route (wrong_key unless it matches)
 *   - invalid request_id path param → 400 invalid_request_id
 *
 * Client: provision-stack register PENDING note:
 *   - doRegister always returns PENDING note on 2xx
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedAdminDecision,
  makeSignedAdminRead,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { IssuanceRequest, GrantLeafPackage, IssuancePackageReadClaim } from "../src/types";
import {
  validateGrantLeafPackage,
  isNkeyAccountPubkeyRegistry,
  isNscJwtShapeRegistry,
} from "../src/validate";

// =============================================================================
// Known test vectors for the anti-drift check.
//
// These strings are tested against the registry-local predicates
// (isNkeyAccountPubkeyRegistry / isNscJwtShapeRegistry) which mirror the
// O-4b predicates (isNkeyAccountPubkey / isNscJwtShape) from
// `src/common/nats/leaf-remote-renderer.ts`.
//
// The companion test `src/__tests__/o4b-grammar-mirror.test.ts` (root-level)
// imports BOTH the registry validators AND the O-4b validators and asserts
// identical results for these vectors — that cross-module check catches any
// future regex drift between the two independent implementations.
//
// If O-4b's grammar ever changes, update BOTH the regexes in validate.ts and
// these vectors, then verify the root-level companion test still passes.
// =============================================================================

/**
 * A NATS nkey-U account pubkey that MUST pass both validators.
 * Grammar: /^A[A-Z2-7]{55}$/ — A prefix + 55 base32 chars = 56 total.
 */
const KNOWN_GOOD_NKEY = "AABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

/** A string that MUST fail both validators (too short, wrong format). */
const KNOWN_BAD_NKEY_SHORT = "ABCDEF";

/** A string that MUST fail both validators (starts with B, not A). */
const KNOWN_BAD_NKEY_WRONG_PREFIX = "BABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

/** A lowercase nkey string that MUST fail both validators. */
const KNOWN_BAD_NKEY_LOWERCASE = "aabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw";

/** A minimally valid NSC JWT shape. */
const KNOWN_GOOD_JWT = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl";

/** Not a JWT (no dots). */
const KNOWN_BAD_JWT_NO_DOTS = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ";

/** Too many segments (4 parts). */
const KNOWN_BAD_JWT_TOO_MANY = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl.extra";

/** Does not start with eyJ. */
const KNOWN_BAD_JWT_WRONG_START = "BAAAAD.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl";

// =============================================================================
// Test scaffold
// =============================================================================

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
 * Build a peer PoP header for the given peer key.
 *
 * N2 — `requestId` is now required: the signed claim includes `request_id`
 * so the token is bound to a specific issuance request and cannot be replayed
 * against a different request for the same peer key.
 *
 * `opts.requestIdOverride` lets tests sign a claim with a DIFFERENT request_id
 * than the path to exercise the mismatch rejection.
 */
async function makePeerPoP(
  peerKey: PrincipalKey,
  requestId: string,
  opts: { issuedAt?: string; signWith?: PrincipalKey; requestIdOverride?: string } = {},
): Promise<string> {
  const claim: IssuancePackageReadClaim = {
    peer_pubkey: peerKey.publicKeyB64,
    request_id: opts.requestIdOverride ?? requestId,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? peerKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return JSON.stringify({ claim, signature });
}

/** Register a principal and return the issuance request created. */
async function registerAndGetRequest(principalId: string): Promise<IssuanceRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);

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

/** A valid minimal GrantLeafPackage. */
const VALID_PACKAGE: GrantLeafPackage = {
  operatorJwt: KNOWN_GOOD_JWT,
  account: KNOWN_GOOD_NKEY,
  accountJwt: KNOWN_GOOD_JWT,
};

/** Build a grant decision body WITH a leaf_package. */
async function makeSignedAdminDecisionWithPackage(
  requestId: string,
  adminKey: PrincipalKey,
  leafPackage: GrantLeafPackage,
  opts: { issuedAt?: string; nonce?: string } = {},
): Promise<{ claim: Record<string, unknown>; signature: string }> {
  const claim: Record<string, unknown> = {
    request_id: requestId,
    decision: "grant",
    admin_pubkey: adminKey.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
    leaf_package: leafPackage,
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signEd25519(adminKey.privateKeyB64, message);
  return { claim, signature };
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
// Registry-local grammar validators (O-4b mirror)
//
// The registry is a SEPARATE package from the main cortex tree and cannot
// import `leaf-remote-renderer.ts`. These tests verify the mirrored regexes
// against the same vectors the O-4b companion test
// (src/__tests__/o4b-grammar-mirror.test.ts) also uses. If the vectors ever
// diverge between here and the companion file, the drift is detectable.
// =============================================================================

describe("isNkeyAccountPubkeyRegistry (mirrors O-4b /^A[A-Z2-7]{55}$/)", () => {
  test("known-good nkey passes", () => {
    expect(isNkeyAccountPubkeyRegistry(KNOWN_GOOD_NKEY)).toBe(true);
  });

  test("too-short nkey fails", () => {
    expect(isNkeyAccountPubkeyRegistry(KNOWN_BAD_NKEY_SHORT)).toBe(false);
  });

  test("wrong-prefix nkey (starts with B) fails", () => {
    expect(isNkeyAccountPubkeyRegistry(KNOWN_BAD_NKEY_WRONG_PREFIX)).toBe(false);
  });

  test("lowercase nkey fails", () => {
    expect(isNkeyAccountPubkeyRegistry(KNOWN_BAD_NKEY_LOWERCASE)).toBe(false);
  });

  test("empty string fails", () => {
    expect(isNkeyAccountPubkeyRegistry("")).toBe(false);
  });
});

describe("isNscJwtShapeRegistry (mirrors O-4b /^eyJ[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+){2}$/)", () => {
  test("known-good JWT passes", () => {
    expect(isNscJwtShapeRegistry(KNOWN_GOOD_JWT)).toBe(true);
  });

  test("no-dots JWT (only one segment) fails", () => {
    expect(isNscJwtShapeRegistry(KNOWN_BAD_JWT_NO_DOTS)).toBe(false);
  });

  test("too-many-segments JWT (4 parts) fails", () => {
    expect(isNscJwtShapeRegistry(KNOWN_BAD_JWT_TOO_MANY)).toBe(false);
  });

  test("wrong-start JWT (not eyJ) fails", () => {
    expect(isNscJwtShapeRegistry(KNOWN_BAD_JWT_WRONG_START)).toBe(false);
  });

  test("empty string fails", () => {
    expect(isNscJwtShapeRegistry("")).toBe(false);
  });
});

// =============================================================================
// validateGrantLeafPackage — unit tests
// =============================================================================

describe("validateGrantLeafPackage", () => {
  test("valid minimal package passes", () => {
    const result = validateGrantLeafPackage(VALID_PACKAGE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.operatorJwt).toBe(KNOWN_GOOD_JWT);
      expect(result.pkg.account).toBe(KNOWN_GOOD_NKEY);
      expect(result.pkg.accountJwt).toBe(KNOWN_GOOD_JWT);
      expect(result.pkg.systemAccount).toBeUndefined();
      expect(result.pkg.systemAccountJwt).toBeUndefined();
    }
  });

  test("valid package with SYS account passes", () => {
    const pkg = {
      ...VALID_PACKAGE,
      systemAccount: KNOWN_GOOD_NKEY,
      systemAccountJwt: KNOWN_GOOD_JWT,
    };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.systemAccount).toBe(KNOWN_GOOD_NKEY);
      expect(result.pkg.systemAccountJwt).toBe(KNOWN_GOOD_JWT);
    }
  });

  test("valid package with endpoint passes", () => {
    const pkg = { ...VALID_PACKAGE, endpoint: "tls://hub.meta-factory.ai:7422" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.endpoint).toBe("tls://hub.meta-factory.ai:7422");
    }
  });

  test("credsPath field → rejected (secret field)", () => {
    const pkg = { ...VALID_PACKAGE, credsPath: "/home/user/.nkeys/creds/mystack.creds" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.field).toContain("credsPath");
      expect(result.errors[0]?.message).toContain("secret");
    }
  });

  test("field containing 'seed' → rejected", () => {
    const pkg = { ...VALID_PACKAGE, accountSeed: "SOABCDEF" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
  });

  test("field containing 'secret' → rejected", () => {
    const pkg = { ...VALID_PACKAGE, secretKey: "XXXXXXXXXXX" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
  });

  test("field containing 'private' → rejected", () => {
    const pkg = { ...VALID_PACKAGE, privateData: "something" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
  });

  test("malformed operatorJwt → rejected", () => {
    const pkg = { ...VALID_PACKAGE, operatorJwt: "notajwt" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.includes("operatorJwt"))).toBe(true);
    }
  });

  test("malformed account (not nkey-U) → rejected", () => {
    const pkg = { ...VALID_PACKAGE, account: "notannkey" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.includes("account"))).toBe(true);
    }
  });

  test("malformed accountJwt → rejected", () => {
    const pkg = { ...VALID_PACKAGE, accountJwt: "badvalue" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.includes("accountJwt"))).toBe(true);
    }
  });

  test("half-specified SYS account: systemAccount without systemAccountJwt → rejected", () => {
    const pkg = { ...VALID_PACKAGE, systemAccount: KNOWN_GOOD_NKEY };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("both"))).toBe(true);
    }
  });

  test("half-specified SYS account: systemAccountJwt without systemAccount → rejected", () => {
    const pkg = { ...VALID_PACKAGE, systemAccountJwt: KNOWN_GOOD_JWT };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("both"))).toBe(true);
    }
  });

  test("empty endpoint → rejected", () => {
    const pkg = { ...VALID_PACKAGE, endpoint: "" };
    const result = validateGrantLeafPackage(pkg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.includes("endpoint"))).toBe(true);
    }
  });
});

// =============================================================================
// Admin grant WITH leaf_package
// =============================================================================

describe("POST /issuance-requests/:id/grant WITH leaf_package", () => {
  test("grant with valid leaf_package stores the package", async () => {
    const req = await registerAndGetRequest("pkg-alice");

    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(200);

    const granted = (await res.json()) as IssuanceRequest;
    expect(granted.status).toBe("GRANTED");
    expect(granted.leaf_package).not.toBeNull();

    // The stored JSON must round-trip to the original package shape.
    const parsed = JSON.parse(granted.leaf_package!) as GrantLeafPackage;
    expect(parsed.operatorJwt).toBe(VALID_PACKAGE.operatorJwt);
    expect(parsed.account).toBe(VALID_PACKAGE.account);
    expect(parsed.accountJwt).toBe(VALID_PACKAGE.accountJwt);
  });

  test("grant with SYS account stores full package", async () => {
    const req = await registerAndGetRequest("pkg-bob");

    const pkgWithSys: GrantLeafPackage = {
      ...VALID_PACKAGE,
      systemAccount: KNOWN_GOOD_NKEY,
      systemAccountJwt: KNOWN_GOOD_JWT,
    };
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, pkgWithSys);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(200);

    const granted = (await res.json()) as IssuanceRequest;
    const parsed = JSON.parse(granted.leaf_package!) as GrantLeafPackage;
    expect(parsed.systemAccount).toBe(KNOWN_GOOD_NKEY);
    expect(parsed.systemAccountJwt).toBe(KNOWN_GOOD_JWT);
  });

  test("grant without leaf_package still works (leaf_package null)", async () => {
    const req = await registerAndGetRequest("pkg-carol");

    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(200);

    const granted = (await res.json()) as IssuanceRequest;
    expect(granted.status).toBe("GRANTED");
    expect(granted.leaf_package).toBeNull();
  });

  test("grant with credsPath in package → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("pkg-dave");

    const badPkg = { ...VALID_PACKAGE, credsPath: "/home/user/.nkeys/creds/mystack.creds" };
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, badPkg as unknown as GrantLeafPackage);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("validation_failed");
  });

  test("grant with malformed account nkey → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("pkg-eve");

    const badPkg: GrantLeafPackage = { ...VALID_PACKAGE, account: "notannkey" };
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, badPkg);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(400);
  });

  test("grant with half-specified SYS account → 400 validation_failed", async () => {
    const req = await registerAndGetRequest("pkg-frank");

    const badPkg = { ...VALID_PACKAGE, systemAccount: KNOWN_GOOD_NKEY }; // missing systemAccountJwt
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, badPkg as unknown as GrantLeafPackage);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(400);
  });

  test("existing O-4a.1 grant (no package) still works after O-4a.2 changes", async () => {
    const req = await registerAndGetRequest("pkg-grace");
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    const res = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(res.status).toBe(200);
    const granted = (await res.json()) as IssuanceRequest;
    expect(granted.status).toBe("GRANTED");
    expect(granted.granted_by).toBe(admin.publicKeyB64);
    expect(granted.leaf_package).toBeNull(); // no regression
  });
});

// =============================================================================
// Peer PoP package fetch — GET /issuance-requests/:id/package
// =============================================================================

describe("GET /issuance-requests/:id/package — peer PoP", () => {
  test("peer fetches their own package from GRANTED request → 200", async () => {
    const req = await registerAndGetRequest("pop-alice");

    // Grant with package.
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    const grantRes = await post(`/issuance-requests/${req.request_id}/grant`, decision);
    expect(grantRes.status).toBe(200);

    // Peer fetches their package.
    const peerHeader = await makePeerPoP(principal, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leaf_package: GrantLeafPackage };
    expect(body.leaf_package.account).toBe(VALID_PACKAGE.account);
    expect(body.leaf_package.operatorJwt).toBe(VALID_PACKAGE.operatorJwt);
    expect(body.leaf_package.accountJwt).toBe(VALID_PACKAGE.accountJwt);
  });

  test("peer request on PENDING request → 409 not_granted", async () => {
    const req = await registerAndGetRequest("pop-bob");
    // Do NOT grant.

    const peerHeader = await makePeerPoP(principal, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_granted");
  });

  test("peer request on REJECTED request → 409 not_granted", async () => {
    const req = await registerAndGetRequest("pop-carol");

    // Reject the request.
    const decision = await makeSignedAdminDecision(req.request_id, "reject", admin);
    await post(`/issuance-requests/${req.request_id}/reject`, decision);

    const peerHeader = await makePeerPoP(principal, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_granted");
  });

  test("peer with wrong key → 403 wrong_key", async () => {
    const req = await registerAndGetRequest("pop-dave");

    // Grant with package.
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // A different peer key signs the PoP.
    const otherKey = await makePrincipalKey();
    const peerHeader = await makePeerPoP(otherKey, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_key");
  });

  test("peer with forged signature → 401 signature_invalid", async () => {
    const req = await registerAndGetRequest("pop-eve");

    // Grant with package.
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // Build a PoP that claims principal.publicKeyB64 but is signed by another key.
    const otherKey = await makePrincipalKey();
    const peerHeader = await makePeerPoP(principal, req.request_id, { signWith: otherKey });
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("peer request on nonexistent request_id → 404 not_found", async () => {
    const knownId = "0000000000000000000000000000cafe";
    const peerHeader = await makePeerPoP(principal, knownId);
    const res = await get(
      `/issuance-requests/${knownId}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("peer request on GRANTED request with no package → 404 package_not_ready", async () => {
    const req = await registerAndGetRequest("pop-frank");

    // Grant WITHOUT package.
    const decision = await makeSignedAdminDecision(req.request_id, "grant", admin);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    const peerHeader = await makePeerPoP(principal, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("package_not_ready");
  });

  test("missing x-peer-signed header → 400", async () => {
    const req = await registerAndGetRequest("pop-grace");

    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    const res = await get(`/issuance-requests/${req.request_id}/package`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x-peer-signed header required");
  });

  test("invalid request_id on /package route → 400 invalid_request_id", async () => {
    // For an invalid path param we use a placeholder known-good id in the claim
    // (the path validation fires before the claim is parsed, so the claim
    // request_id value doesn't matter here — the path param is rejected first).
    const peerHeader = await makePeerPoP(principal, "0000000000000000000000000000cafe");
    const res = await get(
      "/issuance-requests/not-valid-hex/package",
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request_id");
  });

  test("clock-skew check: issued_at in the past beyond skew window → 400", async () => {
    const req = await registerAndGetRequest("pop-hank");

    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // PoP with a stale issued_at (30 min ago > 5 min skew window).
    const staleAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const peerHeader = await makePeerPoP(principal, req.request_id, { issuedAt: staleAt });
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("issued_at out of skew window");
  });

  test("admin key is rejected as peer_pubkey if it doesn't match the registered peer_pubkey", async () => {
    // Register with `principal` key (not `admin` key).
    const req = await registerAndGetRequest("pop-ivan");

    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // Admin tries to fetch using admin key as peer — wrong_key since admin ≠ registered peer.
    const adminPoP = await makePeerPoP(admin, req.request_id);
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": adminPoP },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_key");
  });

  // ===========================================================================
  // M1 — rate-limit: flood of peer GETs trips 429
  // ===========================================================================

  test("M1 — flood of peer GET /package trips 429 (rate-limit shed)", async () => {
    const req = await registerAndGetRequest("pop-rate-limit");

    // Grant with package so the request is GRANTED.
    const decision = await makeSignedAdminDecisionWithPackage(req.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${req.request_id}/grant`, decision);

    // The "read" bucket allows 120 / 60s. Exhaust it with a batch of requests
    // (each signed with a fresh key so they don't short-circuit on ownership).
    // We send 121 to guarantee we cross the threshold; the in-memory fallback
    // will reject the 121st.
    let tripped = false;
    for (let i = 0; i <= 120; i++) {
      const peerHeader = await makePeerPoP(principal, req.request_id);
      const res = await get(
        `/issuance-requests/${req.request_id}/package`,
        env,
        { "x-peer-signed": peerHeader },
      );
      if (res.status === 429) {
        tripped = true;
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("rate_limited");
        break;
      }
    }
    expect(tripped).toBe(true);
  });

  // ===========================================================================
  // N2 — request_id binding: token signed for request A rejected at request B
  // ===========================================================================

  test("N2 — claim.request_id missing from envelope → 400 validation_failed", async () => {
    // Build a raw header WITHOUT request_id in the claim (old pre-N2 shape).
    const claim = {
      peer_pubkey: principal.publicKeyB64,
      // request_id deliberately omitted
      issued_at: new Date().toISOString(),
    };
    const message = new TextEncoder().encode(canonicalJSON(claim));
    const signature = await signEd25519(principal.privateKeyB64, message);
    const header = JSON.stringify({ claim, signature });

    const req = await registerAndGetRequest("n2-missing");
    const res = await get(
      `/issuance-requests/${req.request_id}/package`,
      env,
      { "x-peer-signed": header },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x-peer-signed validation_failed");
  });

  test("N2 — claim signed for request A is rejected at request B → 401 request_id_mismatch", async () => {
    // Register two separate principals so we get two distinct issuance requests.
    const reqA = await registerAndGetRequest("n2-request-a");
    const reqB = await registerAndGetRequest("n2-request-b");

    // Grant request B so it reaches the package-serve logic.
    const decisionB = await makeSignedAdminDecisionWithPackage(reqB.request_id, admin, VALID_PACKAGE);
    await post(`/issuance-requests/${reqB.request_id}/grant`, decisionB);

    // Build a PoP signed for request A (requestIdOverride = reqA.request_id),
    // then present it at request B's endpoint.
    const peerHeader = await makePeerPoP(principal, reqB.request_id, {
      requestIdOverride: reqA.request_id,
    });
    const res = await get(
      `/issuance-requests/${reqB.request_id}/package`,
      env,
      { "x-peer-signed": peerHeader },
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("request_id_mismatch");
  });
});

// Note: provision-stack register PENDING note test lives in
// src/__tests__/o4a2-provision-stack-pending.test.ts (root-level test suite)
// because the CLI module is outside the registry package boundary.
