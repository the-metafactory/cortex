/**
 * S1 (#735 · spec §6 F1) — NetworkRegistryClient tests.
 *
 * Covers the AC + the S1 brief's required cases, all against a STUB registry
 * (an injected `fetch` closure + a real Ed25519 sign-side) — NO network I/O:
 *
 *   1. valid signed descriptor parse (DD-12)
 *   2. valid signed roster parse
 *   3. bad-signature → rejected (the load-bearing DD-9 test)
 *   4. registry-pubkey mismatch → rejected (DD-9)
 *   5. unknown-network 404 handling
 *   6. cache write-after-verify + loadCached read (DD-10)
 *   7. cache is NOT written when verification fails (DD-10 trust boundary)
 *   8. unreachable transport → distinguished from not_found / unverified
 *
 * The sign-side mirrors `client.test.ts`: a fresh WebCrypto Ed25519 keypair
 * signs `canonicalJSON({ payload, issued_at, registry })`, the exact triple
 * the registry's `signAssertion` binds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { NetworkRegistryClient } from "../network-client";
import { canonicalJSON } from "../signing";
import type {
  NetworkDescriptor,
  NetworkRosterResult,
  SignedAssertion,
} from "../types";

// =============================================================================
// Sign-side test helpers (the client only verifies).
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

/** A structurally-valid base64 Ed25519 peer pubkey (44 chars). */
const PEER_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function makeDescriptor(networkId: string): NetworkDescriptor {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    members: ["andreas", "jc"],
  };
}

function makeRoster(networkId: string): NetworkRosterResult {
  return {
    network_id: networkId,
    members: [
      { principal_id: "andreas", stack_id: "andreas/meta-factory", principal_pubkey: PEER_PUBKEY },
      { principal_id: "jc", principal_pubkey: PEER_PUBKEY },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type RouteMap = Record<string, () => Promise<Response> | Response>;

/** Match by URL suffix so route keys can be short ("/networks/iaw"). */
function routeFetch(routes: RouteMap): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const noopLog = (): void => {
  /* swallow in tests; assertions cover behaviour, not log text */
};

// =============================================================================
// Fixtures
// =============================================================================

const NET = "iaw";
let registryPubkey: string;
let registryPrivate: CryptoKey;
let tmp: string;

beforeEach(async () => {
  const kp = await generateKeypair();
  registryPubkey = kp.publicKeyB64;
  registryPrivate = kp.privateKey;
  tmp = mkdtempSync(join(tmpdir(), "cortex-net-cache-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeClient(routes: RouteMap): NetworkRegistryClient {
  return new NetworkRegistryClient({
    url: "https://registry.example",
    pubkey: registryPubkey, // config-pinned (DD-9) — no TOFU
    fetch: routeFetch(routes),
    logError: noopLog,
    cacheOptions: { cacheDir: tmp, logError: noopLog },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("NetworkRegistryClient — descriptor (DD-12)", () => {
  test("parses a valid signed descriptor", async () => {
    const assertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const client = makeClient({ [`/networks/${NET}`]: () => jsonResponse(assertion) });

    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.hub_url).toBe("tls://hub.meta-factory.ai:7422");
      expect(result.value.leaf_port).toBe(7422);
      expect(result.value.members).toEqual(["andreas", "jc"]);
    }
  });

  test("rejects a descriptor with a BAD signature (DD-9)", async () => {
    const assertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    // Tamper the payload AFTER signing — the signature no longer covers it.
    const tampered: typeof assertion = {
      ...assertion,
      payload: { ...assertion.payload, hub_url: "tls://evil.example:7422" },
    };
    const client = makeClient({ [`/networks/${NET}`]: () => jsonResponse(tampered) });

    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("unverified");
    if (result.status === "unverified") expect(result.reason).toBe("bad_signature");
  });

  test("rejects a descriptor signed by the WRONG registry key (pin mismatch, DD-9)", async () => {
    const attacker = await generateKeypair();
    // Attacker signs a valid-looking assertion with THEIR key + stamps THEIR
    // pubkey as `registry`. The pin is the real registry's key.
    const assertion = await signAssertion(
      attacker.privateKey,
      attacker.publicKeyB64,
      makeDescriptor(NET),
    );
    const client = makeClient({ [`/networks/${NET}`]: () => jsonResponse(assertion) });

    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("unverified");
    if (result.status === "unverified") expect(result.reason).toBe("registry_pubkey_mismatch");
  });

  test("returns not_found on a 404 (unknown network)", async () => {
    const client = makeClient({
      [`/networks/${NET}`]: () => jsonResponse({ error: "not_found" }, 404),
    });
    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("not_found");
  });

  test("returns unreachable on a transport error (distinct from not_found)", async () => {
    const client = new NetworkRegistryClient({
      url: "https://registry.example",
      pubkey: registryPubkey,
      fetch: (() =>
        Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch,
      logError: noopLog,
      cacheOptions: { cacheDir: tmp, logError: noopLog },
    });
    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("unreachable");
  });

  test("rejects a verified-but-wrong-shape payload as unverified", async () => {
    // Registry signs garbage (no hub_url). Signature verifies, shape doesn't.
    const assertion = await signAssertion(registryPrivate, registryPubkey, {
      network_id: NET,
      members: [],
    });
    const client = makeClient({ [`/networks/${NET}`]: () => jsonResponse(assertion) });
    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("unverified");
  });
});

describe("NetworkRegistryClient — roster", () => {
  test("parses a valid signed roster", async () => {
    const assertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const client = makeClient({ [`/networks/${NET}/roster`]: () => jsonResponse(assertion) });

    const result = await client.getNetworkRoster(NET);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.members).toHaveLength(2);
      expect(result.value.members[0]).toEqual({
        principal_id: "andreas",
        stack_id: "andreas/meta-factory",
        principal_pubkey: PEER_PUBKEY,
      });
      // Second member has no stack_id — optional field omitted.
      expect(result.value.members[1]?.stack_id).toBeUndefined();
    }
  });

  test("rejects a roster with a BAD signature (DD-9)", async () => {
    const assertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const tampered: typeof assertion = {
      ...assertion,
      payload: {
        ...assertion.payload,
        members: [{ principal_id: "evil", principal_pubkey: PEER_PUBKEY }],
      },
    };
    const client = makeClient({ [`/networks/${NET}/roster`]: () => jsonResponse(tampered) });

    const result = await client.getNetworkRoster(NET);
    expect(result.status).toBe("unverified");
    if (result.status === "unverified") expect(result.reason).toBe("bad_signature");
  });

  test("rejects a roster whose peer pubkey is not base64-Ed25519", async () => {
    const bad: NetworkRosterResult = {
      network_id: NET,
      members: [{ principal_id: "andreas", principal_pubkey: "not-a-key" }],
    };
    const assertion = await signAssertion(registryPrivate, registryPubkey, bad);
    const client = makeClient({ [`/networks/${NET}/roster`]: () => jsonResponse(assertion) });
    const result = await client.getNetworkRoster(NET);
    expect(result.status).toBe("unverified");
  });
});

describe("NetworkRegistryClient — disk cache (DD-10)", () => {
  test("fetchAndCache persists a verified pair; loadCached reads it back", async () => {
    const descAssertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const rosterAssertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const client = makeClient({
      [`/networks/${NET}/roster`]: () => jsonResponse(rosterAssertion),
      [`/networks/${NET}`]: () => jsonResponse(descAssertion),
    });

    const fetched = await client.fetchAndCache(NET);
    expect(fetched.status).toBe("ok");

    const cached = client.loadCached(NET);
    expect(cached).toBeDefined();
    expect(cached?.descriptor.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(cached?.roster.members).toHaveLength(2);
  });

  test("loadCached survives a fresh client instance (true disk persistence)", async () => {
    const descAssertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const rosterAssertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const writer = makeClient({
      [`/networks/${NET}/roster`]: () => jsonResponse(rosterAssertion),
      [`/networks/${NET}`]: () => jsonResponse(descAssertion),
    });
    await writer.fetchAndCache(NET);

    // A brand-new client (no in-memory state) reading the same cache dir.
    const reader = makeClient({});
    const cached = reader.loadCached(NET);
    expect(cached?.descriptor.leaf_port).toBe(7422);
  });

  test("does NOT cache when the descriptor fails verification (DD-9 trust boundary)", async () => {
    const descAssertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const tampered: typeof descAssertion = {
      ...descAssertion,
      payload: { ...descAssertion.payload, hub_url: "tls://evil.example:7422" },
    };
    const rosterAssertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const client = makeClient({
      [`/networks/${NET}/roster`]: () => jsonResponse(rosterAssertion),
      [`/networks/${NET}`]: () => jsonResponse(tampered),
    });

    const fetched = await client.fetchAndCache(NET);
    expect(fetched.status).toBe("unverified");
    // Nothing should have been written — the verification gate is upstream of
    // the cache write.
    expect(client.loadCached(NET)).toBeUndefined();
  });

  test("does NOT cache when only the descriptor verifies but the roster does not", async () => {
    const descAssertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const rosterAssertion = await signAssertion(registryPrivate, registryPubkey, makeRoster(NET));
    const tamperedRoster: typeof rosterAssertion = {
      ...rosterAssertion,
      payload: {
        ...rosterAssertion.payload,
        members: [{ principal_id: "evil", principal_pubkey: PEER_PUBKEY }],
      },
    };
    const client = makeClient({
      [`/networks/${NET}/roster`]: () => jsonResponse(tamperedRoster),
      [`/networks/${NET}`]: () => jsonResponse(descAssertion),
    });

    const fetched = await client.fetchAndCache(NET);
    expect(fetched.status).toBe("unverified");
    expect(client.loadCached(NET)).toBeUndefined();
  });

  test("loadCached returns undefined when nothing is cached", async () => {
    const client = makeClient({});
    expect(client.loadCached("never-fetched")).toBeUndefined();
  });
});

describe("NetworkRegistryClient — TOFU + unconfigured", () => {
  test("rejects an 'unconfigured' registry assertion", async () => {
    // Registry has no signing key → sentinel registry field + empty sig.
    const unconfigured = {
      payload: makeDescriptor(NET),
      issued_at: new Date().toISOString(),
      registry: "unconfigured",
      signature: "",
    };
    // Pin a real key so the mismatch path isn't what triggers; the sentinel
    // is caught first only when pinned===sentinel, so test TOFU instead:
    const client = new NetworkRegistryClient({
      url: "https://registry.example",
      // No pubkey → TOFU. Registry returns the unconfigured sentinel pubkey.
      fetch: routeFetch({
        "/registry/pubkey": () => jsonResponse({ algorithm: "Ed25519", public_key: "unconfigured" }),
        [`/networks/${NET}`]: () => jsonResponse(unconfigured),
      }),
      logError: noopLog,
      cacheOptions: { cacheDir: tmp, logError: noopLog },
    });

    const result = await client.getNetworkDescriptor(NET);
    // TOFU refused the unconfigured pubkey → no pin → unreachable.
    expect(result.status).toBe("unreachable");
  });

  test("TOFU pins the registry pubkey then verifies", async () => {
    const descAssertion = await signAssertion(registryPrivate, registryPubkey, makeDescriptor(NET));
    const client = new NetworkRegistryClient({
      url: "https://registry.example",
      // No config pin → TOFU discovers the real key.
      fetch: routeFetch({
        "/registry/pubkey": () => jsonResponse({ algorithm: "Ed25519", public_key: registryPubkey }),
        [`/networks/${NET}`]: () => jsonResponse(descAssertion),
      }),
      logError: noopLog,
      cacheOptions: { cacheDir: tmp, logError: noopLog },
    });

    const result = await client.getNetworkDescriptor(NET);
    expect(result.status).toBe("ok");
  });
});
