import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { joinLeafAuthNotice, planJoinLeafAuth, resolveJoinHubMode } from "../network";
import { NetworkCache } from "../../../../common/registry/network-cache";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";

const cacheRoot = mkdtempSync(join(tmpdir(), "join-leaf-auth-"));
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));
let cacheN = 0;

describe("planJoinLeafAuth (cortex#2751)", () => {
  const CREDS = "/stack/nats/network.creds";
  const INSTALL = "/stack/nats/network-leaf.creds";
  const base = {
    configuredLeafSecret: undefined,
    credsPath: CREDS,
    credsUsable: true,
    sealedCredsInstallPath: INSTALL,
  };

  test("operator network + usable self-managed creds → render from creds, never open the sealed secret", () => {
    expect(planJoinLeafAuth({ ...base, hubMode: "operator" })).toEqual({
      kind: "self-managed-creds",
      credsPath: CREDS,
    });
  });

  test("operator network without a usable creds file → fetch (the v2 per-member credential path, #1597)", () => {
    expect(planJoinLeafAuth({ ...base, hubMode: "operator", credsUsable: false })).toEqual({
      kind: "sealed-fetch",
      operatorModeHub: true,
    });
  });

  test("operator network whose creds path IS the envelope install path → fetch, so a re-sealed credential is picked up", () => {
    expect(planJoinLeafAuth({ ...base, hubMode: "operator", credsPath: INSTALL })).toEqual({
      kind: "sealed-fetch",
      operatorModeHub: true,
    });
  });

  test("simple or unattested network → fetch as today, even with a creds file on disk", () => {
    expect(planJoinLeafAuth({ ...base, hubMode: "simple" })).toEqual({ kind: "sealed-fetch", operatorModeHub: false });
    expect(planJoinLeafAuth({ ...base, hubMode: undefined })).toEqual({ kind: "sealed-fetch", operatorModeHub: false });
  });

  test("a configured leaf secret wins on any network", () => {
    expect(planJoinLeafAuth({ ...base, hubMode: "operator", configuredLeafSecret: "S" })).toEqual({
      kind: "configured-secret",
    });
  });
});

describe("joinLeafAuthNotice (cortex#2751)", () => {
  const unopenable = { kind: "unavailable" as const, reason: "could not open the sealed box" };

  const selfManaged = { kind: "self-managed-creds" as const, credsPath: "/c/net-a.creds" };

  test("self-managed-creds plan → names the creds file and says the envelope is opened only for K", () => {
    const n = joinLeafAuthNotice("net-a", selfManaged, undefined, "/c/net-a.creds", { ok: true, payloadKey: "K" });
    expect(n).toContain("operator-mode network");
    expect(n).toContain("/c/net-a.creds");
    expect(n).toContain("ignores any sealed leaf credential");
    expect(n).toContain("only for the payload key K");
    expect(n).not.toContain("WARNING");
  });

  test("self-managed-creds plan + unopenable envelope → WARNING that K was not refreshed, join continues (cortex#2759)", () => {
    const n = joinLeafAuthNotice("net-a", selfManaged, undefined, "/c/net-a.creds", { ok: false, reason: "sealed to another key" });
    expect(n).toContain("WARNING");
    expect(n).toContain("payload key K");
    expect(n).toContain("was not refreshed");
    expect(n).toContain("sealed to another key");
    expect(n).toContain("The join continues");
  });

  test("operator network + unopenable sealed secret → WARNING that join continues on the creds path", () => {
    const n = joinLeafAuthNotice("net-a", { kind: "sealed-fetch", operatorModeHub: true }, unopenable, "/c/net-a.creds");
    expect(n).toContain("WARNING");
    expect(n).toContain("could not open the sealed box");
    expect(n).toContain("falls back to the creds file at /c/net-a.creds");
  });

  test("PSK network + unopenable sealed secret → no notice (the existing refusal stands)", () => {
    expect(joinLeafAuthNotice("net-a", { kind: "sealed-fetch", operatorModeHub: false }, unopenable, "/c")).toBeUndefined();
  });

  test("operator network + a delivered credential → no notice", () => {
    expect(
      joinLeafAuthNotice("net-a", { kind: "sealed-fetch", operatorModeHub: true }, { kind: "creds-file", credsPath: "/c", leafUser: "u" }, "/c"),
    ).toBeUndefined();
  });
});

describe("resolveJoinHubMode (cortex#2751)", () => {
  function declared(hub_mode: "operator" | "simple"): PolicyFederatedNetwork {
    return { id: "net-a", hub_mode } as unknown as PolicyFederatedNetwork;
  }
  function cacheWith(hub_mode?: "operator" | "simple"): NetworkCache {
    const cache = new NetworkCache({ cacheDir: join(cacheRoot, String(++cacheN)) });
    if (hub_mode !== undefined) {
      cache.store(
        "net-a",
        { network_id: "net-a", hub_url: "tls://hub.example.org:7422", leaf_port: 7422, members: [], hub_mode },
        { network_id: "net-a", members: [] },
      );
    }
    return cache;
  }

  test("the stack's own networks[] declaration is used when no descriptor is cached", () => {
    expect(resolveJoinHubMode("net-a", [declared("operator")], cacheWith())).toBe("operator");
  });

  test("a cached verified descriptor's attestation wins over the local declaration", () => {
    expect(resolveJoinHubMode("net-a", [declared("operator")], cacheWith("simple"))).toBe("simple");
  });

  test("neither → undefined (unattested, treated as a PSK network)", () => {
    expect(resolveJoinHubMode("net-a", [], cacheWith())).toBeUndefined();
  });
});