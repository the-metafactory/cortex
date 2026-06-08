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
  NatsServerPort,
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
  /** #757 — count of nats-server restarts requested. */
  natsRestarts: number;
  /** #757 — ordered restart log: "nats" / "cortex" in call order. */
  restartOrder: ("nats" | "cortex")[];
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
  /** #794 — accounts the orchestrator pre-flighted via canBindAccount(). */
  bindChecks: string[];
}

function makeFakes(opts: {
  fetch?: NetworkFetchResult<{ descriptor: NetworkDescriptor; roster: NetworkRosterResult }>;
  cached?: { descriptor: NetworkDescriptor; roster: NetworkRosterResult };
  registerOk?: boolean;
  restartOk?: boolean;
  /** #757 — make the nats-server restart fail (default: ok). */
  natsRestartOk?: boolean;
  /** #757 — omit the nats-server port entirely (pre-#757 caller). */
  withoutNatsServer?: boolean;
  initialNetworks?: PolicyFederatedNetwork[];
  leafState?: LeafStatePort;
  /** #794 — make the stack's nats config UNABLE to bind the leaf account. */
  canBind?: boolean;
}): { ports: NetworkPorts; rec: Recorder; storeRef: { networks: PolicyFederatedNetwork[] } } {
  const rec: Recorder = {
    registered: 0,
    restarts: 0,
    natsRestarts: 0,
    restartOrder: [],
    writes: [],
    removes: [],
    includesEnsured: [],
    includesRemoved: [],
    ensured: [],
    dropped: [],
    configWrites: [],
    warnings: [],
    bindChecks: [],
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
    canBindAccount(account) {
      rec.bindChecks.push(account);
      // #794 — default: the bus can bind (operator-mode). A test opts into the
      // anonymous-bus crash case via `canBind: false`.
      return opts.canBind === false
        ? {
            canBind: false,
            reason:
              "config is anonymous/hard-isolated (no operator-mode account tree)",
          }
        : { canBind: true };
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
      rec.restartOrder.push("cortex");
      return opts.restartOk === false
        ? { ok: false, reason: "launchctl kickstart failed" }
        : { ok: true };
    },
  };

  const natsServer: NatsServerPort = {
    async restart() {
      rec.natsRestarts++;
      rec.restartOrder.push("nats");
      return opts.natsRestartOk === false
        ? { ok: false, reason: "nats-server kickstart failed" }
        : { ok: true };
    },
  };

  return {
    ports: {
      registry,
      leafFile,
      plist,
      configStore,
      daemon,
      ...(opts.withoutNatsServer === true ? {} : { natsServer }),
      leafState: opts.leafState,
    },
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
    // (b.5) #794 — the account was pre-flighted before any mutation.
    expect(rec.bindChecks).toEqual([LOCAL.account]);
  });

  // ---------------------------------------------------------------------------
  // #794 — FAIL FAST on a bus that can't bind the leaf account (no crash).
  // ---------------------------------------------------------------------------
  describe("#794 fail-fast (anonymous / hard-isolated bus)", () => {
    test("REFUSES when the nats config can't bind the leaf account", async () => {
      const { ports } = makeFakes({ canBind: false });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      // Actionable error: names the config path, the missing account, the fix.
      expect(res.reason).toContain("/Users/andreas/.config/nats/local.conf");
      expect(res.reason).toContain(LOCAL.account);
      expect(res.reason).toContain("operator-mode");
      expect(res.reason).toContain("cortex#794");
    });

    test("touches NOTHING when it refuses (no leaf, no include, no restart)", async () => {
      const { ports, rec, storeRef } = makeFakes({ canBind: false });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      // The pre-flight ran...
      expect(rec.bindChecks).toEqual([LOCAL.account]);
      // ...but NO mutation followed it.
      expect(rec.writes.length).toBe(0); // no leaf include written
      expect(rec.includesEnsured).toEqual([]); // no local.conf include
      expect(rec.ensured).toEqual([]); // no plist ensure
      expect(rec.configWrites.length).toBe(0); // no federation config write
      expect(rec.restarts).toBe(0); // no daemon restart
      expect(rec.natsRestarts).toBe(0); // no nats-server restart
      expect(storeRef.networks.length).toBe(0); // config untouched
    });

    test("dry-run surfaces the SAME refusal (canBindAccount is a READ)", async () => {
      // The orchestrator is identical under dry-run/live; the fake models the
      // dry-run adapter (reads hit disk, writes no-op) — and the guard fires on
      // the READ, so a dry-run join refuses just like --apply would.
      const { ports, rec } = makeFakes({ canBind: false });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("cortex#794");
      expect(rec.writes.length).toBe(0);
    });

    test("proceeds normally when the config CAN bind the account", async () => {
      const { ports, rec, storeRef } = makeFakes({ canBind: true });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      expect(rec.bindChecks).toEqual([LOCAL.account]);
      // Existing join flow unchanged: leaf written, restarted, config written.
      expect(rec.writes.length).toBe(1);
      expect(rec.restarts).toBe(1);
      expect(storeRef.networks.length).toBe(1);
    });
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
// #757 — join restarts nats-server (so the leaf loads) BEFORE the cortex daemon
// =============================================================================

describe("#757 nats-server restart on join", () => {
  test("join restarts nats-server, then the cortex daemon (order matters)", async () => {
    const { ports, rec } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    // nats-server restarted exactly once (loads local.conf + the new leaf).
    expect(rec.natsRestarts).toBe(1);
    // cortex daemon also restarted (reconnect).
    expect(rec.restarts).toBe(1);
    // Order: nats-server FIRST (bus carries the leaf), THEN cortex reconnects.
    expect(rec.restartOrder).toEqual(["nats", "cortex"]);
  });

  test("the nats-server restart happens AFTER the config writes", async () => {
    const { ports, rec, storeRef } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    // Config + include were written before the restart fired.
    expect(storeRef.networks.length).toBe(1);
    expect(rec.includesEnsured).toEqual(["metafactory"]);
    expect(rec.ensured.length).toBe(1);
    // The restart order proves nats came after the writes (writes are sync,
    // restarts are the last two awaited calls).
    expect(rec.restartOrder).toEqual(["nats", "cortex"]);
  });

  test("step log records the nats-server restart line", async () => {
    const { ports } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(
      res.steps.some((s) => s === "restarted nats-server to load leaf config"),
    ).toBe(true);
    expect(res.steps.some((s) => s === "restarted stack daemon")).toBe(true);
    // nats-server step precedes the cortex daemon step.
    const natsIdx = res.steps.indexOf("restarted nats-server to load leaf config");
    const cortexIdx = res.steps.indexOf("restarted stack daemon");
    expect(natsIdx).toBeLessThan(cortexIdx);
  });

  test("a nats-server restart failure fails the join (config NOT lost, never throws)", async () => {
    const { ports, rec, storeRef } = makeFakes({ natsRestartOk: false });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("nats-server restart failed");
    // The config block WAS written (mutation got that far) — re-running converges.
    expect(storeRef.networks.length).toBe(1);
    // The cortex daemon was NOT restarted — we abort on the nats failure first.
    expect(rec.restarts).toBe(0);
    expect(rec.restartOrder).toEqual(["nats"]);
  });

  test("absent nats-server port → restart skipped (pre-#757 caller still works)", async () => {
    const { ports, rec } = makeFakes({ withoutNatsServer: true });
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(true);
    // No nats restart, but the cortex daemon still restarts.
    expect(rec.natsRestarts).toBe(0);
    expect(rec.restarts).toBe(1);
    expect(rec.restartOrder).toEqual(["cortex"]);
    expect(
      res.steps.some((s) => s === "restarted nats-server to load leaf config"),
    ).toBe(false);
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
// #762 — empty roster must NOT clobber a working hand-pinned peer
// =============================================================================

/** A roster with NO members — the bug condition (nobody announced caps in). */
function emptyRosterFor(networkId: string): NetworkRosterResult {
  return { network_id: networkId, members: [] };
}

/** An existing config entry carrying a hand-pinned peer (the offline fallback). */
function handPinnedNetwork(networkId: string): PolicyFederatedNetwork {
  return {
    id: networkId,
    leaf_node: networkId,
    peers: [
      {
        principal_id: "andreas",
        stack_id: "andreas/meta-factory",
        principal_pubkey: "U" + "A".repeat(55), // valid nkey-U grammar
      },
    ],
    accept_subjects: [`federated.jc.sage-host.>`],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
  };
}

describe("#762 empty roster preserves hand-pins", () => {
  test("empty roster + existing hand-pin → hand-pin PRESERVED, not wiped", async () => {
    const { ports, storeRef, rec } = makeFakes({
      fetch: {
        status: "ok",
        value: { descriptor: descriptorFor("metafactory"), roster: emptyRosterFor("metafactory") },
      },
      initialNetworks: [handPinnedNetwork("metafactory")],
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    // The hand-pinned peer SURVIVES the join (was NOT overwritten with []).
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.peers.map((p) => p.principal_id)).toEqual(["andreas"]);
    expect(net.peers[0]!.principal_pubkey).toBe("U" + "A".repeat(55));
    // The config was still written (the join converges other fields), but the
    // peer list is the preserved hand-pin, not the empty roster.
    expect(rec.configWrites.length).toBe(1);
  });

  test("empty roster + hand-pin → a warning is emitted (not silent)", async () => {
    const { ports, storeRef } = makeFakes({
      fetch: {
        status: "ok",
        value: { descriptor: descriptorFor("metafactory"), roster: emptyRosterFor("metafactory") },
      },
      initialNetworks: [handPinnedNetwork("metafactory")],
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.warnings).toBeDefined();
    expect(res.warnings!.some((w) => w.includes("0 peers"))).toBe(true);
    expect(res.warnings!.some((w) => w.includes("preserved"))).toBe(true);
    // The warning is also in the step log (principal-visible).
    expect(res.steps.some((s) => s.startsWith("WARN:"))).toBe(true);
    expect(storeRef.networks[0]!.peers.length).toBe(1);
  });

  test("empty roster + NO existing peers → writes 0 peers (nothing to preserve, no warning)", async () => {
    const { ports, storeRef } = makeFakes({
      fetch: {
        status: "ok",
        value: { descriptor: descriptorFor("metafactory"), roster: emptyRosterFor("metafactory") },
      },
      // No initial networks — first join, nothing to clobber.
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    expect(storeRef.networks[0]!.peers).toEqual([]);
    // No hand-pin existed, so no preservation warning.
    expect(res.warnings).toBeUndefined();
  });

  test("non-empty roster + existing hand-pin → roster peers used (registry is source of truth, DD-5)", async () => {
    const { ports, storeRef } = makeFakes({
      // Default fetch returns rosterFor() with peer "jc".
      initialNetworks: [handPinnedNetwork("metafactory")],
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    // The roster resolved "jc" → that wins; the stale hand-pin is replaced.
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.peers.map((p) => p.principal_id)).toEqual(["jc"]);
    // A non-empty roster is the normal path — no preservation warning.
    expect(res.warnings).toBeUndefined();
  });

  test("join PRESERVES the hand-authored announce_capabilities (does not blank it)", async () => {
    // The hand-authored caps are the SOURCE deriveJoinInputs reads to announce
    // into the roster. If join blanks them to [], a re-join announces nothing →
    // the roster empties again, defeating the fix. They must survive a join.
    const withCaps: PolicyFederatedNetwork = {
      ...handPinnedNetwork("metafactory"),
      announce_capabilities: ["chat", "release"],
    };

    // Non-empty roster path (the normal converge).
    const a = makeFakes({ initialNetworks: [withCaps] });
    const resA = await joinNetwork("metafactory", LOCAL, a.ports);
    expect(resA.ok).toBe(true);
    expect(
      a.storeRef.networks.find((n) => n.id === "metafactory")!.announce_capabilities,
    ).toEqual(["chat", "release"]);

    // Empty-roster path (the bug condition) — caps still preserved.
    const b = makeFakes({
      fetch: {
        status: "ok",
        value: { descriptor: descriptorFor("metafactory"), roster: emptyRosterFor("metafactory") },
      },
      initialNetworks: [withCaps],
    });
    const resB = await joinNetwork("metafactory", LOCAL, b.ports);
    expect(resB.ok).toBe(true);
    expect(
      b.storeRef.networks.find((n) => n.id === "metafactory")!.announce_capabilities,
    ).toEqual(["chat", "release"]);
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
