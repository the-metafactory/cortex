/**
 * FND-5 (ADR-0020 §4 read-scoping) — per-network admin READ scoping.
 *
 * Before FND-5, listing/getting admission-requests was GLOBAL-admin-only, so a
 * per-network admin's daemon could not fetch its OWN network's pending
 * request-ids (it had to be handed them out-of-band). This hard-blocked the MC
 * pier request-id feature (FLG-5).
 *
 * FND-5 lets `GET /admission-requests?status=` (and the single-row GET) accept a
 * signed read claim from an admin who is EITHER a per-network admin of the
 * network they NAME in the claim, OR a global admin — and returns ONLY that
 * network's rows to the per-network admin. A global admin still sees all (and
 * MAY narrow to one network).
 *
 * SECURITY-CRITICAL PROPERTY (explicitly tested below): a per-network admin
 * MUST NOT be able to read another network's rows — not by naming it, not by
 * omitting the scope, not through the single-row GET.
 *
 * Control-plane only — no wire-grammar change. Mirrors the read gate order:
 * 503 admin_not_configured → 429 rate-limit → 400 header/skew → 401 sig →
 * 403 admin_not_authorized (+ scope filter).
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
  makeSignedAdminDecision,
  resetStores,
  type PrincipalKey,
} from "./helpers";
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
  headers: Record<string, string> = {},
  e: Env = env,
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/** Create a network (as the global admin), optionally with a per-network admin set. */
async function createNetwork(networkId: string, adminPubkeys?: string): Promise<Response> {
  const body = await makeSignedNetworkCreate(networkId, globalAdmin, { adminPubkeys });
  return post(`/networks/${networkId}`, body);
}

/**
 * Register a principal (optionally into a network) and return the PENDING
 * admission request. Uses a GLOBAL-admin unscoped read to locate the row (which
 * still returns ALL networks post-FND-5).
 */
async function registerInto(principalId: string, networkId?: string): Promise<AdmissionRequest> {
  const pk = await makePrincipalKey();
  const reg = await makeSignedRegistration(principalId, pk, {
    ...(networkId !== undefined && { networkId }),
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: pk.publicKeyB64 }],
  });
  const regRes = await post(`/principals/${principalId}/register`, reg);
  expect(regRes.status).toBe(201);

  const signedRead = await makeSignedAdminRead(globalAdmin);
  const listRes = await get("/admission-requests?status=PENDING", {
    "x-admin-signed": JSON.stringify(signedRead),
  });
  expect(listRes.status).toBe(200);
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find(
    (r) => r.principal_id === principalId && r.network_id === (networkId ?? null),
  );
  expect(found).toBeDefined();
  return found!;
}

/** List admission-requests by status as a given admin, with an optional network scope. */
async function listAs(
  adminKey: PrincipalKey,
  status: string,
  opts: { networkId?: string; signWith?: PrincipalKey } = {},
): Promise<Response> {
  const signed = await makeSignedAdminRead(adminKey, opts);
  return get(`/admission-requests?status=${status}`, {
    "x-admin-signed": JSON.stringify(signed),
  });
}

/** Fetch a single admission-request as a given admin, with an optional network scope. */
async function getOneAs(
  adminKey: PrincipalKey,
  requestId: string,
  opts: { networkId?: string } = {},
): Promise<Response> {
  const signed = await makeSignedAdminRead(adminKey, opts);
  return get(`/admission-requests/${requestId}`, {
    "x-admin-signed": JSON.stringify(signed),
  });
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
  } as Env;
});

// =============================================================================
// Per-network admin read scoping — the core of FND-5
// =============================================================================

describe("GET /admission-requests — per-network admin read scope", () => {
  test("a per-network admin sees ONLY their own network's rows", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);

    const reqA = await registerInto("joel", "net-a");
    await registerInto("vincent", "net-b"); // a row in the OTHER network

    const res = await listAs(adminA, "PENDING", { networkId: "net-a" });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as AdmissionRequest[];

    expect(rows.map((r) => r.request_id)).toEqual([reqA.request_id]);
    expect(rows.every((r) => r.network_id === "net-a")).toBe(true);
    // The other network's row is absent.
    expect(rows.some((r) => r.network_id === "net-b")).toBe(false);
  });

  test("SECURITY: a per-network admin CANNOT read another network's rows by naming it → 403", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);
    await registerInto("vincent", "net-b");

    // admin A signs a read scoped to net-b — a network A does NOT administer.
    const res = await listAs(adminA, "PENDING", { networkId: "net-b" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("SECURITY: a per-network admin CANNOT read ALL networks by omitting the scope → 403", async () => {
    const adminA = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    await registerInto("joel", "net-a");

    // No networkId in the claim → a non-global admin has nothing to scope to.
    const res = await listAs(adminA, "PENDING");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("a stranger (neither global nor per-network admin) naming a network → 403", async () => {
    const adminA = await makePrincipalKey();
    const stranger = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    await registerInto("joel", "net-a");

    const res = await listAs(stranger, "PENDING", { networkId: "net-a" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");
  });

  test("scoping also applies to ADMITTED (not just PENDING)", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);

    const reqA = await registerInto("joel", "net-a");
    const reqB = await registerInto("vincent", "net-b");

    // Admit one row in each network (each by its own per-network admin).
    expect((await post(`/admission-requests/${reqA.request_id}/admit`, await makeSignedAdminDecision(reqA.request_id, "admit", adminA))).status).toBe(200);
    expect((await post(`/admission-requests/${reqB.request_id}/admit`, await makeSignedAdminDecision(reqB.request_id, "admit", adminB))).status).toBe(200);

    const res = await listAs(adminA, "ADMITTED", { networkId: "net-a" });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as AdmissionRequest[];
    expect(rows.map((r) => r.request_id)).toEqual([reqA.request_id]);
  });
});

// =============================================================================
// Global admin — still sees all; may narrow
// =============================================================================

describe("GET /admission-requests — global admin", () => {
  test("global admin with NO scope sees ALL networks' rows (regression)", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);
    const reqA = await registerInto("joel", "net-a");
    const reqB = await registerInto("vincent", "net-b");

    const res = await listAs(globalAdmin, "PENDING");
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as AdmissionRequest[]).map((r) => r.request_id).sort();
    expect(ids).toEqual([reqA.request_id, reqB.request_id].sort());
  });

  test("global admin MAY narrow to one network", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);
    const reqA = await registerInto("joel", "net-a");
    await registerInto("vincent", "net-b");

    const res = await listAs(globalAdmin, "PENDING", { networkId: "net-a" });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as AdmissionRequest[];
    expect(rows.map((r) => r.request_id)).toEqual([reqA.request_id]);
  });

  test("a network-less row (network_id null) stays GLOBAL-admin-only (ADR-0020 §3)", async () => {
    const adminA = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    const netless = await registerInto("solo"); // no network
    await registerInto("joel", "net-a");

    // Global admin (unscoped) sees the network-less row.
    const gRes = await listAs(globalAdmin, "PENDING");
    const gIds = ((await gRes.json()) as AdmissionRequest[]).map((r) => r.request_id);
    expect(gIds).toContain(netless.request_id);

    // A per-network admin scoped to net-a never sees it (null !== "net-a").
    const aRes = await listAs(adminA, "PENDING", { networkId: "net-a" });
    const aIds = ((await aRes.json()) as AdmissionRequest[]).map((r) => r.request_id);
    expect(aIds).not.toContain(netless.request_id);
  });
});

// =============================================================================
// Auth failures — fail-closed
// =============================================================================

describe("GET /admission-requests — auth failures", () => {
  test("no x-admin-signed header → 400 (unsigned enumeration blocked)", async () => {
    const res = await get("/admission-requests?status=PENDING");
    expect(res.status).toBe(400);
  });

  test("forged signature (wrong signing key) → 401", async () => {
    const adminA = await makePrincipalKey();
    const attacker = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);

    // Claim declares adminA's pubkey but is signed by the attacker's key.
    const res = await listAs(adminA, "PENDING", { networkId: "net-a", signWith: attacker });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("admin_not_configured (no REGISTRY_ADMIN_PUBKEYS) → 503 fail-closed", async () => {
    const bareEnv = { ...env, REGISTRY_ADMIN_PUBKEYS: "" } as Env;
    const signed = await makeSignedAdminRead(globalAdmin);
    const res = await get(
      "/admission-requests?status=PENDING",
      { "x-admin-signed": JSON.stringify(signed) },
      bareEnv,
    );
    expect(res.status).toBe(503);
  });
});

// =============================================================================
// Single-row GET — same scope
// =============================================================================

describe("GET /admission-requests/:request_id — per-network admin read scope", () => {
  test("a per-network admin can fetch a row in THEIR network", async () => {
    const adminA = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    const reqA = await registerInto("joel", "net-a");

    const res = await getOneAs(adminA, reqA.request_id, { networkId: "net-a" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).request_id).toBe(reqA.request_id);
  });

  test("SECURITY: a per-network admin fetching another network's row → 404 (no existence leak)", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-a", adminA.publicKeyB64)).status).toBe(201);
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);
    const reqB = await registerInto("vincent", "net-b");

    // admin A is an admin of net-a; asks for net-a scope but a net-b row id.
    const res = await getOneAs(adminA, reqB.request_id, { networkId: "net-a" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("global admin can fetch any network's row", async () => {
    const adminB = await makePrincipalKey();
    expect((await createNetwork("net-b", adminB.publicKeyB64)).status).toBe(201);
    const reqB = await registerInto("vincent", "net-b");

    const res = await getOneAs(globalAdmin, reqB.request_id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).request_id).toBe(reqB.request_id);
  });
});
