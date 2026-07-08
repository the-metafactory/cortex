/**
 * cortex#1598 (epic #1595 slice 2) — `resolveOperatorAttestation` (Sage
 * follow-up on PR #1610). The admit-side guard fires on `hubMode === "operator"`,
 * so how `hubMode` is RESOLVED is security-relevant: a fail-open resolution that
 * leaves an operator network's `hubMode` undefined would silently degrade it to
 * the PSK/hub-write path and crash the operator hub (cortex#794).
 *
 * The rule under test: the VERIFIED descriptor wins when cached; ELSE the hub
 * owner's OWN local `policy.federated.networks[].hub_mode` (the load-bearing
 * fallback — the hub owner runs `create`, not `join`, so may have no cached
 * descriptor for their own network); NEITHER ⇒ undefined (unattested = simple,
 * back-compat) — the fallback direction is simple, never a silent operator write.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { resolveOperatorAttestation, seedAdminDescriptorCache, seedDescriptorCacheOnMiss } from "../network";
import { NetworkCache } from "../../../../common/registry/network-cache";
import type { LoadedConfig } from "../../../../common/config/loader";

function freshCache(): NetworkCache {
  return new NetworkCache({ cacheDir: mkdtempSync(join(tmpdir(), "op-attest-cache-")) });
}

/** A fake ConfigReader whose config declares `net` with the given attestation. */
function loaderFor(net: string, attest: { hub_mode?: string; resolver_mode?: string; hub_fed_account?: string }) {
  return () =>
    ({
      policy: { federated: { networks: [{ id: net, ...attest }] } },
    } as unknown as LoadedConfig);
}

/** A ConfigReader that throws (unreadable config) — must be non-fatal. */
const throwingLoader = () => {
  throw new Error("config unreadable");
};

const NET = "metafactory";

describe("cortex#1598 — resolveOperatorAttestation", () => {
  test("verified descriptor attesting operator wins", () => {
    const cache = freshCache();
    cache.store(
      NET,
      { network_id: NET, hub_url: "tls://h:7422", leaf_port: 7422, members: [], hub_mode: "operator", resolver_mode: "nats" },
      { network_id: NET, members: [] },
    );
    const r = resolveOperatorAttestation({}, NET, loaderFor(NET, {}), cache);
    expect(r.hubMode).toBe("operator");
    expect(r.resolverMode).toBe("nats");
  });

  test("cache MISS + local config declares operator → resolves operator (closes the fail-open)", () => {
    const r = resolveOperatorAttestation(
      {},
      NET,
      loaderFor(NET, { hub_mode: "operator", resolver_mode: "nats", hub_fed_account: "FEDERATION" }),
      freshCache(), // empty cache — the hub owner never joined their own network
    );
    expect(r.hubMode).toBe("operator");
    expect(r.resolverMode).toBe("nats");
    expect(r.hubFedAccount).toBe("FEDERATION");
  });

  test("cache MISS + no local declaration → undefined (unattested = simple, back-compat)", () => {
    const r = resolveOperatorAttestation({}, NET, loaderFor(NET, {}), freshCache());
    expect(r.hubMode).toBeUndefined();
    expect(r.resolverMode).toBeUndefined();
  });

  test("descriptor SIMPLE overrides a local operator declaration (verified wins)", () => {
    const cache = freshCache();
    cache.store(
      NET,
      { network_id: NET, hub_url: "tls://h:7422", leaf_port: 7422, members: [], hub_mode: "simple" },
      { network_id: NET, members: [] },
    );
    const r = resolveOperatorAttestation({}, NET, loaderFor(NET, { hub_mode: "operator" }), cache);
    expect(r.hubMode).toBe("simple");
  });

  test("an unreadable config is non-fatal (undefined, never throws)", () => {
    const r = resolveOperatorAttestation({}, NET, throwingLoader, freshCache());
    expect(r.hubMode).toBeUndefined();
  });
});

describe("cortex#1652 — seedAdminDescriptorCache", () => {
  test("reports seeded on a verified fetch (ok)", async () => {
    let seenId = "";
    const r = await seedAdminDescriptorCache("metafactory", "http://reg", undefined, () => ({
      fetchAndCache: async (id: string) => {
        seenId = id;
        return { status: "ok" };
      },
    }));
    expect(r.seeded).toBe(true);
    expect(seenId).toBe("metafactory");
  });

  test("reports NOT seeded (with the status as reason) on a non-ok fetch — never throws", async () => {
    const r = await seedAdminDescriptorCache("metafactory", "http://reg", undefined, () => ({
      fetchAndCache: async () => ({ status: "unreachable" }),
    }));
    expect(r.seeded).toBe(false);
    expect(r.reason).toBe("unreachable");
  });

  test("a throwing client is swallowed (best-effort — never fails the create)", async () => {
    const r = await seedAdminDescriptorCache("metafactory", "http://reg", undefined, () => ({
      fetchAndCache: async () => {
        throw new Error("connection refused");
      },
    }));
    expect(r.seeded).toBe(false);
    expect(r.reason).toContain("connection refused");
  });

  test("passes a pinned registry pubkey through to the client when supplied", async () => {
    let seenCfg: { url: string; pubkey?: string } | undefined;
    await seedAdminDescriptorCache("metafactory", "http://reg", "PINNEDPUB", (cfg) => {
      seenCfg = cfg;
      return { fetchAndCache: async () => ({ status: "ok" }) };
    });
    expect(seenCfg).toEqual({ url: "http://reg", pubkey: "PINNEDPUB" });
  });
});

describe("cortex#1652 — seedDescriptorCacheOnMiss (admit-path re-seal gap)", () => {
  test("cache MISS → calls the seed fn (so admit resolves operator, not PSK)", async () => {
    let called = 0;
    let seenArgs: [string, string, string | undefined] | undefined;
    const seedSpy = async (id: string, url: string, pk?: string) => {
      called += 1;
      seenArgs = [id, url, pk];
      return { seeded: true };
    };
    const r = await seedDescriptorCacheOnMiss(NET, "http://reg", "PIN", freshCache(), seedSpy);
    expect(called).toBe(1);
    expect(seenArgs).toEqual([NET, "http://reg", "PIN"]);
    expect(r.seeded).toBe(true);
    expect(r.skipped).toBeUndefined();
  });

  test("cache HIT → skips the network fetch entirely (warm cache, no seed call)", async () => {
    const cache = freshCache();
    cache.store(
      NET,
      { network_id: NET, hub_url: "tls://h:7422", leaf_port: 7422, members: [], hub_mode: "operator" },
      { network_id: NET, members: [] },
    );
    let called = 0;
    const seedSpy = async () => {
      called += 1;
      return { seeded: true };
    };
    const r = await seedDescriptorCacheOnMiss(NET, "http://reg", undefined, cache, seedSpy);
    expect(called).toBe(0);
    expect(r.seeded).toBe(true);
    expect(r.skipped).toBe(true);
  });

  test("cache MISS + seed reports NOT seeded → propagates the reason (admit warns, stays best-effort)", async () => {
    const seedSpy = async () => ({ seeded: false, reason: "unreachable" });
    const r = await seedDescriptorCacheOnMiss(NET, "http://reg", undefined, freshCache(), seedSpy);
    expect(r.seeded).toBe(false);
    expect(r.reason).toBe("unreachable");
  });
});
