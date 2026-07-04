/**
 * cortex#1498 (epic #1479 follow-up) — hub-owner authorization marker.
 *
 * Trust-path coverage (the hub-authorize registry write — same authority
 * model as sealed-secret delivery, ADR-0018 Q5):
 *   authorize write (hub-admin authority):
 *     - allowlisted hub-admin stamps `hub_authorized_at` onto an ADMITTED row → 200
 *     - write against a non-ADMITTED (PENDING) row → 409 not_admitted
 *     - write against an unknown request → 404
 *     - forged signature → 401 ; non-allowlisted key → 403 ; no allowlist → 503
 *     - replayed nonce → 409
 *     - request_id path/body mismatch → 400
 *     - re-authorize (second write) is allowed (re-stamps the timestamp)
 *   revoke / depart clear the stamp:
 *     - revoke of an authorized ADMITTED row → REVOKED + hub_authorized_at cleared
 *     - depart of an authorized ADMITTED row → DEPARTED + hub_authorized_at cleared
 *   store-level (InMemoryIssuanceRequestStore.markHubAuthorized):
 *     - sets hub_authorized_at on an ADMITTED row
 *     - no-op (undefined) on a non-ADMITTED row
 *     - no-op (undefined) on a missing row
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
import { InMemoryIssuanceRequestStore } from "../src/store";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let hubAdmin: PrincipalKey;
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

async function registerPending(principalId: string): Promise<AdmissionRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
    networkId: "metafactory",
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);
  const signedRead = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=PENDING`, env, {
    "x-admin-signed": JSON.stringify(signedRead),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId);
  expect(found).toBeDefined();
  return found!;
}

async function makeAdmitDecision(requestId: string, adminKey: PrincipalKey) {
  const claim = {
    request_id: requestId,
    decision: "admit" as const,
    admin_pubkey: adminKey.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(adminKey.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

async function admit(requestId: string): Promise<void> {
  const res = await post(`/admission-requests/${requestId}/admit`, await makeAdmitDecision(requestId, admin));
  expect(res.status).toBe(200);
}

async function makeAuthorize(
  requestId: string,
  signer: PrincipalKey,
  opts: { issuedAt?: string; nonce?: string; pubkeyOverride?: string } = {},
) {
  const claim = {
    request_id: requestId,
    hub_admin_pubkey: opts.pubkeyOverride ?? signer.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

async function makeRevoke(requestId: string, signer: PrincipalKey) {
  const claim = {
    request_id: requestId,
    hub_admin_pubkey: signer.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

async function makeDepart(requestId: string, principalId: string, signer: PrincipalKey) {
  const claim = {
    request_id: requestId,
    principal_id: principalId,
    peer_pubkey: signer.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

/** Member PoP-read of their own admission rows. Returns the row for the network. */
async function readMine(networkId: string): Promise<AdmissionRequest | undefined> {
  const claim = {
    principal_id: "alice",
    peer_pubkey: principal.publicKeyB64,
    issued_at: new Date().toISOString(),
  };
  const signature = await signEd25519(principal.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  const res = await get(`/admission-requests/mine`, env, { "x-pop-signed": JSON.stringify({ claim, signature }) });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as AdmissionRequest[];
  return rows.find((r) => r.network_id === networkId);
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
// Authorize write — the hub-authorize registry marker (cortex#1498)
// =============================================================================

describe("POST /admission-requests/:id/authorize — happy path", () => {
  test("admit stamps NOTHING: hub_authorized_at is null until the hub-admin authorizes", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const mine = await readMine("metafactory");
    expect(mine?.status).toBe("ADMITTED");
    expect(mine?.hub_authorized_at).toBeNull();
  });

  test("hub-admin authorizes an ADMITTED row; /mine then reports it", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);

    // A real (within clock-skew) issued_at — the persisted hub_authorized_at
    // is the CLAIM's issued_at, not the registry's receipt time, so a distinct
    // value here still proves the row carries exactly what the hub-admin signed.
    const issuedAt = new Date(Date.now() - 1000).toISOString();
    const res = await post(
      `/admission-requests/${req.request_id}/authorize`,
      await makeAuthorize(req.request_id, hubAdmin, { issuedAt }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as AdmissionRequest;
    expect(updated.hub_authorized_at).toBe(issuedAt);
    expect(updated.status).toBe("ADMITTED");

    const mine = await readMine("metafactory");
    expect(mine?.hub_authorized_at).toBe(issuedAt);
  });

  test("a second authorize (re-run) re-stamps the timestamp", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const first = new Date(Date.now() - 2000).toISOString();
    const second = new Date(Date.now() - 1000).toISOString();
    await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, hubAdmin, { issuedAt: first }));
    const res = await post(
      `/admission-requests/${req.request_id}/authorize`,
      await makeAuthorize(req.request_id, hubAdmin, { issuedAt: second }),
    );
    expect(res.status).toBe(200);
    const mine = await readMine("metafactory");
    expect(mine?.hub_authorized_at).toBe(second);
  });
});

describe("POST /admission-requests/:id/authorize — guards", () => {
  test("write against a PENDING (not-admitted) row → 409 not_admitted", async () => {
    const req = await registerPending("alice");
    const res = await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, hubAdmin));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("not_admitted");
  });

  test("write against an unknown request → 404", async () => {
    const unknown = "deadbeef".repeat(4);
    const res = await post(`/admission-requests/${unknown}/authorize`, await makeAuthorize(unknown, hubAdmin));
    expect(res.status).toBe(404);
  });

  test("forged signature → 401", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const attacker = await makePrincipalKey();
    const body = await makeAuthorize(req.request_id, attacker, { pubkeyOverride: hubAdmin.publicKeyB64 });
    const res = await post(`/admission-requests/${req.request_id}/authorize`, body);
    expect(res.status).toBe(401);
  });

  test("non-allowlisted hub-admin key → 403", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const stranger = await makePrincipalKey();
    const res = await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, stranger));
    expect(res.status).toBe(403);
  });

  test("no hub-admin (nor registry-admin) allowlist → 503 fail-closed", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const noAdminEnv: Env = { ...env, REGISTRY_ADMIN_PUBKEYS: "", REGISTRY_HUB_ADMIN_PUBKEYS: "" };
    const res = await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, hubAdmin), noAdminEnv);
    expect(res.status).toBe(503);
  });

  test("replayed nonce → 409", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const body = await makeAuthorize(req.request_id, hubAdmin);
    const first = await post(`/admission-requests/${req.request_id}/authorize`, body);
    expect(first.status).toBe(200);
    const replay = await post(`/admission-requests/${req.request_id}/authorize`, body);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).toBe("nonce_replayed");
  });

  test("request_id body/path mismatch → 400", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const other = "abcd1234".repeat(4);
    const body = await makeAuthorize(other, hubAdmin);
    const res = await post(`/admission-requests/${req.request_id}/authorize`, body);
    expect(res.status).toBe(400);
  });

  test("two separable authorities: a registry-admin-only key CANNOT authorize when a distinct hub allowlist is set", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const res = await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, admin));
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Revoke / depart clear the hub-authorize stamp (cortex#1498)
// =============================================================================

describe("revoke / depart clear hub_authorized_at", () => {
  test("hub-admin revoke of an authorized ADMITTED row clears hub_authorized_at", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, hubAdmin));
    expect((await readMine("metafactory"))?.hub_authorized_at).not.toBeNull();

    const res = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, hubAdmin));
    expect(res.status).toBe(200);
    const revoked = (await res.json()) as AdmissionRequest;
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.hub_authorized_at).toBeNull();
  });

  test("member depart of an authorized ADMITTED row clears hub_authorized_at", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    await post(`/admission-requests/${req.request_id}/authorize`, await makeAuthorize(req.request_id, hubAdmin));

    const res = await post(`/admission-requests/${req.request_id}/depart`, await makeDepart(req.request_id, "alice", principal));
    expect(res.status).toBe(200);
    const departed = (await res.json()) as AdmissionRequest;
    expect(departed.status).toBe("DEPARTED");
    expect(departed.hub_authorized_at).toBeNull();
  });
});

// =============================================================================
// Store-level — InMemoryIssuanceRequestStore.markHubAuthorized
// =============================================================================

describe("InMemoryIssuanceRequestStore.markHubAuthorized", () => {
  test("sets hub_authorized_at on an ADMITTED row", async () => {
    const store = new InMemoryIssuanceRequestStore();
    const pending = await store.upsertPending("alice", "pk-alice", "federated.alice.>", "metafactory");
    await store.transitionIssuanceRequest(pending.request_id, "ADMITTED", "admin-pubkey");

    const updated = await store.markHubAuthorized(pending.request_id, "2026-04-01T00:00:00.000Z");
    expect(updated?.hub_authorized_at).toBe("2026-04-01T00:00:00.000Z");
    expect(updated?.status).toBe("ADMITTED");
  });

  test("no-op (undefined) on a non-ADMITTED (PENDING) row", async () => {
    const store = new InMemoryIssuanceRequestStore();
    const pending = await store.upsertPending("alice", "pk-alice", "federated.alice.>", "metafactory");

    const result = await store.markHubAuthorized(pending.request_id, "2026-04-01T00:00:00.000Z");
    expect(result).toBeUndefined();
  });

  test("no-op (undefined) on a missing row", async () => {
    const store = new InMemoryIssuanceRequestStore();
    const result = await store.markHubAuthorized("no-such-request-id", "2026-04-01T00:00:00.000Z");
    expect(result).toBeUndefined();
  });

  test("no-op (undefined) on a REVOKED row (cannot re-authorize a revoked member)", async () => {
    const store = new InMemoryIssuanceRequestStore();
    const pending = await store.upsertPending("alice", "pk-alice", "federated.alice.>", "metafactory");
    await store.transitionIssuanceRequest(pending.request_id, "ADMITTED", "admin-pubkey");
    await store.revokeAdmission(pending.request_id);

    const result = await store.markHubAuthorized(pending.request_id, "2026-04-01T00:00:00.000Z");
    expect(result).toBeUndefined();
  });
});
