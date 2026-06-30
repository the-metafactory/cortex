/**
 * #1321 — per-network admin authorization.
 *
 * Encodes the existing domain concept **Network posture (admin vs member)**
 * (CONTEXT.md §Network posture) into the registry schema: a network carries its
 * own `admin_pubkeys`, and the network-create/update gate + the admission-grant
 * gate authorize against THAT network's admins OR the global
 * `REGISTRY_ADMIN_PUBKEYS` allowlist (the `metafactory` bootstrap admin).
 *
 * Privilege model (anti-self-escalation):
 *   - network CREATE      → global admin only (may set initial admin_pubkeys)
 *   - network UPDATE      → per-network admin OR global; but only a GLOBAL admin
 *                           may change admin_pubkeys (a per-network admin cannot
 *                           add co-admins or lock out the global admin)
 *   - admission GRANT     → per-network admin (for the request's network) OR global
 *   - admin READS         → global only (per-network read-scoping is a fast-follow)
 *
 * Control-plane only — NO wire-grammar change (no network on the wire; the
 * `admin_pubkeys` set never appears in a subject/source/originator).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedNetworkCreate,
  makeSignedRegistration,
  makeSignedAdminRead,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import { getStore } from "../src/store";
import type { AdmissionRequest } from "../src/types";

let env: Env;
let globalAdmin: PrincipalKey;

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

/** Build a signed admission decision (admit/reject) for the given admin key. */
async function makeDecision(
  requestId: string,
  decision: "admit" | "reject",
  adminKey: PrincipalKey,
): Promise<{ claim: unknown; signature: string }> {
  const claim = {
    request_id: requestId,
    decision,
    admin_pubkey: adminKey.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signEd25519(adminKey.privateKeyB64, message);
  return { claim, signature };
}

/** Create a network (as the global admin), optionally with a per-network admin set. */
async function createNetwork(networkId: string, adminPubkeys?: string): Promise<Response> {
  const body = await makeSignedNetworkCreate(networkId, globalAdmin, { adminPubkeys });
  return post(`/networks/${networkId}`, body);
}

/** Register a principal into a network and return the PENDING admission request. */
async function registerInto(principalId: string, networkId: string): Promise<AdmissionRequest> {
  const pk = await makePrincipalKey();
  const reg = await makeSignedRegistration(principalId, pk, {
    networkId,
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: pk.publicKeyB64 }],
  });
  const regRes = await post(`/principals/${principalId}/register`, reg);
  expect(regRes.status).toBe(201);

  const signedRead = await makeSignedAdminRead(globalAdmin);
  const listRes = await get("/admission-requests?status=PENDING", env, {
    "x-admin-signed": JSON.stringify(signedRead),
  });
  expect(listRes.status).toBe(200);
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  globalAdmin = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: globalAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Admission grant — the core of #1321: each network sovereign over its roster
// =============================================================================

describe("admission grant — per-network admin", () => {
  test("a per-network admin can admit a request to THEIR network (not a global admin)", async () => {
    const pna = await makePrincipalKey(); // per-network admin, NOT on the global allowlist
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    const req = await registerInto("joel", "research-collab");
    const decision = await makeDecision(req.request_id, "admit", pna);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);

    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).status).toBe("ADMITTED");
  });

  test("a per-network admin of network A CANNOT admit a request to network B → 403", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);

    const reqB = await registerInto("joel", "net-b");
    const decision = await makeDecision(reqB.request_id, "admit", adminA); // A's admin, B's request
    const res = await post(`/admission-requests/${reqB.request_id}/admit`, decision);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("the global admin can still admit any network's request (regression)", async () => {
    const pna = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    const req = await registerInto("joel", "research-collab");
    const decision = await makeDecision(req.request_id, "admit", globalAdmin);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);

    expect(res.status).toBe(200);
  });

  test("a stranger (neither global nor per-network admin) → 403", async () => {
    const pna = await makePrincipalKey();
    const stranger = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    const req = await registerInto("joel", "research-collab");
    const decision = await makeDecision(req.request_id, "admit", stranger);
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);

    expect(res.status).toBe(403);
  });
});

// =============================================================================
// Network create/update — per-network admin authority + anti-escalation
// =============================================================================

describe("network create/update — per-network admin", () => {
  test("a per-network admin can update their network's topology", async () => {
    const pna = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    const update = await makeSignedNetworkCreate("research-collab", pna, { hubUrl: "tls://new:7500", leafPort: 7500 });
    const res = await post("/networks/research-collab", update);
    expect(res.status).toBe(201);

    const stored = await getStore(env).getNetwork("research-collab");
    expect(stored?.hub_url).toBe("tls://new:7500");
  });

  test("a per-network topology update PRESERVES the existing admin set (no clobber)", async () => {
    const pna = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    // pna updates only topology — the claim carries no admin_pubkeys.
    const update = await makeSignedNetworkCreate("research-collab", pna, { hubUrl: "tls://moved:7600", leafPort: 7600 });
    expect((await post("/networks/research-collab", update)).status).toBe(201);

    // The admin set must survive the update — not be nulled to global-only.
    const stored = await getStore(env).getNetwork("research-collab");
    expect(stored?.admin_pubkeys).toBe(pna.publicKeyB64);

    // And the per-network admin can still admit afterwards (proves preservation end-to-end).
    const req = await registerInto("joel", "research-collab");
    const decision = await makeDecision(req.request_id, "admit", pna);
    expect((await post(`/admission-requests/${req.request_id}/admit`, decision)).status).toBe(200);
  });

  test("a per-network admin CANNOT change admin_pubkeys (anti-self-escalation) → 403", async () => {
    const pna = await makePrincipalKey();
    const accomplice = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    // pna tries to add `accomplice` to the admin set — must be refused.
    const escalate = await makeSignedNetworkCreate("research-collab", pna, {
      adminPubkeys: `${pna.publicKeyB64},${accomplice.publicKeyB64}`,
    });
    const res = await post("/networks/research-collab", escalate);
    expect(res.status).toBe(403);

    // The admin set is unchanged — accomplice still cannot admit.
    const stored = await getStore(env).getNetwork("research-collab");
    expect(stored?.admin_pubkeys).toBe(pna.publicKeyB64);
  });

  test("the global admin CAN set/change admin_pubkeys", async () => {
    const pna = await makePrincipalKey();
    expect((await createNetwork("research-collab").then((r) => r.status))).toBe(201);

    const setAdmins = await makeSignedNetworkCreate("research-collab", globalAdmin, {
      adminPubkeys: pna.publicKeyB64,
    });
    const res = await post("/networks/research-collab", setAdmins);
    expect(res.status).toBe(201);

    const stored = await getStore(env).getNetwork("research-collab");
    expect(stored?.admin_pubkeys).toBe(pna.publicKeyB64);
  });

  test("a stranger cannot update a network with a per-network admin set → 403", async () => {
    const pna = await makePrincipalKey();
    const stranger = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);

    const update = await makeSignedNetworkCreate("research-collab", stranger, { hubUrl: "tls://evil:7422" });
    const res = await post("/networks/research-collab", update);
    expect(res.status).toBe(403);
  });

  test("create persists admin_pubkeys", async () => {
    const pna = await makePrincipalKey();
    expect((await createNetwork("research-collab", pna.publicKeyB64)).status).toBe(201);
    const stored = await getStore(env).getNetwork("research-collab");
    expect(stored?.admin_pubkeys).toBe(pna.publicKeyB64);
  });

  test("malformed admin_pubkeys in claim → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", globalAdmin, {
      adminPubkeys: "not-a-valid-base64-pubkey",
    });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });
});
