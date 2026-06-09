/**
 * S4 (Network Join Control Plane, epic #733) — boot-path federated-peer
 * resolution wiring tests.
 *
 * These exercise the {@link resolveBootFederatedPeers} seam directly (the unit
 * the boot path calls), against a STUB roster provider — NO network I/O, NO
 * `~/.config` touch. The full integration (that `startCortex` feeds the result
 * into the membership gate) lives in `src/__tests__/cortex.federated-peer-boot.test.ts`.
 *
 * Coverage maps to the three load-bearing decisions:
 *   - DD-5  — a pubkey-less peer is filled from the verified roster (nkey-U).
 *   - DD-5  — a hand-pin + a roster-resolved peer MERGE into one network.
 *   - DD-11 — a hand-pin that DISAGREES with the roster → fail-closed drop.
 *   - DD-10 — registry unreachable → cached roster + static peers + warn.
 *   - no-op — no policy / no federation / no registry → untouched pass-through.
 */

import { describe, expect, test } from "bun:test";

import { base64PubkeyToNkey } from "../encoding";
import { resolveBootFederatedPeers } from "../resolve-federated-peers-boot";
import type { NetworkRosterProvider } from "../resolve-federated-peers";
import type { NetworkFetchResult } from "../network-client";
import type { NetworkRosterResult } from "../types";
import type { Policy, PolicyFederatedNetwork } from "../../types/cortex-config";

const PEER_B64_A = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const PEER_B64_B = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
const PEER_NKEY_A = base64PubkeyToNkey(PEER_B64_A)!;
const PEER_NKEY_B = base64PubkeyToNkey(PEER_B64_B)!;

function networkWith(
  peers: PolicyFederatedNetwork["peers"],
): PolicyFederatedNetwork {
  return {
    id: "metafactory-community",
    leaf_node: "hub-leaf",
    peers,
    accept_subjects: ["federated.andreas.community.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
  };
}

function policyWith(
  networks: PolicyFederatedNetwork[],
  opts: { withRegistry?: boolean } = {},
): Policy {
  return {
    principals: [],
    federated: {
      networks,
      ...(opts.withRegistry !== false && {
        registry: { url: "https://network.meta-factory.ai" },
      }),
    },
  } as unknown as Policy;
}

function rosterWith(
  members: NetworkRosterResult["members"],
): NetworkRosterResult {
  return { network_id: "metafactory-community", members };
}

function stubProvider(opts: {
  live?: NetworkFetchResult<{ roster: NetworkRosterResult }>;
  cached?: { roster: NetworkRosterResult } | undefined;
}): NetworkRosterProvider & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async fetchAndCache(networkId) {
      fetched.push(networkId);
      return (
        opts.live ?? { status: "unreachable", reason: "no live result scripted" }
      );
    },
    loadCached() {
      return opts.cached;
    },
  };
}

describe("resolveBootFederatedPeers — DD-5 boot wiring", () => {
  test("fills a pubkey-less peer from the verified roster (nkey-U) into the policy", async () => {
    const policy = policyWith([
      networkWith([{ principal_id: "jcfischer", stack_id: "jcfischer/sage-host" }]),
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jcfischer", principal_pubkey: PEER_B64_A },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      rosterProvider: provider,
      warn: (m) => warnings.push(m),
    });

    expect(result.errors).toHaveLength(0);
    const peers = result.policy?.federated?.networks[0]?.peers ?? [];
    expect(peers).toHaveLength(1);
    expect(peers[0]?.principal_pubkey).toBe(PEER_NKEY_A);
    expect(provider.fetched).toEqual(["metafactory-community"]);
  });

  test("merges a hand-pinned peer and a registry-resolved peer in the same network", async () => {
    const policy = policyWith([
      networkWith([
        { principal_id: "andreas", stack_id: "andreas/community", principal_pubkey: PEER_NKEY_B },
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host" },
      ]),
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "andreas", principal_pubkey: PEER_B64_B },
            { principal_id: "jcfischer", principal_pubkey: PEER_B64_A },
          ]),
        },
      },
    });

    const result = await resolveBootFederatedPeers(policy, { rosterProvider: provider });

    expect(result.errors).toHaveLength(0);
    const peers = result.policy?.federated?.networks[0]?.peers ?? [];
    const byId = new Map(peers.map((p) => [p.principal_id, p.principal_pubkey]));
    expect(byId.get("andreas")).toBe(PEER_NKEY_B); // hand-pin honored (matches)
    expect(byId.get("jcfischer")).toBe(PEER_NKEY_A); // registry-resolved
  });
});

describe("resolveBootFederatedPeers — DD-11 fail-closed", () => {
  test("a hand-pin that disagrees with the roster drops the peer and reports an error", async () => {
    const policy = policyWith([
      networkWith([
        // hand-pinned to A, but the roster says B → drift/attack signal.
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host", principal_pubkey: PEER_NKEY_A },
        // a resolvable peer alongside it — proves the drop is per-peer.
        { principal_id: "andreas", stack_id: "andreas/community" },
      ]),
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jcfischer", principal_pubkey: PEER_B64_B },
            { principal_id: "andreas", principal_pubkey: PEER_B64_A },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      rosterProvider: provider,
      warn: (m) => warnings.push(m),
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("pin_mismatch");
    expect(result.errors[0]?.principalId).toBe("jcfischer");
    // The mismatching peer is dropped from the gate; the resolvable one stays.
    const peers = result.policy?.federated?.networks[0]?.peers ?? [];
    expect(peers.map((p) => p.principal_id)).toEqual(["andreas"]);
    // Aggregate summary warning emitted.
    expect(warnings.some((w) => w.includes("failed closed at") && w.includes("pin_mismatch"))).toBe(true);
  });

  test("MAJOR-1 — a FULLY hand-pinned network is cross-checked; a drifted pin is dropped", async () => {
    // PR #818 review MAJOR-1 regression guard at the boot seam: a single
    // hand-pinned peer (no pubkey-less peer to force a fetch) must STILL be
    // cross-checked against the roster, and a drifted pin DROPPED. Before the
    // fix this network made zero registry calls and the stale pin was admitted.
    const policy = policyWith([
      networkWith([
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host", principal_pubkey: PEER_NKEY_A },
      ]),
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([{ principal_id: "jcfischer", principal_pubkey: PEER_B64_B }]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      rosterProvider: provider,
      warn: (m) => warnings.push(m),
    });

    expect(provider.fetched).toEqual(["metafactory-community"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("pin_mismatch");
    expect(result.policy?.federated?.networks[0]?.peers ?? []).toHaveLength(0);
  });
});

describe("resolveBootFederatedPeers — DD-10 registry-down fallback", () => {
  test("falls back to the cached roster + warns when the registry is unreachable", async () => {
    const policy = policyWith([
      networkWith([{ principal_id: "jcfischer", stack_id: "jcfischer/sage-host" }]),
    ]);
    const provider = stubProvider({
      live: { status: "unreachable", reason: "ECONNREFUSED" },
      cached: {
        roster: rosterWith([
          { principal_id: "jcfischer", principal_pubkey: PEER_B64_A },
        ]),
      },
    });
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      rosterProvider: provider,
      warn: (m) => warnings.push(m),
    });

    expect(result.errors).toHaveLength(0);
    expect(result.policy?.federated?.networks[0]?.peers[0]?.principal_pubkey).toBe(PEER_NKEY_A);
    expect(warnings.some((w) => w.includes("unreachable") && w.includes("cached"))).toBe(true);
  });

  test("hand-pinned peer survives a total registry outage (offline fallback)", async () => {
    const policy = policyWith([
      networkWith([
        { principal_id: "andreas", stack_id: "andreas/community", principal_pubkey: PEER_NKEY_B },
        // a pubkey-less peer forces the roster fetch; the hand-pin must survive
        // even though the registry is fully down + uncached.
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host" },
      ]),
    ]);
    const provider = stubProvider({
      live: { status: "unreachable", reason: "ECONNREFUSED" },
      cached: undefined,
    });

    const result = await resolveBootFederatedPeers(policy, { rosterProvider: provider });

    const peers = result.policy?.federated?.networks[0]?.peers ?? [];
    // hand-pin kept; the unresolved registry-only peer fails closed.
    expect(peers.map((p) => p.principal_id)).toEqual(["andreas"]);
    expect(peers[0]?.principal_pubkey).toBe(PEER_NKEY_B);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("unresolved");
  });
});

describe("resolveBootFederatedPeers — no-op pass-through", () => {
  test("undefined policy is returned unchanged", async () => {
    const result = await resolveBootFederatedPeers(undefined);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  test("a policy with no federation block is returned by reference", async () => {
    const policy = { principals: [] } as unknown as Policy;
    const result = await resolveBootFederatedPeers(policy);
    expect(result.policy).toBe(policy);
    expect(result.errors).toHaveLength(0);
  });

  test("federation declared but no registry + a pubkey-less peer warns, keeps static peers, makes no call", async () => {
    const policy = policyWith(
      [networkWith([{ principal_id: "jcfischer", stack_id: "jcfischer/sage-host" }])],
      { withRegistry: false },
    );
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      warn: (m) => warnings.push(m),
    });

    // No registry, no injected provider → no resolution; the policy is the input.
    expect(result.policy).toBe(policy);
    expect(result.errors).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no policy.federated.registry"))).toBe(true);
  });

  test("a fully hand-pinned network with no registry passes through silently", async () => {
    const policy = policyWith(
      [
        networkWith([
          { principal_id: "andreas", stack_id: "andreas/community", principal_pubkey: PEER_NKEY_B },
        ]),
      ],
      { withRegistry: false },
    );
    const warnings: string[] = [];

    const result = await resolveBootFederatedPeers(policy, {
      warn: (m) => warnings.push(m),
    });

    expect(result.policy).toBe(policy);
    expect(warnings).toHaveLength(0);
  });
});
