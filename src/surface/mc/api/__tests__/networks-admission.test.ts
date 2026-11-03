/**
 * MC-B2 (cortex#1279) + #1410 — tests for `handleAdmissionDecision`: the two
 * gates (bind-conditioned CF-Access principal identity + typed-confirm) and the
 * decider-verdict → HTTP mapping.
 *
 * Loopback cases are pure (stub decider). Non-loopback cases exercise the REAL
 * shared CF-Access verifier against a locally-generated RS256 keypair + a
 * stubbed JWKS fetch — no network.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import {
  handleAdmissionDecision,
  DEFAULT_LOCAL_PRINCIPAL,
  type AdmissionDecider,
  type AdmissionDecisionInput,
  type AdmissionDecisionResult,
  type AdmissionAuthContext,
} from "../networks-admission";
import {
  verifyCfAccessJwt,
  resetCfAccessJwksCache,
  cfAccessIssuer,
} from "../../../../common/auth/cf-access-jwt";
import { createCfAccessSigningKeys, jwksFetch, mintCfAccessJwt } from "./cf-access-fixture";

const TEAM = "metafactory";
const AUD = "test-access-aud-tag";
const ISS = cfAccessIssuer(TEAM);

function decider(result: AdmissionDecisionResult): AdmissionDecider {
  return { decide: () => Promise.resolve(result) };
}

/** A decider that records its input (to assert the resolved principal). */
function recordingDecider(): { decider: AdmissionDecider; calls: AdmissionDecisionInput[] } {
  const calls: AdmissionDecisionInput[] = [];
  return {
    calls,
    decider: {
      decide: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, status: "ADMITTED", requestId: input.requestId });
      },
    },
  };
}

/** A decider that must NOT be called (asserts the gate fired first). */
const throwingDecider: AdmissionDecider = {
  decide: () => {
    throw new Error("decider should not be reached");
  },
};

const OK_BODY = {
  network_id: "alpha",
  request_id: "req-abc-123",
  decision: "admit",
  confirm: "req-abc-123",
};

/**
 * Loopback auth context. The email header is audit metadata on loopback (FND-6
 * posture A); when absent the request resolves to `localPrincipal` (or the
 * built-in `DEFAULT_LOCAL_PRINCIPAL` sentinel), never 401.
 */
function loopbackAuth(
  email: string | undefined,
  localPrincipal?: string,
): AdmissionAuthContext {
  return {
    isLoopback: true,
    emailHeader: email,
    jwtAssertion: undefined,
    ...(localPrincipal ? { localPrincipal } : {}),
  };
}

/**
 * Non-loopback auth context. `emailHeader` is deliberately set to a FORGED
 * value to prove it is ignored off loopback — only the verified JWT counts.
 */
function nonLoopbackAuth(
  jwt: string | undefined,
  verifyJwt?: AdmissionAuthContext["verifyJwt"],
): AdmissionAuthContext {
  return {
    isLoopback: false,
    emailHeader: "forged@evil.test",
    jwtAssertion: jwt,
    ...(verifyJwt ? { verifyJwt } : {}),
  };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

let signKey: CryptoKey;
let wrongKey: CryptoKey;
let stubFetch: typeof fetch;
const mint = mintCfAccessJwt;

/** stub fetch that fails (JWKS unavailable). */
const failFetch = ((): Promise<Response> =>
  Promise.resolve({ ok: false, status: 503 } as unknown as Response)) as unknown as typeof fetch;

/** Build a verifier bound to aud+team, an injected fetch, and a fixed clock. */
function verifierWith(
  fetchImpl: typeof fetch,
  nowSeconds: number,
): AdmissionAuthContext["verifyJwt"] {
  return (token: string) =>
    verifyCfAccessJwt(token, { aud: AUD, teamDomain: TEAM, fetchImpl, nowSeconds });
}

const NOW = 1_700_000_000;
function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: AUD, iss: ISS, email: "principal@example.com", iat: NOW - 30, exp: NOW + 3600, ...over };
}

beforeAll(async () => {
  const keys = await createCfAccessSigningKeys();
  signKey = keys.signKey;
  wrongKey = keys.wrongKey;
  stubFetch = jwksFetch(keys.jwk);
});

beforeEach(() => {
  resetCfAccessJwksCache();
});

describe("handleAdmissionDecision — gate 1 (loopback): audit-metadata email + local-principal fallback (FND-6 posture A)", () => {
  it("falls back to the configured local principal when the header is absent — reaches the decider (no 401)", async () => {
    const { decider: d, calls } = recordingDecider();
    const res = await handleAdmissionDecision(
      d,
      loopbackAuth(undefined, "local@dev.box"),
      OK_BODY,
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.principal).toBe("local@dev.box");
  });

  it("falls back to the DEFAULT_LOCAL_PRINCIPAL sentinel when neither header nor local_principal is set", async () => {
    const { decider: d, calls } = recordingDecider();
    const res = await handleAdmissionDecision(d, loopbackAuth("   "), OK_BODY);
    expect(res.status).toBe(200);
    expect(calls[0]?.principal).toBe(DEFAULT_LOCAL_PRINCIPAL);
  });

  it("uses the email header when present (audit attribution), ignoring the local-principal fallback", async () => {
    const { decider: d, calls } = recordingDecider();
    const res = await handleAdmissionDecision(d, loopbackAuth("op@x.io", "local@dev.box"), OK_BODY);
    expect(res.status).toBe(200);
    expect(calls[0]?.principal).toBe("op@x.io");
  });
});

describe("handleAdmissionDecision — gate 1 (non-loopback): verified CF-Access JWT (#1410)", () => {
  it("503 fail-closed when cfAccess is not configured (no verifier)", async () => {
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth("x.y.z"), OK_BODY);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("not_configured");
  });

  it("401 when the JWT assertion header is absent", async () => {
    const auth = nonLoopbackAuth(undefined, verifierWith(stubFetch, NOW));
    const res = await handleAdmissionDecision(throwingDecider, auth, OK_BODY);
    expect(res.status).toBe(401);
  });

  it("accepts a valid JWT and takes the principal from the verified email claim (ignoring the forged header)", async () => {
    const token = await mint(signKey, validClaims());
    const { decider: d, calls } = recordingDecider();
    const res = await handleAdmissionDecision(d, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(200);
    expect(calls[0]?.principal).toBe("principal@example.com");
    expect(calls[0]?.principal).not.toBe("forged@evil.test");
  });

  it("401 fail-closed on a bad signature (signed by an off-JWKS key)", async () => {
    const token = await mint(wrongKey, validClaims());
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed on an expired token", async () => {
    const token = await mint(signKey, validClaims({ exp: NOW - 3600, iat: NOW - 7200 }));
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed on the wrong audience", async () => {
    const token = await mint(signKey, validClaims({ aud: "some-other-app" }));
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed on the wrong issuer", async () => {
    const token = await mint(signKey, validClaims({ iss: cfAccessIssuer("someone-else") }));
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed when nbf is in the future", async () => {
    const token = await mint(signKey, validClaims({ nbf: NOW + 3600, exp: NOW + 7200 }));
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed when the JWKS fetch fails (never falls open)", async () => {
    const token = await mint(signKey, validClaims());
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(failFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });

  it("401 fail-closed when the verified JWT carries no email claim", async () => {
    const token = await mint(signKey, validClaims({ email: undefined }));
    const res = await handleAdmissionDecision(throwingDecider, nonLoopbackAuth(token, verifierWith(stubFetch, NOW)), OK_BODY);
    expect(res.status).toBe(401);
  });
});

describe("handleAdmissionDecision — gate 2: body + typed-confirm", () => {
  it("400 when the body is not an object", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), null);
    expect(res.status).toBe(400);
  });

  it("400 when request_id is invalid", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), { ...OK_BODY, request_id: "!", confirm: "!" });
    expect(res.status).toBe(400);
  });

  it("400 when network_id is invalid", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), { ...OK_BODY, network_id: "Bad Net" });
    expect(res.status).toBe(400);
  });

  it("400 when decision is neither admit nor reject", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), { ...OK_BODY, decision: "revoke" });
    expect(res.status).toBe(400);
  });

  it("400 when confirm does not exactly echo request_id (typed-confirm gate)", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), { ...OK_BODY, confirm: "req-abc-124" });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("confirm must exactly match request_id");
  });

  it("400 when confirm has stray whitespace (exact echo, not trimmed)", async () => {
    const res = await handleAdmissionDecision(throwingDecider, loopbackAuth("op@x.io"), { ...OK_BODY, confirm: "req-abc-123 " });
    expect(res.status).toBe(400);
  });
});

describe("handleAdmissionDecision — decider wiring", () => {
  it("503 when the decider is not wired (null)", async () => {
    const res = await handleAdmissionDecision(null, loopbackAuth("op@x.io"), OK_BODY);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("not_configured");
  });

  it("200 + status when the decider admits", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: true, status: "ADMITTED", requestId: "req-abc-123" }),
      loopbackAuth("op@x.io"),
      OK_BODY,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.status).toBe("ADMITTED");
    expect(b.request_id).toBe("req-abc-123");
  });

  it("200 + REJECTED when rejecting", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: true, status: "REJECTED", requestId: "req-abc-123" }),
      loopbackAuth("op@x.io"),
      { ...OK_BODY, decision: "reject" },
    );
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe("REJECTED");
  });

  it("403 when the registry says not_authorized", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: false, reason: "not_authorized", detail: "not an admin" }),
      loopbackAuth("op@x.io"),
      OK_BODY,
    );
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error).toBe("not_authorized");
    expect(b.detail).toBe("not an admin");
  });

  it("409 already_decided, 429 rate_limited, 404 not_found, 502 unreachable map through", async () => {
    const cases: [AdmissionDecisionResult, number][] = [
      [{ ok: false, reason: "already_decided", detail: "x" }, 409],
      [{ ok: false, reason: "replayed", detail: "x" }, 409],
      [{ ok: false, reason: "rate_limited", detail: "x" }, 429],
      [{ ok: false, reason: "not_found", detail: "x" }, 404],
      [{ ok: false, reason: "invalid", detail: "x" }, 400],
      [{ ok: false, reason: "unreachable", detail: "x" }, 502],
    ];
    for (const [result, status] of cases) {
      const res = await handleAdmissionDecision(decider(result), loopbackAuth("op@x.io"), OK_BODY);
      expect(res.status).toBe(status);
    }
  });
});

describe("networks-admission module boundary", () => {
  it("never imports the bus — cortex.ts injects the signer as an AdmissionDecider", async () => {
    const source = await Bun.file(new URL("../networks-admission.ts", import.meta.url)).text();
    const specifiers = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => /(^|\/)bus(\/|$)/.test(s ?? ""))).toEqual([]);
  });
});
