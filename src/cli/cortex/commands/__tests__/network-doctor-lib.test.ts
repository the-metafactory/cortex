/**
 * Tests for the `cortex network doctor` orchestration (cortex#1484, epic #1479).
 *
 * Drives `runDoctorChecks` with FAKE ports (a fake config port, a fake
 * monitor port, and the SAME fake probe-bus shape `network-ping-lib.test.ts`
 * uses) — no fs, no NATS, no HTTP, no live wire.
 *
 * Close-criteria (per the acceptance's check matrix):
 *   (a) all-green — every leg pass, verdict healthy, exit 0.
 *   (b) network-not-in-config — config-network fails, downstream legs skip.
 *   (c) no monitor configured — monitor-reachable warns (not fails); leaf
 *       checks skip; peer-reachable is unaffected (doesn't need /leafz).
 *   (d) leaf down — leaf-established fails (a hard prerequisite ⇒ broken).
 *   (e) peer timeout — peer-reachable fails with the ping timeout verdict.
 *
 * Plus a few extra legs (leaf-account-bound mismatch/report-only, a
 * partial-peer-failure "degraded" verdict) since the orchestrator owns both
 * the implementation and these tests.
 */

import { describe, expect, test } from "bun:test";

import type { Envelope } from "../../../../bus/myelin/envelope-validator";
import { PROBE_REPLY_ECHO_TYPE } from "../../../../bus/probe-responder";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import {
  DOCTOR_EXIT_CODE,
  runDoctorChecks,
  selectNetworkLeaf,
  type DoctorCheck,
} from "../network-doctor-lib";
import type {
  DoctorConfigPort,
  LeafzResponse,
  NetworkDoctorPorts,
} from "../network-doctor-ports";
import type {
  LeafzCounters,
  NetworkPingPorts,
  ProbeFireInputs,
  ProbeRoundTripResult,
} from "../network-ping-ports";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loadedConfig(peers: { principal_id: string; stack_id: string }[]): LoadedConfig {
  return {
    config: { nats: { url: "nats://127.0.0.1:4222" } } as unknown as AgentConfig,
    inlineAgents: [{ id: "luna" } as unknown as LoadedConfig["inlineAgents"][number]],
    principal: { id: "andreas" },
    // cortex#1482 — a registered/PoP pubkey fixture for the Pair 1 leg. A
    // plain placeholder (not a real nkey) is fine: the leg only compares it
    // against the (also-fake) FED account fixture via `samePubkey`, which
    // returns `false` for anything that isn't a genuinely decodable pubkey —
    // exactly what we want for two UNRELATED-looking fixture strings.
    stack: { id: "andreas/community", nkey_pub: "REGISTERED_PUBKEY_FIXTURE" },
    policy: {
      federated: {
        networks: [
          {
            id: "metafactory-community",
            // cortex#1728 — leaf_node so derivePingInputs resolves the scoping
            // key the leafz sampler is invoked with (matches network() fixture).
            leaf_node: "hub",
            peers,
          } as unknown as NonNullable<
            NonNullable<LoadedConfig["policy"]>["federated"]
          >["networks"][number],
        ],
      },
    } as unknown as LoadedConfig["policy"],
  };
}

function network(overrides: Partial<PolicyFederatedNetwork> = {}): PolicyFederatedNetwork {
  return {
    id: "metafactory-community",
    leaf_node: "hub",
    peers: [{ principal_id: "jc", stack_id: "jc/default" }],
    accept_subjects: ["federated.>"],
    deny_subjects: [],
    ...overrides,
  } as unknown as PolicyFederatedNetwork;
}

function fakeConfigPort(
  networks: PolicyFederatedNetwork[],
  expectedAccount?: string,
  // cortex#1482 (Pair 2) — `undefined` = "cannot determine" (no
  // resolver_preload block / no local nats config, the (c) no-monitor-style
  // default); tests that care about the leg override it explicitly.
  resolverPreloadHasAccount?: (accountPubkey: string) => boolean | undefined,
  // cortex#1728 Guard 1 — the leafnode-authorization crash-bomb files; default
  // clean bus (no bomb).
  leafnodeAuthBombFiles?: string[],
): DoctorConfigPort {
  return {
    readNetworks: () => ({ networks }),
    expectedFedAccount: () => expectedAccount,
    resolverPreloadHasAccount: resolverPreloadHasAccount ?? (() => undefined),
    scanLeafnodeAuthorizationBomb: () =>
      (leafnodeAuthBombFiles ?? []).map((path) => ({
        path,
        fix: `remove the leafnodes authorization block from ${path}`,
      })),
  };
}

function fakeMonitorPort(opts: {
  configured: boolean;
  leafz?: LeafzResponse;
  url?: string;
}): NetworkDoctorPorts["monitor"] {
  return {
    resolve: () => ({ url: opts.url ?? "http://127.0.0.1:8222", configured: opts.configured }),
    fetchLeafz: async () => opts.leafz,
  };
}

/** A fake probe-bus port (the exact `NetworkPingPorts` shape `pingPeer` consumes). */
function fakeProbe(
  respond: (fired: ProbeFireInputs, seq: number) => ProbeRoundTripResult,
  leafzReadings?: (LeafzCounters | undefined)[],
): NetworkPingPorts {
  let seq = 0;
  const ports: NetworkPingPorts = {
    bus: {
      fireProbe: async (f) => {
        seq++;
        return respond(f, seq);
      },
    },
    newNonce: () => `nonce-${seq}`,
    newCorrelationId: () => `corr-${seq}`,
  };
  // cortex#1728 (guard 4) — inject a scripted before/after leafz sampler so the
  // doctor timeout leg can fold the half-disambiguation.
  if (leafzReadings !== undefined) {
    let call = 0;
    ports.leafz = {
      sample: async (_leafNode: string) => {
        const r = leafzReadings[call];
        call++;
        return r;
      },
    };
  }
  return ports;
}

/** Build a conformant echo reply for a fired probe (mock responder). */
function echoReply(fired: ProbeFireInputs, rttMs: number): ProbeRoundTripResult {
  const reqPayload = fired.request.payload as { nonce: string; seq?: number };
  const reply: Envelope = {
    id: crypto.randomUUID(),
    source: "jc.default.sage",
    type: PROBE_REPLY_ECHO_TYPE,
    timestamp: "2026-07-03T00:00:00.000Z",
    correlation_id: fired.correlationId,
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {
      nonce: reqPayload.nonce,
      server_ts: "2026-07-03T00:00:00.000Z",
      responder_version: "1.0.0",
      ...(reqPayload.seq !== undefined && { seq: reqPayload.seq }),
    },
  };
  return { kind: "reply", rttMs, reply };
}

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check with id "${id}" in ${JSON.stringify(checks.map((x) => x.id))}`);
  return c;
}

const ESTABLISHED_LEAFZ: LeafzResponse = {
  leafs: [{ name: "hub", account: "ACCOUNT_A", in_msgs: 10, out_msgs: 12 }],
};

// ---------------------------------------------------------------------------
// (a) all-green
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (a) all-green", () => {
  test("every leg passes, verdict healthy, exit 0", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", (acct) => acct === "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 41)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    expect(res.verdict).toBe("healthy");
    expect(res.exitCode).toBe(0);
    expect(res.exitCode).toBe(DOCTOR_EXIT_CODE.healthy);
    // 5 pre-#1482 legs + registered-vs-fed-account + resolver-preload-account
    // + the sealed-secret-hub-authorized stub (always present, always skip)
    // + the cortex#1728 leafnode-authorization-bomb leg.
    expect(res.checks).toHaveLength(9);
    expect(findCheck(res.checks, "config-network").status).toBe("pass");
    expect(findCheck(res.checks, "leafnode-authorization-bomb").status).toBe("pass");
    expect(findCheck(res.checks, "registered-vs-fed-account").status).toBe("pass");
    expect(findCheck(res.checks, "resolver-preload-account").status).toBe("pass");
    expect(findCheck(res.checks, "sealed-secret-hub-authorized").status).toBe("skip");
    expect(findCheck(res.checks, "monitor-reachable").status).toBe("pass");
    expect(findCheck(res.checks, "leaf-established").status).toBe("pass");
    expect(findCheck(res.checks, "leaf-account-bound").status).toBe("pass");
    const peerCheck = findCheck(res.checks, "peer-reachable:jc/default");
    expect(peerCheck.status).toBe("pass");
    expect(peerCheck.owner).toBe("peer");
    expect(peerCheck.detail).toContain("rtt=41ms");
    // A skip'd leg (Pair 3) is a valid outcome, not a broken/degraded verdict.
    expect(res.verdict).not.toBe("broken");
    // Every check carries a responsible owner.
    for (const c of res.checks) {
      expect(["member", "hub-owner", "admin", "peer"]).toContain(c.owner);
    }
  });
});

// ---------------------------------------------------------------------------
// cortex#1728 Guard 1 — leafnode-authorization crash-bomb leg
// ---------------------------------------------------------------------------

describe("runDoctorChecks — cortex#1728 leafnode-authorization-bomb leg", () => {
  test("FAILS when the resolved config carries the operator-mode fatal block", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort(
        [network()],
        "ACCOUNT_A",
        (acct) => acct === "ACCOUNT_A",
        ["/Users/andreas/.config/nats/local.conf"],
      ),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const leg = findCheck(res.checks, "leafnode-authorization-bomb");
    expect(leg.status).toBe("fail");
    expect(leg.detail).toContain("/Users/andreas/.config/nats/local.conf");
    expect(leg.fix).toBeDefined();
    // A non-critical fail ⇒ degraded (config-network + leaf still pass).
    expect(res.verdict).not.toBe("healthy");
  });

  test("still runs (and can FAIL) even when the network is NOT configured", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort(
        [], // network-not-configured ⇒ config-network fails, downstream legs skip
        undefined,
        undefined,
        ["/Users/andreas/.config/nats/local.conf"],
      ),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    // The member most needs to know their bus is armed even before joining.
    expect(findCheck(res.checks, "leafnode-authorization-bomb").status).toBe("fail");
  });

  test("PASSES on a clean bus", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", (acct) => acct === "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "leafnode-authorization-bomb").status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// (b) network-not-in-config
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (b) network-not-in-config", () => {
  test("config-network fails; downstream legs skip; no peer checks; verdict broken", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([]), // the requested network isn't configured at all
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    expect(findCheck(res.checks, "config-network").status).toBe("fail");
    expect(findCheck(res.checks, "config-network").fix).toContain("join the network");
    expect(findCheck(res.checks, "monitor-reachable").status).toBe("skip");
    expect(findCheck(res.checks, "leaf-established").status).toBe("skip");
    expect(findCheck(res.checks, "leaf-account-bound").status).toBe("skip");
    expect(res.checks.some((c) => c.id.startsWith("peer-reachable:"))).toBe(false);
    expect(res.verdict).toBe("broken");
    expect(res.exitCode).toBe(DOCTOR_EXIT_CODE.broken);
  });

  test("a network with zero peers[] also fails config-network", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network({ peers: [] })]),
      monitor: fakeMonitorPort({ configured: true }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "config-network").status).toBe("fail");
    expect(findCheck(res.checks, "config-network").detail).toContain("no peers[]");
  });

  test("a network with empty accept_subjects[] also fails config-network", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network({ accept_subjects: [] })]),
      monitor: fakeMonitorPort({ configured: true }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "config-network").status).toBe("fail");
    expect(findCheck(res.checks, "config-network").detail).toContain("accept_subjects");
  });
});

// ---------------------------------------------------------------------------
// (c) no monitor configured → warn, not fail
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (c) no monitor configured", () => {
  test("monitor-reachable warns; leaf legs skip; peer-reachable is unaffected", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()]),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 30)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    const monitorCheck = findCheck(res.checks, "monitor-reachable");
    expect(monitorCheck.status).toBe("warn");
    expect(monitorCheck.fix).toContain("http_port/monitor_port");
    expect(findCheck(res.checks, "leaf-established").status).toBe("skip");
    expect(findCheck(res.checks, "leaf-account-bound").status).toBe("skip");
    // The echo round-trip does not depend on /leafz — it still runs + passes.
    expect(findCheck(res.checks, "peer-reachable:jc/default").status).toBe("pass");
    // A warn never blocks "healthy" — only fails do.
    expect(res.verdict).toBe("healthy");
    expect(res.exitCode).toBe(0);
  });

  test("a configured-but-unreachable monitor FAILS (distinct from absent)", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()]),
      monitor: fakeMonitorPort({ configured: true, leafz: undefined }), // fetch failed
      probe: fakeProbe((f) => echoReply(f, 30)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "monitor-reachable").status).toBe("fail");
    expect(findCheck(res.checks, "leaf-established").status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// (d) leaf down
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (d) leaf down", () => {
  test("leaf-established fails (no matching/established leaf in /leafz); verdict broken", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()]),
      monitor: fakeMonitorPort({ configured: true, leafz: { leafs: [] } }),
      probe: fakeProbe(() => ({ kind: "timeout" })),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    const leafCheck = findCheck(res.checks, "leaf-established");
    expect(leafCheck.status).toBe("fail");
    expect(leafCheck.owner).toBe("hub-owner");
    expect(leafCheck.fix).toContain("leaf not up");
    expect(findCheck(res.checks, "leaf-account-bound").status).toBe("skip");
    // leaf-established is a CRITICAL check — its failure makes the network
    // fundamentally broken regardless of the peer-reachable outcome.
    expect(res.verdict).toBe("broken");
    expect(res.exitCode).toBe(DOCTOR_EXIT_CODE.broken);
  });
});

// ---------------------------------------------------------------------------
// (d2) lone-leaf fallback is an HONEST warn, not a silent pass
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (d2) lone-leaf fallback", () => {
  test("a single leaf whose name/account doesn't match leaf_node → leaf-established WARN (discloses the assumption), not a silent pass", async () => {
    // One leaf, name "$G" (≠ leaf_node "hub"); account still "ACCOUNT_A" so
    // only leaf-established is affected (leaf-account-bound stays a pass).
    const LONE_UNNAMED: LeafzResponse = {
      leafs: [{ name: "$G", account: "ACCOUNT_A", in_msgs: 3, out_msgs: 4 }],
    };
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: LONE_UNNAMED }),
      probe: fakeProbe((f) => echoReply(f, 20)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    const leaf = findCheck(res.checks, "leaf-established");
    expect(leaf.status).toBe("warn");
    expect(leaf.detail).toContain("assumed the sole leaf");
    expect(leaf.owner).toBe("member");
    // downstream leaf-account-bound still runs (established leaf was returned)
    expect(findCheck(res.checks, "leaf-account-bound").status).toBe("pass");
    // a warn is advisory — it must NOT make the verdict broken
    expect(res.verdict).not.toBe("broken");
  });
});

// ---------------------------------------------------------------------------
// (e) peer timeout
// ---------------------------------------------------------------------------

describe("runDoctorChecks — (e) peer timeout", () => {
  test("peer-reachable fails with the ping timeout verdict + a peer/hub fix", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe(() => ({ kind: "timeout" })),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });

    const peerCheck = findCheck(res.checks, "peer-reachable:jc/default");
    expect(peerCheck.status).toBe("fail");
    expect(peerCheck.owner).toBe("peer");
    expect(peerCheck.fix).toContain("peer/hub");
    // config-network + leaf-established both pass, but the single configured
    // peer is entirely unreachable ⇒ the federation path is broken.
    expect(res.verdict).toBe("broken");
    expect(res.exitCode).toBe(DOCTOR_EXIT_CODE.broken);
  });

  test("cortex#1728 — leafz out+/in0 sharpens the timeout fix to the REMOTE half", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe(() => ({ kind: "timeout" }), [
        { outMsgs: 10, inMsgs: 5 }, // before
        { outMsgs: 11, inMsgs: 5 }, // after: probe crossed, no echo back ⇒ remote
      ]),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const peerCheck = findCheck(res.checks, "peer-reachable:jc/default");
    expect(peerCheck.status).toBe("fail");
    expect(peerCheck.detail).toContain("REMOTE");
    expect(peerCheck.fix).toContain("peer/echo leg");
    expect(peerCheck.fix).not.toContain("peer/hub"); // the sharper remediation wins
  });

  test("cortex#1728 — leafz out+0 sharpens the timeout fix to the LOCAL-egress half", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe(() => ({ kind: "timeout" }), [
        { outMsgs: 10, inMsgs: 5 }, // before
        { outMsgs: 10, inMsgs: 5 }, // after: nothing left the leaf ⇒ local egress
      ]),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const peerCheck = findCheck(res.checks, "peer-reachable:jc/default");
    expect(peerCheck.status).toBe("fail");
    expect(peerCheck.detail).toContain("LOCAL egress");
    expect(peerCheck.fix).toContain("local egress");
  });

  test("partial peer failure (one of two peers times out) ⇒ degraded, not broken", async () => {
    const twoPeerNetwork = network({
      peers: [
        { principal_id: "jc", stack_id: "jc/default" },
        { principal_id: "andreas", stack_id: "andreas/community" },
      ] as unknown as PolicyFederatedNetwork["peers"],
    });
    let calls = 0;
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([twoPeerNetwork], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => {
        calls++;
        return calls === 1 ? { kind: "timeout" } : echoReply(f, 20);
      }),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([
        { principal_id: "jc", stack_id: "jc/default" },
        { principal_id: "andreas", stack_id: "andreas/community" },
      ]),
      networkId: "metafactory-community",
    });

    expect(res.checks.filter((c) => c.id.startsWith("peer-reachable:"))).toHaveLength(2);
    expect(res.verdict).toBe("degraded");
    expect(res.exitCode).toBe(DOCTOR_EXIT_CODE.degraded);
  });
});

// ---------------------------------------------------------------------------
// leaf-account-bound — mismatch fails, undeterminable degrades to warn
// ---------------------------------------------------------------------------

describe("runDoctorChecks — leaf-account-bound", () => {
  test("mismatched account FAILS", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_EXPECTED"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }), // reports ACCOUNT_A
      probe: fakeProbe((f) => echoReply(f, 10)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const accountCheck = findCheck(res.checks, "leaf-account-bound");
    expect(accountCheck.status).toBe("fail");
    expect(accountCheck.detail).toContain("ACCOUNT_A");
    expect(accountCheck.detail).toContain("ACCOUNT_EXPECTED");
  });

  test("undeterminable expected account degrades to warn/report-only", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], undefined), // not derivable
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 10)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const accountCheck = findCheck(res.checks, "leaf-account-bound");
    expect(accountCheck.status).toBe("warn");
    expect(accountCheck.detail).toContain("ACCOUNT_A");
  });
});

// ===========================================================================
// cortex#1482 (epic #1479, join-3) — the three representation-pairs.
// ===========================================================================

describe("runDoctorChecks — registered-vs-fed-account (Pair 1, informational)", () => {
  test("a LEGITIMATE divergence (different keys) is a pass, never a fail", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "registered-vs-fed-account");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("ADR-0018");
    expect(res.verdict).not.toBe("broken");
  });

  test("no stack.nkey_pub configured → skip (not a failure)", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]);
    const res = await runDoctorChecks(ports, { cfg: { ...cfg, stack: { id: cfg.stack!.id } }, networkId: "metafactory-community" });
    const c = findCheck(res.checks, "registered-vs-fed-account");
    expect(c.status).toBe("skip");
  });

  test("FED account not yet derivable → warn (not fail) — never joined yet", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], undefined),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "registered-vs-fed-account");
    expect(c.status).toBe("warn");
    expect(res.verdict).not.toBe("broken");
  });

  test("registered pubkey and FED account decoding to the SAME key material → warn, flagged as suspicious (still never fail)", async () => {
    // A REAL (decodable) base64 pubkey on BOTH sides — samePubkey only fires
    // on genuinely-decodable, byte-identical keys, not on two fixture
    // strings that merely happen to be textually equal but decode to
    // nothing (see the "LEGITIMATE divergence" test above, which uses
    // non-decodable fixtures deliberately).
    const sameKeyB64 = Buffer.from(new Uint8Array(32).fill(4)).toString("base64");
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]);
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], sameKeyB64),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: { ...cfg, stack: { id: cfg.stack!.id, nkey_pub: sameKeyB64 } },
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "registered-vs-fed-account");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("SAME key material");
    expect(c.owner).toBe("admin");
  });

  test("skipped entirely when config-network fails (network not configured)", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([]),
      monitor: fakeMonitorPort({ configured: true }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "registered-vs-fed-account").status).toBe("skip");
    expect(findCheck(res.checks, "resolver-preload-account").status).toBe("skip");
    expect(findCheck(res.checks, "sealed-secret-hub-authorized").status).toBe("skip");
  });
});

describe("runDoctorChecks — resolver-preload-account (Pair 2)", () => {
  test("a REAL mismatch (account not in resolver_preload) FAILS — the boot/auth failure this leg catches early", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", () => false),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "resolver-preload-account");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("ACCOUNT_A");
    expect(c.fix).toContain("resolver_preload");
    expect(c.fix).toContain("restart");
    // A real Pair 2 mismatch DOES flip the verdict — it's a real boot/auth bug.
    expect(res.verdict).not.toBe("healthy");
  });

  test("account IS preloaded → pass", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", (acct) => acct === "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "resolver-preload-account").status).toBe("pass");
  });

  test("cannot determine (no local nats config / no resolver_preload block at all) → warn, not fail", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", () => undefined),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "resolver-preload-account");
    expect(c.status).toBe("warn");
    expect(res.verdict).not.toBe("broken");
  });

  test("no FED account derivable yet → skip", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], undefined, () => true),
      monitor: fakeMonitorPort({ configured: false }),
      probe: fakeProbe((f) => echoReply(f, 1)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    expect(findCheck(res.checks, "resolver-preload-account").status).toBe("skip");
  });
});

describe("runDoctorChecks — sealed-secret-hub-authorized (Pair 3, documented stub)", () => {
  test("ALWAYS skip, owner hub-owner, detail documents the follow-up — never fabricates a pass/fail it can't back", async () => {
    const ports: NetworkDoctorPorts = {
      config: fakeConfigPort([network()], "ACCOUNT_A", (acct) => acct === "ACCOUNT_A"),
      monitor: fakeMonitorPort({ configured: true, leafz: ESTABLISHED_LEAFZ }),
      probe: fakeProbe((f) => echoReply(f, 10)),
    };
    const res = await runDoctorChecks(ports, {
      cfg: loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]),
      networkId: "metafactory-community",
    });
    const c = findCheck(res.checks, "sealed-secret-hub-authorized");
    expect(c.status).toBe("skip");
    expect(c.owner).toBe("hub-owner");
    expect(c.detail).toContain("opaque ciphertext");
    // A skip never blocks a healthy verdict.
    expect(res.verdict).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// cortex#1728 (guard 4) — selectNetworkLeaf: SCOPED leaf attribution
// (the #1731 review BLOCK — never sum sibling leaves' counters)
// ---------------------------------------------------------------------------

describe("selectNetworkLeaf — multi-leaf attribution (cortex#1728)", () => {
  // A real host runs several leaves that share the hub ip:port.
  const MULTI_LEAF: LeafzResponse = {
    leafs: [
      { name: "metafactory", account: "ACCT_MF", in_msgs: 5, out_msgs: 5 },
      { name: "community", account: "ACCT_COMM", in_msgs: 99, out_msgs: 99 },
      { name: "halden", account: "ACCT_HAL", in_msgs: 7, out_msgs: 7 },
    ],
  };

  test("matches ONLY the named leaf — sibling counters are never included", () => {
    const m = selectNetworkLeaf(MULTI_LEAF, "metafactory");
    expect(m?.match).toBe("named");
    expect(m?.leaf.out_msgs).toBe(5); // metafactory's own, NOT the summed 111
    expect(m?.leaf.in_msgs).toBe(5);
  });

  test("matches on account as a secondary key", () => {
    const m = selectNetworkLeaf(MULTI_LEAF, "ACCT_COMM");
    expect(m?.match).toBe("named");
    expect(m?.leaf.out_msgs).toBe(99);
  });

  test("multi-leaf bus with NO name/account match ⇒ undefined (never misattribute)", () => {
    // This is the core of the review BLOCK: metafactory egress could be dead
    // (out+0) while community ticks — if we summed, we'd mask the break. With no
    // match on a 3-leaf bus we refuse to attribute.
    expect(selectNetworkLeaf(MULTI_LEAF, "unknown-leaf")).toBeUndefined();
  });

  test("lone-leaf bus ⇒ attributes the single leaf even without a name match", () => {
    const lone: LeafzResponse = { leafs: [{ name: "hub", in_msgs: 3, out_msgs: 4 }] };
    const m = selectNetworkLeaf(lone, "some-network-leaf");
    expect(m?.match).toBe("lone-fallback");
    expect(m?.leaf.out_msgs).toBe(4);
  });

  test("empty leafs ⇒ undefined", () => {
    expect(selectNetworkLeaf({ leafs: [] }, "hub")).toBeUndefined();
    expect(selectNetworkLeaf({}, "hub")).toBeUndefined();
  });
});
