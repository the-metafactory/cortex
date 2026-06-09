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
  /** #799 — bind-mode resolutions: the (account, hasCreds) pairs queried. */
  bindModeChecks: { account: string | undefined; hasCreds: boolean }[];
  /** C-820 — network ids the leave path asked the registry to deregister from. */
  deregistered: string[];
}

function makeFakes(opts: {
  fetch?: NetworkFetchResult<{ descriptor: NetworkDescriptor; roster: NetworkRosterResult }>;
  cached?: { descriptor: NetworkDescriptor; roster: NetworkRosterResult };
  registerOk?: boolean;
  /** C-820 — outcome of the leave-side registry deregister (default: ok). */
  deregisterOk?: boolean;
  restartOk?: boolean;
  /** #757 — make the nats-server restart fail (default: ok). */
  natsRestartOk?: boolean;
  /** #757 — omit the nats-server port entirely (pre-#757 caller). */
  withoutNatsServer?: boolean;
  initialNetworks?: PolicyFederatedNetwork[];
  leafState?: LeafStatePort;
  /** #794 — make the stack's nats config UNABLE to bind the leaf account. */
  canBind?: boolean;
  /**
   * #799 — model the bus type the leaf-file port resolves a bind mode against:
   *   - "operator-mode" (default) → operator-mode bus that binds the account.
   *   - "default-g"               → $G/default-account bus (no account tree).
   * The fake's `resolveBindMode` mirrors the real `resolveLeafBindMode` decision.
   */
  busType?: "operator-mode" | "default-g";
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
    bindModeChecks: [],
    deregistered: [],
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
    async deregisterFromNetwork(networkId) {
      rec.deregistered.push(networkId);
      return opts.deregisterOk === false
        ? { ok: false, reason: "registry unreachable for retag" }
        : { ok: true, note: "retagged" };
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
    resolveBindMode(account, hasCreds) {
      rec.bindModeChecks.push({ account, hasCreds });
      // #799 — mirror the real resolveLeafBindMode decision over the modelled
      // bus type. No creds → refuse (can't authenticate to the hub).
      if (!hasCreds) {
        return { mode: "refuse", reason: "no leaf creds available" };
      }
      const busType = opts.busType ?? "operator-mode";
      if (busType === "default-g") {
        // $G/default-account bus + creds → no-account remote (creds JWT binds).
        return { mode: "creds-only" };
      }
      // operator-mode bus. `canBind: false` models an operator-mode bus that
      // does NOT define the offered account → refuse (would crash nats-server).
      if (opts.canBind === false) {
        return {
          mode: "refuse",
          reason: "operator-mode bus does not define the leaf account",
        };
      }
      const trimmed = account?.trim();
      if (trimmed !== undefined && trimmed.length > 0) {
        return { mode: "operator-account", account: trimmed };
      }
      // operator-mode bus but no account offered → creds-only (the binding must
      // ride in the creds JWT; nothing to account-bind).
      return { mode: "creds-only" };
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
    // (b.5) #799 — the bind mode was resolved before any mutation (account +
    // creds present → operator-account).
    expect(rec.bindModeChecks).toEqual([
      { account: LOCAL.account, hasCreds: true },
    ]);
    // The operator-mode account WAS written into the leaf remote.
    expect(rec.writes[0]!.binding.account).toBe(LOCAL.account);
  });

  // ---------------------------------------------------------------------------
  // #794/#799 — choose the bind mode by bus type; FAIL FAST only on a genuinely
  // un-joinable bus (no crash). #799 relaxes the #794 guard for $G+creds buses.
  // ---------------------------------------------------------------------------
  describe("#794/#799 bind-mode fail-fast", () => {
    test("REFUSES when an operator-mode bus does NOT define the leaf account", async () => {
      // canBind:false models an operator-mode bus missing THIS account → still
      // refuse (rendering an account-bound leaf there crashes nats-server).
      const { ports } = makeFakes({ canBind: false, busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      // Actionable error: names the config path + the fix + the issue refs.
      expect(res.reason).toContain("/Users/andreas/.config/nats/local.conf");
      expect(res.reason).toContain("operator-mode");
      expect(res.reason).toContain("cortex#794/#799");
    });

    test("touches NOTHING when it refuses (no leaf, no include, no restart)", async () => {
      const { ports, rec, storeRef } = makeFakes({ canBind: false, busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      // The bind-mode pre-flight ran...
      expect(rec.bindModeChecks).toEqual([{ account: LOCAL.account, hasCreds: true }]);
      // ...but NO mutation followed it.
      expect(rec.writes.length).toBe(0); // no leaf include written
      expect(rec.includesEnsured).toEqual([]); // no local.conf include
      expect(rec.ensured).toEqual([]); // no plist ensure
      expect(rec.configWrites.length).toBe(0); // no federation config write
      expect(rec.restarts).toBe(0); // no daemon restart
      expect(rec.natsRestarts).toBe(0); // no nats-server restart
      expect(storeRef.networks.length).toBe(0); // config untouched
    });

    test("dry-run surfaces the SAME refusal (resolveBindMode is a READ)", async () => {
      const { ports, rec } = makeFakes({ canBind: false, busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("cortex#794/#799");
      expect(rec.writes.length).toBe(0);
    });

    test("proceeds account-bound when the operator-mode bus CAN bind the account", async () => {
      const { ports, rec, storeRef } = makeFakes({ canBind: true, busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      expect(rec.bindModeChecks).toEqual([{ account: LOCAL.account, hasCreds: true }]);
      // Existing join flow unchanged: account-bound leaf written, restarted.
      expect(rec.writes.length).toBe(1);
      expect(rec.writes[0]!.binding.account).toBe(LOCAL.account);
      expect(rec.restarts).toBe(1);
      expect(storeRef.networks.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // #799 — the critical new behaviour: a $G/default-account bus + creds is
    // now JOINABLE via a NO-ACCOUNT leaf remote (the case #794 wrongly refused).
    // -------------------------------------------------------------------------
    test("#799 $G/default bus + creds → joins with a NO-ACCOUNT leaf remote", async () => {
      // The driving case: jc/default ($G bus + jc.creds) → metafactory-community.
      const G_PEER: JoiningStack = {
        principalId: "jc",
        stackSlug: "default",
        credentials: "/Users/jc/.config/nats/jc.creds",
        // No account — a $G bus has no operator-mode account to bind.
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "default-g" });
      const res = await joinNetwork("metafactory-community", G_PEER, ports);

      expect(res.ok).toBe(true);
      // The leaf remote was rendered WITHOUT an account (creds JWT binds it).
      expect(rec.writes.length).toBe(1);
      expect(rec.writes[0]!.binding.account).toBeUndefined();
      expect(rec.writes[0]!.binding.credentials).toBe(
        "/Users/jc/.config/nats/jc.creds",
      );
      // The join completed end-to-end (config written, restarted) — the bus is
      // NOT taken down.
      expect(storeRef.networks.length).toBe(1);
      expect(rec.restarts).toBe(1);
      // The bind-mode pre-flight saw creds present (account omitted is fine).
      expect(rec.bindModeChecks).toEqual([{ account: undefined, hasCreds: true }]);
    });

    test("#799 a $G+creds bus is NOT refused by the #794 fail-fast", async () => {
      // Explicit regression for the #794-over-refusal: a $G bus with creds must
      // NOT be refused even though it cannot bind an account.
      const G_PEER: JoiningStack = {
        principalId: "jc",
        stackSlug: "default",
        credentials: "/Users/jc/.config/nats/jc.creds",
      };
      const { ports } = makeFakes({ busType: "default-g" });
      const res = await joinNetwork("metafactory-community", G_PEER, ports);
      expect(res.ok).toBe(true);
      if (!res.ok) expect(res.reason).toBeUndefined();
    });

    test("#799 REFUSES when there are NO creds (can't authenticate to the hub)", async () => {
      const NO_CREDS: JoiningStack = {
        principalId: "jc",
        stackSlug: "default",
        credentials: "", // no creds
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "default-g" });
      const res = await joinNetwork("metafactory-community", NO_CREDS, ports);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("cortex#794/#799");
      // No mutation followed the refusal.
      expect(rec.writes.length).toBe(0);
      expect(storeRef.networks.length).toBe(0);
      expect(rec.bindModeChecks).toEqual([{ account: undefined, hasCreds: false }]);
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

  test("reverses exactly: removes config + leaf, PRESERVES base -c arg, restarts (#801)", async () => {
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
    // #801 — even with NO networks remaining, the base nats-server `-c <config>`
    // arg is NEVER stripped (it names the BASE config the leaf files include
    // INTO; stripping it leaves nats-server unstartable). dropConfigArg is never
    // called by leave.
    expect(rec.dropped).toEqual([]);
    // The step log records the intentional preservation.
    expect(
      res.steps.some((s) => s.includes("left intact") && s.includes("#801")),
    ).toBe(true);
    // Restarted.
    expect(rec.restarts).toBe(1);
  });

  test("#801 leave with networks remaining also never drops the base -c arg", async () => {
    const { ports, rec, storeRef } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory"), joinedNetwork("research")],
    });
    const res = await leaveNetwork("metafactory", ports);
    expect(res.ok).toBe(true);
    expect(storeRef.networks.map((n) => n.id)).toEqual(["research"]);
    expect(rec.removes).toEqual(["metafactory"]);
    // base -c arg never dropped (true regardless of remaining networks).
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
    // C-820 — a no-op leave never touches the registry.
    expect(rec.deregistered.length).toBe(0);
  });

  test("C-820 — leave deregisters the network from the registry cap roster (symmetry with join's union)", async () => {
    const { ports, rec, storeRef } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory"), joinedNetwork("community")],
    });
    const res = await leaveNetwork("community", ports);

    expect(res.ok).toBe(true);
    // Local teardown still happened.
    expect(storeRef.networks.map((n) => n.id)).toEqual(["metafactory"]);
    // The registry was asked to deregister EXACTLY the left network.
    expect(rec.deregistered).toEqual(["community"]);
    // The step log records the deregister.
    expect(
      res.steps.some((s) => s.includes("deregistered capabilities") && s.includes("community")),
    ).toBe(true);
    // No warning on the happy path.
    expect(res.warnings ?? []).toHaveLength(0);
  });

  test("C-820 — a registry deregister FAILURE is non-fatal: local leave still ok, surfaced as a warning", async () => {
    const { ports, rec, storeRef } = makeFakes({
      initialNetworks: [joinedNetwork("community")],
      deregisterOk: false,
    });
    const res = await leaveNetwork("community", ports);

    // The LOCAL leave succeeded despite the registry retag failing.
    expect(res.ok).toBe(true);
    expect(storeRef.networks.length).toBe(0);
    expect(rec.removes).toEqual(["community"]);
    expect(rec.restarts).toBe(1);
    // The failure is surfaced as a warning (re-runnable), not a hard failure.
    expect(rec.deregistered).toEqual(["community"]);
    expect((res.warnings ?? []).some((w) => w.includes("deregister-from-network") && w.includes("community"))).toBe(true);
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

  // C-797 — leafz keys the leaf connection by the leaf-node (remote) name, which
  // is NOT necessarily the network id. The status join must key on `leaf_node`
  // so a connected leaf reports `established` (up), not `unknown`.
  test("C-797: joins leafz by leaf_node when it differs from the network id", async () => {
    const net: PolicyFederatedNetwork = {
      ...joinedNetwork("research-collab"),
      // The physical leaf link is named differently from the network id.
      leaf_node: "shared-hub",
    };
    const leafState: LeafStatePort = {
      async linkStates() {
        // leafz reports the link keyed by the leaf-node name, not the network id.
        return { "shared-hub": { state: "established", inMsgs: 5, outMsgs: 3 } };
      },
    };
    const { ports } = makeFakes({ initialNetworks: [net], leafState });
    const res = await networkStatus(ports);

    const row = res.networks[0]!;
    expect(row.networkId).toBe("research-collab");
    // BEFORE the fix this was "unknown" (lookup by network id missed the
    // leaf_node-keyed leafz row) — the exact #797 symptom.
    expect(row.link.state).toBe("established");
    expect(row.link.inMsgs).toBe(5);
    expect(row.link.outMsgs).toBe(3);
  });

  test("C-797: a genuinely-down leaf reports its reported state, not 'unknown'", async () => {
    const leafState: LeafStatePort = {
      async linkStates() {
        return { metafactory: { state: "down" } };
      },
    };
    const { ports } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory")],
      leafState,
    });
    const res = await networkStatus(ports);
    expect(res.networks[0]!.link.state).toBe("down");
  });

  test("C-797: leaf_node lookup still works when leaf_node equals the network id", async () => {
    const leafState: LeafStatePort = {
      async linkStates() {
        return { metafactory: { state: "established" } };
      },
    };
    const { ports } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory")], // leaf_node === id
      leafState,
    });
    const res = await networkStatus(ports);
    expect(res.networks[0]!.link.state).toBe("established");
  });

  test("C-797: degrades to 'unknown' when leafz has no row for the leaf (genuinely unreachable monitor)", async () => {
    const leafState: LeafStatePort = {
      async linkStates() {
        // Monitor unreachable / no matching leaf row — empty map.
        return {};
      },
    };
    const { ports } = makeFakes({
      initialNetworks: [joinedNetwork("metafactory")],
      leafState,
    });
    const res = await networkStatus(ports);
    expect(res.networks[0]!.link.state).toBe("unknown");
  });
});
