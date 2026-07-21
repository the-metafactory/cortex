/**
 * TC-2b (cortex#634) — MultiPrincipalIdentityRegistry tests.
 *
 * Covers the spec matrix:
 *
 *   1. Back-compat — single boot principal still resolves as before
 *      (no resolver wired; only the pinned boot entry is available).
 *   2. Multi-principal — register/resolve principals A and B, both
 *      retrievable, no cross-contamination.
 *   3. On-demand resolve populates the map via the resolver; second
 *      lookup is a cache hit (no re-resolve).
 *   4. Posture OFF — peer lookup performs ZERO registry I/O; only the
 *      boot entry is available.
 *   5. Unresolved peer → negative outcome, NOT a throw; the local boot
 *      entry is never overwritten.
 *
 * The on-demand end-to-end test drives a real TC-2a `PrincipalPubkeyResolver`
 * against an EPHEMERAL `Bun.serve({ port: 0 })` registry stub — never a
 * hardcoded port (the #671 de-flake). The remaining tests inject a tiny
 * resolver stub so the cache / posture / negative paths are deterministic
 * and I/O-free.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  classExplicitResolvedPeerDid,
  MultiPrincipalIdentityRegistry,
  type RegistryResolveOutcome,
} from "../identity-registry";
import { PrincipalPubkeyResolver, type ResolveResult } from "../resolve-pubkey";
import { canonicalJSON } from "../signing";
import type { Identity } from "@the-metafactory/myelin/identity";

// =============================================================================
// Fixtures
// =============================================================================

// A structurally-valid base64 Ed25519 pubkey (44 chars w/ padding).
const PEER_PUBKEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PEER_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const BOOT_PUBKEY = "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M=";

function bootIdentity(principalId: string): Identity {
  return {
    id: `did:mf:${principalId}`,
    display_name: principalId,
    network: principalId,
    public_key: BOOT_PUBKEY,
    type: "agent",
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Minimal resolver stub implementing `Pick<PrincipalPubkeyResolver,
 * "resolve">`. Drives the registry's resolve matrix without any I/O.
 * Counts calls so cache-hit tests can assert no re-resolve.
 */
function makeResolverStub(
  responses: Record<string, ResolveResult>,
  fallback: ResolveResult = { status: "unresolved" },
): {
  resolve: (id: string, stackId?: string) => Promise<ResolveResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    resolve(id: string, stackId?: string): Promise<ResolveResult> {
      // C-787 — a stack-aware lookup keys on `"{id} {stack}"` (falling back to
      // the bare id), mirroring the real per-stack resolver. The bare id is
      // recorded in `calls` so existing cache-hit assertions are unchanged.
      calls.push(id);
      const key = stackId === undefined ? id : `${id} ${stackId}`;
      return Promise.resolve(responses[key] ?? responses[id] ?? fallback);
    },
  };
}

// =============================================================================
// 1. Back-compat — single boot principal, no resolver
// =============================================================================

describe("back-compat (single-principal)", () => {
  test("boot principal resolves synchronously and via resolve()", async () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });

    const got = reg.get("boot");
    expect(got).toBeDefined();
    expect(got?.provenance).toBe("local-boot");
    expect(got?.identity.public_key).toBe(BOOT_PUBKEY);

    const resolved = await reg.resolve("boot");
    expect(resolved.resolved).toBe(true);
    if (resolved.resolved) {
      expect(resolved.entry.principalId).toBe("boot");
      expect(resolved.entry.provenance).toBe("local-boot");
    }
  });

  test("materialised myelin registry contains exactly the boot identity", () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });
    const myelin = reg.toIdentityRegistry();
    expect(myelin.list()).toHaveLength(1);
    expect(myelin.resolve("did:mf:boot")?.public_key).toBe(BOOT_PUBKEY);
  });

  test("unknown peer with no resolver is inert (disabled), no boot mutation", async () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });
    const outcome = await reg.resolve("stranger");
    expect(outcome).toEqual({ resolved: false, reason: "disabled" });
    expect(reg.get("stranger")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});

// =============================================================================
// 2. Multi-principal — A and B, no cross-contamination
// =============================================================================

describe("multi-principal", () => {
  test("resolves A and B; both retrievable; no cross-contamination", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
      bob: { status: "resolved", principalPubkey: PEER_PUBKEY_B },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const a = await reg.resolve("alice");
    const b = await reg.resolve("bob");

    expect(a.resolved).toBe(true);
    expect(b.resolved).toBe(true);
    if (a.resolved) expect(a.entry.identity.public_key).toBe(PEER_PUBKEY_A);
    if (b.resolved) expect(b.entry.identity.public_key).toBe(PEER_PUBKEY_B);

    // No cross-contamination: A's pubkey stays A's, B's stays B's.
    expect(reg.get("alice")?.identity.public_key).toBe(PEER_PUBKEY_A);
    expect(reg.get("bob")?.identity.public_key).toBe(PEER_PUBKEY_B);
    expect(reg.get("alice")?.identity.id).toBe("did:mf:alice");
    expect(reg.get("bob")?.identity.id).toBe("did:mf:bob");
    expect(reg.get("alice")?.provenance).toBe("resolved-registry");

    // Boot + 2 peers materialise into the myelin registry.
    const myelin = reg.toIdentityRegistry();
    expect(myelin.list()).toHaveLength(3);
    expect(myelin.resolve("did:mf:alice")?.public_key).toBe(PEER_PUBKEY_A);
    expect(myelin.resolve("did:mf:bob")?.public_key).toBe(PEER_PUBKEY_B);
    expect(myelin.resolve("did:mf:boot")?.public_key).toBe(BOOT_PUBKEY);
  });

  test("peerNetwork override stamps the resolved Identity.network", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      peerNetwork: () => "shared-net",
    });
    const a = await reg.resolve("alice");
    if (a.resolved) expect(a.entry.identity.network).toBe("shared-net");
    // Default would have been the peer's own id.
    expect(reg.get("alice")?.identity.network).toBe("shared-net");
  });
});

// =============================================================================
// 3. On-demand resolve populates the map; cache hit on second lookup
// =============================================================================

describe("on-demand resolve + cache", () => {
  test("second resolve is a cache hit — resolver not consulted twice", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const first = await reg.resolve("alice");
    expect(first.resolved).toBe(true);
    expect(stub.calls).toEqual(["alice"]);

    // Synchronous get now hits the populated map.
    expect(reg.get("alice")?.identity.public_key).toBe(PEER_PUBKEY_A);

    const second = await reg.resolve("alice");
    expect(second.resolved).toBe(true);
    // Resolver consulted exactly once across both resolves.
    expect(stub.calls).toEqual(["alice"]);
  });

  test("end-to-end through a real resolver + ephemeral registry stub", async () => {
    const kp = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const stub = startRegistryStub({
      registryPubkey: kp.publicKeyB64,
      sign: (payload) => signAssertion(kp.privateKey, kp.publicKeyB64, payload),
      counter,
    });
    serversToStop.push(stub.stop);

    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl: stub.baseUrl,
      registryPubkey: kp.publicKeyB64,
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver,
    });

    // Miss → on-demand resolve populates the map.
    expect(reg.get("alice")).toBeUndefined();
    const outcome = await reg.resolve("alice");
    expect(outcome.resolved).toBe(true);
    if (outcome.resolved) {
      expect(outcome.entry.provenance).toBe("resolved-registry");
      expect(outcome.entry.identity.id).toBe("did:mf:alice");
    }
    expect(counter.principals).toBe(1);

    // Cache hit: second resolve does not re-fetch the registry.
    await reg.resolve("alice");
    expect(counter.principals).toBe(1);

    // The materialised myelin registry now carries the resolved peer.
    expect(reg.toIdentityRegistry().resolve("did:mf:alice")).not.toBeNull();
  });
});

// =============================================================================
// 4. Posture OFF — zero I/O, only boot entry available
// =============================================================================

describe("posture OFF", () => {
  test("disabled resolver performs ZERO registry I/O", async () => {
    let fetchCalls = 0;
    const resolver = new PrincipalPubkeyResolver({
      enabled: false, // signing !== "enforce"
      baseUrl: "http://127.0.0.1:1", // never reached
      registryPubkey: BOOT_PUBKEY,
      fetch: ((..._args: Parameters<typeof fetch>) => {
        fetchCalls++;
        return Promise.reject(new Error("network must not be touched when OFF"));
      }) as typeof fetch,
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver,
    });

    const outcome = await reg.resolve("alice");
    expect(outcome).toEqual({ resolved: false, reason: "disabled" });
    expect(fetchCalls).toBe(0);

    // Only the boot entry is available.
    expect(reg.get("alice")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
    expect(reg.get("boot")?.provenance).toBe("local-boot");
  });
});

// =============================================================================
// 5. Unresolved / not_found peer → negative, never a throw; boot untouched
// =============================================================================

describe("negative paths (no throw, boot anchor preserved)", () => {
  test("unresolved peer → reason 'unresolved', not cached, boot intact", async () => {
    const stub = makeResolverStub(
      {},
      { status: "unresolved" }, // every miss is unresolved
    );
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      logError: () => {}, // negative-path logging is asserted by behaviour, not stderr
    });

    const outcome = await reg.resolve("ghost");
    expect(outcome).toEqual({ resolved: false, reason: "unresolved" });
    // Negative not cached — re-resolve consults the resolver again.
    expect(reg.get("ghost")).toBeUndefined();
    await reg.resolve("ghost");
    expect(stub.calls).toEqual(["ghost", "ghost"]);

    // Boot anchor untouched.
    expect(reg.get("boot")?.identity.public_key).toBe(BOOT_PUBKEY);
    expect(reg.list()).toHaveLength(1);
  });

  test("not_found peer → reason 'not_found', not cached", async () => {
    const stub = makeResolverStub({ ghost: { status: "not_found" } });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      logError: () => {}, // negative-path logging is asserted by behaviour
    });
    const outcome: RegistryResolveOutcome = await reg.resolve("ghost");
    expect(outcome).toEqual({ resolved: false, reason: "not_found" });
    expect(reg.get("ghost")).toBeUndefined();
  });

  test("resolver returning the boot id does NOT overwrite the boot anchor", async () => {
    // A misbehaving / hostile resolver tries to re-stamp the boot principal
    // with a different pubkey. The pinned boot entry must win.
    const stub = makeResolverStub({
      boot: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    // get() always returns the pinned boot entry without consulting resolver.
    expect(reg.get("boot")?.identity.public_key).toBe(BOOT_PUBKEY);
    // resolve() returns the pinned entry (cache hit) — resolver never called.
    const outcome = await reg.resolve("boot");
    expect(outcome.resolved).toBe(true);
    if (outcome.resolved) {
      expect(outcome.entry.provenance).toBe("local-boot");
      expect(outcome.entry.identity.public_key).toBe(BOOT_PUBKEY);
    }
    expect(stub.calls).toEqual([]); // boot is a cache hit, no resolver I/O
    expect(reg.list()).toHaveLength(1);
  });
});

// =============================================================================
// DID-collision attack — boot anchor displacement at materialisation
// =============================================================================

describe("DID-collision attack (boot anchor displacement)", () => {
  // The internal map is keyed by principalId, but the materialised myelin
  // registry the verifier consumes is keyed by DID and is last-write-wins.
  // `peerDid(p) = did:mf:<p>` is injective over principalId, so two peers can
  // never collide — the ONLY reachable collision is peer-vs-boot, because the
  // boot DID is a caller-supplied STACK DID (`did:mf:<principal>-<stack>`),
  // independent of the boot principalId. A peer registering the hyphenated id
  // `andreas-meta-factory` yields `did:mf:andreas-meta-factory`, colliding with
  // a boot stack DID of the same form. That peer must be REFUSED, or a registry
  // compromise could shadow the out-of-band boot anchor in the verify registry.

  // Boot whose principalId ("boot") differs from its DID (a stack-DID form),
  // so a peer with a distinct principalId can collide on the DID.
  function bootWithStackDid(): Identity {
    return {
      id: "did:mf:andreas-meta-factory",
      display_name: "boot",
      network: "andreas",
      public_key: BOOT_PUBKEY,
      type: "agent",
      created_at: new Date(0).toISOString(),
    };
  }

  test("peer whose DID collides with the boot DID is refused; boot pubkey preserved in BOTH key spaces", async () => {
    const stub = makeResolverStub({
      "andreas-meta-factory": {
        status: "resolved",
        principalPubkey: PEER_PUBKEY_A,
      },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootWithStackDid() },
      resolver: stub,
    });

    // Distinct principalId → NOT a boot cache-hit → reaches the resolver →
    // the DID-collision guard fires (proves it's the guard, not the map cache).
    const outcome = await reg.resolve("andreas-meta-factory");
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) expect(outcome.reason).toBe("unresolved");
    expect(stub.calls).toEqual(["andreas-meta-factory"]); // resolver WAS consulted

    // principalId map: the collision entry was never stored.
    expect(reg.get("andreas-meta-factory")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);

    // DID-keyed materialised registry: the boot pubkey survives, NOT the peer's.
    const myelin = reg.toIdentityRegistry();
    expect(myelin.list()).toHaveLength(1);
    expect(myelin.resolve("did:mf:andreas-meta-factory")?.public_key).toBe(
      BOOT_PUBKEY,
    );
  });

  test("a non-colliding peer alongside a stack-DID boot still resolves normally", async () => {
    // Guard is a precise equality check on the boot DID — it must not reject
    // legitimate peers that merely share a principal prefix.
    const stub = makeResolverStub({
      andreas: { status: "resolved", principalPubkey: PEER_PUBKEY_B },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootWithStackDid() },
      resolver: stub,
    });

    const outcome = await reg.resolve("andreas"); // did:mf:andreas ≠ boot DID
    expect(outcome.resolved).toBe(true);
    expect(reg.get("andreas")?.identity.public_key).toBe(PEER_PUBKEY_B);
    const myelin = reg.toIdentityRegistry();
    expect(myelin.resolve("did:mf:andreas")?.public_key).toBe(PEER_PUBKEY_B);
    expect(myelin.resolve("did:mf:andreas-meta-factory")?.public_key).toBe(
      BOOT_PUBKEY,
    );
  });
});

// =============================================================================
// C-787 — per-stack peer resolution
// =============================================================================

describe("C-787 — per-stack peer resolution", () => {
  test("resolveFederatedPeer threads the stack and returns that stack's pubkey", async () => {
    const stub = makeResolverStub({
      "andreas andreas/community": { status: "resolved", principalPubkey: PEER_PUBKEY_B },
      "andreas andreas/meta-factory": { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const community = await reg.resolveFederatedPeer("andreas", "andreas/community");
    expect(community.resolved).toBe(true);
    if (community.resolved) {
      expect(community.identity.public_key).toBe(PEER_PUBKEY_B);
      // Federated stamp DID is principal-level even for a per-stack resolve.
      expect(community.identity.id).toBe("did:mf:andreas");
    }
  });

  test("the same principal's two stacks cache distinct pubkeys (no clobber)", async () => {
    const stub = makeResolverStub({
      "andreas andreas/community": { status: "resolved", principalPubkey: PEER_PUBKEY_B },
      "andreas andreas/meta-factory": { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const mf = await reg.resolveFederatedPeer("andreas", "andreas/meta-factory");
    const community = await reg.resolveFederatedPeer("andreas", "andreas/community");
    expect(mf.resolved && mf.identity.public_key).toBe(PEER_PUBKEY_A);
    expect(community.resolved && community.identity.public_key).toBe(PEER_PUBKEY_B);

    // Both stacks are cached independently under per-stack entry keys.
    expect(reg.get("andreas andreas/meta-factory")?.identity.public_key).toBe(PEER_PUBKEY_A);
    expect(reg.get("andreas andreas/community")?.identity.public_key).toBe(PEER_PUBKEY_B);
  });

  test("resolveFederatedPeer without a stack falls back to the bare-principal resolve", async () => {
    const stub = makeResolverStub({
      andreas: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });
    const out = await reg.resolveFederatedPeer("andreas");
    expect(out.resolved && out.identity.public_key).toBe(PEER_PUBKEY_A);
  });
});

// =============================================================================
// WP-6 (#1882) / ADR-0025 — STAGED class-explicit resolved-peer relabel.
//
// `classExplicitResolvedPeerDid` is the flag-day-R relabel, computed + proven
// against ./wire NOW but SELECTED by `resolve()` only when
// `RESOLVED_PEER_DID_CLASS_EXPLICIT` flips at R. These tests vet the relabel
// logic so the flag-day change is a one-const flip, not net-new trust-path
// code. The `resolve()` byte-identical pre-cut behaviour is proven LIVE by the
// C-787 tests above (they still assert the flat `did:mf:andreas` stamp).
// =============================================================================

describe("WP-6 — classExplicitResolvedPeerDid (staged flag-day relabel)", () => {
  test("renders the class-explicit STACK DID from a qualified {principal}/{stack}", () => {
    expect(classExplicitResolvedPeerDid("jc", "jc/sage-host")).toBe(
      "did:mf:stack.jc.sage-host",
    );
    expect(
      classExplicitResolvedPeerDid("andreas", "andreas/meta-factory"),
    ).toBe("did:mf:stack.andreas.meta-factory");
  });

  test("the class-explicit stack DID never collides with the flat principal DID (injective by construction)", () => {
    // The whole point of ADR-0025 option (C): the flat encoding made
    // `principalDid("andreas-meta-factory") === "did:mf:andreas-meta-factory"`
    // collide with the stack `andreas/meta-factory`. The class tag + dot-form
    // makes them structurally distinct, so the boot-anchor displacement the
    // `resolve()` SECURITY refuse guards against is not constructible.
    const stackDid = classExplicitResolvedPeerDid(
      "andreas",
      "andreas/meta-factory",
    );
    const flatPrincipalCollision = "did:mf:andreas-meta-factory";
    expect(stackDid).not.toBe(flatPrincipalCollision);
    // And a hyphenated principal id still renders a distinct, well-formed DID.
    expect(
      classExplicitResolvedPeerDid("andreas-meta-factory", "andreas-meta-factory/prod"),
    ).toBe("did:mf:stack.andreas-meta-factory.prod");
  });

  test("no stack id → undefined (root/principal-level resolve falls back to the flat principal stamp)", () => {
    expect(classExplicitResolvedPeerDid("andreas", undefined)).toBeUndefined();
  });

  test("a BARE stack slug (not the qualified {principal}/{stack}) → undefined (WP-1 trap: the seam threads the qualified pair)", () => {
    expect(classExplicitResolvedPeerDid("andreas", "meta-factory")).toBeUndefined();
  });

  test("anti-spoof: a qualified pair whose principal disagrees with the resolved principal → undefined (never stamp under another principal's name)", () => {
    expect(
      classExplicitResolvedPeerDid("jc", "andreas/meta-factory"),
    ).toBeUndefined();
  });

  test("an ungrammatical stack slug → undefined (fail-closed via the ./wire codec)", () => {
    // Trailing hyphen is kebab-strict-illegal; the codec rejects, we fall back.
    expect(classExplicitResolvedPeerDid("andreas", "andreas/bad-")).toBeUndefined();
    // Uppercase is illegal too.
    expect(classExplicitResolvedPeerDid("andreas", "andreas/Prod")).toBeUndefined();
  });
});

// =============================================================================
// Ed25519 sign-side helpers + ephemeral registry stub (mirrors
// resolve-pubkey.test.ts — Bun.serve({ port: 0 }), never a hardcoded port).
// =============================================================================

const serversToStop: (() => void)[] = [];
afterEach(() => {
  while (serversToStop.length > 0) {
    const stop = serversToStop.pop();
    if (stop) stop();
  }
});

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

interface RegistryStubOptions {
  registryPubkey: string;
  sign: (payload: PrincipalPayload) => Promise<unknown>;
  counter: { principals: number; pubkey: number };
}

function startRegistryStub(opts: RegistryStubOptions): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0, // ephemeral — OS assigns a free port (#671 de-flake pattern)
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/registry/pubkey") {
        opts.counter.pubkey++;
        return Response.json({
          algorithm: "Ed25519",
          public_key: opts.registryPubkey,
        });
      }
      const match = /^\/principals\/(.+)$/.exec(url.pathname);
      if (match) {
        opts.counter.principals++;
        const principalId = decodeURIComponent(match[1] ?? "");
        const payload: PrincipalPayload = {
          principal_id: principalId,
          principal_pubkey: PEER_PUBKEY_A,
          stacks: [{ stack_id: `${principalId}/laptop` }],
          capabilities: [],
          updated_at: new Date().toISOString(),
        };
        return Response.json(await opts.sign(payload));
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: server.url.toString(),
    stop: () => {
      server.stop(true);
    },
  };
}
