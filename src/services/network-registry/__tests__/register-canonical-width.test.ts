/**
 * #1418 — pre-auth canonicalJSON WIDTH/SIZE guard on the register route.
 *
 * The register route canonicalizes the claim AS RECEIVED (unauthenticated:
 * `canonicalJSON(signed.claim)` runs BEFORE the signature is proven). #832 added
 * a DEPTH cap; #1418 adds a WIDTH/size cap so a body with ~1e6 flat keys (or a
 * huge array) can't drive the pre-auth `Object.keys(...).sort()`.
 *
 * `validateRegistrationClaim` reads only whitelisted fields and IGNORES unknown
 * keys (#832: unknown/forward fields are signed-but-ignored, never persisted), so
 * an over-wide claim passes structural validation and reaches canonicalJSON —
 * where the width guard throws `CanonicalWidthError`, caught by the route and
 * failed closed as `signature_invalid` (401). The contract we assert: an
 * over-wide register is shed with 400/401, NEVER a 500.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import { MAX_CANONICAL_KEYS, MAX_CANONICAL_ARRAY_LEN } from "../src/signing";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  resetStores,
  type PrincipalKey,
} from "./helpers";

let env: Env;
let pKey: PrincipalKey;

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  } as Env;
  pKey = await makePrincipalKey();
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

describe("#1418 — register with an over-wide claim fails closed (never 500)", () => {
  test("claim with >MAX_CANONICAL_KEYS junk keys → 401, not 500", async () => {
    // Build a structurally valid, validly-signed claim, then bloat the RECEIVED
    // claim with junk keys past the per-object cap. (Validation ignores the extra
    // keys; canonicalJSON(signed.claim) then trips the width guard pre-verify.)
    const { claim, signature } = await makeSignedRegistration("jc", pKey, {
      stacks: [{ stack_id: "jc/default", stack_pubkey: pKey.publicKeyB64 }],
    });
    const bloated: Record<string, unknown> = { ...claim };
    for (let i = 0; i <= MAX_CANONICAL_KEYS; i++) bloated[`junk${i.toString()}`] = i;

    const res = await post("/principals/jc/register", { claim: bloated, signature });

    // Fail-closed: 401 (canonicalJSON threw → signature_invalid). NEVER 500.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("signature_invalid");
  });

  test("claim carrying an over-long array → 401, not 500", async () => {
    const { claim, signature } = await makeSignedRegistration("jc", pKey, {
      stacks: [{ stack_id: "jc/default", stack_pubkey: pKey.publicKeyB64 }],
    });
    // Attach a huge array field on the received claim (ignored by validation).
    const bloated: Record<string, unknown> = {
      ...claim,
      junk_array: Array.from({ length: MAX_CANONICAL_ARRAY_LEN + 1 }, (_, i) => i),
    };

    const res = await post("/principals/jc/register", { claim: bloated, signature });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
  });

  test("a normal-width claim still registers (201) — guard never fires for legit input", async () => {
    const body = await makeSignedRegistration("jc", pKey, {
      stacks: [{ stack_id: "jc/default", stack_pubkey: pKey.publicKeyB64 }],
    });
    const res = await post("/principals/jc/register", body);
    expect(res.status).toBe(201);
  });
});
