/**
 * Tests for the federated echo responder (`cortex network ping` receive-half,
 * signal#113 P-11 / `docs/design-network-ping.md`, issue #56).
 *
 * Close-criteria from the spec §9:
 *   - answers a peer probe (echo correct, EXACTLY one reply);
 *   - REFUSES a non-peer (no reply, fail-closed);
 *   - no-amplification (one request → exactly one reply, never broadcast;
 *     forged/absent originator → no reply; reply ONLY to the attributed
 *     requester scope);
 *   - per-source rate-limit;
 *   - no LLM / harness / Discord on the probe path (structural — the responder
 *     module imports none of them; asserted by inspection + the "no publish
 *     beyond the single reply" checks here).
 */

import { describe, expect, test } from "bun:test";

import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { SystemEventSource } from "../system-events";
import type {
  PolicyFederatedNetwork,
  PolicyFederatedPeer,
} from "../../common/types/cortex-config";
import {
  createProbeResponder,
  decideProbeResponse,
  isProbeEcho,
  parseProbeEchoRequest,
  ProbeRateLimiter,
  PROBE_ECHO_CAPABILITY,
  PROBE_REPLY_ECHO_TYPE,
  RESPONDER_VERSION,
  systemClock,
  type ProbeClock,
  type ProbeDecisionInputs,
  type ProbeEchoReplyPayload,
} from "../probe-responder";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** "Us" — the receiving stack: andreas/community, assistant luna. */
const SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "luna",
  instance: "responder",
};
const OUR_STACK = "community";

/** A peer fixture (jc/default) in a configured network. */
function peer(principal: string, stack: string): PolicyFederatedPeer {
  return { principal_id: principal, stack_id: `${principal}/${stack}` };
}

function networksWithPeers(
  ...peers: PolicyFederatedPeer[]
): Map<string, PolicyFederatedNetwork> {
  const network: PolicyFederatedNetwork = {
    id: "metafactory-community",
    peers,
    accept_subjects: [],
    deny_subjects: [],
    max_hop: 1,
  } as unknown as PolicyFederatedNetwork;
  return new Map([[network.id, network]]);
}

/** Fixed clock so `server_ts` + rate-limit timing are deterministic. */
function fixedClock(ms = 1_000_000): ProbeClock {
  return { nowMs: () => ms, nowIso: () => "2026-06-10T00:00:00.000Z" };
}

function decisionInputs(
  overrides: Partial<ProbeDecisionInputs> = {},
): ProbeDecisionInputs {
  return {
    source: SOURCE,
    stack: OUR_STACK,
    federatedNetworksById: networksWithPeers(peer("jc", "default")),
    rateLimiter: new ProbeRateLimiter(),
    clock: fixedClock(),
    ...overrides,
  };
}

/**
 * Build an inbound `probe.echo` request envelope.
 *   - `source` addresses the TARGET (us) — ADR-0002 §1.
 *   - `originator.identity` carries the REQUESTER DID.
 */
function makeProbeRequest(opts: {
  type?: string;
  requesterDid?: string | null;
  nonce?: string | null;
  seq?: number;
  correlationId?: string;
}): Envelope {
  const payload: Record<string, unknown> = {};
  if (opts.nonce !== null) payload.nonce = opts.nonce ?? "nonce-abc";
  payload.sent_at = "2026-06-10T00:00:00.000Z";
  if (opts.seq !== undefined) payload.seq = opts.seq;

  const env: Envelope = {
    id: "11111111-1111-4111-8111-111111111111",
    source: `${SOURCE.principal}.${OUR_STACK}.${SOURCE.agent}`,
    type: opts.type ?? PROBE_ECHO_CAPABILITY,
    distribution_mode: "direct",
    timestamp: "2026-06-10T00:00:00.000Z",
    correlation_id: opts.correlationId ?? "22222222-2222-4222-8222-222222222222",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload,
  };
  if (opts.requesterDid !== null) {
    env.originator = {
      identity: opts.requesterDid ?? "did:mf:jc-default",
      attribution: "federated",
    };
  }
  return env;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isProbeEcho", () => {
  test("matches Offer form `probe.echo`", () => {
    expect(isProbeEcho("probe.echo")).toBe(true);
  });
  test("matches Direct form `tasks.@did-mf-luna.probe.echo`", () => {
    expect(isProbeEcho("tasks.@did-mf-luna.probe.echo")).toBe(true);
  });
  test("matches `tasks.probe.echo`", () => {
    expect(isProbeEcho("tasks.probe.echo")).toBe(true);
  });
  test("REJECTS the reply type (loop-safety)", () => {
    expect(isProbeEcho(PROBE_REPLY_ECHO_TYPE)).toBe(false);
  });
  test("rejects a chat dispatch", () => {
    expect(isProbeEcho("tasks.@did-mf-luna.chat")).toBe(false);
    expect(isProbeEcho("tasks.chat")).toBe(false);
  });
});

describe("parseProbeEchoRequest", () => {
  test("accepts a bounded nonce + optional seq", () => {
    const env = makeProbeRequest({ seq: 3 });
    const p = parseProbeEchoRequest(env);
    expect(p).not.toBeNull();
    expect(p?.nonce).toBe("nonce-abc");
    expect(p?.seq).toBe(3);
  });
  test("rejects a missing nonce", () => {
    expect(parseProbeEchoRequest(makeProbeRequest({ nonce: null }))).toBeNull();
  });
  test("rejects an empty nonce", () => {
    expect(parseProbeEchoRequest(makeProbeRequest({ nonce: "" }))).toBeNull();
  });
  test("rejects an over-long nonce (no amplification via huge nonce)", () => {
    const huge = "x".repeat(1000);
    expect(parseProbeEchoRequest(makeProbeRequest({ nonce: huge }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideProbeResponse — the security core
// ---------------------------------------------------------------------------

describe("decideProbeResponse — happy path (peer probe)", () => {
  test("answers a configured peer with EXACTLY one correct echo", () => {
    const env = makeProbeRequest({ nonce: "n-1", seq: 1 });
    const decision = decideProbeResponse(env, "federated.andreas.community.tasks.probe.echo", decisionInputs());
    expect(decision.kind).toBe("reply");
    if (decision.kind !== "reply") return;

    // Reply addressed ONLY to the originator-attributed requester scope.
    expect(decision.requesterPrincipal).toBe("jc");
    expect(decision.requesterStack).toBe("default");
    expect(decision.subject).toBe(
      `federated.jc.default.${PROBE_REPLY_ECHO_TYPE}`,
    );

    // Reply envelope: federated scope, reply type, source addresses requester.
    expect(decision.envelope.type).toBe(PROBE_REPLY_ECHO_TYPE);
    expect(decision.envelope.sovereignty.classification).toBe("federated");
    expect(decision.envelope.source).toBe("jc.default.luna");
    // correlation_id is echoed so the requester can join request↔reply.
    expect(decision.envelope.correlation_id).toBe(env.correlation_id);

    // Payload: echoed nonce + server_ts + version + echoed seq. Nothing else.
    const reply = decision.envelope.payload as unknown as ProbeEchoReplyPayload;
    expect(reply.nonce).toBe("n-1");
    expect(reply.seq).toBe(1);
    expect(reply.responder_version).toBe(RESPONDER_VERSION);
    expect(reply.server_ts).toBe("2026-06-10T00:00:00.000Z");
  });

  test("Direct-form request (tasks.@did.probe.echo) is answered the same", () => {
    const env = makeProbeRequest({ type: "tasks.@did-mf-luna.probe.echo" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("reply");
  });

  test("NIT-2: reply data_residency is OUR OWN, not the requester-supplied one", () => {
    const env = makeProbeRequest({});
    // The inbound envelope claims a foreign residency; the reply must ignore it.
    env.sovereignty = { ...env.sovereignty, data_residency: "ATTACKER-LAND" };
    const decision = decideProbeResponse(
      env,
      undefined,
      decisionInputs({ dataResidency: "NZ" }),
    );
    expect(decision.kind).toBe("reply");
    if (decision.kind !== "reply") return;
    expect(decision.envelope.sovereignty.data_residency).toBe("NZ");
    expect(decision.envelope.sovereignty.data_residency).not.toBe("ATTACKER-LAND");
  });

  test("NIT-2: reply residency defaults to NZ when none supplied", () => {
    const env = makeProbeRequest({});
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("reply");
    if (decision.kind === "reply") {
      expect(decision.envelope.sovereignty.data_residency).toBe("NZ");
    }
  });
});

describe("decideProbeResponse — fail-closed (FG-4 + no-amplification)", () => {
  test("REFUSES a non-peer requester (no reply)", () => {
    const env = makeProbeRequest({ requesterDid: "did:mf:evil-stack" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("non-peer");
  });

  test("REFUSES an absent originator (forged/absent attribution)", () => {
    const env = makeProbeRequest({ requesterDid: null });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("no-originator");
  });

  test("REFUSES a malformed originator (no did:mf: prefix)", () => {
    const env = makeProbeRequest({ requesterDid: "jc/default" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("no-originator");
  });

  test("REFUSES a self-loop (requester == us)", () => {
    const env = makeProbeRequest({ requesterDid: "did:mf:andreas-community" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("self-loop");
  });

  test("NIT-3: REFUSES a peer-principal on a DIFFERENT stack than configured", () => {
    // jc IS a configured peer (jc/default), but the originator decodes to
    // jc/other-stack — the decoded {principal}/{stack} must EQUAL the peer's
    // stack_id, else we'd reflect onto jc's unsubscribed subject. Fail-closed.
    const env = makeProbeRequest({ requesterDid: "did:mf:jc-other-stack" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("non-peer");
  });

  test("REFUSES a non-probe-echo type (chat dispatch)", () => {
    const env = makeProbeRequest({ type: "tasks.@did-mf-luna.chat" });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("not-probe-echo");
  });

  test("REFUSES a bad payload (no nonce)", () => {
    const env = makeProbeRequest({ nonce: null });
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("bad-payload");
  });

  test("reply NEVER targets an attacker-supplied address — only the originator scope", () => {
    // Even if the request's SOURCE is spoofed to point at a victim, the reply
    // is keyed off originator.identity, not source. Here source addresses us
    // (correct), originator is the peer — the reply goes to the peer, period.
    const env = makeProbeRequest({});
    env.source = "victim.victim-stack.attacker"; // attacker-controlled source
    const decision = decideProbeResponse(env, undefined, decisionInputs());
    expect(decision.kind).toBe("reply");
    if (decision.kind !== "reply") return;
    expect(decision.subject).toBe(`federated.jc.default.${PROBE_REPLY_ECHO_TYPE}`);
    expect(decision.subject).not.toContain("victim");
  });

  test("empty peers[] (no networks) refuses everything", () => {
    const env = makeProbeRequest({});
    const decision = decideProbeResponse(
      env,
      undefined,
      decisionInputs({ federatedNetworksById: new Map() }),
    );
    expect(decision.kind).toBe("drop");
    if (decision.kind === "drop") expect(decision.reason).toBe("non-peer");
  });
});

describe("ProbeRateLimiter", () => {
  test("allows up to capacity then refuses", () => {
    const rl = new ProbeRateLimiter(3, 0); // capacity 3, no refill
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(false);
  });

  test("one principal's flood does not starve another", () => {
    const rl = new ProbeRateLimiter(2, 0);
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(false); // jc exhausted
    expect(rl.take("other", 0)).toBe(true); // other has its own bucket
  });

  test("refills over time", () => {
    const rl = new ProbeRateLimiter(1, 1000); // 1 token, 1000/sec refill
    expect(rl.take("jc", 0)).toBe(true);
    expect(rl.take("jc", 0)).toBe(false);
    expect(rl.take("jc", 1)).toBe(true); // 1ms * 1000/s = 1 token refilled
  });
});

describe("decideProbeResponse — rate-limit integration", () => {
  test("a flood of probes is rate-limited (not turned into a reply flood)", () => {
    const inputs = decisionInputs({
      rateLimiter: new ProbeRateLimiter(2, 0),
      clock: fixedClock(),
    });
    const env = makeProbeRequest({});
    expect(decideProbeResponse(env, undefined, inputs).kind).toBe("reply");
    expect(decideProbeResponse(env, undefined, inputs).kind).toBe("reply");
    const third = decideProbeResponse(env, undefined, inputs);
    expect(third.kind).toBe("drop");
    if (third.kind === "drop") expect(third.reason).toBe("rate-limited");
  });
});

// ---------------------------------------------------------------------------
// createProbeResponder — runtime wiring
// ---------------------------------------------------------------------------

interface RecordingRuntime {
  runtime: MyelinRuntime;
  /** Replies published via publishOnSubject: { subject, envelope }. */
  replies: { subject: string; envelope: Envelope }[];
  trigger: (env: Envelope, subject: string) => void;
  subscribedPatterns: string[];
}

function recordingRuntime(): RecordingRuntime {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const replies: { subject: string; envelope: Envelope }[] = [];
  const subscribedPatterns: string[] = [];
  return {
    replies,
    subscribedPatterns,
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return {
          unregister: () => {
            handlers.delete(handler);
          },
        };
      },
      publish: async () => {
        throw new Error("probe responder must use publishOnSubject, not publish");
      },
      publishOnSubject: async (envelope, subject) => {
        replies.push({ subject, envelope });
      },
      subscribe: async (pattern) => {
        subscribedPatterns.push(pattern);
        return {
          pattern,
          ready: Promise.resolve(),
          stop: async () => {},
        } as unknown as Awaited<
          ReturnType<NonNullable<MyelinRuntime["subscribe"]>>
        >;
      },
      stop: async () => {},
    },
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
  };
}

describe("createProbeResponder — runtime", () => {
  test("subscribes our OWN federated tasks subject (FG-2)", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    expect(responder.subjects).toEqual([
      "federated.andreas.community.tasks.*.>",
    ]);
    await responder.start();
    expect(r.subscribedPatterns).toEqual([
      "federated.andreas.community.tasks.*.>",
    ]);
    await responder.stop();
  });

  test("a peer probe yields EXACTLY one reply on the requester subject", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
      clock: fixedClock(),
    });
    await responder.start();

    const env = makeProbeRequest({ nonce: "live-1", seq: 7 });
    r.trigger(env, "federated.andreas.community.tasks.probe.echo");

    // EXACTLY ONE reply — no fan-out, no broadcast.
    expect(r.replies).toHaveLength(1);
    const reply = r.replies[0]!;
    expect(reply.subject).toBe(`federated.jc.default.${PROBE_REPLY_ECHO_TYPE}`);
    const p = reply.envelope.payload as unknown as ProbeEchoReplyPayload;
    expect(p.nonce).toBe("live-1");
    expect(p.seq).toBe(7);
    await responder.stop();
  });

  test("a non-peer probe yields NO reply (fail-closed)", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    await responder.start();
    r.trigger(
      makeProbeRequest({ requesterDid: "did:mf:evil-stack" }),
      "federated.andreas.community.tasks.probe.echo",
    );
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });

  test("an absent originator yields NO reply", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    await responder.start();
    r.trigger(
      makeProbeRequest({ requesterDid: null }),
      "federated.andreas.community.tasks.probe.echo",
    );
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });

  test("a chat dispatch on our tasks subject is ignored (not answered)", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    await responder.start();
    r.trigger(
      makeProbeRequest({ type: "tasks.@did-mf-luna.chat" }),
      "federated.andreas.community.tasks.@did-mf-luna.chat",
    );
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });

  test("NIT-4: the SAME request delivered twice yields EXACTLY one reply", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
      clock: fixedClock(),
    });
    await responder.start();
    const env = makeProbeRequest({ nonce: "dup-1" });
    // Redeliver the identical envelope (same id) — idempotency guard drops #2.
    r.trigger(env, "federated.andreas.community.tasks.probe.echo");
    r.trigger(env, "federated.andreas.community.tasks.probe.echo");
    expect(r.replies).toHaveLength(1);
    await responder.stop();
  });

  test("our own reply (probe.reply.echo) never re-triggers a reply (loop-safe)", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    await responder.start();
    // Feed a reply-typed envelope back in — must be ignored.
    const replyEnv = makeProbeRequest({ type: PROBE_REPLY_ECHO_TYPE });
    r.trigger(replyEnv, `federated.andreas.community.tasks.probe.echo`);
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });

  test("an off-pattern subject is ignored", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: networksWithPeers(peer("jc", "default")),
    });
    await responder.start();
    // Probe envelope but on someone else's subject — ignore.
    r.trigger(makeProbeRequest({}), "federated.other.stack.tasks.probe.echo");
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });

  test("dormant when no peers configured (does not subscribe)", async () => {
    const r = recordingRuntime();
    const responder = createProbeResponder({
      runtime: r.runtime,
      source: SOURCE,
      stack: OUR_STACK,
      federatedNetworksById: new Map(),
    });
    await responder.start();
    expect(r.subscribedPatterns).toHaveLength(0);
    r.trigger(makeProbeRequest({}), "federated.andreas.community.tasks.probe.echo");
    expect(r.replies).toHaveLength(0);
    await responder.stop();
  });
});

describe("systemClock", () => {
  test("nowIso is a valid ISO string", () => {
    expect(() => new Date(systemClock.nowIso()).toISOString()).not.toThrow();
  });
});
