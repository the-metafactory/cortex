/**
 * C-787 — Per-stack pubkeys: let a principal federate multiple stacks.
 *
 * These tests ARE the acceptance criteria. The trust-path crux is the
 * **add-stack authorization model**: adding a second stack under an
 * already-registered principal MUST be authorized by a claim signed with the
 * principal's ROOT (`principal_pubkey`) key. A claim signed by any other key —
 * the new stack's own key, or a random attacker key — MUST be rejected. That
 * rejection is the impersonation defense: without it, anyone could append a
 * stack (and its pubkey) under someone else's principal and then sign federated
 * envelopes that verify.
 *
 * Drives the Worker via `app.fetch(request, env)` so the full Hono pipeline +
 * signature verification + store path run exactly as in production.
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
  type PrincipalKey,
} from "./helpers";
import { getStore } from "../src/store";
import type { SignedAssertion, PrincipalRecord, StackIdentity } from "../src/types";

let env: Env;
let rootKey: PrincipalKey; // the principal's root / authority key (first stack's key)

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  };
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

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), env);
}

/** Register the principal's FIRST stack (establishes the root pubkey). */
async function registerFirstStack(
  stackPubkey: string,
): Promise<SignedAssertion<PrincipalRecord>> {
  const body = await makeSignedRegistration("andreas", rootKey, {
    stacks: [{ stack_id: "andreas/meta-factory", stack_pubkey: stackPubkey }],
  });
  const res = await post("/principals/andreas/register", body);
  expect(res.status).toBe(201);
  return (await res.json()) as SignedAssertion<PrincipalRecord>;
}

describe("C-787 — first registration establishes root + first stack pubkey", () => {
  test("first stack's stack_pubkey is stored alongside the root principal_pubkey", async () => {
    const json = await registerFirstStack(rootKey.publicKeyB64);
    expect(json.payload.principal_pubkey).toBe(rootKey.publicKeyB64);
    expect(json.payload.stacks).toHaveLength(1);
    expect(json.payload.stacks[0]!.stack_id).toBe("andreas/meta-factory");
    expect(json.payload.stacks[0]!.stack_pubkey).toBe(rootKey.publicKeyB64);
  });

  test("a first stack MAY carry a distinct stack_pubkey from the root", async () => {
    // The root key authorizes; the first stack can sign with its own key.
    const firstStackKey = await makePrincipalKey();
    const json = await registerFirstStack(firstStackKey.publicKeyB64);
    expect(json.payload.principal_pubkey).toBe(rootKey.publicKeyB64);
    expect(json.payload.stacks[0]!.stack_pubkey).toBe(firstStackKey.publicKeyB64);
  });
});

describe("C-787 — add-stack (principal already exists)", () => {
  test("add-stack with a valid ROOT signature adds the new stack with its own pubkey", async () => {
    await registerFirstStack(rootKey.publicKeyB64);

    // The community stack has its own signing key. The add-stack claim is
    // signed by the ROOT key and attests both stacks (existing + new).
    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "andreas/community", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    expect(json.payload.stacks).toHaveLength(2);
    const community = json.payload.stacks.find(
      (s) => s.stack_id === "andreas/community",
    );
    expect(community?.stack_pubkey).toBe(communityKey.publicKeyB64);
    // Root pubkey is unchanged — adding a stack is NOT a rotation.
    expect(json.payload.principal_pubkey).toBe(rootKey.publicKeyB64);
  });

  test("IMPERSONATION — add-stack signed by the NEW stack's own key is rejected", async () => {
    await registerFirstStack(rootKey.publicKeyB64);

    // Attacker controls only the community stack key. They try to append a
    // stack under `andreas` by signing the claim with the community key, while
    // (a) declaring the community key as principal_pubkey → caught by the
    // rotation gate (409), proving a non-root key cannot self-authorize.
    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", communityKey, {
      stacks: [
        { stack_id: "andreas/community", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    const res = await post("/principals/andreas/register", body);
    // The claim declares principal_pubkey = communityKey ≠ registered root,
    // so the rotation gate rejects it. A non-root key CANNOT add a stack.
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("pubkey_rotation_not_supported");

    // And the community stack was NOT added.
    const store = getStore(env);
    const rec = await store.getPrincipal("andreas");
    expect(rec?.stacks.map((s) => s.stack_id)).not.toContain("andreas/community");
  });

  test("IMPERSONATION — add-stack claiming the ROOT pubkey but signed by an attacker key is rejected (401)", async () => {
    await registerFirstStack(rootKey.publicKeyB64);

    // The subtler attack: the attacker declares the correct root pubkey
    // (so the rotation gate passes) but does NOT possess the root private key,
    // so they sign with their own key. Signature verification against the
    // declared root pubkey MUST fail.
    const attackerKey = await makePrincipalKey();
    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", rootKey, {
      pubkeyOverride: rootKey.publicKeyB64, // claim the real root pubkey
      signWith: attackerKey, // ...but sign with a key we don't control as root
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "andreas/community", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("signature_invalid");

    // The community stack was NOT added.
    const store = getStore(env);
    const rec = await store.getPrincipal("andreas");
    expect(rec?.stacks.map((s) => s.stack_id)).not.toContain("andreas/community");
  });

  test("FORGED — tampering with stack_pubkey after the root signs is rejected (401)", async () => {
    await registerFirstStack(rootKey.publicKeyB64);

    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "andreas/community", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    // Tamper: swap the community stack_pubkey to an attacker key AFTER signing.
    const attackerKey = await makePrincipalKey();
    body.claim.stacks[1]!.stack_pubkey = attackerKey.publicKeyB64;
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(401);
  });

  test("add-stack can UPDATE an existing stack's pubkey when root-authorized", async () => {
    // Root authority can re-key one of its own stacks (root re-signs).
    const firstStackKey = await makePrincipalKey();
    await registerFirstStack(firstStackKey.publicKeyB64);

    const newStackKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: newStackKey.publicKeyB64 },
      ],
    });
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    expect(json.payload.stacks[0]!.stack_pubkey).toBe(newStackKey.publicKeyB64);
  });
});

describe("C-787 — per-stack pubkey served + resolvable", () => {
  test("GET /principals/:id serves per-stack pubkeys", async () => {
    await registerFirstStack(rootKey.publicKeyB64);
    const communityKey = await makePrincipalKey();
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: rootKey.publicKeyB64 },
        { stack_id: "andreas/community", stack_pubkey: communityKey.publicKeyB64 },
      ],
    });
    await post("/principals/andreas/register", body);

    const res = await get("/principals/andreas");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    const byId = new Map(json.payload.stacks.map((s) => [s.stack_id, s.stack_pubkey]));
    expect(byId.get("andreas/meta-factory")).toBe(rootKey.publicKeyB64);
    expect(byId.get("andreas/community")).toBe(communityKey.publicKeyB64);
  });
});

describe("C-787 — validation of stack_pubkey shape", () => {
  test("rejects a stack whose stack_pubkey is malformed", async () => {
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: "too-short" } as StackIdentity,
      ],
    });
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("a stack MAY omit stack_pubkey (back-compat) and the registry backfills it from the root on first register", async () => {
    // A producer that has not yet adopted per-stack keys omits stack_pubkey;
    // the registry treats the root as that stack's pubkey so existing single-
    // stack federation keeps verifying.
    const body = await makeSignedRegistration("andreas", rootKey, {
      stacks: [{ stack_id: "andreas/meta-factory" }],
    });
    const res = await post("/principals/andreas/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    expect(json.payload.stacks[0]!.stack_pubkey).toBe(rootKey.publicKeyB64);
  });
});
