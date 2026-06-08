/**
 * TC-2a (cortex#633) — PrincipalPubkeyResolver tests.
 *
 * Covers the resolve matrix from the spec:
 *
 *   1. Posture OFF (disabled) — inert, no network I/O.
 *   2. Happy path against the documented `SignedAssertion<PrincipalRecord>`
 *      shape — verified pubkey returned.
 *   3. 404 → `{ status: "not_found" }`.
 *   4. Network error / non-404 HTTP → `{ status: "unresolved" }` (no throw).
 *   5. Cache hit — second resolve does NOT re-fetch.
 *   6. invalidate / clearCache — next resolve re-fetches.
 *   7. TOFU pubkey discovery when no pubkey is config-pinned.
 *   8. Tamper / mismatch paths → `{ status: "unresolved" }`.
 *
 * The registry is an EPHEMERAL `Bun.serve({ port: 0 })` stub — never a
 * hardcoded port (the #671 de-flake). Tests read the assigned port off
 * `server.url` and feed it to the resolver as `baseUrl`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { PrincipalPubkeyResolver, resolvePrincipalPubkey } from "../resolve-pubkey";
import { canonicalJSON } from "../signing";

// =============================================================================
// Ed25519 sign-side test helpers (the resolver only verifies; tests sign).
// =============================================================================

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function generateKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return {
    privateKey: kp.privateKey,
    publicKeyB64: bytesToBase64(new Uint8Array(raw)),
  };
}

interface PrincipalPayload {
  principal_id: string;
  principal_pubkey: string;
  stacks: unknown[];
  capabilities: unknown[];
  updated_at: string;
}

async function signAssertion(
  registryPrivateKey: CryptoKey,
  registryPubkey: string,
  payload: PrincipalPayload,
): Promise<unknown> {
  const issued_at = new Date().toISOString();
  const bound = canonicalJSON({ payload, issued_at, registry: registryPubkey });
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    registryPrivateKey,
    new TextEncoder().encode(bound),
  );
  return {
    payload,
    issued_at,
    registry: registryPubkey,
    signature: bytesToBase64(new Uint8Array(sig)),
  };
}

function makePayload(
  principalId: string,
  principalPubkey: string,
): PrincipalPayload {
  return {
    principal_id: principalId,
    principal_pubkey: principalPubkey,
    stacks: [{ stack_id: `${principalId}/laptop` }],
    capabilities: [],
    updated_at: new Date().toISOString(),
  };
}

// A structurally-valid base64 Ed25519 peer pubkey (44 chars w/ padding).
const PEER_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// =============================================================================
// Ephemeral registry stub — Bun.serve({ port: 0 }), never a hardcoded port.
// =============================================================================

interface StubOptions {
  /** Override the principal handler. */
  principal?: (id: string) => Response | Promise<Response>;
  /** Override the /registry/pubkey handler (for TOFU tests). */
  registryPubkey?: () => Response | Promise<Response>;
  /** Count fetches so cache-hit tests can assert no re-fetch. */
  counter?: { principals: number; pubkey: number };
}

function startStub(opts: StubOptions): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0, // ephemeral — OS assigns a free port (#671 de-flake pattern)
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/registry/pubkey") {
        if (opts.counter) opts.counter.pubkey++;
        if (opts.registryPubkey) return opts.registryPubkey();
        return new Response("no pubkey handler", { status: 500 });
      }
      const m = /^\/principals\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (opts.counter) opts.counter.principals++;
        const id = decodeURIComponent(m[1]!);
        if (opts.principal) return opts.principal(id);
        return new Response("no principal handler", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: server.url.toString().replace(/\/$/, ""),
    stop: () => server.stop(true),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// Tests
// =============================================================================

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

function track(stub: { baseUrl: string; stop: () => void }): string {
  stops.push(stub.stop);
  return stub.baseUrl;
}

// A second structurally-valid base64 Ed25519 pubkey, distinct from PEER_PUBKEY.
const STACK_PUBKEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

/** Build a payload with per-stack pubkeys (C-787). */
function makePerStackPayload(
  principalId: string,
  rootPubkey: string,
  stacks: { stack_id: string; stack_pubkey?: string }[],
): PrincipalPayload {
  return {
    principal_id: principalId,
    principal_pubkey: rootPubkey,
    stacks,
    capabilities: [],
    updated_at: new Date().toISOString(),
  };
}

describe("PrincipalPubkeyResolver — C-787 per-stack resolution", () => {
  test("resolve(principal, stackId) returns that stack's stack_pubkey", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(
            await signAssertion(
              reg.privateKey,
              reg.publicKeyB64,
              makePerStackPayload(id, PEER_PUBKEY, [
                { stack_id: `${id}/meta-factory`, stack_pubkey: PEER_PUBKEY },
                { stack_id: `${id}/community`, stack_pubkey: STACK_PUBKEY },
              ]),
            ),
          ),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("andreas", "andreas/community");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.principalPubkey).toBe(STACK_PUBKEY);
    }
  });

  test("the SAME principal's two stacks resolve to DIFFERENT pubkeys (no cache clobber)", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(
            await signAssertion(
              reg.privateKey,
              reg.publicKeyB64,
              makePerStackPayload(id, PEER_PUBKEY, [
                { stack_id: `${id}/meta-factory`, stack_pubkey: PEER_PUBKEY },
                { stack_id: `${id}/community`, stack_pubkey: STACK_PUBKEY },
              ]),
            ),
          ),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const mf = await resolver.resolve("andreas", "andreas/meta-factory");
    const community = await resolver.resolve("andreas", "andreas/community");
    expect(mf.status === "resolved" && mf.principalPubkey).toBe(PEER_PUBKEY);
    expect(community.status === "resolved" && community.principalPubkey).toBe(STACK_PUBKEY);
  });

  test("resolve(principal, unknownStack) falls back to the root pubkey", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(
            await signAssertion(
              reg.privateKey,
              reg.publicKeyB64,
              makePerStackPayload(id, PEER_PUBKEY, [
                { stack_id: `${id}/meta-factory`, stack_pubkey: STACK_PUBKEY },
              ]),
            ),
          ),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("andreas", "andreas/does-not-exist");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      // Falls back to the root principal_pubkey.
      expect(res.principalPubkey).toBe(PEER_PUBKEY);
    }
  });

  test("resolve WITHOUT a stackId returns the root pubkey (pre-C-787 behaviour)", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(
            await signAssertion(
              reg.privateKey,
              reg.publicKeyB64,
              makePerStackPayload(id, PEER_PUBKEY, [
                { stack_id: `${id}/meta-factory`, stack_pubkey: STACK_PUBKEY },
              ]),
            ),
          ),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("andreas");
    expect(res.status === "resolved" && res.principalPubkey).toBe(PEER_PUBKEY);
  });

  test("a stack with NO stack_pubkey (back-compat record) falls back to root", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(
            await signAssertion(
              reg.privateKey,
              reg.publicKeyB64,
              makePerStackPayload(id, PEER_PUBKEY, [{ stack_id: `${id}/laptop` }]),
            ),
          ),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("andreas", "andreas/laptop");
    expect(res.status === "resolved" && res.principalPubkey).toBe(PEER_PUBKEY);
  });
});

describe("PrincipalPubkeyResolver — posture gate (default-OFF)", () => {
  test("disabled resolver is inert: returns 'disabled' with NO network I/O", async () => {
    const counter = { principals: 0, pubkey: 0 };
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        counter,
        principal: (id) => signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY)).then((a) => json(a)),
        registryPubkey: () => json({ algorithm: "Ed25519", public_key: reg.publicKeyB64 }),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: false,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("disabled");
    // The whole point of default-OFF: a dev stack never reaches the registry.
    expect(counter.principals).toBe(0);
    expect(counter.pubkey).toBe(0);
  });
});

describe("PrincipalPubkeyResolver — happy path", () => {
  test("resolves a verified peer pubkey against the documented shape", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.principalPubkey).toBe(PEER_PUBKEY);
    }
  });

  test("functional form resolvePrincipalPubkey resolves the same shape", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const res = await resolvePrincipalPubkey("peer-b", {
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    expect(res.status).toBe("resolved");
  });
});

describe("PrincipalPubkeyResolver — 404 / not_found", () => {
  test("registry 404 → not_found (distinct from unresolved)", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({ principal: () => json({ error: "not_found" }, 404) }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("nobody");
    expect(res.status).toBe("not_found");
  });
});

describe("PrincipalPubkeyResolver — network / transport failure", () => {
  test("network error → unresolved, never throws", async () => {
    const reg = await generateKeypair();
    // No server running at this base URL → fetch rejects.
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl: "http://127.0.0.1:1/", // unroutable; connection refused
      registryPubkey: reg.publicKeyB64,
      requestTimeoutMs: 500,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("non-404 HTTP error → unresolved", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({ principal: () => new Response("boom", { status: 500 }) }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });
});

describe("PrincipalPubkeyResolver — verification failures", () => {
  test("registry pubkey mismatch → unresolved", async () => {
    const reg = await generateKeypair();
    const attacker = await generateKeypair();
    // Assertion signed by the attacker but claims the attacker's registry
    // field — the resolver pins reg.publicKeyB64, so registry !== pinned.
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(await signAssertion(attacker.privateKey, attacker.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("forged signature (right registry field, wrong key) → unresolved", async () => {
    const reg = await generateKeypair();
    const attacker = await generateKeypair();
    // Attacker signs but stamps the assertion with the REAL registry's
    // pubkey in the `registry` field — passes the mismatch gate, fails
    // the crypto verify.
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(await signAssertion(attacker.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("principal_id mismatch (swapped payload) → unresolved", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        // Returns an assertion for "someone-else" no matter who is asked.
        principal: async () =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload("someone-else", PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("malformed peer pubkey grammar → unresolved", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, "not-a-valid-base64-ed25519-key"))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("unconfigured-sentinel registry → unresolved", async () => {
    const reg = await generateKeypair();
    const baseUrl = track(
      startStub({
        principal: (id) =>
          json({
            payload: makePayload(id, PEER_PUBKEY),
            issued_at: new Date().toISOString(),
            registry: "unconfigured",
            signature: "",
          }),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });
});

describe("PrincipalPubkeyResolver — caching", () => {
  test("cache hit: a second resolve does not re-fetch", async () => {
    const reg = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const baseUrl = track(
      startStub({
        counter,
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const a = await resolver.resolve("peer-b");
    const b = await resolver.resolve("peer-b");
    expect(a.status).toBe("resolved");
    expect(b.status).toBe("resolved");
    expect(counter.principals).toBe(1); // only the first call hit the wire
  });

  test("invalidate busts one entry → next resolve re-fetches", async () => {
    const reg = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const baseUrl = track(
      startStub({
        counter,
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    await resolver.resolve("peer-b");
    resolver.invalidate("peer-b");
    await resolver.resolve("peer-b");
    expect(counter.principals).toBe(2);
  });

  test("clearCache busts all → next resolve re-fetches", async () => {
    const reg = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const baseUrl = track(
      startStub({
        counter,
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    await resolver.resolve("peer-b");
    resolver.clearCache();
    await resolver.resolve("peer-b");
    expect(counter.principals).toBe(2);
  });

  test("a failed resolve is NOT cached (retry-able)", async () => {
    const reg = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    let fail = true;
    const baseUrl = track(
      startStub({
        counter,
        principal: async (id) => {
          if (fail) return new Response("boom", { status: 500 });
          return json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY)));
        },
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      registryPubkey: reg.publicKeyB64,
      logError: () => {},
    });
    const first = await resolver.resolve("peer-b");
    expect(first.status).toBe("unresolved");
    fail = false;
    const second = await resolver.resolve("peer-b");
    expect(second.status).toBe("resolved");
    expect(counter.principals).toBe(2); // failure didn't poison the cache
  });
});

describe("PrincipalPubkeyResolver — TOFU (no config-pinned pubkey)", () => {
  test("discovers + pins the registry pubkey via /registry/pubkey", async () => {
    const reg = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const baseUrl = track(
      startStub({
        counter,
        registryPubkey: () => json({ algorithm: "Ed25519", public_key: reg.publicKeyB64 }),
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      // no registryPubkey → TOFU
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("resolved");
    expect(counter.pubkey).toBe(1); // TOFU happened exactly once

    // Second resolve of a NEW id reuses the pinned key — no second TOFU.
    await resolver.resolve("peer-c");
    expect(counter.pubkey).toBe(1);
  });

  test("TOFU returning the unconfigured sentinel → unresolved, no pin", async () => {
    const baseUrl = track(
      startStub({
        registryPubkey: () => json({ algorithm: "Ed25519", public_key: "unconfigured" }),
        principal: () => json({ error: "should not reach here" }, 500),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      logError: () => {},
    });
    const res = await resolver.resolve("peer-b");
    expect(res.status).toBe("unresolved");
  });

  test("TOFU recovers: first attempt fails, a later resolve succeeds", async () => {
    const reg = await generateKeypair();
    let pubkeyUp = false;
    const baseUrl = track(
      startStub({
        registryPubkey: () => {
          if (!pubkeyUp) return new Response("down", { status: 503 });
          return json({ algorithm: "Ed25519", public_key: reg.publicKeyB64 });
        },
        principal: async (id) =>
          json(await signAssertion(reg.privateKey, reg.publicKeyB64, makePayload(id, PEER_PUBKEY))),
      }),
    );
    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl,
      logError: () => {},
    });
    const first = await resolver.resolve("peer-b");
    expect(first.status).toBe("unresolved");
    pubkeyUp = true;
    const second = await resolver.resolve("peer-b");
    expect(second.status).toBe("resolved");
  });
});
