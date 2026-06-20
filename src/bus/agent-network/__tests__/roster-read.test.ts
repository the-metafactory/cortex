/**
 * P1 (cortex#1086) — resolveNetworkRoster unit tests.
 *
 * Tests the runtime-callable registry-roster read in isolation against a FAKE
 * registry client (just the two methods the lib consumes). The verified-fetch
 * + DD-9 signing path is the {@link NetworkRegistryClient}'s own contract
 * (covered by network-client.test.ts); here we test the LIFTED orchestration:
 *
 *   1. resolve — ok fetch → projected peers (local principal excluded, wire +
 *      config views, nkey re-encode / leave-off).
 *   2. 0-peers guard (#762) — empty roster → `emptyRoster: true`, `peers: []`,
 *      `ok: true` (NOT an error: an empty roster is the common early state).
 *   3. registry-unreachable → cached (DD-10) — `unreachable` fetch falls back
 *      to `loadCached`; `usedCache: true`. No cache → `unreachable_uncached`.
 *   4. definitive negatives — `not_found` / `unverified` surface as `ok: false`
 *      without touching the cache.
 *
 * Design: docs/design-roster-driven-federation-wiring.md §4 (signal-optional),
 * §7 (P1). Umbrella: cortex#1084.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveNetworkRoster,
  buildRosterPeers,
  type RosterPeer,
} from "../roster-read";
import type { NetworkRegistryClient } from "../../../common/registry/network-client";
import type {
  NetworkDescriptor,
  NetworkRosterResult,
} from "../../../common/registry/types";

// =============================================================================
// Fixtures + a fake registry client (only fetchAndCache / loadCached are read).
// =============================================================================

const NET = "metafactory";
const LOCAL = "andreas";

/** A structurally-valid base64 Ed25519 pubkey (re-encodable to nkey-U). */
const VALID_B64_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** Not base64 / wrong length — `base64PubkeyToNkey` returns undefined. */
const BAD_B64_PUBKEY = "not-a-pubkey";

function descriptor(networkId: string): NetworkDescriptor {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    members: [LOCAL, "jc"],
  };
}

function roster(
  networkId: string,
  members: NetworkRosterResult["members"],
): NetworkRosterResult {
  return { network_id: networkId, members };
}

type FetchAndCacheReturn = Awaited<
  ReturnType<NetworkRegistryClient["fetchAndCache"]>
>;
type LoadCachedReturn = ReturnType<NetworkRegistryClient["loadCached"]>;

/** Minimal client the lib accepts (the `Pick<>` it's typed against). */
interface FakeClient {
  fetchAndCache: () => Promise<FetchAndCacheReturn>;
  loadCached: () => LoadCachedReturn;
}

function fakeClient(opts: {
  fetch: FetchAndCacheReturn;
  cached?: LoadCachedReturn;
}): FakeClient {
  return {
    fetchAndCache: () => Promise.resolve(opts.fetch),
    loadCached: () => opts.cached,
  };
}

// =============================================================================
// 1. resolve — happy path projection
// =============================================================================

describe("resolveNetworkRoster — resolve (happy path)", () => {
  test("projects roster members → peers, excluding the local principal", async () => {
    const client = fakeClient({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptor(NET),
          roster: roster(NET, [
            // local principal — MUST be excluded (never self in peers[]).
            { principal_id: LOCAL, stack_id: "andreas/meta-factory", principal_pubkey: VALID_B64_PUBKEY },
            { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: VALID_B64_PUBKEY },
          ]),
        },
      },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedCache).toBe(false);
    expect(result.emptyRoster).toBe(false);
    expect(result.peers).toHaveLength(1);

    const jc = result.peers[0]!;
    // Wire-segment view (reconciler builds `federated.{principal}.{stack}.>`).
    expect(jc.principal).toBe("jc");
    expect(jc.stack).toBe("sage-host");
    // Config view (CLI writes PolicyFederatedPeer).
    expect(jc.principal_id).toBe("jc");
    expect(jc.stack_id).toBe("jc/sage-host");
    // Re-encodable key → filled (nkey-U, 56-char U-prefixed).
    expect(jc.principal_pubkey).toBeDefined();
    expect(jc.principal_pubkey!.startsWith("U")).toBe(true);
  });

  test("defaults stack to `{principal}/default` when the roster omits stack_id", async () => {
    const client = fakeClient({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptor(NET),
          roster: roster(NET, [
            { principal_id: "jc", principal_pubkey: VALID_B64_PUBKEY },
          ]),
        },
      },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const jc = result.peers[0]!;
    expect(jc.stack_id).toBe("jc/default");
    expect(jc.stack).toBe("default");
  });

  test("leaves principal_pubkey OFF when the roster key is not re-encodable (DD-5: declare by id)", async () => {
    const client = fakeClient({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptor(NET),
          roster: roster(NET, [
            { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: BAD_B64_PUBKEY },
          ]),
        },
      },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const jc = result.peers[0]!;
    expect(jc.principal_pubkey).toBeUndefined();
    // Identity still resolves so the gate can key on principal_id (DD-5).
    expect(jc.principal_id).toBe("jc");
    expect(jc.stack).toBe("sage-host");
  });
});

// =============================================================================
// 2. 0-peers guard (#762)
// =============================================================================

describe("resolveNetworkRoster — 0-peers guard (#762)", () => {
  test("empty roster → emptyRoster:true, peers:[], ok:true (NOT an error)", async () => {
    const client = fakeClient({
      fetch: {
        status: "ok",
        value: { descriptor: descriptor(NET), roster: roster(NET, []) },
      },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emptyRoster).toBe(true);
    expect(result.peers).toEqual([]);
  });

  test("a roster of ONLY the local principal resolves to 0 peers → emptyRoster:true", async () => {
    // The registry names the local principal (it IS a member) but no peers yet.
    const client = fakeClient({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptor(NET),
          roster: roster(NET, [
            { principal_id: LOCAL, stack_id: "andreas/meta-factory", principal_pubkey: VALID_B64_PUBKEY },
          ]),
        },
      },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emptyRoster).toBe(true);
    expect(result.peers).toEqual([]);
  });
});

// =============================================================================
// 3. registry-unreachable → cached (DD-10)
// =============================================================================

describe("resolveNetworkRoster — registry-unreachable → cached (DD-10)", () => {
  test("falls back to the cached roster and flags usedCache:true", async () => {
    const cachedRoster = roster(NET, [
      { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: VALID_B64_PUBKEY },
    ]);
    const client = fakeClient({
      fetch: { status: "unreachable", reason: "ECONNREFUSED" },
      cached: { descriptor: descriptor(NET), roster: cachedRoster },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedCache).toBe(true);
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]!.principal).toBe("jc");
  });

  test("unreachable AND no cache → ok:false, reason unreachable_uncached", async () => {
    const client = fakeClient({
      fetch: { status: "unreachable", reason: "ETIMEDOUT" },
      cached: undefined,
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreachable_uncached");
    expect(result.detail).toContain("ETIMEDOUT");
  });

  test("a cached roster that is empty still resolves ok with emptyRoster:true", async () => {
    const client = fakeClient({
      fetch: { status: "unreachable", reason: "ECONNREFUSED" },
      cached: { descriptor: descriptor(NET), roster: roster(NET, []) },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedCache).toBe(true);
    expect(result.emptyRoster).toBe(true);
  });
});

// =============================================================================
// 4. definitive negatives — not_found / unverified
// =============================================================================

describe("resolveNetworkRoster — definitive negatives", () => {
  test("not_found → ok:false, reason not_found (no cache consult)", async () => {
    let loadCachedCalled = false;
    const client: FakeClient = {
      fetchAndCache: () => Promise.resolve({ status: "not_found" }),
      loadCached: () => {
        loadCachedCalled = true;
        return undefined;
      },
    };

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    // A definitive negative must NOT fall back to cache (that's unreachable-only).
    expect(loadCachedCalled).toBe(false);
  });

  test("unverified → ok:false, reason unverified, detail carries the cause", async () => {
    const client = fakeClient({
      fetch: { status: "unverified", reason: "bad_signature" },
    });

    const result = await resolveNetworkRoster(NET, LOCAL, client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unverified");
    expect(result.detail).toContain("bad_signature");
  });
});

// =============================================================================
// 5. buildRosterPeers — projection in isolation
// =============================================================================

describe("buildRosterPeers — projection", () => {
  test("excludes the local principal and maps every other member", () => {
    const peers: RosterPeer[] = buildRosterPeers(
      LOCAL,
      roster(NET, [
        { principal_id: LOCAL, stack_id: "andreas/meta-factory", principal_pubkey: VALID_B64_PUBKEY },
        { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: VALID_B64_PUBKEY },
        { principal_id: "kim", stack_id: "kim/lab", principal_pubkey: VALID_B64_PUBKEY },
      ]),
    );
    expect(peers.map((p) => p.principal)).toEqual(["jc", "kim"]);
  });
});
