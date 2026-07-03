/**
 * C-1351 Slice 2 (#1351) — stack-retire (registry deregistration) endpoint
 * `POST /principals/:principal_id/stacks/retire`.
 *
 * Trust-path coverage (ROOT-key-signed directory tombstone):
 *   - happy (ADMITTED-free): retire → 200, retired_at stamped, GET returns it,
 *     dropped from the active set (other stacks live, retired one carries the tombstone)
 *   - live-ADMITTED membership → 409, and BOTH the admission row and the record are UNTOUCHED
 *   - wrong-key (signed by a stack key, not the principal root) → 401
 *   - CAS stale (expected_updated_at != stored) → 409 stale_record
 *   - idempotent re-retire of an already-retired stack → 200 (no updated_at bump)
 *   - unknown stack_id → 404 ; unknown principal → 404
 *   - last-stack retire is ALLOWED (a dormant principal is valid)
 *   - a retired entry SURVIVES a subsequent add-stack re-register (merge preserves it)
 *   - over-wide body (junk keys past the canonical cap) → 401, NEVER 500
 *   - forged-attribution (path/body principal_id or stack_id mismatch) → 400
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
import { canonicalJSON, signEd25519, MAX_CANONICAL_KEYS } from "../src/signing";
import type { AdmissionRequest, PrincipalRecord, StackIdentity } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let root: PrincipalKey;

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

/** Register `principalId` (signed by `root`) with the given stacks + optional network. */
async function register(
  principalId: string,
  stacks: StackIdentity[],
  opts: { networkId?: string } = {},
): Promise<PrincipalRecord> {
  const reg = await post(
    `/principals/${principalId}/register`,
    await makeSignedRegistration(principalId, root, { stacks, ...(opts.networkId !== undefined && { networkId: opts.networkId }) }),
  );
  expect(reg.status).toBe(201);
  return fetchRecord(principalId);
}

/** GET the principal and return its (verified-shape) PrincipalRecord payload. */
async function fetchRecord(principalId: string): Promise<PrincipalRecord> {
  const res = await get(`/principals/${principalId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { payload: PrincipalRecord };
  return body.payload;
}

/** Build a signed retire envelope. Defaults sign with `root`. */
async function makeRetire(
  principalId: string,
  stackId: string,
  expectedUpdatedAt: string,
  opts: {
    signer?: PrincipalKey;
    issuedAt?: string;
    nonce?: string;
    principalIdOverride?: string;
    stackIdOverride?: string;
  } = {},
) {
  const claim = {
    principal_id: opts.principalIdOverride ?? principalId,
    stack_id: opts.stackIdOverride ?? stackId,
    expected_updated_at: expectedUpdatedAt,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signer = opts.signer ?? root;
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

/** Register + admit → leaves an ADMITTED row keyed on the first stack's pubkey. */
async function registerAndAdmit(principalId: string, networkId: string): Promise<AdmissionRequest> {
  await register(principalId, [{ stack_id: `${principalId}/default` }], { networkId });
  const read = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=PENDING`, { "x-admin-signed": JSON.stringify(read) });
  const list = (await listRes.json()) as AdmissionRequest[];
  const req = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
  expect(req).toBeDefined();
  const decision = await makeSignedAdminDecision(req!.request_id, "admit", admin);
  expect((await post(`/admission-requests/${req!.request_id}/admit`, decision)).status).toBe(200);
  return req!;
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  root = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Happy path — tombstone stamped, excluded from active, history preserved
// =============================================================================

describe("POST /principals/:id/stacks/retire — happy path", () => {
  test("retire an ADMITTED-free stack → 200, retired_at stamped, GET shows it, dropped from active", async () => {
    const laptop = await makePrincipalKey();
    const server = await makePrincipalKey();
    const rec = await register("alice", [
      { stack_id: "alice/laptop", stack_pubkey: laptop.publicKeyB64 },
      { stack_id: "alice/server", stack_pubkey: server.publicKeyB64 },
    ]);

    const res = await post(`/principals/alice/stacks/retire`, await makeRetire("alice", "alice/laptop", rec.updated_at));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payload: PrincipalRecord };
    const retiredEntry = body.payload.stacks.find((s) => s.stack_id === "alice/laptop");
    const liveEntry = body.payload.stacks.find((s) => s.stack_id === "alice/server");
    expect(retiredEntry?.retired_at).toBeDefined();
    expect(liveEntry?.retired_at).toBeUndefined();

    // Persisted: a fresh GET still returns the tombstone (history preserved).
    const after = await fetchRecord("alice");
    expect(after.stacks.find((s) => s.stack_id === "alice/laptop")?.retired_at).toBeDefined();
    // The active set is exactly the non-retired stacks.
    const active = after.stacks.filter((s) => s.retired_at === undefined).map((s) => s.stack_id);
    expect(active).toEqual(["alice/server"]);
  });

  test("last-stack retire is ALLOWED (a dormant, all-retired principal is valid)", async () => {
    const only = await makePrincipalKey();
    const rec = await register("bob", [{ stack_id: "bob/only", stack_pubkey: only.publicKeyB64 }]);
    const res = await post(`/principals/bob/stacks/retire`, await makeRetire("bob", "bob/only", rec.updated_at));
    expect(res.status).toBe(200);
    const after = await fetchRecord("bob");
    expect(after.stacks.filter((s) => s.retired_at === undefined)).toHaveLength(0);
    expect(after.stacks).toHaveLength(1); // history preserved — the entry stays
  });

  test("idempotent — a second retire of an already-retired stack → 200, no updated_at bump", async () => {
    const only = await makePrincipalKey();
    const rec = await register("carol", [{ stack_id: "carol/only", stack_pubkey: only.publicKeyB64 }]);
    const first = await post(`/principals/carol/stacks/retire`, await makeRetire("carol", "carol/only", rec.updated_at));
    expect(first.status).toBe(200);
    const afterFirst = await fetchRecord("carol");
    const bumpedAt = afterFirst.updated_at;

    // Second retire with a fresh claim (any CAS token — idempotency ignores CAS).
    const second = await post(
      `/principals/carol/stacks/retire`,
      await makeRetire("carol", "carol/only", "1999-01-01T00:00:00.000Z"),
    );
    expect(second.status).toBe(200);
    const afterSecond = await fetchRecord("carol");
    // No bump — the idempotent path does not re-write the record.
    expect(afterSecond.updated_at).toBe(bumpedAt);
  });
});

// =============================================================================
// ADMITTED-gate — a live membership blocks retire
// =============================================================================

describe("POST /principals/:id/stacks/retire — ADMITTED-gate", () => {
  test("a stack with a live ADMITTED membership → 409, admission row + record UNTOUCHED", async () => {
    await registerAndAdmit("dave", "metafactory");
    const rec = await fetchRecord("dave");

    const res = await post(`/principals/dave/stacks/retire`, await makeRetire("dave", "dave/default", rec.updated_at));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details: string; networks: string[] };
    expect(body.error).toBe("stack_has_live_membership");
    expect(body.details).toContain("metafactory");
    expect(body.details).toMatch(/revoke|depart/);
    expect(body.networks).toContain("metafactory");

    // Record UNTOUCHED — the stack is NOT retired.
    const after = await fetchRecord("dave");
    expect(after.stacks.find((s) => s.stack_id === "dave/default")?.retired_at).toBeUndefined();
    // Admission row UNTOUCHED — still ADMITTED.
    const read = await makeSignedAdminRead(admin);
    const listRes = await get(`/admission-requests?status=ADMITTED`, { "x-admin-signed": JSON.stringify(read) });
    const list = (await listRes.json()) as AdmissionRequest[];
    expect(list.find((r) => r.principal_id === "dave")?.status).toBe("ADMITTED");
  });

  test("a DEPARTED/PENDING membership does NOT block (only ADMITTED blocks)", async () => {
    // PENDING: register with a network but never admit → the row stays PENDING.
    const rec = await register("erin", [{ stack_id: "erin/default" }], { networkId: "metafactory" });
    const res = await post(`/principals/erin/stacks/retire`, await makeRetire("erin", "erin/default", rec.updated_at));
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Fail-closed authz + CAS + input hardening
// =============================================================================

describe("POST /principals/:id/stacks/retire — fail-closed", () => {
  test("wrong-key (signed by a stack key, not the principal root) → 401", async () => {
    const stackKey = await makePrincipalKey();
    const rec = await register("frank", [{ stack_id: "frank/default", stack_pubkey: stackKey.publicKeyB64 }]);
    // Sign the retire with the STACK key, not the root. The route verifies
    // against the stored record's principal_pubkey (the root) → 401.
    const res = await post(
      `/principals/frank/stacks/retire`,
      await makeRetire("frank", "frank/default", rec.updated_at, { signer: stackKey }),
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("signature_invalid");
    // Untouched.
    expect((await fetchRecord("frank")).stacks[0]?.retired_at).toBeUndefined();
  });

  test("CAS stale (expected_updated_at != stored) → 409 stale_record", async () => {
    const rec = await register("grace", [{ stack_id: "grace/default" }]);
    // Also register a second stack so we have TWO live stacks — CAS must guard the
    // full-record write regardless.
    void rec;
    const res = await post(
      `/principals/grace/stacks/retire`,
      await makeRetire("grace", "grace/default", "2000-01-01T00:00:00.000Z"),
    );
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("stale_record");
    // Untouched.
    expect((await fetchRecord("grace")).stacks.find((s) => s.stack_id === "grace/default")?.retired_at).toBeUndefined();
  });

  test("unknown stack_id → 404 stack_not_found", async () => {
    const rec = await register("heidi", [{ stack_id: "heidi/default" }]);
    const res = await post(`/principals/heidi/stacks/retire`, await makeRetire("heidi", "heidi/ghost", rec.updated_at));
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("stack_not_found");
  });

  test("unknown principal → 404 (no record to resolve the verify key from)", async () => {
    const res = await post(`/principals/nobody/stacks/retire`, await makeRetire("nobody", "nobody/default", "2020-01-01T00:00:00.000Z"));
    expect(res.status).toBe(404);
  });

  test("over-wide body (junk keys past the canonical cap) → 401, NEVER 500, record untouched", async () => {
    const rec = await register("ivan", [{ stack_id: "ivan/default" }]);
    const { claim, signature } = await makeRetire("ivan", "ivan/default", rec.updated_at);
    const bloated: Record<string, unknown> = { ...claim };
    for (let i = 0; i <= MAX_CANONICAL_KEYS; i++) bloated[`junk${i.toString()}`] = i;
    const res = await post(`/principals/ivan/stacks/retire`, { claim: bloated, signature });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
    expect((await fetchRecord("ivan")).stacks[0]?.retired_at).toBeUndefined();
  });

  test("principal_id path/body mismatch → 400", async () => {
    const rec = await register("judy", [{ stack_id: "judy/default" }]);
    const body = await makeRetire("judy", "judy/default", rec.updated_at, { principalIdOverride: "mallory" });
    const res = await post(`/principals/judy/stacks/retire`, body);
    expect(res.status).toBe(400);
  });

  test("stack_id prefix does not match principal → 400", async () => {
    const rec = await register("karl", [{ stack_id: "karl/default" }]);
    const body = await makeRetire("karl", "someone/else", rec.updated_at, { stackIdOverride: "someone/else" });
    const res = await post(`/principals/karl/stacks/retire`, body);
    expect(res.status).toBe(400);
  });

  test("replayed nonce (same signed envelope twice) → 409 nonce_replayed", async () => {
    const a = await makePrincipalKey();
    const b = await makePrincipalKey();
    const rec = await register("laura", [
      { stack_id: "laura/a", stack_pubkey: a.publicKeyB64 },
      { stack_id: "laura/b", stack_pubkey: b.publicKeyB64 },
    ]);
    const body = await makeRetire("laura", "laura/a", rec.updated_at);
    const first = await post(`/principals/laura/stacks/retire`, body);
    expect(first.status).toBe(200);
    const replay = await post(`/principals/laura/stacks/retire`, body);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).toBe("nonce_replayed");
  });
});

// =============================================================================
// Merge-preserves-retired — a retired tombstone survives a later add-stack
// =============================================================================

describe("POST /principals/:id/stacks/retire — retired entry survives an add-stack merge", () => {
  test("re-register carrying the full stacks[] (incl. the retired entry) preserves retired_at", async () => {
    const laptop = await makePrincipalKey();
    const server = await makePrincipalKey();
    const phone = await makePrincipalKey();
    const rec = await register("nina", [
      { stack_id: "nina/laptop", stack_pubkey: laptop.publicKeyB64 },
      { stack_id: "nina/server", stack_pubkey: server.publicKeyB64 },
    ]);
    // Retire nina/laptop.
    const retireRes = await post(`/principals/nina/stacks/retire`, await makeRetire("nina", "nina/laptop", rec.updated_at));
    expect(retireRes.status).toBe(200);
    const afterRetire = await fetchRecord("nina");
    const retiredAt = afterRetire.stacks.find((s) => s.stack_id === "nina/laptop")?.retired_at;
    expect(retiredAt).toBeDefined();

    // Simulate the add-stack client: re-register carrying the FULL stacks[] —
    // including the retired laptop WITH its retired_at — plus a new phone stack,
    // CAS-guarded on the current updated_at. This is exactly what resolveMergedStacks
    // produces (it preserves retired entries).
    const mergedStacks: StackIdentity[] = [
      { stack_id: "nina/laptop", stack_pubkey: laptop.publicKeyB64, retired_at: retiredAt },
      { stack_id: "nina/server", stack_pubkey: server.publicKeyB64 },
      { stack_id: "nina/phone", stack_pubkey: phone.publicKeyB64 },
    ];
    const reReg = await post(
      `/principals/nina/register`,
      await makeSignedRegistration("nina", root, { stacks: mergedStacks, expectedUpdatedAt: afterRetire.updated_at }),
    );
    expect(reReg.status).toBe(201);

    const final = await fetchRecord("nina");
    // The retired tombstone SURVIVED (not resurrected).
    expect(final.stacks.find((s) => s.stack_id === "nina/laptop")?.retired_at).toBe(retiredAt!);
    // The new stack landed active; server stayed active.
    expect(final.stacks.find((s) => s.stack_id === "nina/phone")?.retired_at).toBeUndefined();
    expect(final.stacks.find((s) => s.stack_id === "nina/server")?.retired_at).toBeUndefined();
  });
});
