/**
 * CLI-level tests for `cortex network doctor` (cortex#1484, epic #1479).
 *
 * Drives `dispatchNetwork(["doctor", ...], fakeReader, ...defaults, doctorPortsFactory)`
 * with an injected fake config reader AND an injected fake doctor-ports
 * factory — no NATS, no `~/.config`, no live wire, no fs. Mirrors
 * `network-ping-cli.test.ts`'s `fakeBusFactory`/`readerWithPeer` pattern:
 * dispatch-level factory injection, not a real `runDoctorChecks` call (that's
 * covered end-to-end by `network-doctor-lib.test.ts`).
 */

import { describe, expect, test } from "bun:test";

import { dispatchNetwork, type DoctorPortsFactory } from "../network";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { NetworkDoctorPorts } from "../network-doctor-ports";
import type { DoctorCheck } from "../network-doctor-lib";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import { PROBE_REPLY_ECHO_TYPE } from "../../../../bus/probe-responder";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A reader returning a minimal config — `dispatchNetwork`'s injected
 *  doctor-ports factory supplies the canned checks, so the config content
 *  only needs to satisfy `--principal` resolution + `derivePingInputs`. */
function reader(): () => LoadedConfig {
  return () =>
    ({
      config: { nats: { url: "nats://127.0.0.1:4222" } } as unknown as AgentConfig,
      inlineAgents: [{ id: "sage" } as unknown as LoadedConfig["inlineAgents"][number]],
      principal: { id: "andreas" },
      stack: { id: "andreas/community" },
      policy: {
        federated: {
          networks: [
            {
              id: "metafactory-community",
              peers: [{ principal_id: "jc", stack_id: "jc/default" }],
            } as unknown as NonNullable<
              NonNullable<LoadedConfig["policy"]>["federated"]
            >["networks"][number],
          ],
        },
      } as unknown as LoadedConfig["policy"],
    });
}

/** A fake doctor-ports factory that hands back a CANNED ports bundle (unused
 *  by these CLI-level tests beyond satisfying the type — the checks
 *  themselves are asserted via `network-doctor-lib.test.ts`). Records
 *  invocation + stop, so the CLI test can assert the factory lifecycle. */
function fakeDoctorFactory(): {
  factory: DoctorPortsFactory;
  invoked: () => boolean;
  stopped: () => boolean;
} {
  let wasInvoked = false;
  let wasStopped = false;
  const ports: NetworkDoctorPorts = {
    config: {
      readNetworks: () => ({
        networks: [
          {
            id: "metafactory-community",
            leaf_node: "hub",
            peers: [{ principal_id: "jc", stack_id: "jc/default" }],
            accept_subjects: ["federated.>"],
            deny_subjects: [],
          } as unknown as PolicyFederatedNetwork,
        ],
      }),
      expectedFedAccount: () => "ACCOUNT_A",
      resolverPreloadHasAccount: () => true,
      scanLeafnodeAuthorizationBomb: () => [],
    },
    monitor: {
      resolve: () => ({ url: "http://127.0.0.1:8222", configured: true }),
      fetchLeafz: async () => ({
        leafs: [{ name: "hub", account: "ACCOUNT_A", in_msgs: 3, out_msgs: 4 }],
      }),
    },
    probe: {
      bus: {
        fireProbe: async (f) => ({
          kind: "reply",
          rttMs: 12,
          reply: {
            id: crypto.randomUUID(),
            source: "jc.default.sage",
            type: PROBE_REPLY_ECHO_TYPE,
            timestamp: "2026-07-03T00:00:00.000Z",
            correlation_id: f.correlationId,
            sovereignty: {
              classification: "federated",
              data_residency: "NZ",
              max_hop: 1,
              frontier_ok: false,
              model_class: "local-only",
            },
            payload: {
              nonce: (f.request.payload as { nonce: string }).nonce,
              server_ts: "2026-07-03T00:00:00.000Z",
              responder_version: "1.0.0",
            },
          },
        }),
      },
      newNonce: () => "nonce-1",
      newCorrelationId: () => "corr-1",
    },
  };
  const factory: DoctorPortsFactory = async () => {
    wasInvoked = true;
    return {
      ports,
      stop: async () => {
        wasStopped = true;
      },
    };
  };
  return { factory, invoked: () => wasInvoked, stopped: () => wasStopped };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cortex network doctor — happy path", () => {
  test("healthy — exit 0, human output lists every leg + the verdict", async () => {
    const doctor = fakeDoctorFactory();
    const res = await dispatchNetwork(
      ["doctor", "metafactory-community", "--principal", "andreas"],
      reader(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      doctor.factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex network doctor metafactory-community:");
    expect(res.stdout).toContain("config-network");
    expect(res.stdout).toContain("peer-reachable:jc/default");
    expect(res.stdout).toContain("verdict: healthy");
    expect(doctor.invoked()).toBe(true);
    expect(doctor.stopped()).toBe(true);
  });

  test("--json emits the envelope with per-check rows + verdict", async () => {
    const doctor = fakeDoctorFactory();
    const res = await dispatchNetwork(
      ["doctor", "metafactory-community", "--principal", "andreas", "--json"],
      reader(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      doctor.factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      items: DoctorCheck[];
      data: { network: string; verdict: string };
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.data.network).toBe("metafactory-community");
    expect(parsed.data.verdict).toBe("healthy");
    expect(parsed.items.some((c) => c.id === "config-network" && c.status === "pass")).toBe(true);
    expect(
      parsed.items.some((c) => c.id === "peer-reachable:jc/default" && c.status === "pass"),
    ).toBe(true);
    for (const item of parsed.items) {
      expect(["member", "hub-owner", "admin", "peer"]).toContain(item.owner);
    }
  });
});

describe("cortex network doctor — degraded/broken exit codes", () => {
  test("a fail leg drives a non-zero exit code, and the report goes to stderr", async () => {
    let wasInvoked = false;
    const ports: NetworkDoctorPorts = {
      config: {
        readNetworks: () => ({ networks: [] }), // network not configured ⇒ broken
        expectedFedAccount: () => undefined,
        resolverPreloadHasAccount: () => undefined,
        scanLeafnodeAuthorizationBomb: () => [],
      },
      monitor: {
        resolve: () => ({ url: "http://127.0.0.1:8222", configured: true }),
        fetchLeafz: async () => undefined,
      },
      probe: {
        bus: { fireProbe: async () => ({ kind: "timeout" }) },
        newNonce: () => "n",
        newCorrelationId: () => "c",
      },
    };
    const factory: DoctorPortsFactory = async () => {
      wasInvoked = true;
      return { ports, stop: async () => {} };
    };
    const res = await dispatchNetwork(
      ["doctor", "metafactory-community", "--principal", "andreas"],
      reader(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      factory,
    );
    expect(wasInvoked).toBe(true);
    expect(res.exitCode).toBe(2); // DOCTOR_EXIT_CODE.broken
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("config-network");
    expect(res.stderr).toContain("verdict: broken");
  });
});

describe("cortex network doctor — usage", () => {
  test("missing --principal is a usage error (exit 2)", async () => {
    const doctor = fakeDoctorFactory();
    const res = await dispatchNetwork(
      ["doctor", "metafactory-community"],
      reader(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      doctor.factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal");
    expect(doctor.invoked()).toBe(false); // never builds ports on a usage error
  });

  test("top-level help mentions doctor", async () => {
    const res = await dispatchNetwork(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex network doctor");
  });
});
