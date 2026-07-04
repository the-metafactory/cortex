/**
 * cortex#1517 (S3, epic #1514) — `signAdminRequest` byte-identical + round-trip
 * tests.
 *
 * Two guarantees this pins:
 *   1. BYTE-IDENTICAL: a fixed seed + claim always produces the EXACT same
 *      `{ claim, signature }` wire bytes — a regression in canonicalJSON key
 *      order, encoding, or the `{claim,signature}` property order would flip
 *      this pinned expectation. Ed25519 signing is deterministic, so this is
 *      a stable pin, not a flaky one.
 *   2. PRODUCER↔CONSUMER: the wire strings `signAdminRequest` produces verify
 *      against the REAL registry pipeline — `validateSignedAdmissionRead` /
 *      `validateAdmissionDecisionClaim` (validate.ts) + the registry's own
 *      `verifyEd25519` (routes/admission-requests.ts) — for BOTH shapes it
 *      feeds: the `x-admin-signed` HEADER (read claims, no nonce) and the
 *      POST BODY (write claims, with nonce). No verifier is re-implemented
 *      here; the test drives the real registry Worker app.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createUser } from "nkeys.js";

import { signAdminRequest, canonicalJSON, verifyEd25519 } from "../signing";
import { materialFromSeedString, randomNonce } from "../../../bus/stack-provisioning";

import registryApp from "../../../services/network-registry/src/index";
import type { Env } from "../../../services/network-registry/src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  resetStores,
  type PrincipalKey,
} from "../../../services/network-registry/__tests__/helpers";
import { _resetRateLimitBucketsForTest } from "../../../services/network-registry/src/rate-limit";
import type { AdmissionRequest } from "../../../services/network-registry/src/types";

// =============================================================================
// 1. Byte-identical pinned regression (no registry involved).
// =============================================================================

describe("signAdminRequest — byte-identical wire output", () => {
  // A fixed, throwaway NKey seed — generated once for this test, not tied to
  // any real principal/stack. Ed25519 signing is deterministic for a fixed
  // seed+message, so the expected values below are stable across runs.
  const SEED = "SUAMQMLLA3EQSHCIDTOI2TUIUOF55GWLQMYYCLKYWEVVA7KCXDXMWFQDWE";
  const EXPECTED_PUBKEY = "ZwMZ+myA1ULKR4Z80gGkcPNduFT4dYGosPWtrQ/EOqg=";
  const EXPECTED_SIGNATURE =
    "IQTqqP2W7hpYRmHCPXbEjozYIFbHbZ98IANfKKUz28t9Jmg2FoQLp2jqdXQXUma6rZ0DhTpGXduLFmSluER1Dw==";
  const EXPECTED_JSON =
    '{"claim":{"admin_pubkey":"ZwMZ+myA1ULKR4Z80gGkcPNduFT4dYGosPWtrQ/EOqg=","issued_at":"2026-01-01T00:00:00.000Z"},"signature":"IQTqqP2W7hpYRmHCPXbEjozYIFbHbZ98IANfKKUz28t9Jmg2FoQLp2jqdXQXUma6rZ0DhTpGXduLFmSluER1Dw=="}';

  test("fixed seed + claim → exact pinned signature and wire string", async () => {
    const material = materialFromSeedString(SEED);
    expect(material.pubkeyB64).toBe(EXPECTED_PUBKEY);

    const claim = { admin_pubkey: material.pubkeyB64, issued_at: "2026-01-01T00:00:00.000Z" };
    const signed = await signAdminRequest(material.seed, claim);

    // Key order matters here — this is a plain JSON.stringify, not
    // canonicalJSON — so `{claim, signature}` must stay in that order for
    // every hand-rolled copy this replaces to have produced identical bytes.
    expect(signed.signature).toBe(EXPECTED_SIGNATURE);
    expect(JSON.stringify(signed)).toBe(EXPECTED_JSON);
  });

  test("the pinned wire string verifies against the client-side verifier", async () => {
    const parsed = JSON.parse(EXPECTED_JSON) as { claim: Record<string, unknown>; signature: string };
    const message = new TextEncoder().encode(canonicalJSON(parsed.claim));
    const ok = await verifyEd25519(EXPECTED_PUBKEY, parsed.signature, message);
    expect(ok).toBe(true);
  });

  test("re-signing the SAME seed+claim is deterministic", async () => {
    const material = materialFromSeedString(SEED);
    const claim = { admin_pubkey: material.pubkeyB64, issued_at: "2026-01-01T00:00:00.000Z" };
    const a = await signAdminRequest(material.seed, claim);
    const b = await signAdminRequest(material.seed, claim);
    expect(a.signature).toBe(b.signature);
  });
});

// =============================================================================
// 2. Round-trip through the REAL registry pipeline — validate.ts's structural
//    parse + the route's verifyEd25519 — for both wire shapes signAdminRequest
//    feeds. Proves producer (this helper) and consumer (the registry) agree
//    byte-for-byte.
// =============================================================================

describe("signAdminRequest — round-trips through the live registry (validate.ts + verify)", () => {
  let env: Env;
  let adminMaterial: ReturnType<typeof materialFromSeedString>;
  let principal: PrincipalKey;

  beforeEach(async () => {
    resetStores();
    _resetRateLimitBucketsForTest();
    const reg = await makeRegistryKey();
    const kp = createUser();
    adminMaterial = materialFromSeedString(new TextDecoder().decode(kp.getSeed()));
    principal = await makePrincipalKey();
    env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      REGISTRY_ADMIN_PUBKEYS: adminMaterial.pubkeyB64,
      ENVIRONMENT: "test",
    };
  });

  test("READ claim (x-admin-signed header) — the exact CLI wire value is accepted", async () => {
    // The SAME claim shape + call every read call site (network.ts,
    // network-secret-adapters.ts, network-authorize-adapters.ts) builds.
    const claim = { admin_pubkey: adminMaterial.pubkeyB64, issued_at: new Date().toISOString() };
    const signed = await signAdminRequest(adminMaterial.seed, claim);

    const res = await registryApp.fetch(
      new Request("http://localhost/admission-requests?status=ADMITTED", {
        headers: { "x-admin-signed": JSON.stringify(signed) },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("WRITE claim (POST body) — an admit decision built the same way the CLI builds it is accepted", async () => {
    // Register a principal to get a PENDING admission request to decide on.
    const regBody = await makeSignedRegistration("carol", principal, {
      stacks: [{ stack_id: "carol/main", stack_pubkey: principal.publicKeyB64 }],
    });
    const regRes = await registryApp.fetch(
      new Request("http://localhost/principals/carol/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regBody),
      }),
      env,
    );
    expect(regRes.status).toBe(201);

    // Admin-signed read to find the request_id (same read-claim shape above).
    const readClaim = { admin_pubkey: adminMaterial.pubkeyB64, issued_at: new Date().toISOString() };
    const signedRead = await signAdminRequest(adminMaterial.seed, readClaim);
    const listRes = await registryApp.fetch(
      new Request("http://localhost/admission-requests?status=PENDING", {
        headers: { "x-admin-signed": JSON.stringify(signedRead) },
      }),
      env,
    );
    const list = (await listRes.json()) as AdmissionRequest[];
    const found = list.find((r) => r.principal_id === "carol");
    expect(found).toBeDefined();

    // The admit-decision claim — the exact shape `buildAdmissionDecisionBody`
    // (network.ts) builds and POSTs as the body, now routed through
    // signAdminRequest (S3).
    const decisionClaim = {
      request_id: found!.request_id,
      decision: "admit" as const,
      admin_pubkey: adminMaterial.pubkeyB64,
      issued_at: new Date().toISOString(),
      nonce: randomNonce(),
    };
    const signedDecision = await signAdminRequest(adminMaterial.seed, decisionClaim);

    const admitRes = await registryApp.fetch(
      new Request(`http://localhost/admission-requests/${found!.request_id}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedDecision),
      }),
      env,
    );
    expect(admitRes.status).toBe(200);
    const updated = (await admitRes.json()) as AdmissionRequest;
    expect(updated.status).toBe("ADMITTED");
  });
});
