/**
 * S4 (Network Join Control Plane, epic #733) — ADVERSARIAL trust-anchor probes
 * for the boot-path federated-peer resolution, exercised end-to-end through the
 * REAL {@link NetworkRegistryClient} (DD-9 pin+verify) rather than a stub
 * provider. These complement the stub-based unit tests in
 * `resolve-federated-peers-boot.test.ts` by attacking the actual signature /
 * pinning / fail-closed boundary.
 *
 * Folded from the PR #818 adversarial review probe (its passing fail-closed
 * cases — forged signature, MITM pubkey swap, registry 500, malformed JSON —
 * plus the cache-poison probe turned into a real assertion that the NIT-5
 * cache grammar-gate now rejects a poisoned roster pubkey).
 *
 * Every probe asserts the security invariant: an attacker who tampers with the
 * roster, swaps the signer, downs the registry, or poisons the disk cache can
 * NEVER get a peer admitted to the membership gate — the peer is DROPPED
 * (fail-closed), never admitted on attacker-controlled data.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NetworkRegistryClient } from "../network-client";
import { NetworkCache } from "../network-cache";
import { resolveBootFederatedPeers } from "../resolve-federated-peers-boot";
import { canonicalJSON } from "../signing";
import type { Policy } from "../../types/cortex-config";

const NET = "advnet";

// --- crypto helpers ----------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
}

async function genKey(): Promise<{ kp: CryptoKeyPair; pubB64: string }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pubB64: b64(raw) };
}

async function peerPubkey(): Promise<string> {
  return (await genKey()).pubB64; // base64 raw ed25519 (roster surface)
}

async function signAssertion(
  privKey: CryptoKey,
  registryPubB64: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const issued_at = new Date().toISOString();
  const bound = canonicalJSON({ payload, issued_at, registry: registryPubB64 });
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privKey,
      new TextEncoder().encode(bound),
    ),
  );
  return { payload, issued_at, registry: registryPubB64, signature: b64(sig) };
}

/** A route serves either a JSON-able body (signed → 200) or a custom Response. */
type Route = (() => Response) | Record<string, unknown> | unknown[];

/** A `fetch` double serving the descriptor + roster routes. */
function makeFetch(routes: Record<string, Route>): typeof globalThis.fetch {
  return (async (url: string | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    const handler = routes[path];
    if (handler === undefined) return new Response("nf", { status: 404 });
    if (typeof handler === "function") return handler();
    return new Response(JSON.stringify(handler), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "adv-cache-"));
}

function descriptor() {
  return { network_id: NET, hub_url: "nats://h", leaf_port: 4222, members: ["evil"] };
}

function policyWith(
  peers: { principal_id: string; stack_id: string; principal_pubkey?: string }[],
  registryPubkey: string,
): Policy {
  return {
    principals: [],
    federated: {
      registry: { url: "https://reg.example", pubkey: registryPubkey },
      networks: [
        {
          id: NET,
          leaf_node: "primary",
          max_hop: 1,
          accept_subjects: [],
          deny_subjects: [],
          announce_capabilities: [],
          peers,
        },
      ],
    },
  } as unknown as Policy;
}

describe("resolveBootFederatedPeers — adversarial trust anchor (real client)", () => {
  test("forged roster signature (signed by a different key) → peer NOT admitted", async () => {
    const reg = await genKey();
    const attacker = await genKey();
    const peerKey = await peerPubkey();
    const goodDesc = await signAssertion(reg.kp.privateKey, reg.pubB64, descriptor());
    // Roster signed by the ATTACKER's key but CLAIMING reg.pubB64 as the signer.
    const roster = { network_id: NET, members: [{ principal_id: "evil", principal_pubkey: peerKey }] };
    const forged = await signAssertion(attacker.kp.privateKey, reg.pubB64, roster);

    const client = new NetworkRegistryClient({
      url: "https://reg.example",
      pubkey: reg.pubB64, // pinned
      fetch: makeFetch({ [`/networks/${NET}`]: goodDesc, [`/networks/${NET}/roster`]: forged }),
      cacheOptions: { cacheDir: tmpCacheDir() },
    });

    const policy = policyWith([{ principal_id: "evil", stack_id: "evil/s" }], reg.pubB64);
    const res = await resolveBootFederatedPeers(policy, { rosterProvider: client, warn: () => {} });

    const out = res.policy?.federated?.networks[0]?.peers ?? [];
    expect(out.find((p) => p.principal_id === "evil")).toBeUndefined(); // dropped
    expect(res.errors.some((e) => e.principalId === "evil")).toBe(true);
  });

  test("MITM swaps the signer (valid sig under attacker's pinned-claimed key) → peer NOT admitted", async () => {
    const realReg = await genKey();
    const mitm = await genKey();
    const peerKey = await peerPubkey();
    // MITM serves fully valid assertions under ITS OWN key (registry field = mitm).
    const dDesc = await signAssertion(mitm.kp.privateKey, mitm.pubB64, descriptor());
    const dRost = await signAssertion(mitm.kp.privateKey, mitm.pubB64, {
      network_id: NET,
      members: [{ principal_id: "evil", principal_pubkey: peerKey }],
    });

    const client = new NetworkRegistryClient({
      url: "https://reg.example",
      pubkey: realReg.pubB64, // principal pinned the REAL registry
      fetch: makeFetch({ [`/networks/${NET}`]: dDesc, [`/networks/${NET}/roster`]: dRost }),
      cacheOptions: { cacheDir: tmpCacheDir() },
    });

    const policy = policyWith([{ principal_id: "evil", stack_id: "evil/s" }], realReg.pubB64);
    const res = await resolveBootFederatedPeers(policy, { rosterProvider: client, warn: () => {} });

    expect(res.policy?.federated?.networks[0]?.peers.find((p) => p.principal_id === "evil")).toBeUndefined();
  });

  test("registry 500 + no cache → fail-CLOSED (pubkey-less peer dropped)", async () => {
    const reg = await genKey();
    const client = new NetworkRegistryClient({
      url: "https://reg.example",
      pubkey: reg.pubB64,
      fetch: makeFetch({
        [`/networks/${NET}`]: () => new Response("err", { status: 500 }),
        [`/networks/${NET}/roster`]: () => new Response("err", { status: 500 }),
      }),
      cacheOptions: { cacheDir: tmpCacheDir() },
    });
    const policy = policyWith([{ principal_id: "evil", stack_id: "evil/s" }], reg.pubB64);
    const res = await resolveBootFederatedPeers(policy, { rosterProvider: client, warn: () => {} });

    expect(res.policy?.federated?.networks[0]?.peers.length).toBe(0); // dropped
    expect(res.errors.some((e) => e.kind === "unresolved")).toBe(true);
  });

  test("malformed JSON body → never throws, fail-closed", async () => {
    const reg = await genKey();
    const client = new NetworkRegistryClient({
      url: "https://reg.example",
      pubkey: reg.pubB64,
      fetch: makeFetch({
        [`/networks/${NET}`]: () => new Response("{not json", { status: 200 }),
        [`/networks/${NET}/roster`]: () => new Response("{not json", { status: 200 }),
      }),
      cacheOptions: { cacheDir: tmpCacheDir() },
    });
    const policy = policyWith([{ principal_id: "evil", stack_id: "evil/s" }], reg.pubB64);
    const res = await resolveBootFederatedPeers(policy, { rosterProvider: client, warn: () => {} });

    expect(res.policy?.federated?.networks[0]?.peers.length).toBe(0);
  });

  test("NIT-5 — a disk-cache record with a MALFORMED roster pubkey is rejected (grammar-gate)", async () => {
    // Hand-write a cache record with a peer pubkey that is NOT base64 ed25519.
    // parseRoster would reject this on the network path; after the NIT-5 fix the
    // on-disk reader (`NetworkCache.load` → isCachedNetwork) rejects it too, so a
    // poison key can never be served to a future cache consumer.
    const cacheDir = tmpCacheDir();
    const cache = new NetworkCache({ cacheDir, logError: () => {} });
    const poison = {
      schema_version: 1,
      cached_at: new Date().toISOString(),
      descriptor: descriptor(),
      roster: { network_id: NET, members: [{ principal_id: "evil", principal_pubkey: "<<<not-a-key>>>" }] },
    };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${NET}.json`), JSON.stringify(poison));

    // The poison record is treated as corrupt → load returns undefined.
    expect(cache.load(NET)).toBeUndefined();
  });

  test("NIT-5 — a well-formed cache record (valid base64 ed25519) still loads", async () => {
    // Guard against over-tightening: a legitimately-cached roster must still load.
    const cacheDir = tmpCacheDir();
    const cache = new NetworkCache({ cacheDir, logError: () => {} });
    const goodKey = await peerPubkey();
    const ok = {
      schema_version: 1,
      cached_at: new Date().toISOString(),
      descriptor: descriptor(),
      roster: { network_id: NET, members: [{ principal_id: "evil", principal_pubkey: goodKey }] },
    };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${NET}.json`), JSON.stringify(ok));

    const loaded = cache.load(NET);
    expect(loaded?.roster.members[0]?.principal_pubkey).toBe(goodKey);
  });
});
