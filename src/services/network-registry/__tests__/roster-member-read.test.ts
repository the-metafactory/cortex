/**
 * C-1282 (ADR-0018 Q4) — member-accessible ADMITTED peer-roster read.
 *
 * `GET /networks/:network_id/roster/member` releases the network's ADMITTED
 * roster to a caller who proves possession of an ADMITTED member key for THAT
 * network. The PoP signature IS the authorization (no admin key). Fail-closed:
 *
 *   - a non-member (registered-but-PENDING, REVOKED, or never-registered) → 403
 *   - a member of a DIFFERENT network → 403 (network-scoped)
 *   - a bad signature / unsigned request → 401 / 400 (no metadata leaked)
 *
 * The public `GET /networks/:id/roster` (federation-transport resolve path)
 * is unchanged — this is a SEPARATE, PoP-gated surface for the MC member
 * posture (#1275/#1276) and the hosted feed (#1280).
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
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519, verifyEd25519 } from "../src/signing";
import type {
  AdmissionRequest,
  Capability,
  NetworkRoster,
  SignedAssertion,
} from "../src/types";

let env: Env;
let admin: PrincipalKey;

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

/**
 * Register `principalId` targeting `networkId`, then ADMIT the resulting PENDING
 * request. After this the principal is an ADMITTED member of the network.
 */
async function registerAndAdmit(
  principalId: string,
  pKey: PrincipalKey,
  networkId: string,
  capabilities: Capability[] = [],
): Promise<void> {
  const reg = await post(
    `/principals/${principalId}/register`,
    await makeSignedRegistration(principalId, pKey, { networkId, capabilities }),
  );
  expect(reg.status).toBe(201);
  const read = await makeSignedAdminRead(admin);
  const listRes = await get("/admission-requests?status=PENDING", {
    "x-admin-signed": JSON.stringify(read),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const req = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
  expect(req).toBeDefined();
  const decision = await makeSignedAdminDecision(req!.request_id, "admit", admin);
  const admitRes = await post(`/admission-requests/${req!.request_id}/admit`, decision);
  expect(admitRes.status).toBe(200);
}

/** Register but DO NOT admit — leaves a PENDING row for `networkId`. */
async function registerOnly(
  principalId: string,
  pKey: PrincipalKey,
  networkId: string,
): Promise<void> {
  const reg = await post(
    `/principals/${principalId}/register`,
    await makeSignedRegistration(principalId, pKey, { networkId }),
  );
  expect(reg.status).toBe(201);
}

/**
 * Build the signed `x-pop-signed` header for the member roster read. The claim
 * binds the network_id + the member's peer_pubkey; signed by the member's key.
 */
async function makeMemberRead(
  networkId: string,
  member: PrincipalKey,
  opts: {
    issuedAt?: string;
    peerPubkeyOverride?: string;
    networkIdOverride?: string;
    signWith?: PrincipalKey;
  } = {},
): Promise<string> {
  const claim = {
    network_id: opts.networkIdOverride ?? networkId,
    peer_pubkey: opts.peerPubkeyOverride ?? member.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
  };
  const signer = opts.signWith ?? member;
  const signature = await signEd25519(
    signer.privateKeyB64,
    new TextEncoder().encode(canonicalJSON(claim)),
  );
  return JSON.stringify({ claim, signature });
}

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

describe("GET /networks/:id/roster/member — member PoP-read (ADR-0018 Q4)", () => {
  // ---------------------------------------------------------------------------
  // Happy path — an ADMITTED member reads the network's ADMITTED roster
  // ---------------------------------------------------------------------------

  test("an ADMITTED member reads the full ADMITTED roster for their network", async () => {
    const alpha = await makePrincipalKey();
    const beta = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab", [
      { id: "tasks.code-review", networks: ["research-collab"] },
    ]);
    await registerAndAdmit("beta", beta, "research-collab");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    expect(json.payload.network_id).toBe("research-collab");
    const ids = json.payload.members.map((m) => m.principal_id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
    // capabilities are joined as a facet on the roster
    const alphaRow = json.payload.members.find((m) => m.principal_id === "alpha");
    expect(alphaRow?.capabilities).toEqual(["tasks.code-review"]);
    // FLG-4 — additive roster lifecycle facets: this read serves the ADMITTED
    // roster, so `admission_state` is ADMITTED; `sealed` is a boolean delivery
    // signal (false — no sealed secret delivered in this fixture); hub-authorize
    // is null (not yet authorized). NONE of these carry secret material.
    expect(alphaRow?.admission_state).toBe("ADMITTED");
    expect(alphaRow?.sealed).toBe(false);
    expect(alphaRow?.hub_authorized_at).toBeNull();
  });

  test("the response is a registry-signed assertion (verifies against the registry pubkey)", async () => {
    const alpha = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    expect(json.registry).toBe(env.REGISTRY_PUBLIC_KEY ?? "");
    expect(json.signature.length).toBeGreaterThan(0);
    // The assertion binds the {payload, issued_at, registry} triple (signAssertion).
    const bound = canonicalJSON({
      payload: json.payload,
      issued_at: json.issued_at,
      registry: json.registry,
    });
    const ok = await verifyEd25519(
      json.registry,
      json.signature,
      new TextEncoder().encode(bound),
    );
    expect(ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Fail-closed — the trust boundary
  // ---------------------------------------------------------------------------

  test("a NON-member (never registered) is refused with 403 — and learns nothing", async () => {
    const alpha = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");

    const stranger = await makePrincipalKey();
    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", stranger),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { members?: unknown };
    expect(body.members).toBeUndefined();
  });

  test("a PENDING (registered-but-not-admitted) caller is refused with 403", async () => {
    const pending = await makePrincipalKey();
    await registerOnly("pending", pending, "research-collab");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", pending),
    });
    expect(res.status).toBe(403);
  });

  test("a member of a DIFFERENT network cannot read this network's roster (403, network-scoped)", async () => {
    const alpha = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");
    const outsider = await makePrincipalKey();
    await registerAndAdmit("outsider", outsider, "other-net");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", outsider),
    });
    expect(res.status).toBe(403);
  });

  test("a REVOKED member is refused with 403 (revocation cuts the read)", async () => {
    const alpha = await makePrincipalKey();
    const hubAdmin = await makePrincipalKey();
    // hub-admin = registry-admin collapse: reuse admin as hub-admin authority.
    env.REGISTRY_HUB_ADMIN_PUBKEYS = hubAdmin.publicKeyB64;
    await registerAndAdmit("alpha", alpha, "research-collab");

    // find alpha's ADMITTED request_id, then revoke it (hub-admin authority).
    const read = await makeSignedAdminRead(admin);
    const listRes = await get("/admission-requests?status=ADMITTED", {
      "x-admin-signed": JSON.stringify(read),
    });
    const list = (await listRes.json()) as AdmissionRequest[];
    const req = list.find((r) => r.principal_id === "alpha");
    expect(req).toBeDefined();
    const revokeClaim = {
      request_id: req!.request_id,
      hub_admin_pubkey: hubAdmin.publicKeyB64,
      issued_at: new Date().toISOString(),
      nonce: Math.random().toString(16).slice(2),
    };
    const revokeSig = await signEd25519(
      hubAdmin.privateKeyB64,
      new TextEncoder().encode(canonicalJSON(revokeClaim)),
    );
    const revokeRes = await post(`/admission-requests/${req!.request_id}/revoke`, {
      claim: revokeClaim,
      signature: revokeSig,
    });
    expect(revokeRes.status).toBe(200);

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha),
    });
    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Signature / claim integrity
  // ---------------------------------------------------------------------------

  test("a forged signature (signed by a different key) is refused with 401", async () => {
    const alpha = await makePrincipalKey();
    const attacker = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");

    // claim asserts alpha's pubkey but is signed by the attacker's key.
    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha, { signWith: attacker }),
    });
    expect(res.status).toBe(401);
  });

  test("a claim whose network_id does not match the path is rejected (400)", async () => {
    const alpha = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha, {
        networkIdOverride: "other-net",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("a stale (out-of-skew) read token is rejected (400)", async () => {
    const alpha = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");

    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha, { issuedAt: stale }),
    });
    expect(res.status).toBe(400);
  });

  test("a missing x-pop-signed header is rejected (400) — no metadata leaked", async () => {
    const res = await get("/networks/research-collab/roster/member");
    expect(res.status).toBe(400);
  });

  test("a malformed x-pop-signed header (not JSON) is rejected (400)", async () => {
    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": "not-json{",
    });
    expect(res.status).toBe(400);
  });

  test("an invalid network_id in the path is rejected (400)", async () => {
    const alpha = await makePrincipalKey();
    const res = await get("/networks/INVALID_CAPS/roster/member", {
      "x-pop-signed": await makeMemberRead("INVALID_CAPS", alpha),
    });
    expect(res.status).toBe(400);
  });

  test("the member sees ONLY ADMITTED peers — PENDING peers are excluded from the roster", async () => {
    const alpha = await makePrincipalKey();
    const pending = await makePrincipalKey();
    await registerAndAdmit("alpha", alpha, "research-collab");
    await registerOnly("pending", pending, "research-collab");

    const res = await get("/networks/research-collab/roster/member", {
      "x-pop-signed": await makeMemberRead("research-collab", alpha),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    const ids = json.payload.members.map((m) => m.principal_id);
    expect(ids).toEqual(["alpha"]);
  });
});
