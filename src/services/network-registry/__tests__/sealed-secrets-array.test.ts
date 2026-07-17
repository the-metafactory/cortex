/**
 * cortex#1996 D2 (RFC-0006 §8.1/§8.3) — per-key `sealed_secrets[]` delivery.
 *
 * TRUST-PATH coverage for the array delivery channel that closes the #1748
 * transport half (a covered 2nd stack obtaining its own sealed transport):
 *
 *   Store layer (parse + upsert + cap + hygiene):
 *     - parseSealedSecretsColumn fails SAFE on malformed JSON / non-array / bad
 *       entries, dedupes by target key, caps at MAX, and returns undefined on empty
 *     - upsertSealedSecretEntry replaces-in-place and refuses to grow past MAX
 *     - setSealedSecretEntry only writes an ADMITTED row; revoke/depart clear it
 *
 *   Route layer (`POST /admission-requests/:id/sealed-secret`) — the emit side:
 *     - flag OFF (default): a covered-stack target (peer_pubkey ≠ row.peer_pubkey)
 *       is refused 409 identity_mismatch — M17 behaviour byte-identical to today
 *     - flag ON: a covered-stack target is accepted → 200 + a per-key array entry
 *     - flag ON: peer_pubkey == row.peer_pubkey stays the SINGLE-slot write
 *     - flag ON: a peer_pubkey that is neither the row's key nor a covered live
 *       stack → 409 identity_mismatch (fail-closed)
 *     - a covered-stack (wide) write is NEVER counted as a narrow M13 claim
 *     - covered-stack rotate replaces the entry in place (array stays length 1)
 *     - revoke clears the whole array
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
import {
  InMemoryIssuanceRequestStore,
  parseSealedSecretsColumn,
  upsertSealedSecretEntry,
  MAX_SEALED_SECRETS_ENTRIES,
} from "../src/store";
import { narrowAdmissionClaimCount } from "../src/admission-window";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

const SEALED_1 = btoa("sealed-covered-stack-ciphertext-1");
const SEALED_2 = btoa("sealed-covered-stack-ciphertext-2");
const SEALED_ROW = btoa("sealed-row-peer-ciphertext");

// =============================================================================
// Store-layer unit tests (no HTTP)
// =============================================================================

describe("parseSealedSecretsColumn — fail-safe parse", () => {
  test("absent / empty → undefined", () => {
    expect(parseSealedSecretsColumn(null)).toBeUndefined();
    expect(parseSealedSecretsColumn(undefined)).toBeUndefined();
    expect(parseSealedSecretsColumn("")).toBeUndefined();
  });

  test("malformed JSON → undefined (never throws)", () => {
    expect(parseSealedSecretsColumn("{not json")).toBeUndefined();
  });

  test("non-array JSON → undefined", () => {
    expect(parseSealedSecretsColumn(JSON.stringify({ target_stack_pubkey: "k", sealed_secret: SEALED_1 }))).toBeUndefined();
  });

  test("drops malformed entries; keeps well-formed", () => {
    const raw = JSON.stringify([
      { target_stack_pubkey: "k1", sealed_secret: SEALED_1 },
      { target_stack_pubkey: "", sealed_secret: SEALED_2 }, // empty key → dropped
      { target_stack_pubkey: "k2", sealed_secret: "" }, // empty blob → dropped
      { target_stack_pubkey: "k3" }, // missing blob → dropped
      "not-an-object",
      null,
    ]);
    expect(parseSealedSecretsColumn(raw)).toEqual([{ target_stack_pubkey: "k1", sealed_secret: SEALED_1 }]);
  });

  test("dedupes duplicate target keys (keeps first)", () => {
    const raw = JSON.stringify([
      { target_stack_pubkey: "k1", sealed_secret: SEALED_1 },
      { target_stack_pubkey: "k1", sealed_secret: SEALED_2 },
    ]);
    expect(parseSealedSecretsColumn(raw)).toEqual([{ target_stack_pubkey: "k1", sealed_secret: SEALED_1 }]);
  });

  test("caps at MAX_SEALED_SECRETS_ENTRIES", () => {
    const entries = Array.from({ length: MAX_SEALED_SECRETS_ENTRIES + 10 }, (_v, i) => ({
      target_stack_pubkey: `k${String(i)}`,
      sealed_secret: SEALED_1,
    }));
    const parsed = parseSealedSecretsColumn(JSON.stringify(entries));
    expect(parsed?.length).toBe(MAX_SEALED_SECRETS_ENTRIES);
  });

  test("all-malformed array → undefined (never an empty array on the wire)", () => {
    expect(parseSealedSecretsColumn(JSON.stringify([{ bad: 1 }, null]))).toBeUndefined();
  });
});

describe("upsertSealedSecretEntry — replace-in-place + cap", () => {
  test("appends a new key", () => {
    const out = upsertSealedSecretEntry(undefined, "k1", SEALED_1);
    expect(out).toEqual([{ target_stack_pubkey: "k1", sealed_secret: SEALED_1 }]);
  });

  test("replaces an existing key in place (no duplicate)", () => {
    const first = upsertSealedSecretEntry(undefined, "k1", SEALED_1);
    const second = upsertSealedSecretEntry(first, "k1", SEALED_2);
    expect(second).toEqual([{ target_stack_pubkey: "k1", sealed_secret: SEALED_2 }]);
  });

  test("refuses to grow a full array past the cap (new key)", () => {
    const full = Array.from({ length: MAX_SEALED_SECRETS_ENTRIES }, (_v, i) => ({
      target_stack_pubkey: `k${String(i)}`,
      sealed_secret: SEALED_1,
    }));
    expect(upsertSealedSecretEntry(full, "new-key", SEALED_2)).toBeUndefined();
  });

  test("a REPLACE of an existing key is allowed even at the cap", () => {
    const full = Array.from({ length: MAX_SEALED_SECRETS_ENTRIES }, (_v, i) => ({
      target_stack_pubkey: `k${String(i)}`,
      sealed_secret: SEALED_1,
    }));
    const out = upsertSealedSecretEntry(full, "k0", SEALED_2);
    expect(out?.length).toBe(MAX_SEALED_SECRETS_ENTRIES);
    expect(out?.find((e) => e.target_stack_pubkey === "k0")?.sealed_secret).toBe(SEALED_2);
  });
});

describe("InMemoryIssuanceRequestStore.setSealedSecretEntry", () => {
  test("only an ADMITTED row accepts an entry; revoke clears the array", async () => {
    const store = new InMemoryIssuanceRequestStore();
    const pending = await store.upsertPending("alice", "row-key", "federated.alice.>", "metafactory");
    // PENDING → no-op.
    expect(await store.setSealedSecretEntry(pending.request_id, "covered-key", SEALED_1)).toBeUndefined();
    await store.transitionIssuanceRequest(pending.request_id, "ADMITTED", "admin");
    const withEntry = await store.setSealedSecretEntry(pending.request_id, "covered-key", SEALED_1);
    expect(withEntry?.sealed_secrets).toEqual([{ target_stack_pubkey: "covered-key", sealed_secret: SEALED_1 }]);
    // Revoke clears both the single slot and the array.
    const revoked = await store.revokeAdmission(pending.request_id);
    expect(revoked?.sealed_secret).toBeNull();
    expect(revoked?.sealed_secrets).toBeUndefined();
  });
});

// =============================================================================
// Route-layer tests — the emit side
// =============================================================================

let env: Env;
let envArrayOn: Env;
let admin: PrincipalKey;
let hubAdmin: PrincipalKey;
let principal: PrincipalKey; // the row's peer key (stack 1)
let coveredStack: PrincipalKey; // a covered 2nd stack of the SAME principal
let strangerKey: PrincipalKey; // an unrelated key (not a stack of the principal)

async function post(path: string, body: unknown, e: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
  );
}

async function get(path: string, e: Env, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/** Register alice with TWO stacks (row peer = stack1; coveredStack = stack2), return the row. */
async function registerTwoStackPending(): Promise<AdmissionRequest> {
  const body = await makeSignedRegistration("alice", principal, {
    stacks: [
      { stack_id: "alice/main", stack_pubkey: principal.publicKeyB64 },
      { stack_id: "alice/second", stack_pubkey: coveredStack.publicKeyB64 },
    ],
    networkId: "metafactory",
  });
  const res = await post(`/principals/alice/register`, body, env);
  expect(res.status).toBe(201);
  const signedRead = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=PENDING`, env, { "x-admin-signed": JSON.stringify(signedRead) });
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === "alice");
  expect(found).toBeDefined();
  // The admission row keys on the FIRST stack's pubkey (#1748).
  expect(found!.peer_pubkey).toBe(principal.publicKeyB64);
  return found!;
}

async function admit(requestId: string, e: Env): Promise<void> {
  const res = await post(`/admission-requests/${requestId}/admit`, await makeSignedAdminDecision(requestId, "admit", admin), e);
  expect(res.status).toBe(200);
}

/** Build a sealed-secret write claim, optionally binding peer_pubkey (wide). */
async function makeSealedWrite(
  requestId: string,
  opts: { sealed?: string; peerPubkey?: string } = {},
): Promise<{ claim: Record<string, unknown>; signature: string }> {
  const claim: Record<string, unknown> = {
    request_id: requestId,
    sealed_secret: opts.sealed ?? SEALED_1,
    ...(opts.peerPubkey !== undefined && { peer_pubkey: opts.peerPubkey }),
    hub_admin_pubkey: hubAdmin.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(hubAdmin.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

/** Member PoP-read of alice's rows for the network. */
async function readMine(e: Env): Promise<AdmissionRequest | undefined> {
  const claim = { principal_id: "alice", peer_pubkey: principal.publicKeyB64, issued_at: new Date().toISOString() };
  const signature = await signEd25519(principal.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  const res = await get(`/admission-requests/mine`, e, { "x-pop-signed": JSON.stringify({ claim, signature }) });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as AdmissionRequest[];
  return rows.find((r) => r.network_id === "metafactory");
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  hubAdmin = await makePrincipalKey();
  principal = await makePrincipalKey();
  coveredStack = await makePrincipalKey();
  strangerKey = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    REGISTRY_HUB_ADMIN_PUBKEYS: hubAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
  envArrayOn = { ...env, SEALED_SECRETS_ARRAY_EMIT: "true" };
});

describe("sealed-secret array emit — flag OFF (default, byte-identical to M17)", () => {
  test("covered-stack target (peer_pubkey ≠ row key) → 409 identity_mismatch", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, env);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64 }),
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
    // No array written.
    expect((await readMine(env))?.sealed_secrets).toBeUndefined();
  });

  test("row-key target still writes the SINGLE slot (M17 pass)", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, env);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: principal.publicKeyB64, sealed: SEALED_ROW }),
      env,
    );
    expect(res.status).toBe(200);
    const mine = await readMine(env);
    expect(mine?.sealed_secret).toBe(SEALED_ROW);
    expect(mine?.sealed_secrets).toBeUndefined();
  });
});

describe("sealed-secret array emit — flag ON", () => {
  test("covered-stack target → 200 + per-key array entry addressed to that key", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64, sealed: SEALED_2 }),
      envArrayOn,
    );
    expect(res.status).toBe(200);
    const mine = await readMine(envArrayOn);
    // Single slot untouched; the array carries exactly the covered-stack entry.
    expect(mine?.sealed_secret).toBeNull();
    expect(mine?.sealed_secrets).toEqual([{ target_stack_pubkey: coveredStack.publicKeyB64, sealed_secret: SEALED_2 }]);
  });

  test("row-key target stays the SINGLE-slot write even with the flag on", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: principal.publicKeyB64, sealed: SEALED_ROW }),
      envArrayOn,
    );
    expect(res.status).toBe(200);
    const mine = await readMine(envArrayOn);
    expect(mine?.sealed_secret).toBe(SEALED_ROW);
    expect(mine?.sealed_secrets).toBeUndefined();
  });

  test("a key that is neither the row's nor a covered live stack → 409 identity_mismatch", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: strangerKey.publicKeyB64 }),
      envArrayOn,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
    expect((await readMine(envArrayOn))?.sealed_secrets).toBeUndefined();
  });

  test("covered-stack write is NOT counted as a narrow M13 claim (it is wide)", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    const before = narrowAdmissionClaimCount();
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64 }),
      envArrayOn,
    );
    expect(res.status).toBe(200);
    expect(narrowAdmissionClaimCount()).toBe(before);
  });

  test("covered-stack rotate replaces the entry in place (array stays length 1)", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64, sealed: SEALED_1 }),
      envArrayOn,
    );
    const res = await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64, sealed: SEALED_2 }),
      envArrayOn,
    );
    expect(res.status).toBe(200);
    const mine = await readMine(envArrayOn);
    expect(mine?.sealed_secrets).toEqual([{ target_stack_pubkey: coveredStack.publicKeyB64, sealed_secret: SEALED_2 }]);
  });

  test("covered-stack AND row-key seals coexist (multi-stack transport)", async () => {
    const req = await registerTwoStackPending();
    await admit(req.request_id, envArrayOn);
    await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: principal.publicKeyB64, sealed: SEALED_ROW }),
      envArrayOn,
    );
    await post(
      `/admission-requests/${req.request_id}/sealed-secret`,
      await makeSealedWrite(req.request_id, { peerPubkey: coveredStack.publicKeyB64, sealed: SEALED_2 }),
      envArrayOn,
    );
    const mine = await readMine(envArrayOn);
    expect(mine?.sealed_secret).toBe(SEALED_ROW);
    expect(mine?.sealed_secrets).toEqual([{ target_stack_pubkey: coveredStack.publicKeyB64, sealed_secret: SEALED_2 }]);
  });
});
