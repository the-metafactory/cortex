/**
 * cortex#1498 (epic #1479 follow-up) — `buildLiveHubAuthPort` tests.
 *
 * The hub-authorize leg's LIVE adapter reads the registry's real
 * `hub_authorized_at` marker via the SAME `buildAdmissionStatePort` `/mine`
 * path the seal leg uses. These tests drive it via the `__setAdmissionResolverForTests`
 * seam (the SAME seam `network-adapters.ts` exposes for `status` tests) so no
 * real HTTP round trip is needed — but a REAL (temp) seed file is required,
 * since `buildAdmissionStatePort` loads + chmod-checks it before ever reaching
 * the injected resolver.
 *
 *   - a row WITH `hubAuthorizedAt` → `confirmed: true`
 *   - a row WITHOUT it (or no row at all) → `confirmed: false` (a REAL
 *     negative — this is the behavior change from the pre-#1498 stub, which
 *     always returned `undefined`)
 *   - the admission read itself failing (registry unreachable / no seed
 *     configured) → `confirmed: undefined` (the documented fallback)
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";

import { buildLiveHubAuthPort } from "../network-handoff-adapters";
import { __setAdmissionResolverForTests, type LivePortsConfig } from "../network-adapters";
import type { ResolveOwnAdmissionStateResult } from "../../../../common/registry/admission-state";

let tmp: string;
let seedPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "s4-handoff-adapters-"));
  seedPath = join(tmp, "hub-admin.seed");
  writeFileSync(seedPath, new TextDecoder().decode(createUser().getSeed()), { mode: 0o600 });
});

afterEach(() => {
  __setAdmissionResolverForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

function cfg(): LivePortsConfig {
  return {
    networkId: "metafactory",
    principalId: "andreas",
    stackId: "andreas/meta-factory",
    registryUrl: "http://127.0.0.1:0", // never actually dialed — resolver is overridden
    seedPath,
  };
}

function admittedWith(hubAuthorizedAt?: string): ResolveOwnAdmissionStateResult {
  return {
    ok: true,
    state: {
      state: "admitted-sealed",
      networkId: "metafactory",
      requestId: "req-1",
      hasSealedSecret: true,
      peerPubkey: "PUBKEY_FIXTURE",
      ...(hubAuthorizedAt !== undefined && { hubAuthorizedAt }),
    },
  };
}

describe("buildLiveHubAuthPort", () => {
  test("row WITH hub_authorized_at → confirmed: true", async () => {
    __setAdmissionResolverForTests(async () => admittedWith("2026-03-01T00:00:00.000Z"));
    const port = buildLiveHubAuthPort(cfg());
    const res = await port.resolveHubAuthorized("metafactory", "andreas");
    expect(res.confirmed).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  test("row WITHOUT hub_authorized_at → confirmed: false (a REAL negative)", async () => {
    __setAdmissionResolverForTests(async () => admittedWith(undefined));
    const port = buildLiveHubAuthPort(cfg());
    const res = await port.resolveHubAuthorized("metafactory", "andreas");
    expect(res.confirmed).toBe(false);
    expect(res.reason).toContain("cortex network authorize");
  });

  test("no admission row at all → confirmed: false", async () => {
    __setAdmissionResolverForTests(async () => ({
      ok: true,
      state: { state: "no-row", networkId: "metafactory", hasSealedSecret: false, peerPubkey: "PUBKEY_FIXTURE" },
    }));
    const port = buildLiveHubAuthPort(cfg());
    const res = await port.resolveHubAuthorized("metafactory", "andreas");
    expect(res.confirmed).toBe(false);
  });

  test("admission read failure (registry unreachable) → confirmed: undefined (documented fallback)", async () => {
    __setAdmissionResolverForTests(async () => ({ ok: false, reason: "registry mine-read errored: fetch failed" }));
    const port = buildLiveHubAuthPort(cfg());
    const res = await port.resolveHubAuthorized("metafactory", "andreas");
    expect(res.confirmed).toBeUndefined();
    expect(res.reason).toContain("registry mine-read errored");
  });

  test("REMOTE member (member != cfg.principalId) → confirmed: undefined (not observable, never reads own row as theirs)", async () => {
    // A resolver that WOULD return a marked row — proving the remote-member
    // guard short-circuits BEFORE the /mine read, so we never mislabel our own
    // row as the remote member's.
    let resolverCalled = false;
    __setAdmissionResolverForTests(async () => {
      resolverCalled = true;
      return admittedWith("2026-03-01T00:00:00.000Z");
    });
    const port = buildLiveHubAuthPort(cfg()); // cfg().principalId === "andreas"
    const res = await port.resolveHubAuthorized("metafactory", "someone-else");
    expect(res.confirmed).toBeUndefined();
    expect(res.reason).toContain("not observable");
    expect(resolverCalled).toBe(false); // guard fired before the read
  });

  test("no seed configured at all → confirmed: undefined (never throws)", async () => {
    __setAdmissionResolverForTests(async () => admittedWith("2026-03-01T00:00:00.000Z"));
    const port = buildLiveHubAuthPort({
      networkId: "metafactory",
      principalId: "andreas",
      stackId: "andreas/meta-factory",
      registryUrl: "http://127.0.0.1:0",
      // seedPath omitted entirely
    });
    const res = await port.resolveHubAuthorized("metafactory", "andreas");
    expect(res.confirmed).toBeUndefined();
  });
});
