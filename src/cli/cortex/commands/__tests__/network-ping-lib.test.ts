/**
 * Tests for the `cortex network ping` orchestration (signal#113 P-11 /
 * `docs/design-network-ping.md`, issue #56).
 *
 * Close-criteria (spec §3.3 / §9):
 *   - each verdict (reachable via a mock responder, not-configured, timeout,
 *     no-responder) + its exit code;
 *   - RTT measured + min/avg/max aggregation over `--count`;
 *   - the request envelope is FG-conformant: `source` addresses the target,
 *     `originator` carries our DID, the reply subscription is OUR scope.
 *
 * The bus is a FAKE (injected port) — no NATS, no `~/.config`, no live wire.
 */

import { describe, expect, test } from "bun:test";

import type { Envelope } from "../../../../bus/myelin/envelope-validator";
import {
  PROBE_REPLY_ECHO_TYPE,
  type ProbeEchoReplyPayload,
} from "../../../../bus/probe-responder";
import type { LoadedConfig } from "../../../../common/config/loader";
import {
  buildProbeRequestEnvelope,
  buildProbeRequestSubject,
  buildReplySubjectPattern,
  classifyRoundTrip,
  derivePingInputs,
  diagnoseLeafzDelta,
  pingPeer,
  VERDICT_EXIT_CODE,
  type PingInputs,
} from "../network-ping-lib";
import type {
  LeafzCounters,
  LeafzSamplerPort,
  NetworkPingPorts,
  ProbeFireInputs,
  ProbeRoundTripResult,
} from "../network-ping-ports";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function inputs(overrides: Partial<PingInputs> = {}): PingInputs {
  return {
    requesterPrincipal: "andreas",
    requesterStack: "community",
    requesterAssistant: "luna",
    targetPrincipal: "jc",
    targetStack: "default",
    targetAssistantDid: "did:mf:jc-default",
    count: 1,
    timeoutMs: 2000,
    isConfiguredPeer: true,
    // cortex#1728 (guard 4) — a resolved leaf_node so the leafz sampler runs in
    // the fold tests. Tests that assert the "no leaf_node" omit-path override
    // this to `undefined`.
    networkLeafNode: "hub",
    ...overrides,
  };
}

/**
 * A fake bus that runs a scripted responder. The `respond` callback decides,
 * per fired probe, what round-trip to return. Records every fired probe.
 */
function fakeBus(
  respond: (fired: ProbeFireInputs, seq: number) => ProbeRoundTripResult,
): { ports: NetworkPingPorts; fired: ProbeFireInputs[] } {
  const fired: ProbeFireInputs[] = [];
  let nonceN = 0;
  let corrN = 0;
  let probeSeq = 0;
  const ports: NetworkPingPorts = {
    bus: {
      fireProbe: async (f) => {
        fired.push(f);
        probeSeq++;
        return respond(f, probeSeq);
      },
    },
    newNonce: () => `nonce-${++nonceN}`,
    newCorrelationId: () => `corr-${++corrN}`,
  };
  return { ports, fired };
}

/** Build a conformant echo reply for a fired probe (mock responder). */
function echoReply(fired: ProbeFireInputs, rttMs: number): ProbeRoundTripResult {
  const reqPayload = fired.request.payload as { nonce: string; seq?: number };
  const reply: Envelope = {
    id: crypto.randomUUID(),
    source: "andreas.community.luna",
    type: PROBE_REPLY_ECHO_TYPE,
    timestamp: "2026-06-10T00:00:00.000Z",
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
      server_ts: "2026-06-10T00:00:00.000Z",
      responder_version: "1.0.0",
      ...(reqPayload.seq !== undefined && { seq: reqPayload.seq }),
    } satisfies ProbeEchoReplyPayload,
  };
  return { kind: "reply", rttMs, reply };
}

// ---------------------------------------------------------------------------
// Subject + envelope construction (FG conformance)
// ---------------------------------------------------------------------------

describe("buildProbeRequestSubject — FG-2 (subject addresses the target)", () => {
  test("Direct subject carries the target + encoded assistant DID, no network", () => {
    const s = buildProbeRequestSubject("jc", "default", "did:mf:jc-default");
    expect(s).toBe("federated.jc.default.tasks.@did-mf-jc-default.probe.echo");
    expect(s).not.toContain("metafactory-community"); // network NOT on the wire
  });
});

describe("buildReplySubjectPattern — FG-4 (reply keyed on the requester)", () => {
  test("we subscribe OUR OWN scope", () => {
    expect(buildReplySubjectPattern("andreas", "community")).toBe(
      "federated.andreas.community.probe.reply.>",
    );
  });
});

describe("buildProbeRequestEnvelope — FG conformance", () => {
  test("source addresses the target; originator carries OUR DID", () => {
    const env = buildProbeRequestEnvelope({
      inputs: inputs(),
      nonce: "n",
      correlationId: "c",
      seq: 1,
    });
    // FG-2: source first segments are the TARGET.
    expect(env.source).toBe("jc.default.luna");
    // FG-3: requester rides in originator.identity = our DID.
    expect(env.originator?.identity).toBe("did:mf:andreas-community");
    // cortex#1728: a Direct probe carries target_assistant (F-021 requires it
    // for distribution_mode:direct — omitting it got every probe dropped at the
    // peer's envelope validator before the responder saw it).
    expect(env.distribution_mode).toBe("direct");
    expect(env.target_assistant).toBe("did:mf:jc-default");
    expect(env.sovereignty.classification).toBe("federated");
    expect(env.sovereignty.max_hop).toBe(1);
    expect(env.distribution_mode).toBe("direct");
    // FG-1: no network_id anywhere.
    expect(JSON.stringify(env)).not.toContain("network_id");
    expect(env.correlation_id).toBe("c");
    const p = env.payload as { nonce: string; seq: number };
    expect(p.nonce).toBe("n");
    expect(p.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// classifyRoundTrip — verdict taxonomy
// ---------------------------------------------------------------------------

describe("classifyRoundTrip", () => {
  test("conformant echo with matching nonce ⇒ reachable", () => {
    const { ports, fired } = fakeBus(() => ({ kind: "timeout" }));
    void ports;
    // Build a reply directly.
    const reply: Envelope = {
      id: "x",
      source: "andreas.community.luna",
      type: PROBE_REPLY_ECHO_TYPE,
      timestamp: "t",
      sovereignty: {
        classification: "federated",
        data_residency: "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { nonce: "abc", server_ts: "t", responder_version: "1.0.0" },
    };
    const c = classifyRoundTrip({ kind: "reply", rttMs: 42, reply }, "abc");
    expect(c.verdict).toBe("reachable");
    expect(c.rttMs).toBe(42);
    void fired;
  });

  test("mismatched nonce ⇒ no-responder (never reachable)", () => {
    const reply: Envelope = {
      id: "x",
      source: "andreas.community.luna",
      type: PROBE_REPLY_ECHO_TYPE,
      timestamp: "t",
      sovereignty: {
        classification: "federated",
        data_residency: "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { nonce: "WRONG", server_ts: "t", responder_version: "1.0.0" },
    };
    const c = classifyRoundTrip({ kind: "reply", rttMs: 5, reply }, "abc");
    expect(c.verdict).toBe("no-responder");
  });

  test("timeout ⇒ timeout", () => {
    expect(classifyRoundTrip({ kind: "timeout" }, "abc").verdict).toBe("timeout");
  });

  test("publish-failed ⇒ not-configured", () => {
    expect(
      classifyRoundTrip({ kind: "publish-failed", reason: "no route" }, "abc").verdict,
    ).toBe("not-configured");
  });
});

// ---------------------------------------------------------------------------
// pingPeer — the verdicts + exit codes + RTT aggregation
// ---------------------------------------------------------------------------

describe("pingPeer — verdicts + exit codes", () => {
  test("reachable (via mock responder) — exit 0, RTT measured", async () => {
    const { ports, fired } = fakeBus((f) => echoReply(f, 40));
    const res = await pingPeer(inputs(), ports);
    expect(res.verdict).toBe("reachable");
    expect(res.exitCode).toBe(0);
    expect(res.stats.received).toBe(1);
    expect(res.stats.loss).toBe(0);
    expect(res.stats.rttMinMs).toBe(40);
    expect(res.stats.rttAvgMs).toBe(40);
    expect(res.stats.rttMaxMs).toBe(40);
    // The fired probe addressed the target + our scope.
    expect(fired[0]!.requestSubject).toBe(
      "federated.jc.default.tasks.@did-mf-jc-default.probe.echo",
    );
    expect(fired[0]!.replySubjectPattern).toBe(
      "federated.andreas.community.probe.reply.>",
    );
  });

  test("not-configured — exit 2, NOTHING emitted (no probe fired)", async () => {
    const { ports, fired } = fakeBus((f) => echoReply(f, 1));
    const res = await pingPeer(inputs({ isConfiguredPeer: false }), ports);
    expect(res.verdict).toBe("not-configured");
    expect(res.exitCode).toBe(2);
    expect(fired).toHaveLength(0); // fail-closed at the publish boundary
    expect(res.detail).toContain("peers[]");
  });

  test("timeout — exit 4", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const res = await pingPeer(inputs(), ports);
    expect(res.verdict).toBe("timeout");
    expect(res.exitCode).toBe(4);
    expect(res.stats.loss).toBe(1);
  });

  test("no-responder (reply but wrong nonce) — exit 3", async () => {
    const { ports } = fakeBus((f) => {
      const r = echoReply(f, 5);
      if (r.kind === "reply") {
        (r.reply.payload).nonce = "TAMPERED";
      }
      return r;
    });
    const res = await pingPeer(inputs(), ports);
    expect(res.verdict).toBe("no-responder");
    expect(res.exitCode).toBe(3);
  });

  test("publish-failed ⇒ not-configured (exit 2)", async () => {
    const { ports } = fakeBus(() => ({
      kind: "publish-failed",
      reason: "no leaf route",
    }));
    const res = await pingPeer(inputs(), ports);
    expect(res.verdict).toBe("not-configured");
    expect(res.exitCode).toBe(2);
  });
});

describe("pingPeer — --count aggregation", () => {
  test("three reachable probes aggregate min/avg/max RTT + 0% loss", async () => {
    const rtts = [39, 42, 45];
    const { ports, fired } = fakeBus((f, seq) => echoReply(f, rtts[seq - 1]!));
    const res = await pingPeer(inputs({ count: 3 }), ports);
    expect(res.verdict).toBe("reachable");
    expect(res.probes).toHaveLength(3);
    expect(fired).toHaveLength(3);
    expect(res.stats.sent).toBe(3);
    expect(res.stats.received).toBe(3);
    expect(res.stats.loss).toBe(0);
    expect(res.stats.rttMinMs).toBe(39);
    expect(res.stats.rttMaxMs).toBe(45);
    expect(res.stats.rttAvgMs).toBeCloseTo(42, 5);
    // Per-seq rows carry their own RTT.
    expect(res.probes.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(res.probes[0]!.rttMs).toBe(39);
  });

  test("partial loss — reachable overall, loss fraction reported", async () => {
    const { ports } = fakeBus((f, seq) =>
      seq === 2 ? { kind: "timeout" } : echoReply(f, 50),
    );
    const res = await pingPeer(inputs({ count: 3 }), ports);
    expect(res.verdict).toBe("reachable"); // at least one echo
    expect(res.stats.sent).toBe(3);
    expect(res.stats.received).toBe(2);
    expect(res.stats.loss).toBeCloseTo(1 / 3, 5);
  });

  test("all probes time out ⇒ timeout overall, 100% loss", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const res = await pingPeer(inputs({ count: 3 }), ports);
    expect(res.verdict).toBe("timeout");
    expect(res.stats.loss).toBe(1);
    expect(res.stats.received).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// derivePingInputs — config derivation + peers[] membership
// ---------------------------------------------------------------------------

function loadedConfig(
  peers: { principal_id: string; stack_id: string }[],
  networkId = "metafactory-community",
  leafNode = "hub",
): LoadedConfig {
  return {
    config: {} as unknown as LoadedConfig["config"],
    inlineAgents: [{ id: "luna" } as unknown as LoadedConfig["inlineAgents"][number]],
    principal: { id: "andreas" },
    stack: { id: "andreas/community" },
    policy: {
      federated: {
        networks: [
          { id: networkId, leaf_node: leafNode, peers } as unknown as NonNullable<
            NonNullable<LoadedConfig["policy"]>["federated"]
          >["networks"][number],
        ],
      },
    } as unknown as LoadedConfig["policy"],
  };
}

/** A two-network config where a peer sits on BOTH networks (distinct leaves). */
function loadedConfigTwoNetworks(
  peer: { principal_id: string; stack_id: string },
  leafA: string,
  leafB: string,
): LoadedConfig {
  return {
    config: {} as unknown as LoadedConfig["config"],
    inlineAgents: [{ id: "luna" } as unknown as LoadedConfig["inlineAgents"][number]],
    principal: { id: "andreas" },
    stack: { id: "andreas/community" },
    policy: {
      federated: {
        networks: [
          { id: "net-a", leaf_node: leafA, peers: [peer] },
          { id: "net-b", leaf_node: leafB, peers: [peer] },
        ] as unknown as NonNullable<
          NonNullable<LoadedConfig["policy"]>["federated"]
        >["networks"],
      },
    } as unknown as LoadedConfig["policy"],
  };
}

describe("derivePingInputs", () => {
  test("resolves requester from config + target as a configured peer", () => {
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]);
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.inputs?.requesterPrincipal).toBe("andreas");
    expect(r.inputs?.requesterStack).toBe("community");
    expect(r.inputs?.requesterAssistant).toBe("luna");
    expect(r.inputs?.targetAssistantDid).toBe("did:mf:jc-default");
    expect(r.inputs?.isConfiguredPeer).toBe(true);
  });

  test("cortex#1728 — resolves the peer's network leaf_node for leafz scoping", () => {
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }], "metafactory-community", "mfleaf");
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.networkLeafNode).toBe("mfleaf");
  });

  test("cortex#1728 — peer on TWO networks with distinct leaves ⇒ leaf_node undefined (ambiguous, no --network)", () => {
    const cfg = loadedConfigTwoNetworks({ principal_id: "jc", stack_id: "jc/default" }, "leaf-a", "leaf-b");
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.isConfiguredPeer).toBe(true);
    expect(r.inputs?.networkLeafNode).toBeUndefined(); // never guess which leaf
  });

  test("cortex#1728 — --network selector disambiguates the leaf_node", () => {
    const cfg = loadedConfigTwoNetworks({ principal_id: "jc", stack_id: "jc/default" }, "leaf-a", "leaf-b");
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      network: "net-b",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.networkLeafNode).toBe("leaf-b");
  });

  test("cortex#1728 — two networks SHARING one leaf_node collapse to that leaf", () => {
    const cfg = loadedConfigTwoNetworks({ principal_id: "jc", stack_id: "jc/default" }, "shared", "shared");
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.networkLeafNode).toBe("shared"); // one distinct leaf ⇒ unambiguous
  });

  test("a target NOT in peers[] resolves isConfiguredPeer=false", () => {
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]);
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "stranger",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.isConfiguredPeer).toBe(false);
  });

  test("--assistant overrides the target assistant DID (Direct routing)", () => {
    const cfg = loadedConfig([{ principal_id: "jc", stack_id: "jc/default" }]);
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      assistant: "sage",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.targetAssistantDid).toBe("did:mf:sage");
  });

  test("--network scopes peer resolution to that network", () => {
    const cfg = loadedConfig(
      [{ principal_id: "jc", stack_id: "jc/default" }],
      "other-net",
    );
    // Scoped to a different network id ⇒ not found.
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      network: "metafactory-community",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.inputs?.isConfiguredPeer).toBe(false);
  });

  test("fails closed when principal cannot be resolved", () => {
    const cfg = { ...loadedConfig([]), principal: undefined } as LoadedConfig;
    const r = derivePingInputs({
      cfg,
      targetPrincipal: "jc",
      targetStack: "default",
      count: 1,
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("principal");
  });
});

describe("VERDICT_EXIT_CODE — spec §3.3 mapping", () => {
  test("exact exit-code taxonomy", () => {
    expect(VERDICT_EXIT_CODE.reachable).toBe(0);
    expect(VERDICT_EXIT_CODE["not-configured"]).toBe(2);
    expect(VERDICT_EXIT_CODE["no-responder"]).toBe(3);
    expect(VERDICT_EXIT_CODE.timeout).toBe(4);
    expect(VERDICT_EXIT_CODE.refused).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// cortex#1728 (guard 4) — leafz-aware half-disambiguation
// ---------------------------------------------------------------------------

/**
 * A fake leafz sampler that returns a scripted sequence of readings — one per
 * `sample()` call, so a before/after pair can encode a controlled delta. A
 * `undefined` entry (or exhausting the script) models a failed read.
 */
function fakeLeafz(
  readings: (LeafzCounters | undefined)[],
): { port: LeafzSamplerPort; leafNodes: string[] } {
  const leafNodes: string[] = [];
  let calls = 0;
  const port: LeafzSamplerPort = {
    sample: async (leafNode: string) => {
      leafNodes.push(leafNode); // record the scoping key each call received
      const r = readings[calls];
      calls++;
      return r;
    },
  };
  return { port, leafNodes };
}

describe("diagnoseLeafzDelta — pure half-disambiguation (cortex#1728)", () => {
  test("out +N, in +0 ⇒ remote (echo leg / peer responder)", () => {
    const d = diagnoseLeafzDelta({ outMsgs: 100, inMsgs: 50 }, { outMsgs: 103, inMsgs: 50 });
    expect(d?.half).toBe("remote");
    expect(d?.outDelta).toBe(3);
    expect(d?.inDelta).toBe(0);
    expect(d?.line).toContain("REMOTE");
    expect(d?.line).toContain("out +3");
  });

  test("out +0 ⇒ local-egress (leaf account/binding, not the peer)", () => {
    const d = diagnoseLeafzDelta({ outMsgs: 100, inMsgs: 50 }, { outMsgs: 100, inMsgs: 50 });
    expect(d?.half).toBe("local-egress");
    expect(d?.outDelta).toBe(0);
    expect(d?.line).toContain("LOCAL egress");
  });

  test("out +N, in +N ⇒ inconclusive (both legs advanced, not a clean split)", () => {
    const d = diagnoseLeafzDelta({ outMsgs: 100, inMsgs: 50 }, { outMsgs: 103, inMsgs: 53 });
    expect(d?.half).toBe("inconclusive");
    expect(d?.outDelta).toBe(3);
    expect(d?.inDelta).toBe(3);
  });

  test("negative delta (counter reset / reconnect) ⇒ inconclusive", () => {
    const d = diagnoseLeafzDelta({ outMsgs: 100, inMsgs: 50 }, { outMsgs: 2, inMsgs: 0 });
    expect(d?.half).toBe("inconclusive");
    expect(d?.line).toContain("reconnected");
  });

  test("missing before/after sample ⇒ undefined (nothing to diff)", () => {
    expect(diagnoseLeafzDelta(undefined, { outMsgs: 1, inMsgs: 1 })).toBeUndefined();
    expect(diagnoseLeafzDelta({ outMsgs: 1, inMsgs: 1 }, undefined)).toBeUndefined();
    expect(diagnoseLeafzDelta(undefined, undefined)).toBeUndefined();
  });
});

describe("pingPeer — folds leafz delta into a timeout verdict (cortex#1728)", () => {
  test("timeout + out+ / in0 ⇒ leafz.half=remote on the result", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const { port: leafz, leafNodes } = fakeLeafz([
      { outMsgs: 100, inMsgs: 50 }, // before
      { outMsgs: 101, inMsgs: 50 }, // after: 1 probe crossed, no echo back
    ]);
    const res = await pingPeer(inputs({ networkLeafNode: "mfleaf" }), { ...ports, leafz });
    expect(res.verdict).toBe("timeout");
    expect(res.leafz?.half).toBe("remote");
    expect(res.leafz?.outDelta).toBe(1);
    expect(res.leafz?.inDelta).toBe(0);
    // The sampler was scoped to the network's leaf_node on BOTH before/after.
    expect(leafNodes).toEqual(["mfleaf", "mfleaf"]);
  });

  test("timeout + out+0 ⇒ leafz.half=local-egress on the result", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const { port: leafz } = fakeLeafz([
      { outMsgs: 100, inMsgs: 50 }, // before
      { outMsgs: 100, inMsgs: 50 }, // after: nothing left the leaf
    ]);
    const res = await pingPeer(inputs(), { ...ports, leafz });
    expect(res.verdict).toBe("timeout");
    expect(res.leafz?.half).toBe("local-egress");
    expect(res.leafz?.outDelta).toBe(0);
  });

  test("reachable ⇒ NO leafz diagnosis folded (only timeout is disambiguated)", async () => {
    const { ports } = fakeBus((f) => echoReply(f, 12));
    const { port: leafz } = fakeLeafz([
      { outMsgs: 100, inMsgs: 50 },
      { outMsgs: 101, inMsgs: 51 },
    ]);
    const res = await pingPeer(inputs(), { ...ports, leafz });
    expect(res.verdict).toBe("reachable");
    expect(res.leafz).toBeUndefined();
  });

  test("no leafz sampler wired ⇒ timeout carries no leafz field (best-effort)", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const res = await pingPeer(inputs(), ports); // no `leafz` on ports
    expect(res.verdict).toBe("timeout");
    expect(res.leafz).toBeUndefined();
  });

  test("leafz sampler throws ⇒ ping still succeeds, no leafz line", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const leafz: LeafzSamplerPort = {
      sample: async () => {
        throw new Error("monitor exploded");
      },
    };
    const res = await pingPeer(inputs(), { ...ports, leafz });
    expect(res.verdict).toBe("timeout"); // never fails the ping
    expect(res.leafz).toBeUndefined();
  });

  test("leafz sampler returns undefined (monitor unreachable) ⇒ no line", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const { port: leafz } = fakeLeafz([undefined, undefined]);
    const res = await pingPeer(inputs(), { ...ports, leafz });
    expect(res.verdict).toBe("timeout");
    expect(res.leafz).toBeUndefined();
  });

  test("cortex#1728 — no resolved leaf_node ⇒ sampler NOT called, no line (never misattribute)", async () => {
    const { ports } = fakeBus(() => ({ kind: "timeout" }));
    const { port: leafz, leafNodes } = fakeLeafz([
      { outMsgs: 100, inMsgs: 50 },
      { outMsgs: 200, inMsgs: 50 }, // would look like "remote" if wrongly sampled
    ]);
    const res = await pingPeer(inputs({ networkLeafNode: undefined }), { ...ports, leafz });
    expect(res.verdict).toBe("timeout");
    expect(res.leafz).toBeUndefined(); // ambiguous leaf ⇒ omit rather than guess
    expect(leafNodes).toEqual([]); // sampler never invoked
  });
});
