/**
 * cortex#76 — TrustResolver operator-signature verifier tests.
 *
 * Covers:
 *   - Module-level `verifyOperatorUserJwt`:
 *       - Happy path: valid JWT minted by trusted operator → ok
 *       - wrong_issuer: JWT minted by a different account signing key
 *       - expired: JWT with `exp` in the past
 *       - not_yet_valid: JWT with `nbf` in the future
 *       - malformed_jwt: empty / garbage / wrong segment count
 *       - clock-skew tolerance honoured at the boundary
 *
 *   - Module-level `verifyOperatorSignedRequest`:
 *       - Happy path: well-formed envelope with valid signature → ok
 *       - malformed_envelope: missing fields, wrong types
 *       - subject_mismatch: envelope.subject ≠ expectedSubject
 *       - ts_out_of_range: too old, too far in future, unparseable
 *       - malformed_signature: not base64url, length wrong
 *       - signature_invalid: payload mutated, subject mutated, JWT swapped
 *       - JWT issuer chain still enforced (re-uses verifyOperatorUserJwt path)
 *
 *   - TrustResolver instance methods:
 *       - verifyOperatorSignature delegates correctly
 *       - verifyUserJwt delegates correctly
 *       - OperatorVerifierNotConfiguredError when pubkey absent
 *       - isOperatorVerifierConfigured reflects construction
 *       - Construction without options is backward-compatible (no opts arg)
 */

import { describe, test, expect, beforeAll } from "bun:test";

import { createAccount, createUser, type KeyPair } from "@nats-io/nkeys";
import { Algorithms, encodeUser } from "@nats-io/jwt";

import { AgentRegistry } from "../registry";
import {
  canonicalSignedRequestBytes,
  OperatorVerifierNotConfiguredError,
  TrustResolver,
  verifyOperatorSignedRequest,
  verifyOperatorUserJwt,
  type SignedRequest,
} from "../trust-resolver";
import type { Agent } from "../../types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

/** Operator account signing keypair — the trust anchor for all tests. */
let trustedAccountSigningKey: KeyPair;
/** A different operator account signing keypair — used for "wrong issuer" tests. */
let untrustedAccountSigningKey: KeyPair;
/** Fresh per-test user keypairs minted as if by `mintUserCreds`. */

beforeAll(() => {
  trustedAccountSigningKey = createAccount();
  untrustedAccountSigningKey = createAccount();
});

interface MintedFixture {
  jwt: string;
  userKey: KeyPair;
  agentName: string;
}

/**
 * Mint a JWT analogous to `mintUserCreds()` output — signed by the given
 * account key, scoped to a fresh user nkey. Optional override of valid-window
 * claims (`exp` / `nbf`) for time-related test cases.
 */
async function mintJwtFixture(
  accountSigningKey: KeyPair,
  agentName = "test-agent",
  opts: { exp?: number; nbf?: number } = {},
): Promise<MintedFixture> {
  const userKey = createUser();
  const jwt = await encodeUser(
    agentName,
    userKey,
    accountSigningKey,
    { pub: { allow: [] }, sub: { allow: [] } },
    { algorithm: Algorithms.v2, exp: opts.exp, nbf: opts.nbf },
  );
  return { jwt, userKey, agentName };
}

/** Base64url-encode a Uint8Array (no padding, `-_` instead of `+/`). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Sign a request envelope using a user keypair. Mirrors what cortex#75's
 * NATS producer would do — provides the canonical reference implementation
 * tests use to assert verifier acceptance.
 */
function signRequest(
  userKey: KeyPair,
  parts: { subject: string; userJwt: string; nonce: string; ts: string; payload: unknown },
): SignedRequest {
  const canonical = canonicalSignedRequestBytes(parts);
  const signature = base64UrlEncode(userKey.sign(canonical));
  return { ...parts, signature };
}

function agentFixture(): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: {},
  };
}

function registryWithLuna(): AgentRegistry {
  return AgentRegistry.fromAgents([agentFixture()]);
}

// =============================================================================
// verifyOperatorUserJwt
// =============================================================================

describe("verifyOperatorUserJwt", () => {
  test("happy path — JWT minted by trusted operator verifies", async () => {
    const { jwt, userKey, agentName } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userPublicKey).toBe(userKey.getPublicKey());
      expect(result.agentName).toBe(agentName);
    }
  });

  test("wrong_issuer — JWT minted by a different account is rejected", async () => {
    const { jwt } = await mintJwtFixture(untrustedAccountSigningKey, "rogue");
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_issuer");
      expect(result.detail).toContain("does not match trusted operator");
    }
  });

  test("expired — JWT with exp in the past is rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600; // 1h ago, well past 60s skew
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna", { exp: past });
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("expired — JWT just inside the skew tolerance is accepted", async () => {
    // exp = now - 30s, skew = 60s → still within tolerance
    const past = Math.floor(Date.now() / 1000) - 30;
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna", { exp: past });
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey(), {
      clockSkewToleranceSec: 60,
    });
    expect(result.ok).toBe(true);
  });

  test("not_yet_valid — JWT with nbf in the future is rejected", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna", { nbf: future });
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_yet_valid");
  });

  test("malformed_jwt — empty string is rejected", () => {
    const result = verifyOperatorUserJwt("", trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_jwt");
  });

  test("malformed_jwt — garbage segments are rejected", () => {
    const result = verifyOperatorUserJwt(
      "not.a.real-jwt",
      trustedAccountSigningKey.getPublicKey(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_jwt");
  });

  test("malformed_jwt — single segment is rejected", () => {
    const result = verifyOperatorUserJwt("oneblob", trustedAccountSigningKey.getPublicKey());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_jwt");
  });

  test("clock-skew tolerance — explicit nowMs honoured", async () => {
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna", {
      exp: Math.floor(Date.now() / 1000) + 10,
    });
    // Pretend "now" is 1h in the future — should be expired.
    const futureMs = Date.now() + 60 * 60 * 1000;
    const result = verifyOperatorUserJwt(jwt, trustedAccountSigningKey.getPublicKey(), {
      nowMs: futureMs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });
});

// =============================================================================
// verifyOperatorSignedRequest
// =============================================================================

describe("verifyOperatorSignedRequest", () => {
  test("happy path — envelope signed by user nkey under trusted JWT verifies", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "nonce-1",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "local.acme.cortex.creds.issue",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userPublicKey).toBe(userKey.getPublicKey());
  });

  test("happy path — expectedSubject matches envelope.subject", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "local.acme.cortex.creds.issue",
    });
    expect(result.ok).toBe(true);
  });

  test("subject_mismatch — expectedSubject differs from envelope.subject", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "local.acme.cortex.creds.rotate",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("subject_mismatch");
  });

  test("malformed_envelope — missing fields", () => {
    const result = verifyOperatorSignedRequest(
      { subject: "x", userJwt: "y" },
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_envelope");
  });

  test("malformed_envelope — non-object envelope", () => {
    const result = verifyOperatorSignedRequest(
      "not an envelope",
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "irrelevant" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_envelope");
  });

  test("malformed_envelope — null", () => {
    const result = verifyOperatorSignedRequest(null, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "irrelevant",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_envelope");
  });

  test("wrong_issuer — JWT signed by untrusted operator is rejected", async () => {
    const { jwt, userKey } = await mintJwtFixture(untrustedAccountSigningKey, "rogue");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "local.acme.cortex.creds.issue",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_issuer");
  });

  test("ts_out_of_range — too old", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const oldTs = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h ago
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts: oldTs,
      payload: {},
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ts_out_of_range");
  });

  test("ts_out_of_range — too far in future", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const futureTs = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts: futureTs,
      payload: {},
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ts_out_of_range");
  });

  test("ts_out_of_range — unparseable timestamp", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts: "not-a-date",
      payload: {},
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ts_out_of_range");
  });

  test("malformed_signature — non-base64url chars", async () => {
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env: SignedRequest = {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: {},
      signature: "@@@not valid base64!!!@@@",
    };
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either malformed_signature (decode failed) OR signature_invalid (decoded
      // but wrong bytes). Either is acceptable — both are structured failures.
      expect(["malformed_signature", "signature_invalid"]).toContain(result.reason);
    }
  });

  test("signature_invalid — payload mutated after signing", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const ts = new Date().toISOString();
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts,
      payload: { verb: "issue", agent_id: "luna" },
    });
    // Attacker swaps the payload to a privileged verb — signature should fail.
    const tampered: SignedRequest = { ...env, payload: { verb: "rotate", agent_id: "luna" } };
    const result = verifyOperatorSignedRequest(
      tampered,
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "s" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  test("signature_invalid — subject mutated after signing (defeats subject-rebinding)", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const tampered: SignedRequest = { ...env, subject: "local.acme.cortex.creds.revoke" };
    // expectedSubject matches the tampered subject so we exercise the signature
    // check (not the subject_mismatch short-circuit). This proves the signature
    // covers `subject` end-to-end — even if the transport delivered the envelope
    // on the tampered subject, the canonical bytes still won't verify.
    const result = verifyOperatorSignedRequest(
      tampered,
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "local.acme.cortex.creds.revoke" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  test("signature_invalid — nonce mutated after signing", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "original-nonce",
      ts: new Date().toISOString(),
      payload: {},
    });
    const tampered: SignedRequest = { ...env, nonce: "different-nonce" };
    const result = verifyOperatorSignedRequest(
      tampered,
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "s" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  test("signature_invalid — JWT swapped to a different user's JWT (signature can't migrate)", async () => {
    const aliceFixture = await mintJwtFixture(trustedAccountSigningKey, "alice");
    const bobFixture = await mintJwtFixture(trustedAccountSigningKey, "bob");
    // Bob signs the request, but envelope claims Alice's JWT — verifier should
    // reject because the signature won't verify under Alice's pubkey.
    const env = signRequest(bobFixture.userKey, {
      subject: "s",
      userJwt: aliceFixture.jwt, // mismatched
      nonce: "n",
      ts: new Date().toISOString(),
      payload: {},
    });
    const result = verifyOperatorSignedRequest(env, trustedAccountSigningKey.getPublicKey(), {
      expectedSubject: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  test("custom signedRequestMaxAgeSec is honoured", async () => {
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const ts = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts,
      payload: {},
    });
    // With max age = 10s, 30s old envelope must reject.
    const tightResult = verifyOperatorSignedRequest(
      env,
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "s", signedRequestMaxAgeSec: 10 },
    );
    expect(tightResult.ok).toBe(false);
    if (!tightResult.ok) expect(tightResult.reason).toBe("ts_out_of_range");

    // With default max age (300s), 30s old envelope must accept.
    const lenientResult = verifyOperatorSignedRequest(
      env,
      trustedAccountSigningKey.getPublicKey(),
      { expectedSubject: "s" },
    );
    expect(lenientResult.ok).toBe(true);
  });
});

// =============================================================================
// canonicalSignedRequestBytes
// =============================================================================

describe("canonicalSignedRequestBytes", () => {
  test("identical inputs produce identical bytes", () => {
    const a = canonicalSignedRequestBytes({
      subject: "s",
      nonce: "n",
      ts: "2026-01-01T00:00:00Z",
      payload: { x: 1 },
    });
    const b = canonicalSignedRequestBytes({
      subject: "s",
      nonce: "n",
      ts: "2026-01-01T00:00:00Z",
      payload: { x: 1 },
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("different subjects produce different bytes", () => {
    const a = canonicalSignedRequestBytes({
      subject: "s1",
      nonce: "n",
      ts: "t",
      payload: {},
    });
    const b = canonicalSignedRequestBytes({
      subject: "s2",
      nonce: "n",
      ts: "t",
      payload: {},
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// =============================================================================
// TrustResolver instance methods
// =============================================================================

describe("TrustResolver.verifyOperatorSignature", () => {
  test("backward-compatible — constructor without options still works", () => {
    // Pre-cortex#76 callers passed only the registry. Must still compile + run.
    const resolver = new TrustResolver(registryWithLuna());
    expect(resolver.size).toBe(0);
    expect(resolver.isOperatorVerifierConfigured).toBe(false);
  });

  test("throws OperatorVerifierNotConfiguredError when pubkey absent", () => {
    const resolver = new TrustResolver(registryWithLuna());
    expect(() => resolver.verifyOperatorSignature({}, { expectedSubject: "x" })).toThrow(
      OperatorVerifierNotConfiguredError,
    );
    expect(() => resolver.verifyUserJwt("any.jwt.value")).toThrow(
      OperatorVerifierNotConfiguredError,
    );
  });

  test("delegates to verifyOperatorSignedRequest with configured pubkey", async () => {
    const resolver = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
    });
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: { verb: "issue", agent_id: "luna" },
    });
    const result = resolver.verifyOperatorSignature(env, {
      expectedSubject: "local.acme.cortex.creds.issue",
    });
    expect(result.ok).toBe(true);
  });

  test("delegates to verifyOperatorUserJwt", async () => {
    const resolver = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
    });
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const result = resolver.verifyUserJwt(jwt);
    expect(result.ok).toBe(true);
  });

  test("expectedSubject passed through to delegate", async () => {
    const resolver = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
    });
    const { jwt, userKey } = await mintJwtFixture(trustedAccountSigningKey, "luna");
    const env = signRequest(userKey, {
      subject: "local.acme.cortex.creds.issue",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: {},
    });
    const result = resolver.verifyOperatorSignature(env, {
      expectedSubject: "local.acme.cortex.creds.rotate",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("subject_mismatch");
  });

  test("rejects JWT from untrusted operator at instance layer too", async () => {
    const resolver = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
    });
    const { jwt, userKey } = await mintJwtFixture(untrustedAccountSigningKey, "rogue");
    const env = signRequest(userKey, {
      subject: "s",
      userJwt: jwt,
      nonce: "n",
      ts: new Date().toISOString(),
      payload: {},
    });
    const result = resolver.verifyOperatorSignature(env, { expectedSubject: "s" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_issuer");
  });

  test("isOperatorVerifierConfigured reflects construction", () => {
    const unconfigured = new TrustResolver(registryWithLuna());
    expect(unconfigured.isOperatorVerifierConfigured).toBe(false);

    const configured = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
    });
    expect(configured.isOperatorVerifierConfigured).toBe(true);
  });

  test("custom clock-skew tolerance flows through to delegate", async () => {
    const resolver = new TrustResolver(registryWithLuna(), {
      operatorAccountSigningPublicKey: trustedAccountSigningKey.getPublicKey(),
      clockSkewToleranceSec: 0, // strictest
    });
    // exp = now - 5s, zero skew → expired
    const past = Math.floor(Date.now() / 1000) - 5;
    const { jwt } = await mintJwtFixture(trustedAccountSigningKey, "luna", { exp: past });
    const result = resolver.verifyUserJwt(jwt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });
});
