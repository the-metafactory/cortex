/**
 * S4 (Network Join Control Plane, epic #733; DD-5 wiring) — integration test
 * that `startCortex` invokes the boot-path federated-peer resolver and feeds
 * the resolved `peers[]` into the SAME membership gate a hand-pin feeds.
 *
 * This closes the `cortex-config.ts` "WIRING STATUS (S2)" gap: before S4 the
 * resolver was never called at boot. Here we drive the real `startCortex` with
 * an injected fixture roster provider (NO network I/O, NO `~/.config` touch)
 * and assert:
 *
 *   1. DD-5 — a peer declared with only `principal_id` + `stack_id` (no
 *      `principal_pubkey`) has its key filled from the verified roster after
 *      boot, and the resolved network's `peers[]` is what the gate now sees.
 *   2. The gate (`evaluateFederationGate` / `resolveSourceNetwork`) admits the
 *      registry-resolved peer IDENTICALLY to a hand-pinned one — there is no
 *      separate registry-resolved code path (DD-5).
 *   3. DD-11 — a hand-pin that disagrees with the roster is dropped from the
 *      gate at boot, so the gate then DENIES that peer as `unknown_network`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCortex, type StartCortexOptions } from "../cortex";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";
import {
  evaluateFederationGate,
  type FederationGateDecision,
} from "../bus/surface-router";
import { base64PubkeyToNkey } from "../common/registry/encoding";
import type { NetworkRosterProvider } from "../common/registry/resolve-federated-peers";
import type { NetworkFetchResult } from "../common/registry/network-client";
import type { NetworkRosterResult } from "../common/registry/types";
import type {
  Policy,
  PolicyFederatedNetwork,
} from "../common/types/cortex-config";

const PEER_B64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const PEER_B64_OTHER = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
const PEER_NKEY = base64PubkeyToNkey(PEER_B64)!;

function minimalConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-fedboot-published" },
  });
}

function createNoopRuntime(): MyelinRuntime {
  /* eslint-disable @typescript-eslint/no-empty-function */
  return {
    enabled: false,
    onEnvelope: (_handler: EnvelopeHandler) => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
  /* eslint-enable @typescript-eslint/no-empty-function */
}

function networkWith(
  peers: PolicyFederatedNetwork["peers"],
): PolicyFederatedNetwork {
  return {
    id: "metafactory-community",
    leaf_node: "primary",
    peers,
    // Accept federated traffic addressed to the LOCAL principal/stack.
    accept_subjects: ["federated.test-op.default.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
  };
}

function policyWith(networks: PolicyFederatedNetwork[]): Policy {
  return {
    principals: [],
    federated: {
      networks,
      registry: { url: "https://network.meta-factory.ai" },
    },
  } as unknown as Policy;
}

function fixtureProvider(roster: NetworkRosterResult): NetworkRosterProvider {
  return {
    async fetchAndCache(): Promise<NetworkFetchResult<{ roster: NetworkRosterResult }>> {
      return { status: "ok", value: { roster } };
    },
    loadCached() {
      return undefined;
    },
  };
}

/** A federated envelope whose `source` principal is `sourcePrincipal`. */
function federatedEnvelopeFrom(sourcePrincipal: string): Envelope {
  return {
    source: `${sourcePrincipal}.sage-host`,
  } as unknown as Envelope;
}

async function bootWithPolicy(
  policy: Policy,
  provider: NetworkRosterProvider,
): Promise<{
  resolvedPolicy: Policy | undefined;
  callerPolicyUnchanged: boolean;
  stop: () => Promise<void>;
}> {
  const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-fedboot-"));
  // PR #818 NIT-6 — `startCortex` no longer mutates `options.policy`. Capture
  // the resolved view via the test-only `onBootResolvedPolicy` observation seam.
  let resolvedPolicy: Policy | undefined;
  const options: StartCortexOptions = {
    disableConfigWatcher: true,
    disableDashboard: true,
    disableOutboundPoller: true,
    disableGithubReceiver: true,
    agentsDir: tmpAgentsDir,
    injectRuntime: createNoopRuntime(),
    principal: { id: "test-op" },
    policy,
    bootFederatedRosterProvider: provider,
    onBootResolvedPolicy: (p) => {
      resolvedPolicy = p;
    },
  };
  const handle = await startCortex(minimalConfig(), options);
  return {
    resolvedPolicy,
    // The caller's `options.policy` reference must be UNTOUCHED (NIT-6).
    callerPolicyUnchanged: options.policy === policy,
    stop: async () => {
      await handle.stop();
      rmSync(tmpAgentsDir, { recursive: true, force: true });
    },
  };
}

/** Build the gate's network map from a resolved policy + evaluate one subject. */
function gateDecision(
  resolvedPolicy: Policy | undefined,
  sourcePrincipal: string,
): FederationGateDecision {
  const networksById = new Map<string, PolicyFederatedNetwork>();
  for (const n of resolvedPolicy?.federated?.networks ?? []) {
    networksById.set(n.id, n);
  }
  return evaluateFederationGate(
    "federated.test-op.default.tasks.code-review.req",
    federatedEnvelopeFrom(sourcePrincipal),
    networksById,
    "primary",
  );
}

describe("startCortex — federated-peer boot resolution (DD-5 wiring)", () => {
  test("a pubkey-less peer is registry-resolved at boot and admitted by the gate", async () => {
    const policy = policyWith([
      networkWith([{ principal_id: "jcfischer", stack_id: "jcfischer/sage-host" }]),
    ]);
    const provider = fixtureProvider({
      network_id: "metafactory-community",
      members: [{ principal_id: "jcfischer", principal_pubkey: PEER_B64 }],
    });

    const { resolvedPolicy, callerPolicyUnchanged, stop } = await bootWithPolicy(
      policy,
      provider,
    );
    try {
      // DD-5 — the peer's pubkey is filled from the roster (nkey-U).
      const peers = resolvedPolicy?.federated?.networks[0]?.peers ?? [];
      expect(peers).toHaveLength(1);
      expect(peers[0]?.principal_id).toBe("jcfischer");
      expect(peers[0]?.principal_pubkey).toBe(PEER_NKEY);

      // The gate now admits the registry-resolved peer (membership keys on
      // `peers[].principal_id`, populated by the resolver — same path a
      // hand-pin feeds). `allow` for an accepted subject.
      expect(gateDecision(resolvedPolicy, "jcfischer")).toBe("allow");

      // PR #818 NIT-6 — the caller's `options.policy` reference is NOT mutated:
      // the resolved view is a fresh local binding in `startCortex`. (The input
      // peer was pubkey-less; the resolved one carries the filled key — so they
      // are also not the same object.)
      expect(callerPolicyUnchanged).toBe(true);
      expect(policy.federated?.networks[0]?.peers[0]?.principal_pubkey).toBeUndefined();
    } finally {
      await stop();
    }
  });

  test("a registry-resolved peer is admitted IDENTICALLY to a hand-pinned one", async () => {
    // Network A: peer hand-pinned. Network B: same peer pubkey-less (resolved).
    // Both must yield the SAME gate verdict for the same source principal.
    const handPinned = policyWith([
      networkWith([
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host", principal_pubkey: PEER_NKEY },
      ]),
    ]);
    const resolvedOnly = policyWith([
      networkWith([{ principal_id: "jcfischer", stack_id: "jcfischer/sage-host" }]),
    ]);
    const provider = fixtureProvider({
      network_id: "metafactory-community",
      members: [{ principal_id: "jcfischer", principal_pubkey: PEER_B64 }],
    });

    const a = await bootWithPolicy(handPinned, provider);
    const b = await bootWithPolicy(resolvedOnly, provider);
    try {
      const verdictHandPinned = gateDecision(a.resolvedPolicy, "jcfischer");
      const verdictResolved = gateDecision(b.resolvedPolicy, "jcfischer");
      expect(verdictResolved).toEqual(verdictHandPinned);
      expect(verdictResolved).toBe("allow");
      // And both carry the same resolved key on the gate's network.
      expect(b.resolvedPolicy?.federated?.networks[0]?.peers[0]?.principal_pubkey).toBe(
        a.resolvedPolicy?.federated?.networks[0]?.peers[0]?.principal_pubkey,
      );
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("DD-11 — a hand-pin disagreeing with the roster is dropped; gate denies it", async () => {
    const policy = policyWith([
      networkWith([
        // hand-pinned to PEER_NKEY, but the roster will say PEER_B64_OTHER.
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host", principal_pubkey: PEER_NKEY },
        // a second, pubkey-less peer (resolved) — proves the mismatch drop is
        // per-peer, not all-or-nothing.
        { principal_id: "andreas", stack_id: "andreas/community" },
      ]),
    ]);
    const provider = fixtureProvider({
      network_id: "metafactory-community",
      members: [
        { principal_id: "jcfischer", principal_pubkey: PEER_B64_OTHER },
        { principal_id: "andreas", principal_pubkey: PEER_B64 },
      ],
    });

    const { resolvedPolicy, stop } = await bootWithPolicy(policy, provider);
    try {
      // jcfischer dropped (DD-11 mismatch); andreas resolved + kept.
      const peers = resolvedPolicy?.federated?.networks[0]?.peers ?? [];
      expect(peers.map((p) => p.principal_id)).toEqual(["andreas"]);

      // The gate now treats jcfischer as an unknown peer (dropped from peers[]).
      const denied = gateDecision(resolvedPolicy, "jcfischer");
      expect(typeof denied).toBe("object");
      if (typeof denied === "object" && denied.kind === "peer_not_in_accept_list") {
        expect(denied.unknown_network).toBe(true);
      } else {
        throw new Error(`expected peer_not_in_accept_list, got ${JSON.stringify(denied)}`);
      }
      // andreas (resolved) is still admitted.
      expect(gateDecision(resolvedPolicy, "andreas")).toBe("allow");
    } finally {
      await stop();
    }
  });

  test("DD-11 MAJOR-1 — a FULLY hand-pinned network is cross-checked; a drifted pin is dropped", async () => {
    // PR #818 review MAJOR-1 regression guard. BEFORE the fix this network made
    // ZERO registry calls (every peer hand-pinned ⇒ `needsRegistry` false), so a
    // hand-pin that had drifted from a rotated/tampered roster key was admitted
    // on the stale pin and DD-11 never fired. AFTER the fix the roster IS fetched
    // for any non-empty network when a registry is configured, so the pin↔roster
    // cross-check fires and the drifted peer is DROPPED.
    const policy = policyWith([
      networkWith([
        // The ONLY peer — fully hand-pinned to PEER_NKEY.
        { principal_id: "jcfischer", stack_id: "jcfischer/sage-host", principal_pubkey: PEER_NKEY },
      ]),
    ]);
    // The registry serves a DIFFERENT key for the same principal (rotation /
    // compromise): drift signal.
    const provider = fixtureProvider({
      network_id: "metafactory-community",
      members: [{ principal_id: "jcfischer", principal_pubkey: PEER_B64_OTHER }],
    });

    const { resolvedPolicy, stop } = await bootWithPolicy(policy, provider);
    try {
      // The drifted hand-pin is DROPPED (not silently kept on the stale pin).
      const peers = resolvedPolicy?.federated?.networks[0]?.peers ?? [];
      expect(peers).toHaveLength(0);

      // The gate denies the dropped peer as an unknown network member.
      const denied = gateDecision(resolvedPolicy, "jcfischer");
      expect(typeof denied).toBe("object");
      if (typeof denied === "object" && denied.kind === "peer_not_in_accept_list") {
        expect(denied.unknown_network).toBe(true);
      } else {
        throw new Error(`expected peer_not_in_accept_list, got ${JSON.stringify(denied)}`);
      }
    } finally {
      await stop();
    }
  });
});
