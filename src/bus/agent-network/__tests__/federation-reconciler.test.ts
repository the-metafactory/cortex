/**
 * P3 (cortex#1088) — tests for the runtime federation roster reconciler.
 *
 * The reconciler is the missing wire (design §4): for each opted-in network it
 * resolves the registry roster (P1), derives the desired federation policy
 * (peers ∪ accept_subjects, P2), and APPLIES it to the LIVE
 * `PolicyFederatedNetwork` objects the federation gate reads — IN PLACE, so a
 * peer that joins a shared network after the local stack joined is admitted
 * within one reconcile interval, without a manual `network join`.
 *
 * Trust focus (the slice is trust-sensitive): a continuous reconcile must NEVER
 * accept-list a non-roster peer, open an interior subtree, or perturb the gate
 * for a network it was not asked to reconcile. The registry stays the authority;
 * the wire is never the source of membership.
 */

import { describe, expect, it } from "bun:test";
import {
  reconcileNetwork,
  reconcileOnce,
  startFederationReconciler,
} from "../federation-reconciler";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type {
  NetworkRosterProvider,
} from "../../../common/registry/resolve-federated-peers";
import type { NetworkFetchResult } from "../../../common/registry/network-client";
import type {
  NetworkRosterResult,
  NetworkRosterPeer,
} from "../../../common/registry/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A 44-char base64 placeholder pubkey (shape-valid; never crypto-checked here). */
const FAKE_PUBKEY = "A".repeat(43) + "=";

function member(principalId: string, stackId?: string): NetworkRosterPeer {
  return {
    principal_id: principalId,
    ...(stackId !== undefined && { stack_id: stackId }),
    principal_pubkey: FAKE_PUBKEY,
  };
}

function roster(members: NetworkRosterPeer[], networkId: string): NetworkRosterResult {
  return { network_id: networkId, members };
}

/**
 * A fake registry client whose roster is a per-network lookup. `fetchAndCache`
 * returns `ok` with the configured roster; an unconfigured network returns
 * `not_found`. An `unreachable` mode drives the DD-10 cache fallback path.
 */
function fakeClient(opts: {
  rosters?: Record<string, NetworkRosterPeer[]>;
  unreachable?: boolean;
  cached?: Record<string, NetworkRosterPeer[]>;
  /** Records each fetchAndCache call (for cadence assertions). */
  calls?: string[];
}): NetworkRosterProvider {
  return {
    fetchAndCache(
      networkId: string,
    ): Promise<NetworkFetchResult<{ roster: NetworkRosterResult }>> {
      opts.calls?.push(networkId);
      if (opts.unreachable) {
        return Promise.resolve({ status: "unreachable", reason: "timeout" });
      }
      const members = opts.rosters?.[networkId];
      if (members === undefined) {
        return Promise.resolve({ status: "not_found" });
      }
      return Promise.resolve({
        status: "ok",
        value: { roster: roster(members, networkId) },
      });
    },
    loadCached(networkId: string) {
      const members = opts.cached?.[networkId];
      if (members === undefined) return undefined;
      return { roster: roster(members, networkId) };
    },
  };
}

function network(
  overrides: Partial<PolicyFederatedNetwork> & { id: string },
): PolicyFederatedNetwork {
  return {
    id: overrides.id,
    leaf_node: overrides.leaf_node ?? overrides.id,
    peers: overrides.peers ?? [],
    accept_subjects: overrides.accept_subjects ?? [],
    deny_subjects: overrides.deny_subjects ?? [],
    announce_capabilities: overrides.announce_capabilities ?? [],
    max_hop: overrides.max_hop ?? 1,
    ...(overrides.reconcile !== undefined && { reconcile: overrides.reconcile }),
    ...(overrides.nats !== undefined && { nats: overrides.nats }),
  };
}

const SELF = { principal: "andreas", stack: "meta-factory" };

// ===========================================================================
// reconcileNetwork — the pure per-network policy derivation + in-place apply
// ===========================================================================

describe("reconcileNetwork — derive + apply in place", () => {
  it("admits a later-joining roster peer: writes peer subtree onto accept_subjects + peers, in place", async () => {
    const net = network({
      id: "metafactory",
      // The OWN-only accept-list a pre-P3 `network join` wrote (jc joined later).
      accept_subjects: ["federated.andreas.meta-factory.>"],
      peers: [],
    });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("applied");
    // peers[] now carries jc (the gate's resolveSourceNetwork needs this).
    expect(net.peers.map((p) => p.principal_id)).toEqual(["jc"]);
    // accept_subjects = OWN ∪ jc's subtree (the defect-#1 fix).
    expect(net.accept_subjects).toEqual([
      "federated.andreas.meta-factory.>",
      "federated.jc.research.agent.>",
    ]);
  });

  it("mutates the SAME object reference (the gate's Map sees it without re-subscribe)", async () => {
    const net = network({ id: "metafactory", peers: [] });
    const ref = net; // the federation gate holds this exact reference
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    await reconcileNetwork(net, SELF, client);

    // The gate reads `ref.accept_subjects` live — same object, mutated in place.
    expect(ref.accept_subjects).toContain("federated.jc.research.agent.>");
    expect(ref).toBe(net);
  });

  it("is idempotent — a second reconcile with the same roster is a no-op (no duplicate subtrees)", async () => {
    const net = network({ id: "metafactory", peers: [] });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    const first = await reconcileNetwork(net, SELF, client);
    const acceptAfterFirst = [...net.accept_subjects];
    const second = await reconcileNetwork(net, SELF, client);

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("unchanged");
    expect(net.accept_subjects).toEqual(acceptAfterFirst);
  });

  // --- #762 hand-pin guard -------------------------------------------------

  it("#762 — 0 resolved peers + existing hand-pins ⇒ PRESERVES hand-pins (never wipes)", async () => {
    const net = network({
      id: "metafactory",
      peers: [{ principal_id: "jc", stack_id: "jc/research" }],
      accept_subjects: [
        "federated.andreas.meta-factory.>",
        "federated.jc.research.agent.>",
      ],
    });
    // Empty roster (jc registered but announced no caps into the net yet).
    const client = fakeClient({ rosters: { metafactory: [] } });

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("preserved-handpins");
    // Hand-pin survives — NOT wiped to [].
    expect(net.peers.map((p) => p.principal_id)).toEqual(["jc"]);
    expect(net.accept_subjects).toContain("federated.jc.research.agent.>");
  });

  it("#762 — 0 resolved peers + NO prior peers ⇒ collapses to OWN-only (first-join case)", async () => {
    const net = network({ id: "metafactory", peers: [], accept_subjects: [] });
    const client = fakeClient({ rosters: { metafactory: [] } });

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("applied");
    expect(net.peers).toEqual([]);
    // Own subtree only — never empty (deriveAcceptSubjects invariant).
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
  });

  // --- Trust: registry is authority, not the wire --------------------------

  it("only accept-lists peers the ROSTER names (registry is authority)", async () => {
    const net = network({ id: "metafactory", peers: [] });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    await reconcileNetwork(net, SELF, client);

    // Exactly OWN + jc — no extra subtree appears from nowhere.
    expect(net.accept_subjects).toHaveLength(2);
    expect(net.accept_subjects).not.toContain("federated.mallory.evil.>");
  });

  it("never writes a literal interior — only wildcard subtrees (own `.>`, peer presence `.agent.>`)", async () => {
    const net = network({ id: "metafactory", peers: [] });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    await reconcileNetwork(net, SELF, client);

    for (const subj of net.accept_subjects) {
      // Each accept entry is a WILDCARD subtree (terminal `>`), never a narrowed
      // interior literal (e.g. `…agent.online` or a tool/prompt path). The OWN
      // entry is the full `federated.{me}.{stack}.>` (dispatch addressed to me);
      // a PEER entry is the presence-only `federated.{peer}.{stack}.agent.>`
      // (#1105 least-privilege). Both end in `.>` — a wildcard, not a literal.
      expect(subj).toMatch(/^federated\.[a-z0-9-]+\.[a-z0-9-]+(\.agent)?\.>$/);
    }
  });

  // --- Best-effort: registry failures never perturb the live policy --------

  it("registry not_found ⇒ leaves the live policy UNCHANGED (does not wipe accept_subjects)", async () => {
    const net = network({
      id: "ghost",
      peers: [{ principal_id: "jc", stack_id: "jc/research" }],
      accept_subjects: [
        "federated.andreas.meta-factory.>",
        "federated.jc.research.agent.>",
      ],
    });
    const before = {
      peers: [...net.peers],
      accept: [...net.accept_subjects],
    };
    const client = fakeClient({ rosters: {} }); // ghost not configured ⇒ not_found

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("skipped-error");
    expect(net.peers).toEqual(before.peers);
    expect(net.accept_subjects).toEqual(before.accept);
  });

  it("registry unreachable + cached roster ⇒ applies the cached roster (DD-10 fallback)", async () => {
    const net = network({ id: "metafactory", peers: [] });
    const client = fakeClient({
      unreachable: true,
      cached: { metafactory: [member("jc", "jc/research")] },
    });

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("applied");
    expect(result.usedCache).toBe(true);
    expect(net.accept_subjects).toContain("federated.jc.research.agent.>");
  });

  it("registry unreachable + NO cache ⇒ UNCHANGED (keeps last-good live policy)", async () => {
    const net = network({
      id: "metafactory",
      peers: [{ principal_id: "jc", stack_id: "jc/research" }],
      accept_subjects: ["federated.jc.research.agent.>"],
    });
    const before = [...net.accept_subjects];
    const client = fakeClient({ unreachable: true });

    const result = await reconcileNetwork(net, SELF, client);

    expect(result.outcome).toBe("skipped-error");
    expect(net.accept_subjects).toEqual(before);
  });
});

// ===========================================================================
// reconcileOnce — one pass over all opted-in networks
// ===========================================================================

describe("reconcileOnce — per-network opt-in (OQ1)", () => {
  it("reconciles ONLY networks with reconcile.enabled = true", async () => {
    const optedIn = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    const optedOut = network({
      id: "community",
      peers: [],
      accept_subjects: ["federated.andreas.community.>"],
      // no reconcile block ⇒ default off
    });
    const client = fakeClient({
      rosters: {
        metafactory: [member("jc", "jc/research")],
        community: [member("mallory", "mallory/x")],
      },
    });

    await reconcileOnce({
      networks: [optedIn, optedOut],
      self: SELF,
      client,
    });

    // metafactory reconciled — jc admitted.
    expect(optedIn.accept_subjects).toContain("federated.jc.research.agent.>");
    // community NOT touched — mallory never appears (opt-out honoured).
    expect(optedOut.accept_subjects).toEqual([
      "federated.andreas.community.>",
    ]);
    expect(optedOut.peers).toEqual([]);
  });

  it("reconcile.enabled = false is treated as opt-out", async () => {
    const net = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: false, interval_ms: 60000 },
    });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    await reconcileOnce({ networks: [net], self: SELF, client });

    expect(net.peers).toEqual([]);
    expect(net.accept_subjects).toEqual([]);
  });

  it("one network's registry error never blocks reconcile of the others", async () => {
    const good = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    const broken = network({
      id: "ghost",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    // metafactory resolves; ghost is not_found.
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });

    const summary = await reconcileOnce({
      networks: [broken, good],
      self: SELF,
      client,
    });

    // good still reconciled despite broken erroring first.
    expect(good.accept_subjects).toContain("federated.jc.research.agent.>");
    expect(summary.applied).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it("returns an empty summary when no network is opted in (no client calls)", async () => {
    const calls: string[] = [];
    const net = network({ id: "metafactory", peers: [] }); // no opt-in
    const client = fakeClient({ rosters: { metafactory: [] }, calls });

    const summary = await reconcileOnce({
      networks: [net],
      self: SELF,
      client,
    });

    expect(summary.applied).toBe(0);
    expect(summary.errors).toBe(0);
    expect(calls).toEqual([]); // opt-out ⇒ no registry I/O at all
  });
});

// ===========================================================================
// startFederationReconciler — the scheduled loop + lifecycle
// ===========================================================================

describe("startFederationReconciler — scheduled loop", () => {
  it("is inert (no schedule, no I/O) when no network is opted in", async () => {
    const calls: string[] = [];
    const net = network({ id: "metafactory", peers: [] });
    let scheduled = false;
    const handle = startFederationReconciler({
      networks: [net],
      self: SELF,
      client: fakeClient({ rosters: { metafactory: [] }, calls }),
      schedule: () => {
        scheduled = true;
        return () => {};
      },
      runOnStart: false,
    });

    expect(handle.active).toBe(false);
    expect(scheduled).toBe(false);
    await handle.stop();
  });

  it("is inert when federated policy is undefined (signal-optional, no federation declared)", async () => {
    const handle = startFederationReconciler({
      networks: undefined,
      self: SELF,
      client: fakeClient({ rosters: {} }),
    });
    expect(handle.active).toBe(false);
    await handle.stop();
  });

  it("runs a reconcile pass on each scheduled tick (driven by an injected scheduler)", async () => {
    const net = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    const client = fakeClient({
      rosters: { metafactory: [member("jc", "jc/research")] },
    });
    let tickFn: (() => void) | null = null;
    const handle = startFederationReconciler({
      networks: [net],
      self: SELF,
      client,
      runOnStart: false,
      schedule: (fn) => {
        tickFn = fn;
        return () => {};
      },
    });

    expect(handle.active).toBe(true);
    expect(net.accept_subjects).not.toContain("federated.jc.research.agent.>");

    // Fire one tick — the reconcile pass runs.
    tickFn!();
    await handle.settle();

    expect(net.accept_subjects).toContain("federated.jc.research.agent.>");
    await handle.stop();
  });

  it("uses the MINIMUM opted-in interval_ms across networks as the loop cadence", () => {
    const fast = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 10000 },
    });
    const slow = network({
      id: "research",
      peers: [],
      reconcile: { enabled: true, interval_ms: 90000 },
    });
    let observedMs = -1;
    const handle = startFederationReconciler({
      networks: [fast, slow],
      self: SELF,
      client: fakeClient({ rosters: {} }),
      runOnStart: false,
      schedule: (_fn, ms) => {
        observedMs = ms;
        return () => {};
      },
    });

    expect(observedMs).toBe(10000);
    void handle.stop();
  });

  it("a reconcile tick that throws never escapes the loop (best-effort)", async () => {
    const net = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    // A client that throws synchronously inside fetchAndCache.
    const throwingClient: NetworkRosterProvider = {
      fetchAndCache() {
        throw new Error("boom");
      },
      loadCached() {
        return undefined;
      },
    };
    let tickFn: (() => void) | null = null;
    const errors: unknown[] = [];
    const handle = startFederationReconciler({
      networks: [net],
      self: SELF,
      client: throwingClient,
      runOnStart: false,
      onError: (e) => errors.push(e),
      schedule: (fn) => {
        tickFn = fn;
        return () => {};
      },
    });

    // Must not throw out of the tick.
    expect(() => tickFn!()).not.toThrow();
    await handle.settle();
    await handle.stop();
  });

  it("stop() is idempotent and cancels the schedule", async () => {
    let cancelled = 0;
    const net = network({
      id: "metafactory",
      peers: [],
      reconcile: { enabled: true, interval_ms: 60000 },
    });
    const handle = startFederationReconciler({
      networks: [net],
      self: SELF,
      client: fakeClient({ rosters: { metafactory: [] } }),
      runOnStart: false,
      schedule: () => () => {
        cancelled += 1;
      },
    });

    await handle.stop();
    await handle.stop();
    expect(cancelled).toBe(1);
  });
});
