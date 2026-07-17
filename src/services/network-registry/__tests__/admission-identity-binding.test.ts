/**
 * cortex#2188 — admission identity-binding (RFC-0006 §7.3 / §8.3, myelin#235 W5).
 *
 * TRUST-PATH claim verification. Covers:
 *   - M9  — a WIDE decision claim binds peer_pubkey/network_id; each MUST match
 *           the row → else 409 identity_mismatch (BEFORE the authority check).
 *   - M12 — the per-network authority check consumes the BOUND network_id when
 *           present (falls back to the stored row network_id for narrow claims).
 *   - M13 — a NARROW claim is still admitted, but counted + a warning logged
 *           (dual-accept window OPEN; require-present flip NOT performed).
 *   - M17 — the seal write binds peer_pubkey the same way → 409 on mismatch.
 *
 * The headline case is the §7.3 CROSS-NETWORK CONFUSED-DEPUTY: a claim bound to
 * network A, replayed onto a network-B row, is refused 409 EVEN WHEN the signing
 * admin is legitimately authorised on B (fail-before: it admitted; pass-after:
 * 409).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedNetworkCreate,
  makeSignedRegistration,
  makeSignedAdminRead,
  makeSignedAdminDecision,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import { narrowAdmissionClaimCount } from "../src/admission-window";
import type { AdmissionRequest } from "../src/types";

let env: Env;
let globalAdmin: PrincipalKey;
let hubAdmin: PrincipalKey;

const SEALED = btoa("sealed-leaf-psk-opaque-ciphertext-v1");

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

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), env);
}

async function createNetwork(networkId: string, adminPubkeys?: string): Promise<void> {
  const body = await makeSignedNetworkCreate(networkId, globalAdmin, { adminPubkeys });
  expect((await post(`/networks/${networkId}`, body)).status).toBe(201);
}

/** Register a principal into a network; return the PENDING row (carries peer_pubkey + network_id). */
async function registerInto(principalId: string, networkId: string): Promise<AdmissionRequest> {
  const pk = await makePrincipalKey();
  const reg = await makeSignedRegistration(principalId, pk, {
    networkId,
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: pk.publicKeyB64 }],
  });
  expect((await post(`/principals/${principalId}/register`, reg)).status).toBe(201);

  const signedRead = await makeSignedAdminRead(globalAdmin);
  const listRes = await get("/admission-requests?status=PENDING", {
    "x-admin-signed": JSON.stringify(signedRead),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
  expect(found).toBeDefined();
  return found!;
}

async function makeSealedWrite(
  requestId: string,
  signer: PrincipalKey,
  opts: { peerPubkey?: string } = {},
): Promise<{ claim: unknown; signature: string }> {
  const claim = {
    request_id: requestId,
    sealed_secret: SEALED,
    ...(opts.peerPubkey !== undefined && { peer_pubkey: opts.peerPubkey }),
    hub_admin_pubkey: signer.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

// A console.warn spy so the M13 deprecation-warning assertion doesn't depend on
// log inspection tooling.
let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(async () => {
  resetStores();
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const reg = await makeRegistryKey();
  globalAdmin = await makePrincipalKey();
  hubAdmin = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: globalAdmin.publicKeyB64,
    REGISTRY_HUB_ADMIN_PUBKEYS: hubAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

afterEach(() => {
  console.warn = realWarn;
});

// =============================================================================
// M9 — wide decision claim binding (peer_pubkey + network_id)
// =============================================================================

describe("M9 — decision claim identity binding", () => {
  test("a WIDE claim whose peer_pubkey + network_id match the row → admitted", async () => {
    const pna = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna, {
      peerPubkey: req.peer_pubkey,
      networkId: "research-collab",
    });
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).status).toBe("ADMITTED");
    // A wide claim is NOT a narrow claim — the window counter stays at zero.
    expect(narrowAdmissionClaimCount()).toBe(0);
  });

  test("a mismatched peer_pubkey → 409 identity_mismatch", async () => {
    const pna = await makePrincipalKey();
    const other = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna, {
      peerPubkey: other.publicKeyB64, // NOT the row's peer
      networkId: "research-collab",
    });
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details?: { field: string } };
    expect(body.error).toBe("identity_mismatch");
    expect(body.details?.field).toBe("peer_pubkey");
    // Refused → not admitted.
    expect(req.status).toBe("PENDING");
  });

  test("a mismatched network_id → 409 identity_mismatch", async () => {
    const pna = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    await createNetwork("other-net", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna, {
      peerPubkey: req.peer_pubkey,
      networkId: "other-net", // row is research-collab
    });
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
  });
});

// =============================================================================
// §7.3 CROSS-NETWORK CONFUSED-DEPUTY — the headline case
// =============================================================================

describe("§7.3 cross-network confused-deputy", () => {
  test("claim bound to network A, row is network B, admin authorised on B → 409 (even though authorised on B)", async () => {
    const adminA = await makePrincipalKey();
    const adminB = await makePrincipalKey();
    await createNetwork("net-a", adminA.publicKeyB64);
    await createNetwork("net-b", adminB.publicKeyB64);

    // The victim row lives on net-b; adminB is a legitimate net-b admin.
    const reqB = await registerInto("joel", "net-b");

    // adminB signs a decision BOUND to net-a (the claim they believe/intend is
    // for A) but it is submitted against the net-b row. Pre-M9 this ADMITTED
    // (authority keyed off the stored net-b, on which adminB IS authorised) —
    // the confused deputy. M9 refuses it: the bound network_id contradicts the
    // row BEFORE authority is even consulted.
    const decision = await makeSignedAdminDecision(reqB.request_id, "admit", adminB, {
      peerPubkey: reqB.peer_pubkey,
      networkId: "net-a",
    });
    const res = await post(`/admission-requests/${reqB.request_id}/admit`, decision);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details?: { field: string } };
    expect(body.error).toBe("identity_mismatch");
    expect(body.details?.field).toBe("network_id");
  });
});

// =============================================================================
// M12 — the authority check consumes the bound network_id
// =============================================================================

describe("M12 — per-network authority keyed off the bound network_id", () => {
  test("a per-network admin of B, wide-claim-bound to B, on a B row → admitted", async () => {
    const adminB = await makePrincipalKey();
    await createNetwork("net-b", adminB.publicKeyB64);
    const reqB = await registerInto("joel", "net-b");

    const decision = await makeSignedAdminDecision(reqB.request_id, "admit", adminB, {
      peerPubkey: reqB.peer_pubkey,
      networkId: "net-b",
    });
    expect((await post(`/admission-requests/${reqB.request_id}/admit`, decision)).status).toBe(200);
  });
});

// =============================================================================
// M13 — dual-accept window: narrow claims still admitted, counted + warned
// =============================================================================

describe("M13 — narrow claim dual-accept window", () => {
  test("a NARROW claim (no binding) is still admitted, counted, and warns", async () => {
    const pna = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna); // no binding
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).status).toBe("ADMITTED");

    // Counter incremented + a deprecation warning logged (the require-present
    // flip's zero-narrow gate reads this).
    expect(narrowAdmissionClaimCount()).toBe(1);
    expect(warnings.some((w) => w.includes("admission-window") && w.includes("narrow"))).toBe(true);
  });
});

// =============================================================================
// M17 — seal write identity binding
// =============================================================================

describe("M17 — sealed-secret claim identity binding", () => {
  async function admittedRow(principalId: string): Promise<AdmissionRequest> {
    await createNetwork("metafactory");
    const req = await registerInto(principalId, "metafactory");
    // Admit with a WIDE claim so the admit step doesn't bump the narrow counter —
    // keeps the seal-surface narrow-count assertions below isolated.
    const decision = await makeSignedAdminDecision(req.request_id, "admit", globalAdmin, {
      peerPubkey: req.peer_pubkey,
      networkId: "metafactory",
    });
    expect((await post(`/admission-requests/${req.request_id}/admit`, decision)).status).toBe(200);
    return req;
  }

  test("a seal claim binding the row's peer_pubkey → written (200)", async () => {
    const req = await admittedRow("alice");
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, hubAdmin, { peerPubkey: req.peer_pubkey }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdmissionRequest).sealed_secret).toBe(SEALED);
  });

  test("a seal claim binding the WRONG peer_pubkey → 409 identity_mismatch", async () => {
    const req = await admittedRow("alice");
    const other = await makePrincipalKey();
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, hubAdmin, { peerPubkey: other.publicKeyB64 }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
  });

  test("a NARROW seal claim (no binding) still writes, counted + warns", async () => {
    const req = await admittedRow("alice");
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, hubAdmin),
    );
    expect(res.status).toBe(200);
    expect(narrowAdmissionClaimCount()).toBe(1);
    expect(warnings.some((w) => w.includes("sealed-secret") && w.includes("narrow"))).toBe(true);
  });

  test("a WRONG-peer seal claim does NOT count (mismatch is not an admission)", async () => {
    const req = await admittedRow("alice");
    const other = await makePrincipalKey();
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, hubAdmin, { peerPubkey: other.publicKeyB64 }),
    );
    expect(res.status).toBe(409);
    // A wide (bound) claim never counts anyway, but assert the counter is clean.
    expect(narrowAdmissionClaimCount()).toBe(0);
  });
});

// =============================================================================
// M13 — the counter is POISON-RESISTANT: only a CONFIRMED admit counts
// (PR #2194 adversarial BLOCKER). A narrow claim that bounces pre-transition
// (403 unauthorised / 404 missing row / 409 nonce-replay) must NOT increment
// the §7.3 zero-narrow flip gate.
// =============================================================================

describe("M13 — counter poison-resistance", () => {
  test("a narrow claim that 403s (stranger signer) does NOT count", async () => {
    const pna = await makePrincipalKey();
    const stranger = await makePrincipalKey(); // neither global nor per-network admin
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", stranger); // narrow
    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(403);
    expect(narrowAdmissionClaimCount()).toBe(0);
  });

  test("a narrow claim against a nonexistent row (404) does NOT count", async () => {
    // Valid-format but nonexistent request_id; global admin passes auth, so it
    // reaches the transition → 404 not_found, AFTER which counting is gated.
    const missingId = "0".repeat(32);
    const decision = await makeSignedAdminDecision(missingId, "admit", globalAdmin); // narrow
    const res = await post(`/admission-requests/${missingId}/admit`, decision);
    expect(res.status).toBe(404);
    expect(narrowAdmissionClaimCount()).toBe(0);
  });

  test("a replayed narrow claim (nonce reuse) counts only the first, confirmed admit", async () => {
    const pna = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna); // narrow
    expect((await post(`/admission-requests/${req.request_id}/admit`, decision)).status).toBe(200);
    expect(narrowAdmissionClaimCount()).toBe(1);

    // Replay the identical signed claim (same nonce) → 409, no second count.
    const replay = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(replay.status).toBe(409);
    expect(narrowAdmissionClaimCount()).toBe(1);
  });
});

// =============================================================================
// Strip-downgrade — an attacker cannot strip the binding off a signed WIDE
// claim to masquerade as narrow: the signature is over the wide bytes, so the
// stripped (narrow) wire canonical-JSON no longer verifies → 401.
// =============================================================================

describe("strip-downgrade resistance", () => {
  test("deleting peer_pubkey + network_id from a signed wide claim → 401", async () => {
    const pna = await makePrincipalKey();
    await createNetwork("research-collab", pna.publicKeyB64);
    const req = await registerInto("joel", "research-collab");

    const decision = await makeSignedAdminDecision(req.request_id, "admit", pna, {
      peerPubkey: req.peer_pubkey,
      networkId: "research-collab",
    });
    // Tamper the wire: strip the binding AFTER signing (signature is over the
    // wide claim). The route verifies over canonicalJSON(signed.claim) — now the
    // narrow bytes — so it can no longer match the wide-claim signature.
    const wire = decision.claim as unknown as Record<string, unknown>;
    delete wire.peer_pubkey;
    delete wire.network_id;

    const res = await post(`/admission-requests/${req.request_id}/admit`, decision);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
    // A rejected forgery is not a narrow admission — counter untouched.
    expect(narrowAdmissionClaimCount()).toBe(0);
  });
});
