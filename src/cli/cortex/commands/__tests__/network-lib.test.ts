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
 *   - wire contract (P2 #1087): accept_subjects = the stack's OWN
 *     federated.{me}.{stack}.> (inbound dispatch) ∪ each roster peer's
 *     federated.{peer}.{peer-stack}.> (inbound presence) — no network id on the
 *     wire. Empty roster collapses to the OWN-only list.
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
import {
  renderLeafIncludeFile,
  type OperatorModeLeafPackage,
} from "../../../../common/nats/leaf-remote-renderer";
import { nkeyToBase64Pubkey } from "../../../../common/registry/encoding";

// O-3 (cortex#1053) — a public-repo-safe fake leaf package: the operator-mode
// material `cortex network join` renders to convert an anonymous bus. O-4
// supplies this for real via the register→issue handshake.
const LOCAL_PACKAGE: OperatorModeLeafPackage = {
  operatorJwt:
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_OPERATOR.sig",
  account: "A" + "B".repeat(55),
  accountJwt:
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_ACCOUNT.sig",
};

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
  /** #821 — creds-existence paths pre-flighted. */
  credsChecks: string[];
  /** #821 — networks whose leaf state was snapshotted (pre-mutation). */
  snapshots: string[];
  /** #821 — networks whose leaf state was restored (rollback). */
  restores: string[];
  /** #821 — count of nats-server health probes after restart. */
  healthProbes: number;
  /** #821 MAJOR-1 — count of `nats-server -c <cfg> -t` validation gate runs. */
  validateConfigs: number;
  /** O-3 (#1053) — leaf packages the orchestrator asked to convert with. */
  conversions: OperatorModeLeafPackage[];
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
  busType?: "operator-mode" | "default-g" | "anonymous" | "foreign-operator";
  /** #821 — model the leaf creds file as MISSING (pre-flight refuses). */
  credsMissing?: boolean;
  /**
   * #821 — model nats-server's post-restart health. `false` = the restart exited
   * 0 but the server then crashed (the community case) → orchestrator rolls back.
   * Default: healthy.
   */
  natsHealthy?: boolean;
  /** #821 — make the rollback recovery restart ALSO fail by EXIT CODE (worst-case). */
  recoveryRestartFails?: boolean;
  /**
   * #821 BLOCKER — model the recovery restart's HEALTH (post-restart probe).
   * `false` = the recovery restart exits 0 but the server is still DOWN — must
   * report failure, never "restored to prior state". Default: healthy.
   */
  recoveryHealthy?: boolean;
  /** #821 MAJOR-1 — make the pre-restart `nats-server -t` syntax gate FAIL. */
  validateConfigFails?: boolean;
  /** #821 item-2 — make natsServer.restart() THROW synchronously (Bun.spawn ENOENT). */
  restartThrows?: boolean;
  /** #821 item-2 — make natsServer.validateConfig() THROW synchronously (spawn ENOENT). */
  validateThrows?: boolean;
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
    credsChecks: [],
    snapshots: [],
    restores: [],
    healthProbes: 0,
    validateConfigs: 0,
    conversions: [],
  };
  const storeRef = { networks: opts.initialNetworks ?? [] };
  // O-3 (#1053) — the fake's mutable view of the bus type. An "anonymous" bus
  // that convertToOperatorMode() successfully converts FLIPS to operator-mode,
  // so the subsequent resolveBindMode() returns account-bound (mirroring how the
  // real renderOperatorModeBlocks rewrites the on-disk config the next read sees).
  let busType = opts.busType ?? "operator-mode";
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
      // O-3 (#1053) — an anonymous / foreign-operator bus refuses (the #794
      // fail-fast input). A successful conversion flips `busType` to operator-mode
      // BEFORE the orchestrator re-resolves, so this branch only fires pre-convert.
      if (busType === "anonymous" || busType === "foreign-operator") {
        return {
          mode: "refuse",
          reason:
            "config is anonymous/hard-isolated (no operator-mode account tree)",
        };
      }
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
      // #821 — operator-mode bus but NO account offered → REFUSE. Rendering a
      // no-account ($G) remote onto an operator-mode bus crashes nats-server
      // (it rejects a remote carrying no account nkey). The pre-#821 fake
      // (and the real resolveLeafBindMode) wrongly returned creds-only here.
      return {
        mode: "refuse",
        reason:
          "operator-mode bus requires the leaf remote to declare an account nkey, " +
          "but none was offered",
      };
    },
    convertToOperatorMode(pkg) {
      rec.conversions.push(pkg);
      // O-3 (#1053) — model the real adapter's outcomes over the bus type:
      //   - foreign-operator bus → REFUSE (never clobber someone else's tree).
      //   - already operator-mode (any operator-binding type) → 'already' no-op.
      //   - anonymous bus + a valid package → 'converted'; FLIP busType to
      //     operator-mode so the orchestrator's re-resolve binds the account.
      //   - anonymous bus + an INVALID package → refuse (the preserved fail-fast).
      if (busType === "foreign-operator") {
        return {
          status: "refuse",
          reason:
            "the nats config is ALREADY operator-mode under a different operator",
        };
      }
      if (busType !== "anonymous") {
        return { status: "already", conf: "ALREADY-OPERATOR-MODE" };
      }
      // Anonymous bus. Validate the package the way the real renderer does (only
      // the fields the orchestrator depends on): operator JWT + account present.
      if (pkg.operatorJwt.trim().length === 0 || pkg.account.trim().length === 0) {
        return {
          status: "refuse",
          reason: "leaf package is missing the operator JWT or account",
        };
      }
      busType = "operator-mode"; // the conversion stuck — the bus is now operator-mode.
      return { status: "converted", conf: "CONVERTED-OPERATOR-MODE-CONF" };
    },
    credsExist(path) {
      rec.credsChecks.push(path);
      // #821 — default: the creds file exists. A test opts into the missing-file
      // refusal via `credsMissing: true`.
      return opts.credsMissing !== true;
    },
    snapshotLeafState(networkId) {
      rec.snapshots.push(networkId);
      return { networkId, includeFile: undefined, natsConfig: undefined };
    },
    restoreLeafState(snapshot) {
      rec.restores.push(snapshot.networkId);
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
    async validateConfig() {
      rec.validateConfigs++;
      // #821 item-2 — model a SYNCHRONOUS throw escaping the port (e.g. Bun.spawn
      // ENOENT when the test tool isn't on PATH). joinNetwork must NOT propagate.
      if (opts.validateThrows === true) {
        throw new Error("spawn nats-server ENOENT");
      }
      // #821 MAJOR-1 — default: the -t syntax gate passes. A test opts into a
      // -t failure via `validateConfigFails: true`.
      return opts.validateConfigFails === true
        ? { ok: false, reason: "nats-server -t: parse error near line 12" }
        : { ok: true };
    },
    async restart() {
      rec.natsRestarts++;
      rec.restartOrder.push("nats");
      // #821 item-2 — model a SYNCHRONOUS throw escaping restart() (Bun.spawn
      // ENOENT: launchctl/systemctl not on PATH). The never-throws contract means
      // joinNetwork must catch this and return a failure verdict, not crash.
      if (opts.restartThrows === true) {
        throw new Error("spawn launchctl ENOENT");
      }
      // #821 — the SECOND nats restart is the rollback-recovery restart; let a
      // test fail it independently to exercise the worst-case "recovery also
      // failed" path. The first restart obeys `natsRestartOk`.
      const isRecovery = rec.natsRestarts > 1;
      if (isRecovery) {
        return opts.recoveryRestartFails === true
          ? { ok: false, reason: "recovery nats-server kickstart failed" }
          : { ok: true };
      }
      return opts.natsRestartOk === false
        ? { ok: false, reason: "nats-server kickstart failed" }
        : { ok: true };
    },
    async isHealthy() {
      rec.healthProbes++;
      // #821 — health is modelled PER PROBE so a test can make the FIRST restart
      // come up down (triggering rollback) and the RECOVERY restart ALSO come up
      // down (the BLOCKER case: a recovery that exits 0 but leaves the bus DOWN
      // must still report failure, never "restored"). The first probe follows the
      // first restart; the second probe follows the recovery restart.
      const isRecoveryProbe = rec.healthProbes > 1;
      const healthy = isRecoveryProbe
        ? opts.recoveryHealthy ?? true
        : opts.natsHealthy ?? true;
      return healthy
        ? { healthy: true }
        : {
            healthy: false,
            reason: isRecoveryProbe
              ? "recovery: monitor port 8224 not listening"
              : "monitor port 8224 not listening",
          };
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

    // -------------------------------------------------------------------------
    // #821 — THE INCIDENT. An operator-mode bus joined WITHOUT an account must
    // REFUSE (and touch nothing), not fall through to a no-account ($G) leaf
    // that crashes nats-server. This is the andreas/community crash: an
    // operator-mode community.conf + a join run without --account rendered a
    // no-account remote → nats-server exited 1 → the live bus went DOWN, yet
    // join reported success.
    // -------------------------------------------------------------------------
    test("#821 operator-mode bus + NO account → REFUSES (the community crash)", async () => {
      const NO_ACCOUNT: JoiningStack = {
        principalId: "andreas",
        stackSlug: "community",
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        // No account — and the bus is operator-mode. Pre-#821 this fell through
        // to creds-only and crashed nats-server.
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "operator-mode" });
      const res = await joinNetwork("metafactory-community", NO_ACCOUNT, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toContain("operator-mode");
      expect(res.reason).toContain("cortex#794/#799");
      // The bind-mode pre-flight ran with no account...
      expect(rec.bindModeChecks).toEqual([{ account: undefined, hasCreds: true }]);
      // ...and NOTHING was mutated — the bus is never touched.
      expect(rec.writes.length).toBe(0); // no leaf include
      expect(rec.includesEnsured).toEqual([]); // no local.conf include
      expect(rec.ensured).toEqual([]); // no plist ensure
      expect(rec.configWrites.length).toBe(0); // no federation config write
      expect(rec.restarts).toBe(0); // no daemon restart
      expect(rec.natsRestarts).toBe(0); // no nats-server restart
      expect(storeRef.networks.length).toBe(0); // config untouched
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

  // ---------------------------------------------------------------------------
  // O-3 (cortex#1053, epic #1050, spec §4-D2) — auto-convert an anonymous bus to
  // operator-mode instead of fail-fasting (#794). The orchestrator, given a leaf
  // package on the joining stack, converts the bus THEN proceeds with the
  // existing leaf render + policy write + restart.
  // ---------------------------------------------------------------------------
  describe("O-3 auto-convert an anonymous bus to operator-mode", () => {
    test("anonymous bus + leaf package → converts, then joins account-bound", async () => {
      const STACK: JoiningStack = {
        principalId: "andreas",
        stackSlug: "community",
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        account: LOCAL_PACKAGE.account,
        operatorModePackage: LOCAL_PACKAGE,
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "anonymous" });
      const res = await joinNetwork("metafactory-community", STACK, ports);

      expect(res.ok).toBe(true);
      // The conversion ran with the supplied package...
      expect(rec.conversions).toEqual([LOCAL_PACKAGE]);
      // ...and the join then proceeded account-bound (the converted bus is now
      // operator-mode, so resolveBindMode bound the account on the re-resolve).
      expect(rec.writes.length).toBe(1);
      expect(rec.writes[0]!.binding.account).toBe(LOCAL_PACKAGE.account);
      expect(storeRef.networks.length).toBe(1);
      expect(rec.restarts).toBe(1);
      // A step records the conversion so the CLI can surface it.
      expect(res.steps.some((s) => /operator-mode/i.test(s))).toBe(true);
    });

    test("an already-operator-mode bus is NOT converted (no package needed)", async () => {
      // The pre-O-3 happy path: operator-mode bus that binds the account → join
      // proceeds WITHOUT any conversion attempt.
      const { ports, rec } = makeFakes({ busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      expect(rec.conversions).toEqual([]); // no conversion attempted
      expect(rec.writes.length).toBe(1);
    });

    test("anonymous bus with NO leaf package → STILL fail-fasts (#794 preserved)", async () => {
      // The conversion seam only engages when a package is present. Without one,
      // an anonymous bus is still un-joinable → the #794 refusal stands.
      const STACK: JoiningStack = {
        principalId: "andreas",
        stackSlug: "community",
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        account: LOCAL_PACKAGE.account,
        // no operatorModePackage
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "anonymous" });
      const res = await joinNetwork("metafactory-community", STACK, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toContain("cortex#794/#799");
      expect(rec.conversions).toEqual([]); // never attempted (no package)
      // NOTHING mutated.
      expect(rec.writes.length).toBe(0);
      expect(storeRef.networks.length).toBe(0);
      expect(rec.restarts).toBe(0);
    });

    test("conversion REFUSE (foreign-operator bus) aborts the join, touches nothing", async () => {
      const STACK: JoiningStack = {
        principalId: "andreas",
        stackSlug: "community",
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        account: LOCAL_PACKAGE.account,
        operatorModePackage: LOCAL_PACKAGE,
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "foreign-operator" });
      const res = await joinNetwork("metafactory-community", STACK, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/different operator|operator-mode/i);
      // Conversion was attempted (and refused) — but NOTHING was mutated.
      expect(rec.conversions).toEqual([LOCAL_PACKAGE]);
      expect(rec.writes.length).toBe(0);
      expect(storeRef.networks.length).toBe(0);
      expect(rec.restarts).toBe(0);
    });

    test("conversion REFUSE (incomplete package) aborts the join", async () => {
      const STACK: JoiningStack = {
        principalId: "andreas",
        stackSlug: "community",
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        account: LOCAL_PACKAGE.account,
        operatorModePackage: { ...LOCAL_PACKAGE, operatorJwt: "" },
      };
      const { ports, rec, storeRef } = makeFakes({ busType: "anonymous" });
      const res = await joinNetwork("metafactory-community", STACK, ports);

      expect(res.ok).toBe(false);
      expect(rec.conversions.length).toBe(1);
      expect(rec.writes.length).toBe(0);
      expect(storeRef.networks.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // #821 guarantee 2 — PRE-FLIGHT the creds file BEFORE writing/restarting.
  // ---------------------------------------------------------------------------
  describe("#821 creds-existence pre-flight", () => {
    test("REFUSES before any mutation when the leaf creds file is missing", async () => {
      const { ports, rec, storeRef } = makeFakes({
        busType: "operator-mode",
        credsMissing: true,
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toContain("creds file not found");
      expect(res.reason).toContain("cortex#821");
      // The creds path was checked...
      expect(rec.credsChecks).toEqual([LOCAL.credentials ?? ""]);
      // ...and NOTHING was written/restarted (the refusal is before any mutation).
      expect(rec.writes.length).toBe(0);
      expect(rec.includesEnsured).toEqual([]);
      expect(rec.configWrites.length).toBe(0);
      expect(rec.natsRestarts).toBe(0);
      expect(rec.restarts).toBe(0);
      expect(storeRef.networks.length).toBe(0);
      // No snapshot taken (refused before the snapshot step).
      expect(rec.snapshots).toEqual([]);
    });

    test("proceeds when the creds file exists (the happy path checks it)", async () => {
      const { ports, rec } = makeFakes({ busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      expect(rec.credsChecks).toEqual([LOCAL.credentials ?? ""]);
    });
  });

  // ---------------------------------------------------------------------------
  // #821 guarantee 3 — restart safety: verify nats came back up; ROLL BACK on
  // failure so a failed join never leaves the bus down.
  // ---------------------------------------------------------------------------
  describe("#821 restart safety + rollback", () => {
    test("snapshots the prior leaf state BEFORE mutating + probes health after restart", async () => {
      const { ports, rec } = makeFakes({ busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      // Snapshot taken before the write.
      expect(rec.snapshots).toEqual(["metafactory"]);
      // Health probed after the (single) restart; no rollback on the happy path.
      expect(rec.healthProbes).toBe(1);
      expect(rec.restores).toEqual([]);
      expect(rec.natsRestarts).toBe(1);
      expect(res.steps.some((s) => s.includes("verified healthy"))).toBe(true);
    });

    test("restart exits 0 but server is DOWN → ROLLS BACK + re-restarts + reports FAILURE", async () => {
      // The community case: kickstart returned 0, nats-server then crashed on the
      // bad leaf. Health probe catches it; the snapshot is restored + re-restarted.
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsHealthy: false,
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      // The join is reported as FAILED — never success while the bus is down.
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("did not come back up");
      // Rollback ran: snapshot restored + a recovery restart issued.
      expect(rec.snapshots).toEqual(["metafactory"]);
      expect(rec.restores).toEqual(["metafactory"]);
      // Two nats restarts: the failed one + the recovery one.
      expect(rec.natsRestarts).toBe(2);
      // The cortex daemon was NEVER restarted (we bailed before step e.2).
      expect(rec.restarts).toBe(0);
      // The recovery succeeded — the warning says the bus was restored.
      expect(res.warnings?.some((w) => w.includes("restored to prior state"))).toBe(true);
    });

    test("restart EXITS non-zero → ROLLS BACK + re-restarts + reports FAILURE", async () => {
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsRestartOk: false,
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toContain("nats-server restart failed");
      // Rollback restored the prior config + re-restarted.
      expect(rec.restores).toEqual(["metafactory"]);
      expect(rec.natsRestarts).toBe(2);
      expect(rec.restarts).toBe(0);
    });

    test("worst case: recovery restart ALSO fails → reports a clear manual-intervention warning", async () => {
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsHealthy: false,
        recoveryRestartFails: true,
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      expect(rec.restores).toEqual(["metafactory"]);
      expect(rec.natsRestarts).toBe(2);
      expect(res.reason).toContain("recovery restart");
      expect(res.warnings?.some((w) => w.includes("intervene manually"))).toBe(true);
    });

    // -------------------------------------------------------------------------
    // #821 BLOCKER — the recovery restart must be HEALTH-PROBED, not trusted by
    // exit code. A recovery that exits 0 but leaves the bus DOWN must report
    // FAILURE + manual-intervention, NEVER "restored to prior state". This is
    // the original sin reborn on the recovery path: the first restart is probed,
    // but the recovery restart was decided on `recovery.ok` (exit code) alone.
    // -------------------------------------------------------------------------
    test("BLOCKER: recovery restart exits 0 but bus DOWN → reports failure, NOT 'restored'", async () => {
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsHealthy: false, // first restart: exit 0 but DOWN → triggers rollback
        recoveryHealthy: false, // recovery restart: exit 0 but STILL DOWN
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      // Rollback ran and the recovery restart was issued + HEALTH-PROBED.
      expect(rec.restores).toEqual(["metafactory"]);
      expect(rec.natsRestarts).toBe(2);
      expect(rec.healthProbes).toBe(2); // BOTH restarts probed (the fix)
      // It must NOT claim the bus was restored — the recovery is down too.
      expect(res.reason).not.toContain("restored to prior state");
      expect(res.warnings?.some((w) => w.includes("restored to prior state"))).toBe(
        false,
      );
      // It must surface the manual-intervention escalation.
      expect(res.reason).toContain("intervene manually");
      expect(res.warnings?.some((w) => w.includes("intervene manually"))).toBe(true);
    });

    // -------------------------------------------------------------------------
    // #821 MAJOR-1 — the cheap pre-restart `nats-server -t` syntax gate. A `-t`
    // FAILURE must refuse BEFORE restarting (never crash the bus on a config we
    // already know is broken) and revert the leaf write.
    // -------------------------------------------------------------------------
    test("MAJOR-1: a failing `-t` gate refuses BEFORE restart + reverts the leaf write", async () => {
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        validateConfigFails: true,
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false);
      expect(res.reason).toContain("config validation (-t) failed");
      // The gate ran...
      expect(rec.validateConfigs).toBe(1);
      // ...and NO restart happened (refused before it).
      expect(rec.natsRestarts).toBe(0);
      expect(rec.restarts).toBe(0);
      // The leaf write was reverted (snapshot restored) so the on-disk config is
      // clean for the next attempt.
      expect(rec.restores).toEqual(["metafactory"]);
    });

    test("MAJOR-1: the `-t` gate runs on the happy path (before the restart)", async () => {
      const { ports, rec } = makeFakes({ busType: "operator-mode" });
      const res = await joinNetwork("metafactory", LOCAL, ports);
      expect(res.ok).toBe(true);
      expect(rec.validateConfigs).toBe(1);
      // Order: validate (1) ran before the single restart.
      expect(rec.natsRestarts).toBe(1);
    });

    // -------------------------------------------------------------------------
    // #821 item-2 — never-throws contract. A SYNCHRONOUS throw from the
    // nats-server port (Bun.spawn ENOENT when launchctl/systemctl/nats-server is
    // not on PATH) must be CAUGHT by joinNetwork and returned as a failure
    // verdict — never propagated as an uncaught stack trace that wedges the CLI.
    // -------------------------------------------------------------------------
    test("item-2: a THROWING restart() → joinNetwork returns a failure verdict, does NOT throw", async () => {
      const { ports } = makeFakes({ busType: "operator-mode", restartThrows: true });
      let res: Awaited<ReturnType<typeof joinNetwork>> | undefined;
      let threw = false;
      try {
        res = await joinNetwork("metafactory", LOCAL, ports);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false); // never-throws contract honoured
      expect(res?.ok).toBe(false);
      expect(res?.reason).toContain("ENOENT");
    });

    test("item-2: a THROWING validateConfig() → joinNetwork returns a failure verdict, does NOT throw", async () => {
      const { ports } = makeFakes({ busType: "operator-mode", validateThrows: true });
      let res: Awaited<ReturnType<typeof joinNetwork>> | undefined;
      let threw = false;
      try {
        res = await joinNetwork("metafactory", LOCAL, ports);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(res?.ok).toBe(false);
      expect(res?.reason).toContain("ENOENT");
    });

    test("item-2: a throwing RECOVERY restart is still caught (rollback path never throws)", async () => {
      // First restart down → rollback re-restarts; make THAT recovery restart
      // throw. The existing recovery try/catch must absorb it into the verdict.
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsHealthy: false, // first restart exits 0 but DOWN → triggers rollback
      });
      // Patch the fake to throw on the SECOND (recovery) restart only.
      const realRestart = ports.natsServer!.restart.bind(ports.natsServer);
      let calls = 0;
      ports.natsServer!.restart = async () => {
        calls += 1;
        if (calls >= 2) throw new Error("spawn launchctl ENOENT");
        return realRestart();
      };
      let threw = false;
      let res: Awaited<ReturnType<typeof joinNetwork>> | undefined;
      try {
        res = await joinNetwork("metafactory", LOCAL, ports);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(res?.ok).toBe(false);
      // The rollback path absorbed the throw and escalated to manual intervention.
      expect(res?.reason).toContain("intervene manually");
      expect(rec.restores).toEqual(["metafactory"]);
    });

    test("recovery restart exits 0 AND healthy → reports 'restored to prior state'", async () => {
      const { ports, rec } = makeFakes({
        busType: "operator-mode",
        natsHealthy: false, // first restart down → rollback
        recoveryHealthy: true, // recovery comes back UP
      });
      const res = await joinNetwork("metafactory", LOCAL, ports);

      expect(res.ok).toBe(false); // the JOIN still failed (the leaf was bad)...
      expect(rec.healthProbes).toBe(2);
      // ...but the bus WAS restored — only then may we say so.
      expect(res.warnings?.some((w) => w.includes("restored to prior state"))).toBe(
        true,
      );
    });
  });

  test("accept_subjects = OWN-scope only, never a peer subtree or the network id (#1220)", async () => {
    const { ports, storeRef } = makeFakes({});
    await joinNetwork("metafactory", LOCAL, ports);
    const net = storeRef.networks[0]!;
    // #1220 — join PERSISTS own-scope only (peer PRESENCE is re-derived in-memory
    // by the reconciler). rosterFor() resolves peer jc/sage-host, but its presence
    // subtree is NOT persisted (it fails the boot config validator's own-scope rule).
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
    // No peer subtree persisted.
    expect(net.accept_subjects.some((s) => s.includes("jc.sage-host"))).toBe(false);
    // The wire contract STILL holds: subjects gate by principal/stack segments,
    // never the network id `metafactory` (note `meta-factory` is the stack SLUG,
    // a hyphenated segment that does not contain the un-hyphenated network id).
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
    // #821 — the line now carries the post-restart health verification.
    expect(
      res.steps.some((s) => s === "restarted nats-server to load leaf config (verified healthy)"),
    ).toBe(true);
    expect(res.steps.some((s) => s === "restarted stack daemon")).toBe(true);
    // nats-server step precedes the cortex daemon step.
    const natsIdx = res.steps.indexOf(
      "restarted nats-server to load leaf config (verified healthy)",
    );
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
    // #821 — the failed restart now triggers a rollback + recovery restart, so
    // the nats service is restarted a SECOND time to bring the bus back up.
    expect(rec.restartOrder).toEqual(["nats", "nats"]);
    expect(rec.restores).toEqual(["metafactory"]);
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
// cortex#1220 — join PERSISTS accept_subjects = OWN-scope ONLY
// (peer PRESENCE subtrees are re-derived IN-MEMORY at runtime by the
// federation-reconciler; persisting them fails the boot config validator).
// =============================================================================

describe("#1220 accept_subjects — join persists own-scope only", () => {
  test("normal join → OWN subtree ONLY, even with a resolved roster peer", async () => {
    // rosterFor() yields one real peer: jc/sage-host (andreas is self → excluded).
    // Pre-#1220 the writer persisted jc's `.agent.>` presence subtree too, which
    // the daemon then refused to boot. Now the writer persists own-scope only.
    const { ports, storeRef } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.accept_subjects).toEqual([
      "federated.andreas.meta-factory.>", // dispatch addressed TO me (full subtree)
    ]);
    // The peer is still written to peers[] (the gate resolves the source network
    // from peers[]); only its PRESENCE subtree is kept OUT of the persisted accept-list.
    expect(net.peers.map((p) => p.principal_id)).toEqual(["jc"]);
  });

  test("the step log records the own-scope accept-list (no peer subtree)", async () => {
    const { ports } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    expect(
      res.steps.some(
        (s) =>
          s.includes("federated.andreas.meta-factory.>") &&
          !s.includes("federated.jc.sage-host.agent.>"),
      ),
    ).toBe(true);
  });

  test("empty-roster preserve path → accept-list derived from the PRESERVED peers", async () => {
    // handPinnedNetwork pins peer `andreas/meta-factory` — which EQUALS the self
    // subtree, so the derived list collapses to OWN-only (the dedupe). The point:
    // the accept-list is derived from the FINAL (preserved) peer set, staying
    // consistent with whatever peers are actually written.
    const { ports, storeRef } = makeFakes({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptorFor("metafactory"),
          roster: emptyRosterFor("metafactory"),
        },
      },
      initialNetworks: [handPinnedNetwork("metafactory")],
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    // Preserved peer == self subtree → deduped to OWN-only.
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
  });

  test("validate-before-write REFUSES a merged config with an out-of-scope subject, does NOT write (#1220)", async () => {
    // A stale entry a PRE-FIX join left behind: an OTHER network whose accept-list
    // carries a peer PRESENCE subtree — OUT of andreas/meta-factory's own scope, so
    // it would fail the daemon boot validator (the exact #1220 failure mode).
    const staleBad: PolicyFederatedNetwork = {
      id: "othernet",
      leaf_node: "othernet",
      peers: [],
      accept_subjects: ["federated.jc.sage-host.agent.>"], // out of own scope
      deny_subjects: [],
      announce_capabilities: [],
      max_hop: 1,
    };
    const { ports, storeRef } = makeFakes({ initialNetworks: [staleBad] });

    const res = await joinNetwork("metafactory", LOCAL, ports);

    // Refused BEFORE the config write: the reason names the offending subject +
    // the fix, and the store is untouched (no partial write, no new entry).
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("refusing to write policy.federated.networks");
    expect(res.reason).toContain("federated.jc.sage-host.agent.>");
    expect(res.reason).toContain("#1220");
    expect(storeRef.networks).toEqual([staleBad]);
    expect(storeRef.networks.some((n) => n.id === "metafactory")).toBe(false);
  });

  test("first-join empty roster → OWN-only accept-list (pre-P2 behaviour preserved)", async () => {
    const { ports, storeRef } = makeFakes({
      fetch: {
        status: "ok",
        value: {
          descriptor: descriptorFor("metafactory"),
          roster: emptyRosterFor("metafactory"),
        },
      },
      // No initial networks — first join, 0 peers.
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
  });
});

// =============================================================================
// cortex#1220 review blocker — join ENABLES the reconciler on a fresh join and
// PRESERVES a principal's explicit choice on a re-join. Without this, narrowing
// persisted accept_subjects to own-scope (above) admits ZERO peer presence,
// because the reconciler that re-derives own ∪ peer in-memory is per-network
// opt-in, default OFF — a silent in=0 regression.
// =============================================================================

describe("#1220 reconcile — join enables + preserves so peer presence is admitted", () => {
  test("FRESH join → writes reconcile.enabled=true (reconciler is load-bearing post-#1220)", async () => {
    // No initial networks — first join. The written entry must opt this network
    // into the reconciler, else own-scope-only accept_subjects admit no peers.
    const { ports, storeRef } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.reconcile).toBeDefined();
    expect(net.reconcile!.enabled).toBe(true);
    // Fresh enable is not a principal override, so no disabled-WARN.
    expect((res.warnings ?? []).some((w) => w.includes("reconcile.enabled=false"))).toBe(false);
  });

  test("legacy re-join (prior entry has NO reconcile block) → self-heals to enabled=true", async () => {
    // handPinnedNetwork carries no reconcile block (a pre-this-PR entry). A re-join
    // upgrades it to enabled=true — the desired heal for existing deployments
    // stuck in silent in=0. This is NOT overriding an explicit choice (none exists).
    const { ports, storeRef } = makeFakes({
      initialNetworks: [handPinnedNetwork("metafactory")],
    });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.reconcile!.enabled).toBe(true);
  });

  test("RE-join PRESERVES an explicit reconcile.enabled=false (never forced true) + loud WARN", async () => {
    // A principal deliberately disabled the reconciler for this network. A re-join
    // must NOT silently re-enable it — but MUST warn that peer presence won't be
    // admitted while it stays off (the silent in=0 mode, now announced).
    const disabled: PolicyFederatedNetwork = {
      ...handPinnedNetwork("metafactory"),
      reconcile: { enabled: false, interval_ms: 60000 },
    };
    const { ports, storeRef } = makeFakes({ initialNetworks: [disabled] });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    // Preserved verbatim — the explicit false SURVIVES the re-join.
    expect(net.reconcile!.enabled).toBe(false);
    // Loud, principal-visible WARN: both the warnings array and the step log.
    expect(res.warnings).toBeDefined();
    expect(res.warnings!.some((w) => w.includes("reconcile.enabled=false PRESERVED"))).toBe(true);
    expect(
      res.steps.some((s) => s.startsWith("WARN:") && s.includes("will NOT admit peer presence")),
    ).toBe(true);
  });

  test("RE-join PRESERVES an explicit reconcile.enabled=true (no disabled-WARN)", async () => {
    // A network already opted in stays opted in, verbatim, and does not trip the
    // disabled-WARN. Also pins a non-default interval to prove verbatim carry.
    const enabled: PolicyFederatedNetwork = {
      ...handPinnedNetwork("metafactory"),
      reconcile: { enabled: true, interval_ms: 30000 },
    };
    const { ports, storeRef } = makeFakes({ initialNetworks: [enabled] });
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.reconcile).toEqual({ enabled: true, interval_ms: 30000 });
    expect((res.warnings ?? []).some((w) => w.includes("reconcile.enabled=false"))).toBe(false);
  });

  test("enabling reconcile keeps the write boot-valid — own-scope accept_subjects unchanged", async () => {
    // The reconcile field is orthogonal to the accept-list scope guard: adding it
    // must not perturb the own-scope-only accept_subjects the validate-before-write
    // gate requires (#1220). Fresh join → own-scope only AND reconcile enabled.
    const { ports, storeRef } = makeFakes({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    const net = storeRef.networks.find((n) => n.id === "metafactory")!;
    expect(net.accept_subjects).toEqual(["federated.andreas.meta-factory.>"]);
    expect(net.reconcile!.enabled).toBe(true);
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

// =============================================================================
// C-1224 (ADR-0013 Model B) — secret-authenticated leaf join.
//
// A Model-B join carries a leaf SHARED SECRET (not a `.creds` file): the leaf
// authenticates the transport pipe via URL userinfo and binds the principal's
// OWN local account. These assert the orchestration delta: the secret counts as
// an auth method (bind-mode resolves), the `.creds` pre-flight is SKIPPED (no
// creds file exists), and the write binding carries the secret + own account,
// never a credentials path.
// =============================================================================

const LOCAL_SECRET: JoiningStack = {
  principalId: "andreas",
  stackSlug: "meta-factory",
  // Model B — NO creds file; the credential is the leaf secret (URL userinfo).
  leafSecret: "s3cr3t-leaf-pipe",
  leafUser: "andreas",
  account: "A" + "B".repeat(55),
};

describe("C-1224 — secret-auth leaf join (Model B)", () => {
  test("operator-mode bus + secret binds own account; SKIPS the creds pre-flight", async () => {
    const { ports, rec } = makeFakes({ busType: "operator-mode" });
    const res = await joinNetwork("metafactory", LOCAL_SECRET, ports);

    expect(res.ok).toBe(true);
    // The `.creds` pre-flight is skipped — a secret-auth leaf has no creds file.
    expect(rec.credsChecks).toEqual([]);
    // Bind-mode WAS resolved (the secret satisfied the has-auth gate → hasCreds true).
    expect(rec.bindModeChecks).toEqual([
      { account: LOCAL_SECRET.account, hasCreds: true },
    ]);
    // The write binding carries the secret + the OWN account, and NO credentials.
    expect(rec.writes.length).toBe(1);
    const binding = rec.writes[0]!.binding;
    expect(binding.leafSecret).toBe("s3cr3t-leaf-pipe");
    expect(binding.leafUser).toBe("andreas");
    expect(binding.account).toBe(LOCAL_SECRET.account);
    expect(binding.credentials).toBeUndefined();
  });

  test("$G/default bus + secret-only (no account) renders no-account secret leaf", async () => {
    const noAccount: JoiningStack = {
      principalId: "andreas",
      stackSlug: "meta-factory",
      leafSecret: "s3cr3t",
      leafUser: "andreas",
    };
    const { ports, rec } = makeFakes({ busType: "default-g" });
    const res = await joinNetwork("metafactory", noAccount, ports);

    expect(res.ok).toBe(true);
    expect(rec.credsChecks).toEqual([]);
    const binding = rec.writes[0]!.binding;
    expect(binding.leafSecret).toBe("s3cr3t");
    expect(binding.account).toBeUndefined();
    expect(binding.credentials).toBeUndefined();
  });

  test("creds-path join is UNCHANGED — still pre-flights the creds file (no regression)", async () => {
    const { ports, rec } = makeFakes({ busType: "operator-mode" });
    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(true);
    // The legacy creds path STILL runs the #821 creds pre-flight.
    expect(rec.credsChecks).toEqual([LOCAL.credentials ?? ""]);
    const binding = rec.writes[0]!.binding;
    expect(binding.credentials).toBe(LOCAL.credentials);
    expect(binding.leafSecret).toBeUndefined();
  });

  test("operator-mode auto-convert path is untouched by the secret delta (Model-B survivor)", async () => {
    // An anonymous bus + a leaf package still auto-converts (O-3) — the secret
    // delta did not disturb the operator-mode-package flow. Here we exercise the
    // creds-path join on an anonymous bus that converts, confirming no regression.
    const withPkg: JoiningStack = { ...LOCAL, operatorModePackage: LOCAL_PACKAGE };
    const { ports, rec } = makeFakes({ busType: "anonymous" });
    const res = await joinNetwork("metafactory", withPkg, ports);
    expect(res.ok).toBe(true);
    expect(rec.conversions.length).toBe(1);
  });

  test("secret-only leaf on an auto-converted anonymous bus binds the account (NOT a creds error)", async () => {
    // Regression guard for the post-auto-convert re-resolve (network-lib:310):
    // a secret-only Model-B leaf (hasCreds === false, hasSecret === true) on an
    // anonymous bus must auto-convert (O-3) and then RE-RESOLVE on `hasLeafAuth`
    // — not `hasCreds`. If it re-resolved on `hasCreds` the secret would be
    // invisible and the join would abort with a misleading "no leaf creds
    // available" despite a valid secret.
    const secretWithPkg: JoiningStack = {
      principalId: "andreas",
      stackSlug: "community",
      // Model B — NO creds file; the leaf secret is the only auth method.
      leafSecret: "s3cr3t-leaf-pipe",
      leafUser: "andreas",
      account: LOCAL_PACKAGE.account,
      operatorModePackage: LOCAL_PACKAGE,
    };
    const { ports, rec } = makeFakes({ busType: "anonymous" });
    const res = await joinNetwork("metafactory-community", secretWithPkg, ports);

    expect(res.ok).toBe(true);
    // The bus auto-converted exactly once...
    expect(rec.conversions).toEqual([LOCAL_PACKAGE]);
    // ...and BOTH bind-mode resolves saw the secret as an auth method
    // (hasCreds === true here is the modelled `hasLeafAuth`). The pre-fix bug
    // passed the literal `hasCreds` (false) on the second resolve.
    expect(rec.bindModeChecks).toEqual([
      { account: LOCAL_PACKAGE.account, hasCreds: true },
      { account: LOCAL_PACKAGE.account, hasCreds: true },
    ]);
    // The re-resolve bound the OWN account + carried the secret, no creds path.
    expect(rec.writes.length).toBe(1);
    const binding = rec.writes[0]!.binding;
    expect(binding.account).toBe(LOCAL_PACKAGE.account);
    expect(binding.leafSecret).toBe("s3cr3t-leaf-pipe");
    expect(binding.credentials).toBeUndefined();
  });
});
