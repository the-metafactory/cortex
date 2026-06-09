/**
 * cortex#682 — D1-backed durable storage + durable nonce cache.
 *
 * Exercises the D1 implementations directly against a thin in-memory D1
 * mock (see d1-mock.ts) plus the backend-selection logic in getStore /
 * getNonceCache. The mock shares ONE underlying store across multiple
 * D1RegistryStore / D1NonceCache instances to model multiple Worker
 * isolates talking to the same logical D1 — that is how the
 * nonce-durability test proves a cross-isolate replay is caught.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  D1NonceCache,
  D1RegistryStore,
  InMemoryRegistryStore,
  InMemoryNonceCache,
  StaleRecordError,
  NONCE_WINDOW_MS,
  getStore,
  getNonceCache,
  _setStoreForTest,
  _setNonceCacheForTest,
  type StoreEnv,
} from "../src/store";
import type { Capability, StackIdentity } from "../src/types";
import { MockD1, asD1 } from "./d1-mock";

beforeEach(() => {
  // Clear backend-selection memo so each test picks a fresh backend.
  _setStoreForTest(undefined);
  _setNonceCacheForTest(undefined);
});

// =============================================================================
// D1RegistryStore — round-trips
// =============================================================================

describe("D1RegistryStore", () => {
  const stacks: StackIdentity[] = [
    { stack_id: "andreas/laptop", display_name: "Laptop" },
  ];
  const caps: Capability[] = [
    { id: "tasks.code-review", description: "Reviews TS", networks: ["research-collab"] },
  ];

  test("put then get round-trips the full record", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    const written = await store.putPrincipal("andreas", "pubkey-aaa", stacks, caps);
    expect(written.principal_id).toBe("andreas");
    expect(written.updated_at.length).toBeGreaterThan(0);

    const got = await store.getPrincipal("andreas");
    expect(got).toBeDefined();
    expect(got!.principal_pubkey).toBe("pubkey-aaa");
    expect(got!.stacks).toEqual(stacks);
    expect(got!.capabilities).toEqual(caps);
    expect(got!.updated_at).toBe(written.updated_at);
  });

  test("getPrincipal returns undefined for unknown id", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    expect(await store.getPrincipal("nobody")).toBeUndefined();
  });

  // #825 — optimistic concurrency: a CAS write only lands if the stored
  // updated_at still matches the value the caller's read-merge was based on.
  describe("putPrincipal CAS (#825)", () => {
    test("matching expectedUpdatedAt → write lands", async () => {
      const store = new D1RegistryStore(asD1(new MockD1()));
      const first = await store.putPrincipal("p", "k", [], []);
      const second = await store.putPrincipal("p", "k", stacks, [], first.updated_at);
      expect(second.stacks).toEqual(stacks);
      expect((await store.getPrincipal("p"))!.stacks).toEqual(stacks);
    });

    test("stale expectedUpdatedAt → StaleRecordError, record unchanged", async () => {
      const store = new D1RegistryStore(asD1(new MockD1()));
      const first = await store.putPrincipal("p", "k", stacks, []);
      let threw: unknown;
      try {
        await store.putPrincipal("p", "k", [], [], "1999-01-01T00:00:00.000Z");
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(StaleRecordError);
      // The winner's record is intact — the stale write did NOT clobber it.
      expect((await store.getPrincipal("p"))!.stacks).toEqual(stacks);
      expect((await store.getPrincipal("p"))!.updated_at).toBe(first.updated_at);
    });

    test("no existing record → CAS is a no-op (nothing to clobber)", async () => {
      const store = new D1RegistryStore(asD1(new MockD1()));
      const written = await store.putPrincipal("fresh", "k", stacks, [], "1999-01-01T00:00:00.000Z");
      expect(written.stacks).toEqual(stacks);
    });

    test("InMemory store enforces the same CAS", async () => {
      const store = new InMemoryRegistryStore();
      await store.putPrincipal("p", "k", stacks, []);
      await expect(
        store.putPrincipal("p", "k", [], [], "1999-01-01T00:00:00.000Z"),
      ).rejects.toBeInstanceOf(StaleRecordError);
    });
  });

  test("listPrincipals returns every stored principal", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    await store.putPrincipal("alice", "k1", [], []);
    await store.putPrincipal("bob", "k2", [], []);
    const all = await store.listPrincipals();
    expect(all.map((p) => p.principal_id).sort()).toEqual(["alice", "bob"]);
  });

  test("upsert replaces stacks/capabilities on re-register (no leftover)", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    await store.putPrincipal("andreas", "k1", [{ stack_id: "andreas/laptop" }], []);
    const updated = await store.putPrincipal(
      "andreas",
      "k1",
      [{ stack_id: "andreas/server" }],
      [],
    );
    expect(updated.stacks).toHaveLength(1);
    const got = await store.getPrincipal("andreas");
    expect(got!.stacks.map((s) => s.stack_id)).toEqual(["andreas/server"]);
    expect(got!.stacks.map((s) => s.stack_id)).not.toContain("andreas/laptop");
    // Still exactly one row — UPSERT replaced in place, not appended.
    expect(await store.listPrincipals()).toHaveLength(1);
  });

  test("reset clears all principals", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    await store.putPrincipal("a", "k", [], []);
    await store.reset();
    expect(await store.listPrincipals()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // SQLi-safety: every query is parameterised, so a principal_id full of
  // SQL metacharacters round-trips as opaque data and cannot alter a query.
  // ---------------------------------------------------------------------------
  test("SQLi-safety: quote/metacharacter-laden principal_id is opaque data", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    const nasty = `x'; DROP TABLE principals;--`;
    await store.putPrincipal(nasty, "k-nasty", [], []);

    // The table is intact and the row is retrievable verbatim under the
    // exact nasty key — proving the value never reached the SQL grammar.
    const got = await store.getPrincipal(nasty);
    expect(got).toBeDefined();
    expect(got!.principal_id).toBe(nasty);

    // A second, ordinary principal still lists fine (table not dropped).
    await store.putPrincipal("normal", "k", [], []);
    const all = await store.listPrincipals();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.principal_id)).toContain(nasty);
  });
});

// =============================================================================
// D1RegistryStore — network topology round-trips (S2.5 #745)
// =============================================================================

describe("D1RegistryStore — networks (S2.5)", () => {
  test("putNetwork then getNetwork round-trips the topology record", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    const written = await store.putNetwork(
      "research-collab",
      "tls://hub.meta-factory.ai:7422",
      7422,
    );
    expect(written.network_id).toBe("research-collab");
    expect(written.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(written.leaf_port).toBe(7422);
    expect(written.updated_at.length).toBeGreaterThan(0);

    const got = await store.getNetwork("research-collab");
    expect(got).toBeDefined();
    expect(got!.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(got!.leaf_port).toBe(7422);
    expect(got!.updated_at).toBe(written.updated_at);
  });

  test("getNetwork returns undefined for an unseeded network", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    expect(await store.getNetwork("nope")).toBeUndefined();
  });

  test("putNetwork UPSERTs in place (no duplicate row)", async () => {
    const shared = new MockD1();
    const store = new D1RegistryStore(asD1(shared));
    await store.putNetwork("research-collab", "tls://old:7422", 7422);
    await store.putNetwork("research-collab", "tls://new:7500", 7500);
    expect(shared.networks.size).toBe(1);
    const got = await store.getNetwork("research-collab");
    expect(got!.hub_url).toBe("tls://new:7500");
    expect(got!.leaf_port).toBe(7500);
  });

  test("reset clears networks too", async () => {
    const store = new D1RegistryStore(asD1(new MockD1()));
    await store.putNetwork("n", "tls://h:7422", 7422);
    await store.reset();
    expect(await store.getNetwork("n")).toBeUndefined();
  });

  test("in-memory backend round-trips putNetwork/getNetwork", async () => {
    const store = new InMemoryRegistryStore();
    await store.putNetwork("research-collab", "tls://h:7422", 7422);
    const got = await store.getNetwork("research-collab");
    expect(got!.leaf_port).toBe(7422);
    await store.reset();
    expect(await store.getNetwork("research-collab")).toBeUndefined();
  });
});

// =============================================================================
// D1NonceCache — durability across isolates
// =============================================================================

describe("D1NonceCache", () => {
  test("fresh nonce records and returns true; immediate replay returns false", async () => {
    const cache = new D1NonceCache(asD1(new MockD1()));
    const now = Date.now();
    expect(await cache.recordIfFresh("nonce-1", now)).toBe(true);
    expect(await cache.recordIfFresh("nonce-1", now)).toBe(false);
  });

  test("DURABILITY: a replay against a DIFFERENT isolate (shared D1) is caught", async () => {
    // One shared D1 ⇒ two D1NonceCache instances == two isolates.
    const shared = new MockD1();
    const isolateA = new D1NonceCache(asD1(shared));
    const isolateB = new D1NonceCache(asD1(shared));
    const now = Date.now();

    // Principal registers on isolate A.
    expect(await isolateA.recordIfFresh("shared-nonce", now)).toBe(true);
    // Captured-in-flight registration replayed against isolate B within
    // the skew window. With the OLD in-memory cache this succeeded
    // (isolate B's map was empty). With durable D1 it is rejected.
    expect(await isolateB.recordIfFresh("shared-nonce", now + 1000)).toBe(false);
  });

  test("prunes nonces older than the window; a stale nonce becomes fresh again", async () => {
    const shared = new MockD1();
    const cache = new D1NonceCache(asD1(shared));
    const t0 = Date.now();
    expect(await cache.recordIfFresh("old-nonce", t0)).toBe(true);

    // A later call past the window prunes the stale entry. The same nonce
    // is then treated as fresh (its replay protection has legitimately
    // expired — the route-layer skew check is the backstop beyond this).
    const later = t0 + NONCE_WINDOW_MS + 1;
    expect(await cache.recordIfFresh("filler", later)).toBe(true);
    expect(shared.nonces.has("old-nonce")).toBe(false);
    expect(await cache.recordIfFresh("old-nonce", later)).toBe(true);
  });

  test("reset clears the nonce table", async () => {
    const shared = new MockD1();
    const cache = new D1NonceCache(asD1(shared));
    await cache.recordIfFresh("n", Date.now());
    await cache.reset();
    expect(shared.nonces.size).toBe(0);
  });
});

// =============================================================================
// Backend selection — D1 when bound, in-memory fallback otherwise
// =============================================================================

describe("getStore / getNonceCache backend selection", () => {
  test("uses D1 backends when env.DB is present", () => {
    const env: StoreEnv = { DB: asD1(new MockD1()) };
    expect(getStore(env)).toBeInstanceOf(D1RegistryStore);
    _setStoreForTest(undefined);
    _setNonceCacheForTest(undefined);
    expect(getNonceCache(env)).toBeInstanceOf(D1NonceCache);
  });

  test("falls back to in-memory backends when env.DB is absent", () => {
    const env: StoreEnv = {};
    expect(getStore(env)).toBeInstanceOf(InMemoryRegistryStore);
    _setStoreForTest(undefined);
    _setNonceCacheForTest(undefined);
    expect(getNonceCache(env)).toBeInstanceOf(InMemoryNonceCache);
  });

  test("PRODUCTION + no DB → getStore FAILS CLOSED (no silent in-memory in prod)", () => {
    const env: StoreEnv = { ENVIRONMENT: "production" };
    expect(() => getStore(env)).toThrow(/production but no D1|refusing to fall back/i);
  });

  test("PRODUCTION + no DB → getNonceCache FAILS CLOSED", () => {
    const env: StoreEnv = { ENVIRONMENT: "production" };
    expect(() => getNonceCache(env)).toThrow(/production but no D1|refusing to fall back/i);
  });

  test("PRODUCTION WITH DB → uses D1 (no throw)", () => {
    const env: StoreEnv = { ENVIRONMENT: "production", DB: asD1(new MockD1()) };
    expect(getStore(env)).toBeInstanceOf(D1RegistryStore);
    _setStoreForTest(undefined);
    _setNonceCacheForTest(undefined);
    expect(getNonceCache(env)).toBeInstanceOf(D1NonceCache);
  });

  test("non-production + no DB → in-memory, no throw (back-compat preserved)", () => {
    const env: StoreEnv = { ENVIRONMENT: "development" };
    expect(getStore(env)).toBeInstanceOf(InMemoryRegistryStore);
  });

  test("in-memory fallback still round-trips put/get (no D1 needed)", async () => {
    const env: StoreEnv = {};
    const store = getStore(env);
    await store.putPrincipal("p", "k", [{ stack_id: "p/s" }], []);
    const got = await store.getPrincipal("p");
    expect(got!.principal_pubkey).toBe("k");
    expect(got!.stacks).toHaveLength(1);
  });
});
