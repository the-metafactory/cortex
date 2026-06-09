/**
 * CLI-level tests for `cortex network ping` (signal#113 P-11 / #56).
 *
 * Drives `dispatchNetwork(["ping", ...])` with an injected fake config reader
 * AND an injected fake probe-bus factory — no NATS, no `~/.config`, no live
 * wire. Asserts the verdict → exit-code mapping (§3.3), the `not-configured`
 * fail-closed (nothing emitted), `--count` aggregation, and `--json` output.
 */

import { describe, expect, test } from "bun:test";

import { dispatchNetwork, type PingBusFactory } from "../network";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import { PROBE_REPLY_ECHO_TYPE } from "../../../../bus/probe-responder";
import type { Envelope } from "../../../../bus/myelin/envelope-validator";
import type {
  NetworkPingPorts,
  ProbeFireInputs,
  ProbeRoundTripResult,
} from "../network-ping-ports";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A reader returning a config that declares jc/default as a peer. */
function readerWithPeer(): () => LoadedConfig {
  return () =>
    ({
      config: { nats: { url: "nats://127.0.0.1:4222" } } as unknown as AgentConfig,
      inlineAgents: [{ id: "luna" } as unknown as LoadedConfig["inlineAgents"][number]],
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

/**
 * A fake bus factory whose responder is scripted by `respond`. Records whether
 * the factory was invoked (i.e. whether a probe was actually attempted).
 */
function fakeBusFactory(
  respond: (f: ProbeFireInputs, seq: number) => ProbeRoundTripResult,
): { factory: PingBusFactory; invoked: () => boolean; stopped: () => boolean } {
  let wasInvoked = false;
  let wasStopped = false;
  let seq = 0;
  const factory: PingBusFactory = async () => {
    wasInvoked = true;
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
    return { ports, stop: async () => { wasStopped = true; } };
  };
  return { factory, invoked: () => wasInvoked, stopped: () => wasStopped };
}

function echoReply(f: ProbeFireInputs, rttMs: number): ProbeRoundTripResult {
  const reqPayload = f.request.payload as { nonce: string; seq?: number };
  const reply: Envelope = {
    id: crypto.randomUUID(),
    source: "andreas.community.luna",
    type: PROBE_REPLY_ECHO_TYPE,
    timestamp: "2026-06-10T00:00:00.000Z",
    correlation_id: f.correlationId,
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {
      nonce: reqPayload.nonce,
      server_ts: "2026-06-10T00:00:00.000Z",
      responder_version: "1.0.0",
      ...(reqPayload.seq !== undefined && { seq: reqPayload.seq }),
    },
  };
  return { kind: "reply", rttMs, reply };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cortex network ping — verdicts + exit codes", () => {
  test("reachable — exit 0, prints RTT", async () => {
    const bus = fakeBusFactory((f) => echoReply(f, 41));
    const res = await dispatchNetwork(["ping", "jc"], readerWithPeer(), bus.factory);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PING jc/default");
    expect(res.stdout).toContain("reachable");
    expect(res.stdout).toContain("rtt=41ms");
    expect(bus.invoked()).toBe(true);
    expect(bus.stopped()).toBe(true);
  });

  test("not-configured — exit 2, bus NEVER built (nothing emitted)", async () => {
    const bus = fakeBusFactory((f) => echoReply(f, 1));
    const res = await dispatchNetwork(
      ["ping", "stranger"],
      readerWithPeer(),
      bus.factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not-configured");
    expect(bus.invoked()).toBe(false); // fail-closed at the publish boundary
  });

  test("timeout — exit 4", async () => {
    const bus = fakeBusFactory(() => ({ kind: "timeout" }));
    const res = await dispatchNetwork(["ping", "jc"], readerWithPeer(), bus.factory);
    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("timeout");
  });

  test("no-responder (wrong nonce) — exit 3", async () => {
    const bus = fakeBusFactory((f) => {
      const r = echoReply(f, 5);
      if (r.kind === "reply") (r.reply.payload).nonce = "X";
      return r;
    });
    const res = await dispatchNetwork(["ping", "jc"], readerWithPeer(), bus.factory);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("no-responder");
  });

  test("publish-failed ⇒ not-configured (exit 2)", async () => {
    const bus = fakeBusFactory(() => ({ kind: "publish-failed", reason: "no route" }));
    const res = await dispatchNetwork(["ping", "jc"], readerWithPeer(), bus.factory);
    expect(res.exitCode).toBe(2);
  });
});

describe("cortex network ping — --count + --json", () => {
  test("--count 3 aggregates min/avg/max + loss in output", async () => {
    const rtts = [39, 42, 45];
    const bus = fakeBusFactory((f, seq) => echoReply(f, rtts[seq - 1]!));
    const res = await dispatchNetwork(
      ["ping", "jc", "--count", "3"],
      readerWithPeer(),
      bus.factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("3 probes sent, 3 echoes received, 0% loss");
    expect(res.stdout).toContain("rtt min/avg/max = 39/42.0/45 ms");
  });

  test("--json emits the envelope with verdict + stats", async () => {
    const bus = fakeBusFactory((f) => echoReply(f, 40));
    const res = await dispatchNetwork(
      ["ping", "jc", "--json"],
      readerWithPeer(),
      bus.factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      data: { peer: string; verdict: string; received: string };
    };
    expect(parsed.data.peer).toBe("jc/default");
    expect(parsed.data.verdict).toBe("reachable");
    expect(parsed.data.received).toBe("1");
  });

  test("--count 0 is a usage error (exit 2)", async () => {
    const bus = fakeBusFactory((f) => echoReply(f, 1));
    const res = await dispatchNetwork(
      ["ping", "jc", "--count", "0"],
      readerWithPeer(),
      bus.factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--count");
  });

  test("ping {principal}/{stack} parses an explicit stack", async () => {
    const bus = fakeBusFactory((f) => echoReply(f, 10));
    const res = await dispatchNetwork(
      ["ping", "jc/default"],
      readerWithPeer(),
      bus.factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PING jc/default");
  });
});

describe("cortex network ping — help", () => {
  test("top-level help mentions ping", async () => {
    const res = await dispatchNetwork(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex network ping");
  });
});
