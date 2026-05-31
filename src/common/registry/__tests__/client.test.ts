/**
 * IAW Phase D.4.3 — RegistryClient tests.
 *
 * Covers the cases called out in the D.4.3 spec:
 *
 *   1. TOFU pubkey fetch at boot
 *   2. Pinned pubkey from config bypasses TOFU
 *   3. `getPrincipal` returns verified data
 *   4. `getPrincipal` returns undefined on signature verification failure
 *   5. `getPrincipal` returns undefined on network failure (no throw)
 *   6. Periodic refresh updates cache
 *   7. Shutdown stops the refresh timer
 *
 * The test rig builds a `fakeFetch` closure that maps URL → response,
 * signs assertions with a fresh Ed25519 keypair, and injects the
 * closure via `RegistryClientOptions.fetch`. No real network.
 */

import { describe, expect, mock, test } from "bun:test";

import { RegistryClient } from "../client";
import { canonicalJSON } from "../signing";
import type { OperatorRecord, SignedAssertion } from "../types";

// =============================================================================
// Test helpers — Ed25519 sign-side (the client only verifies; tests
// produce the assertions the client consumes).
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
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { privateKey: kp.privateKey, publicKeyB64: bytesToBase64(new Uint8Array(raw)) };
}

async function signAssertion<T>(
  privateKey: CryptoKey,
  registryPubkey: string,
  payload: T,
): Promise<SignedAssertion<T>> {
  const issued_at = new Date().toISOString();
  const bound = canonicalJSON({ payload, issued_at, registry: registryPubkey });
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(bound),
  );
  return {
    payload,
    issued_at,
    registry: registryPubkey,
    signature: bytesToBase64(new Uint8Array(sig)),
  };
}

/**
 * Structurally-valid base64 Ed25519 pubkey (44 chars: 43 of alphabet
 * + one `=` of padding). Real keys come out of WebCrypto's
 * `generateKeypair`; tests only need the regex to pass at the
 * payload-grammar gate. Echo cortex#230 round 1 added that gate.
 */
const FAKE_PEER_PUBKEY_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FAKE_PEER_PUBKEY_V2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

/**
 * Build a wire-shape payload — the JSON the registry emits and the
 * client deserializes. Wire fields are `principal_id` / `principal_pubkey`
 * per PR-R7c-network-registry; cortex's internal `OperatorRecord`
 * cache type uses different field names and the client maps between
 * them. Tests assert against the in-memory `OperatorRecord` view, so
 * the fixture is left as `unknown`-typed wire bytes.
 */
function makeOperator(
  principal_id: string,
  pubkeyB64 = FAKE_PEER_PUBKEY_V1,
): {
  principal_id: string;
  principal_pubkey: string;
  stacks: { stack_id: string }[];
  capabilities: never[];
  updated_at: string;
} {
  return {
    principal_id,
    principal_pubkey: pubkeyB64,
    stacks: [{ stack_id: `${principal_id}/main` }],
    capabilities: [],
    updated_at: new Date().toISOString(),
  };
}

type FakeFetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function makeRouteFetch(
  routes: Record<string, () => Promise<Response> | Response>,
): FakeFetchHandler {
  return async (url: string) => {
    // Match by suffix so callers can write short keys like
    // "/registry/pubkey" or "/principals/andreas".
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    return new Response("not found", { status: 404 });
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("RegistryClient — TOFU + pinned pubkey", () => {
  test("TOFU: fetches /registry/pubkey at start() and pins the response", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    let pubkeyFetched = false;
    const fakeFetch = makeRouteFetch({
      "/registry/pubkey": () => {
        pubkeyFetched = true;
        return jsonResponse({ algorithm: "Ed25519", public_key: kp.publicKeyB64 });
      },
      "/principals/andreas": () => jsonResponse(assertion),
    });

    const client = new RegistryClient({
      url: "https://registry.example/",
      principalIds: ["andreas"],
      refreshIntervalMs: 0, // disable background timer for tests
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      expect(pubkeyFetched).toBe(true);
      const fetched = client.getPrincipal("andreas");
      expect(fetched).toBeDefined();
      expect(fetched?.operator_id).toBe("andreas");
    } finally {
      client.stop();
    }
  });

  test("pinned pubkey from config skips the /registry/pubkey TOFU call", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("jcfischer");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    let pubkeyFetched = false;
    const fakeFetch = makeRouteFetch({
      "/registry/pubkey": () => {
        pubkeyFetched = true;
        return jsonResponse({ algorithm: "Ed25519", public_key: kp.publicKeyB64 });
      },
      "/principals/jcfischer": () => jsonResponse(assertion),
    });

    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["jcfischer"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      expect(pubkeyFetched).toBe(false);
      expect(client.getPrincipal("jcfischer")).toBeDefined();
    } finally {
      client.stop();
    }
  });
});

describe("RegistryClient — getPrincipal()", () => {
  test("returns the verified record after a successful refresh", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("andreas", FAKE_PEER_PUBKEY_V1);
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    const fakeFetch = makeRouteFetch({
      "/principals/andreas": () => jsonResponse(assertion),
    });

    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      const got = client.getPrincipal("andreas");
      // The cache is keyed on the cortex-internal `OperatorRecord`
      // shape (`operator_id`/`operator_pubkey`), built from the wire
      // payload (`principal_id`/`principal_pubkey`) per PR-R7c.
      const expected: OperatorRecord = {
        operator_id: op.principal_id,
        operator_pubkey: op.principal_pubkey,
        stacks: op.stacks,
        capabilities: op.capabilities,
        updated_at: op.updated_at,
      };
      expect(got).toEqual(expected);
    } finally {
      client.stop();
    }
  });

  test("returns undefined when the signature does not verify", async () => {
    // Two distinct keypairs: the registry signs with `signerKp`, but
    // the client pins `pinnedKp.publicKeyB64`. The assertion's
    // `registry` field is set to the pinned key (so the pubkey-match
    // check passes) but the signature was produced under the wrong
    // private key. This is the canonical "trust anchor mismatch but
    // structural shape correct" attack the verify step must catch.
    const signerKp = await generateKeypair();
    const pinnedKp = await generateKeypair();
    const op = makeOperator("attacker");
    const issued_at = new Date().toISOString();
    const bound = canonicalJSON({ payload: op, issued_at, registry: pinnedKp.publicKeyB64 });
    const sigBuf = await crypto.subtle.sign(
      { name: "Ed25519" },
      signerKp.privateKey,
      new TextEncoder().encode(bound),
    );
    const forged: SignedAssertion<ReturnType<typeof makeOperator>> = {
      payload: op,
      issued_at,
      registry: pinnedKp.publicKeyB64,
      signature: bytesToBase64(new Uint8Array(sigBuf)),
    };

    const errs: string[] = [];
    const fakeFetch = makeRouteFetch({
      "/principals/attacker": () => jsonResponse(forged),
    });
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: pinnedKp.publicKeyB64,
      principalIds: ["attacker"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    await client.start();
    try {
      expect(client.getPrincipal("attacker")).toBeUndefined();
      expect(errs.some((e) => e.includes("signature did not verify"))).toBe(true);
    } finally {
      client.stop();
    }
  });

  test("returns undefined on network failure (no throw at call site)", async () => {
    const kp = await generateKeypair();
    const fakeFetch: FakeFetchHandler = async () => {
      throw new Error("connection refused");
    };
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    // start() must not throw even when every fetch rejects.
    await client.start();
    try {
      expect(client.getPrincipal("andreas")).toBeUndefined();
      expect(errs.some((e) => e.includes("connection refused"))).toBe(true);
    } finally {
      client.stop();
    }
  });

  test("returns undefined when the registry returned an `unconfigured` sentinel", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const unsignedAssertion: SignedAssertion<ReturnType<typeof makeOperator>> = {
      payload: op,
      issued_at: new Date().toISOString(),
      registry: "unconfigured",
      signature: "",
    };
    const fakeFetch = makeRouteFetch({
      "/principals/andreas": () => jsonResponse(unsignedAssertion),
    });
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    await client.start();
    try {
      expect(client.getPrincipal("andreas")).toBeUndefined();
      expect(errs.some((e) => e.includes("unconfigured"))).toBe(true);
    } finally {
      client.stop();
    }
  });

  test("returns undefined when the registry pubkey on the assertion does not match the pinned pubkey", async () => {
    const realKp = await generateKeypair();
    const otherKp = await generateKeypair();
    const op = makeOperator("victim");
    // Assertion is well-signed by realKp, but the client pinned otherKp.
    const assertion = await signAssertion(realKp.privateKey, realKp.publicKeyB64, op);
    const fakeFetch = makeRouteFetch({
      "/principals/victim": () => jsonResponse(assertion),
    });
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: otherKp.publicKeyB64,
      principalIds: ["victim"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    await client.start();
    try {
      expect(client.getPrincipal("victim")).toBeUndefined();
      expect(errs.some((e) => e.includes("registry pubkey mismatch"))).toBe(true);
    } finally {
      client.stop();
    }
  });

  test("returns undefined when the payload's principal_id does not match the requested id", async () => {
    // Defends against a swapped-payload attack: a malicious registry
    // serves a valid signed assertion for `eve` when cortex asked for
    // `alice`. The signature verifies, the registry pubkey matches —
    // only the per-principal id check catches it.
    const kp = await generateKeypair();
    const eve = makeOperator("eve");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, eve);
    const fakeFetch = makeRouteFetch({
      "/principals/alice": () => jsonResponse(assertion),
    });
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["alice"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    await client.start();
    try {
      expect(client.getPrincipal("alice")).toBeUndefined();
      expect(errs.some((e) => e.includes("principal_id mismatch"))).toBe(true);
    } finally {
      client.stop();
    }
  });

  test("returns undefined when the payload's principal_pubkey is signed but malformed", async () => {
    // Echo cortex#230 rounds 1 + 3: a signed-but-malformed peer
    // pubkey is still a wire-contract violation. The structural
    // grammar gate runs BEFORE the signature verify (cheap-check-
    // first ordering — no wasted crypto on garbage payloads), so a
    // wrong-shape pubkey is rejected even if the rest of the
    // assertion would have verified.
    const kp = await generateKeypair();
    const op = {
      ...makeOperator("andreas"),
      principal_pubkey: "definitely-not-base64-ed25519", // wrong length + alphabet
    };
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);
    const fakeFetch = makeRouteFetch({
      "/principals/andreas": () => jsonResponse(assertion),
    });
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    await client.start();
    try {
      expect(client.getPrincipal("andreas")).toBeUndefined();
      expect(errs.some((e) => e.includes("not base64-Ed25519"))).toBe(true);
    } finally {
      client.stop();
    }
  });
});

describe("RegistryClient — start()/stop() idempotency", () => {
  test("start() is idempotent under refreshIntervalMs=0 (no setInterval timer)", async () => {
    // Without a dedicated `started` flag, the previous implementation
    // used `refreshTimer !== undefined` as the "already started" guard.
    // With refreshIntervalMs=0 there is no timer, so a second start()
    // would re-run TOFU + the eager refresh — visible here as a
    // doubled fetch count. The `started` flag fixes that. Echo
    // cortex#230 round 1.
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);
    const fetchCalls: string[] = [];
    const fakeFetch: FakeFetchHandler = async (url: string) => {
      fetchCalls.push(url);
      if (url.endsWith("/registry/pubkey")) {
        return jsonResponse({ algorithm: "Ed25519", public_key: kp.publicKeyB64 });
      }
      if (url.endsWith("/principals/andreas")) return jsonResponse(assertion);
      return new Response("nope", { status: 404 });
    };
    const client = new RegistryClient({
      url: "https://registry.example",
      // No pubkey → TOFU mode → /registry/pubkey is called on start.
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    const callsAfterFirst = fetchCalls.length;
    expect(callsAfterFirst).toBe(2); // /registry/pubkey + /principals/andreas

    await client.start(); // second invocation must short-circuit
    try {
      expect(fetchCalls.length).toBe(callsAfterFirst);
    } finally {
      client.stop();
    }
  });

  test("TOFU failure at boot is recoverable — subsequent refreshAll() retries the pubkey fetch", async () => {
    // Echo cortex#230 round 1: previously, a transient outage on the
    // initial /registry/pubkey call left the client permanently dead —
    // pinnedPubkey stayed undefined and every cycle bailed at the top.
    // The fix: when in TOFU mode, retry the pubkey fetch at the start
    // of each refreshAll() until it succeeds.
    //
    // The fake registry simulates a registry that's down for the first
    // TWO calls (boot TOFU + boot eager-refresh's retry) and recovers
    // by the third (manual refreshAll). This proves the retry
    // semantics persist beyond start() — not just "TOFU plus one
    // eager-refresh retry then give up".
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    let pubkeyAttempts = 0;
    const fakeFetch: FakeFetchHandler = async (url: string) => {
      if (url.endsWith("/registry/pubkey")) {
        pubkeyAttempts++;
        if (pubkeyAttempts <= 2) {
          return new Response("warming", { status: 503 });
        }
        return jsonResponse({ algorithm: "Ed25519", public_key: kp.publicKeyB64 });
      }
      if (url.endsWith("/principals/andreas")) return jsonResponse(assertion);
      return new Response("nope", { status: 404 });
    };
    const client = new RegistryClient({
      url: "https://registry.example",
      // TOFU mode (no pubkey from config).
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      // After start: 2 TOFU attempts (boot + eager-refresh retry), both
      // failed, cache still empty.
      expect(pubkeyAttempts).toBe(2);
      expect(client.getPrincipal("andreas")).toBeUndefined();
      // Third cycle: TOFU retries and succeeds → cache populates. The
      // client recovered without external intervention.
      await client.refreshAll();
      expect(pubkeyAttempts).toBe(3);
      expect(client.getPrincipal("andreas")).toBeDefined();
    } finally {
      client.stop();
    }
  });
});

describe("RegistryClient — periodic refresh + shutdown", () => {
  test("periodic refresh updates the cache on each cycle", async () => {
    const kp = await generateKeypair();
    let currentPubkey = FAKE_PEER_PUBKEY_V1;
    const fakeFetch: FakeFetchHandler = async (url: string) => {
      if (url.endsWith("/principals/andreas")) {
        const op = makeOperator("andreas", currentPubkey);
        const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);
        return jsonResponse(assertion);
      }
      return new Response("not found", { status: 404 });
    };

    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      // Disable the timer; drive cycles manually via refreshAll().
      // The timer behaviour is exercised by the shutdown test below.
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      expect(client.getPrincipal("andreas")?.operator_pubkey).toBe(FAKE_PEER_PUBKEY_V1);
      // Principal rotates their pubkey upstream.
      currentPubkey = FAKE_PEER_PUBKEY_V2;
      await client.refreshAll();
      expect(client.getPrincipal("andreas")?.operator_pubkey).toBe(FAKE_PEER_PUBKEY_V2);
    } finally {
      client.stop();
    }
  });

  test("stop() cancels the refresh timer", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    const fetchCalls: string[] = [];
    const fakeFetch: FakeFetchHandler = async (url: string) => {
      fetchCalls.push(url);
      if (url.endsWith("/principals/andreas")) return jsonResponse(assertion);
      return new Response("not found", { status: 404 });
    };

    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 25, // very short — would fire if not stopped
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    const callsAfterStart = fetchCalls.length;
    client.stop();

    // Wait several refresh intervals; no further fetches should occur.
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchCalls.length).toBe(callsAfterStart);
  });

  test("concurrent refreshAll() invocations are coalesced — the second call short-circuits while the first is in flight", async () => {
    // Echo cortex#230 round 1: without the in-flight guard, a
    // setInterval tick firing while the previous cycle still drains
    // would reassign `cycleAbort` and orphan the previous controller.
    // We model that by stalling the first fetch on a manually-resolved
    // promise, then invoking `refreshAll()` a second time before the
    // first completes. The fake `fetch` records every call; with the
    // guard the second invocation must NOT issue any GET.
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);

    const fetchCalls: string[] = [];
    let release: (() => void) | undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch: FakeFetchHandler = async (url: string) => {
      fetchCalls.push(url);
      await block;
      return jsonResponse(assertion);
    };
    const errs: string[] = [];
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: (m) => errs.push(m),
    });
    try {
      // Start a refresh cycle; do NOT await — it'll block on `release`.
      const inFlight = client.refreshAll();
      // Yield so the cycle reaches its first fetch and registers the
      // call. Without this microtask boundary the second refreshAll
      // could race the first into the `refreshInFlight = true` set.
      await Promise.resolve();
      // Second invocation while the first is still pending: must
      // short-circuit (no additional fetch).
      await client.refreshAll();
      expect(fetchCalls.length).toBe(1);
      expect(errs.some((e) => e.includes("previous cycle still draining"))).toBe(true);
      // Now release the first cycle and let it complete.
      release?.();
      await inFlight;
      expect(client.getPrincipal("andreas")).toBeDefined();
      // A subsequent refresh after the cycle drained must run normally.
      await client.refreshAll();
      expect(fetchCalls.length).toBe(2);
    } finally {
      release?.();
      client.stop();
    }
  });

  test("invalidate() drops a cache entry; the next refresh repopulates it", async () => {
    const kp = await generateKeypair();
    const op = makeOperator("andreas");
    const assertion = await signAssertion(kp.privateKey, kp.publicKeyB64, op);
    const fakeFetch = makeRouteFetch({
      "/principals/andreas": () => jsonResponse(assertion),
    });

    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: kp.publicKeyB64,
      principalIds: ["andreas"],
      refreshIntervalMs: 0,
      fetch: fakeFetch as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      expect(client.getPrincipal("andreas")).toBeDefined();
      client.invalidate("andreas");
      expect(client.getPrincipal("andreas")).toBeUndefined();
      await client.refreshAll();
      expect(client.getPrincipal("andreas")).toBeDefined();
    } finally {
      client.stop();
    }
  });
});

describe("RegistryClient — empty config", () => {
  test("principalIds=[] makes the client dormant — no fetches, getPrincipal returns undefined", async () => {
    const fetchSpy = mock(async (_url: string) => new Response("nope", { status: 404 }));
    const client = new RegistryClient({
      url: "https://registry.example",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // 43 chars + = = 44
      principalIds: [],
      refreshIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
      logError: () => {},
    });
    await client.start();
    try {
      expect(client.getPrincipal("anyone")).toBeUndefined();
      expect(fetchSpy.mock.calls.length).toBe(0);
    } finally {
      client.stop();
    }
  });
});
