/**
 * S4 (Network Join Control Plane, #738) — join/leave/status orchestration tests.
 *
 * Every I/O is a FAKE port (no real fs / exec / registry / launchctl — the S4
 * SAFETY rule). Coverage maps to the brief's TESTS list:
 *
 *   - join writes the expected leaf include + plist arg + config block + calls
 *     restart; idempotent on re-run (no dup network).
 *   - only a VERIFIED descriptor reaches the renderer (a bad-signature
 *     descriptor aborts join — DD-9 + the branded-type boundary).
 *   - registry-down → uses cached + warns, join still configures (DD-10).
 *   - peers resolved by principal_id (DD-5); the local principal is never in
 *     its own peers[].
 *   - leave reverses exactly + is idempotent.
 *   - status renders joined networks + peers + link state.
 *   - wire contract: accept_subjects = the stack's OWN federated.{me}.{stack}.>
 *     (no network id on the wire).
 */

import { describe, test, expect } from "bun:test";

import {
  joinNetwork,
  leaveNetwork,
  networkStatus,
  type JoiningStack,
} from "../network-lib";
import type {
  ConfigStorePort,
  DaemonPort,
  LeafFilePort,
  LeafStatePort,
  NetworkPorts,
  NetworkRegistryPort,
  PlistPort,
  RenderLeafInputs,
} from "../network-ports";
import type {
  NetworkDescriptor,
  NetworkRosterResult,
} from "../../../../common/registry/types";
import type { NetworkFetchResult } from "../../../../common/registry/network-client";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import { renderLeafIncludeFile } from "../../../../common/nats/leaf-remote-renderer";
import { nkeyToBase64Pubkey } from "../../../../common/registry/encoding";

// =============================================================================
// Fixtures
// =============================================================================

// A valid base64 ed25519 pubkey (44 chars w/ padding) that re-encodes to a
// valid nkey-U via the encoding module — so the join's nkey re-encode produces
// a deterministic peer pubkey we can round-trip-assert.
function validPeerBase64(): string {
  // A 32-byte all-0x01 key, base64-encoded — valid base64 ed25519 grammar.
  const raw = new Uint8Array(32).fill(1);
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PEER_B64 = validPeerBase64();

const LOCAL: JoiningStack = {
  principalId: "andreas",
  stackSlug: "meta-factory",
  credentials: "/Users/andreas/.config/nats/andreas.creds",
  account: "A" + "B".repeat(55), // valid nkey-U account grammar (A + 55 base32)
};

function descriptorFor(networkId: string): NetworkDescriptor {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    members: ["andreas", "jc"],
  };
}

function rosterFor(networkId: string): NetworkRosterResult {
  return {
    network_id: networkId,
    members: [
      // The local principal — must be EXCLUDED from peers[].
      { principal_id: "andreas", principal_pubkey: PEER_B64, stack_id: "andreas/meta-factory" },
      // A real peer.
      { principal_id: "jc", principal_pubkey: PEER_B64, stack_id: "jc/sage-host" },
    ],
  };
}

// =============================================================================
// Fake ports
// =============================================================================

interface Recorder {
  registered: number;
  restarts: number;
  writes: RenderLeafInputs[];
  removes: string[];
  /** #754 — networks whose include directive was ensured into local.conf. */
  includesEnsured: string[];
  /** #754 — networks whose include directive was removed from local.conf. */
  includesRemoved: string[];
  ensured: string[];
  dropped: string[];
  configWrites: PolicyFederatedNetwork[][];
  warnings: string[];
}

function makeFakes(opts: {
  fetch?: NetworkFetchResult<{ descriptor: NetworkDescriptor; roster: NetworkRosterResult }>;
  cached?: { descriptor: NetworkDescriptor; roster: NetworkRosterResult };
  registerOk?: boolean;
  restartOk?: boolean;
  initialNetworks?: PolicyFederatedNetwork[];
  leafState?: LeafStatePort;
}): { ports: NetworkPorts; rec: Recorder; storeRef: { networks: PolicyFederatedNetwork[] } } {
  const rec: Recorder = {
    registered: 0,
    restarts: 0,
    writes: [],
    removes: [],
    includesEnsured: [],
    includesRemoved: [],
    ensured: [],
    dropped: [],
    configWrites: [],
    warnings: [],
  };
  const storeRef = { networks: opts.initialNetworks ?? [] };
  const leafFilesPresent = new Set<string>(
    (opts.initialNetworks ?? []).map((n) => n.id),
  );

  const registry: NetworkRegistryPort = {
    async registerStack() {
      rec.registered++;
      return opts.registerOk === false
        ? { ok: false, reason: "registry rejected" }
        : { ok: true, note: "HTTP 201" };
    },
    async fetchVerified(_id) {
      return (
        opts.fetch ?? {
          status: "ok",
          value: { descriptor: descriptorFor(_id), roster: rosterFor(_id) },
        }
      );
    },
    loadCached(_id) {
      return opts.cached;
    },
  };

  const leafFile: LeafFilePort = {
    write(inputs) {
      rec.writes.push(inputs);
      leafFilesPresent.add(inputs.descriptor.network_id);
    },
    remove(networkId) {
      rec.removes.push(networkId);
      leafFilesPresent.delete(networkId);
    },
    ensureInclude(networkId) {
      rec.includesEnsured.push(networkId);
    },
    removeInclude(networkId) {
      rec.includesRemoved.push(networkId);
    },
    list() {
      return [...leafFilesPresent];
    },
    natsConfigPath() {
      return "/Users/andreas/.config/nats/local.conf";
    },
  };

  const plist: PlistPort = {
    ensureConfigLoaded(p) {
      rec.ensured.push(p);
    },
    dropConfigArg(p) {
      rec.dropped.push(p);
    },
  };

  const configStore: ConfigStorePort = {
    readNetworks() {
      return storeRef.networks;
    },
    writeNetworks(networks) {
      storeRef.networks = networks;
      rec.configWrites.push(networks);
    },
  };

  const daemon: DaemonPort = {
    async restart() {
      rec.restarts++;
      return opts.restartOk === false
        ? { ok: false, reason: "launchctl kickstart failed" }
        : { ok: true };
    },
  };

  return {
    ports: { registry, leafFile, plist, configStore, daemon, leafState: opts.leafState },
    rec,
    storeRef,
  };
}

// =============================================================================
// join
// =============================================================================

describe("join", () => {
  test("writes leaf include + plist arg + config block + restarts (DD-4)", async () => {
    const { ports, rec, storeRef } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    // (a) registered exactly once.
    expect(rec.registered).toBe(1);
    // (c) leaf include written for the network, from a VERIFIED descriptor.
    expect(rec.writes.length).toBe(1);
    expect(rec.writes[0]!.descriptor.network_id).toBe("metafactory");
    // The S3 renderer accepts the branded descriptor + binding without throwing.
    const rendered = renderLeafIncludeFile(
      rec.writes[0]!.descriptor,
      rec.writes[0]!.binding,
    );
    expect(rendered).toContain("leafnodes {");
    expect(rendered).toContain("tls://hub.meta-factory.ai:7422");
    // (c) plist ensured to load the nats config.
    expect(rec.ensured).toEqual(["/Users/andreas/.config/nats/local.conf"]);
    // (c) #754 — local.conf ensured to INCLUDE the rendered leaf file, so the
    // leaf is actually loaded (not dormant).
    expect(rec.includesEnsured).toEqual(["metafactory"]);
    expect(
      res.steps.some((s) => s === "ensured local.conf includes leafnodes-metafactory.conf"),
    ).toBe(true);
    // (d) config block written.
    expect(storeRef.networks.length).toBe(1);
    const net = storeRef.networks[0]!;
    expect(net.id).toBe("metafactory");
    // (e) restarted.
    expect(rec.restarts).toBe(1);
  });

  test("accept_subjects is the stack's OWN federated.{me}.{stack}.> (wire contract)", async () => {
    const { ports, storeRef } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    const net = storeRef.networks[0]!;
    // The wire contract: own principal/stack segment, NOT the network id.
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
    // Network id must NOT appear in any accept subject (no network on the wire).
    expect(net.accept_subjects.some((s) => s.includes("metafactory"))).toBe(false);
  });

  test("peers resolved by principal_id, local principal excluded (DD-5)", async () => {
    const { ports, storeRef } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);
    const net = storeRef.networks[0]!;
    // Only the peer "jc" — the local "andreas" is never in its own peers[].
    expect(net.peers.map((p) => p.principal_id)).toEqual(["jc"]);
    expect(res.resolvedPeers).toEqual(["jc"]);
    // The peer declares principal_id + stack_id; pubkey resolved to nkey-U.
    const peer = net.peers[0]!;
    expect(peer.stack_id).toBe("jc/sage-host");
    expect(peer.principal_pubkey).toBeDefined();
    // The resolved nkey re-encodes back to the roster's base64 (DD-8 round-trip).
    expect(nkeyToBase64Pubkey(peer.principal_pubkey!)).toBe(PEER_B64);
  });

  test("idempotent — re-running replaces, does not duplicate the network", async () => {
    const { ports, storeRef, rec } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    await joinNetwork("metafactory", LOCAL, ports);
    // Still exactly one network entry.
    expect(storeRef.networks.length).toBe(1);
    // Both runs wrote the leaf + restarted (converge), no dup network.
    expect(rec.writes.length).toBe(2);
    expect(rec.restarts).toBe(2);
  });

  test("a second distinct network accumulates (multi-network, OQ3)", async () => {
    const { ports, storeRef } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    await joinNetwork("research", LOCAL, ports);
    expect(storeRef.networks.map((n) => n.id).sort()).toEqual([
      "metafactory",
      "research",
    ]);
  });

  test("writes a conscious max_hop (schema has no default)", async () => {
    const { ports, storeRef } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    expect(storeRef.networks[0]!.max_hop).toBe(1);
  });
});

// =============================================================================
// DD-9 trust boundary — only a verified descriptor reaches the renderer
// =============================================================================

describe("DD-9 trust boundary", () => {
  test("a bad-signature descriptor aborts join — renderer never called", async () => {
    const { ports, rec, storeRef } = makeFakes({
      fetch: { status: "unverified", reason: "bad_signature" },
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("verification");
    // The leaf renderer was NEVER called with an unverified descriptor.
    expect(rec.writes.length).toBe(0);
    // No config written, no plist touched, no restart.
    expect(storeRef.networks.length).toBe(0);
    expect(rec.ensured.length).toBe(0);
    expect(rec.restarts).toBe(0);
  });

  test("not_found aborts join cleanly", async () => {
    const { ports, rec } = makeFakes({ fetch: { status: "not_found" } });
    const res = await joinNetwork("ghost", LOCAL, ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("not found");
    expect(rec.writes.length).toBe(0);
  });
});

// =============================================================================
// DD-10 — registry-down → cached + warn, join still configures
// =============================================================================

describe("DD-10 cached fallback", () => {
  test("registry unreachable → uses cached descriptor, join still configures", async () => {
    const { ports, rec, storeRef } = makeFakes({
      fetch: { status: "unreachable", reason: "timeout" },
      cached: { descriptor: descriptorFor("metafactory"), roster: rosterFor("metafactory") },
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    expect(res.usedCache).toBe(true);
    // The step log carries the DD-10 warning.
    expect(res.steps.some((s) => s.includes("DD-10"))).toBe(true);
    // Join still configured everything.
    expect(rec.writes.length).toBe(1);
    expect(storeRef.networks.length).toBe(1);
    expect(rec.restarts).toBe(1);
  });

  test("registry unreachable AND no cache → join fails (cannot render unverified)", async () => {
    const { ports, rec } = makeFakes({
      fetch: { status: "unreachable", reason: "timeout" },
      cached: undefined,
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no cached descriptor");
    expect(rec.writes.length).toBe(0);
  });
});

// =============================================================================
// failure surfacing
// =============================================================================

describe("join failure surfacing", () => {
  test("register failure aborts before any mutation", async () => {
    const { ports, rec } = makeFakes({ registerOk: false });
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("register failed");
    expect(rec.writes.length).toBe(0);
    expect(rec.restarts).toBe(0);
  });

  test("restart failure → config is written but result is not ok", async () => {
    const { ports, storeRef } = makeFakes({ restartOk: false });
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("restart failed");
    // Config WAS written (the restart is the last step) — surfaced to the user.
    expect(storeRef.networks.length).toBe(1);
  });
});

// =============================================================================
// leave
// =============================================================================

describe("leave", () => {
  function joinedNetwork(id: string): PolicyFederatedNetwork {
    return {
      id,
      leaf_node: id,
      peers: [{ principal_id: "jc", stack_id: "jc/sage-host" }],
      accept_subjects: ["federated.andreas.meta-factory.>"],
      deny_subjects: [],
      announce_capabilities: [],
      max_hop: 1,
    };
  }

  test("reverses exactly: removes config + leaf, drops plist arg, restarts", async () => {
    const { ports, rec, storeRef } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory")],
    });
    const res = await leaveNetwork("metafactory", ports);

    expect(res.ok).toBe(true);
    // Config entry removed.
    expect(storeRef.networks.length).toBe(0);
    // #754 — the include directive removed from local.conf (inverse of join).
    expect(rec.includesRemoved).toEqual(["metafactory"]);
    // Leaf include deleted.
    expect(rec.removes).toEqual(["metafactory"]);
    // No networks remain → plist -c dropped.
    expect(rec.dropped).toEqual(["/Users/andreas/.config/nats/local.conf"]);
    // Restarted.
    expect(rec.restarts).toBe(1);
  });

  test("keeps the plist arg when other networks remain", async () => {
    const { ports, rec, storeRef } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory"), joinedNetwork("research")],
    });
    const res = await leaveNetwork("metafactory", ports);
    expect(res.ok).toBe(true);
    expect(storeRef.networks.map((n) => n.id)).toEqual(["research"]);
    expect(rec.removes).toEqual(["metafactory"]);
    // research still has a leaf → plist arg NOT dropped.
    expect(rec.dropped.length).toBe(0);
  });

  test("idempotent — leaving a network never joined is a clean no-op", async () => {
    const { ports, rec, storeRef } = makeFakes({ initialNetworks: [] });
    const res = await leaveNetwork("metafactory", ports);
    expect(res.ok).toBe(true);
    expect(res.notJoined).toBe(true);
    expect(rec.removes.length).toBe(0);
    expect(rec.restarts).toBe(0);
    expect(storeRef.networks.length).toBe(0);
  });
});

// =============================================================================
// status
// =============================================================================

describe("status", () => {
  function joinedNetwork(id: string): PolicyFederatedNetwork {
    return {
      id,
      leaf_node: id,
      peers: [{ principal_id: "jc", stack_id: "jc/sage-host" }],
      accept_subjects: [`federated.andreas.meta-factory.>`],
      deny_subjects: [],
      announce_capabilities: [],
      max_hop: 1,
    };
  }

  test("renders joined networks + peers + accept subjects + link state", async () => {
    const leafState: LeafStatePort = {
      async linkStates() {
        return {
          metafactory: { state: "established", inMsgs: 42, outMsgs: 7 },
        };
      },
    };
    const { ports } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory")],
      leafState,
    });
    const res = await networkStatus(ports);

    expect(res.ok).toBe(true);
    expect(res.networks.length).toBe(1);
    const row = res.networks[0]!;
    expect(row.networkId).toBe("metafactory");
    expect(row.peers).toEqual(["jc"]);
    expect(row.acceptSubjects).toEqual(["federated.andreas.meta-factory.>"]);
    expect(row.link.state).toBe("established");
    expect(row.link.inMsgs).toBe(42);
  });

  test("link state is 'unknown' when no leaf-state provider is wired", async () => {
    const { ports } = makeFakes({ initialNetworks: [joinedNetwork("metafactory")] });
    const res = await networkStatus(ports);
    expect(res.networks[0]!.link.state).toBe("unknown");
  });

  test("empty when no networks are joined", async () => {
    const { ports } = makeFakes({ initialNetworks: [] });
    const res = await networkStatus(ports);
    expect(res.ok).toBe(true);
    expect(res.networks.length).toBe(0);
  });
});
