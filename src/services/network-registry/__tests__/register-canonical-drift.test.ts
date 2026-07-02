/**
 * #832 — root-seed add-stack register returned `401 signature_invalid`: a
 * canonicalization drift between what the client SIGNED and what the registry
 * VERIFIED, on the merge (add-stack) path.
 *
 * ROOT CAUSE (design fragility): the register route verified the Ed25519
 * signature over the server's whitelist *reconstruction* of the claim
 * (`validateRegistrationClaim` rebuilds the claim from a fixed set of known
 * fields), NOT over the claim as received on the wire. So ANY validly-signed
 * field the reconstruction did not echo silently changed the canonical bytes
 * and 401'd a legitimate register. That is exactly what the v5.4.0 batch
 * (#825) tripped: the client began signing `expected_updated_at` (the CAS
 * token) into the CAS-bearing add-stack claim, and a registry whose
 * reconstruction dropped that field rejected every such register.
 *
 * FIX (#832): verify over the claim AS RECEIVED (`canonicalJSON(signed.claim)`)
 * — one canonical contract, "the principal signs canonicalJSON(claim); the
 * registry verifies the same bytes." Structural validation still runs (400 on
 * malformed) and STORAGE still uses the whitelisted reconstruction, so an
 * unknown/forward field is signed-but-ignored, never persisted.
 *
 * These tests drive the full Hono pipeline via `app.fetch`, so signature
 * verification + store path run exactly as in production.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import { canonicalJSON, signEd25519 } from "../src/signing";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import type { SignedAssertion, PrincipalRecord } from "../src/types";

let env: Env;
let rootKey: PrincipalKey;

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  } as Env;
  rootKey = await makePrincipalKey();
});

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

/** Establish the principal's first stack (root pubkey on record). */
async function registerFirstStack(): Promise<string> {
  const body = await makeSignedRegistration("jc", rootKey, {
    stacks: [{ stack_id: "jc/default", stack_pubkey: rootKey.publicKeyB64 }],
  });
  const res = await post("/principals/jc/register", body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
  return json.payload.updated_at;
}

describe("#832 — verify over the claim as received (not the reconstruction)", () => {
  test("REGRESSION: a CAS-bearing (expected_updated_at) root-signed add-stack register verifies (201)", async () => {
    // This is the concrete #825→#832 field. The client's fetch-merge captures
    // the record's updated_at and signs it into the claim as the CAS token; the
    // registry MUST verify the same bytes it received. A reconstruction that
    // dropped the field would 401 here — the exact production symptom.
    const updatedAt = await registerFirstStack();

    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("jc", rootKey, {
      expectedUpdatedAt: updatedAt,
      stacks: [
        { stack_id: "jc/default", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "jc/clawbox", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    const res = await post("/principals/jc/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    expect(json.payload.stacks.map((s) => s.stack_id).sort()).toEqual([
      "jc/clawbox",
      "jc/default",
    ]);
  });

  test("a validly-signed claim carrying a forward-compatible optional field still verifies (201)", async () => {
    // The invariant that closes the regression CLASS: a field the server does
    // not (yet) model must not break signature verification. Before the fix the
    // route verified over the reconstruction, which silently dropped this field
    // → canonical mismatch → 401. After the fix the route verifies the received
    // bytes → 201 — and the field is signed-but-ignored (never persisted).
    await registerFirstStack();

    const communityKey = await makePrincipalKey();
    // Build the claim by hand so we can sign OVER an unknown field.
    const claim = {
      principal_id: "jc",
      principal_pubkey: rootKey.publicKeyB64,
      stacks: [
        { stack_id: "jc/default", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "jc/clawbox", stack_pubkey: communityKey.publicKeyB64 },
      ],
      capabilities: [],
      // A future optional the current server does not model — signed all the same.
      client_protocol_version: "6.1.0",
      issued_at: new Date().toISOString(),
      nonce: randomNonce(),
    };
    const signature = await signEd25519(
      rootKey.privateKeyB64,
      new TextEncoder().encode(canonicalJSON(claim)),
    );
    const res = await post("/principals/jc/register", { claim, signature });
    expect(res.status).toBe(201);

    // The forward field was NOT persisted — storage uses the whitelist.
    const getRes = await app.fetch(new Request("http://localhost/principals/jc"), env);
    const json = (await getRes.json()) as SignedAssertion<PrincipalRecord & Record<string, unknown>>;
    expect("client_protocol_version" in json.payload).toBe(false);
  });

  test("SECURITY: tampering with a stack_pubkey after signing still fails closed (401)", async () => {
    // Verify-over-wire must not weaken tamper resistance: mutating any field
    // after the root signs changes the very bytes verified, so the signature
    // (over the original) still fails.
    await registerFirstStack();

    const communityKey = await makePrincipalKey();
    const attackerKey = await makePrincipalKey();
    const body = await makeSignedRegistration("jc", rootKey, {
      stacks: [
        { stack_id: "jc/default", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "jc/clawbox", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    body.claim.stacks[1]!.stack_pubkey = attackerKey.publicKeyB64; // tamper post-sign
    const res = await post("/principals/jc/register", body);
    expect(res.status).toBe(401);
  });

  test("SECURITY: a pathologically deep claim is rejected 401 (canonical depth guard, not a 500)", async () => {
    // Verify runs BEFORE the signature is proven, so canonicalJSON now runs over
    // unauthenticated input. A deeply-nested body must fail closed (401), never
    // exhaust the stack or surface a 500.
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i++) deep = [deep];
    const claim = {
      principal_id: "jc",
      principal_pubkey: rootKey.publicKeyB64,
      stacks: [],
      capabilities: [],
      evil: deep,
      issued_at: new Date().toISOString(),
      nonce: randomNonce(),
    };
    // Signature is irrelevant — the depth guard trips before it can match.
    const res = await post("/principals/jc/register", { claim, signature: "AA==" });
    expect(res.status).toBe(401);
  });
});
