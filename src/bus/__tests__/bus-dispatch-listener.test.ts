/**
 * IAW Phase B.2a (cortex#114) — BusDispatchListener tests.
 *
 * Coverage axes:
 *   1. Subscribe + unsubscribe lifecycle.
 *   2. Peer-dispatch filter — only `dispatch.task.dispatched` envelopes
 *      from non-self sources trigger the verify path; other types and
 *      our own publishes are ignored.
 *   3. Verify gate — invalid chain (untrusted signer, malformed
 *      principal, etc.) drops with a stderr log; no visibility event.
 *   4. Valid chain emits `system.bus.peer_dispatch_received` carrying
 *      the peer source + envelope id + correlation id.
 *   5. Idempotent start/stop.
 */

import { describe, test, expect } from "bun:test";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import type {
  EnvelopeHandler,
  MyelinRuntime,
} from "../myelin/runtime";
import type { Envelope, SignedBy } from "../myelin/envelope-validator";
import type { Agent } from "../../common/types/cortex-config";
import { BusDispatchListener } from "../bus-dispatch-listener";

// =============================================================================
// Fixtures (mirrors verify-signed-by-chain.test.ts patterns)
// =============================================================================

const NKEY_ECHO = "U" + "B".repeat(55);

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function resolverWith(...agents: Agent[]): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents(agents));
}

function ed25519Stamp(principal: string): SignedBy {
  return {
    method: "ed25519",
    // R11 — stamp DID key is `identity` post-myelin#184.
    identity: principal,
    signature: "A".repeat(88),
    at: "2026-05-15T11:00:00.000Z",
  };
}

function peerDispatchEnvelope(opts: {
  source?: string;
  type?: string;
  correlationId?: string;
  signerPrincipal?: string;
  id?: string;
}): Envelope {
  const env: Envelope = {
    id: opts.id ?? "00000000-0000-4000-8000-000000000111",
    source: opts.source ?? "metafactory.echo.local",
    type: opts.type ?? "dispatch.task.dispatched",
    timestamp: "2026-05-15T11:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {},
  };
  if (opts.correlationId !== undefined) env.correlation_id = opts.correlationId;
  if (opts.signerPrincipal !== undefined) {
    env.signed_by = ed25519Stamp(opts.signerPrincipal);
  }
  return env;
}

function fakeRuntime() {
  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async publish(envelope) {
      published.push(envelope);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {
      handlers.clear();
    },
  };
  function deliverInbound(envelope: Envelope, subject = "test.subject") {
    for (const handler of handlers) handler(envelope, subject);
  }
  // Yield to the event loop so the listener's serial-promise chain
  // can process any queued inbounds before the test asserts on
  // `published`.
  async function drain(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { runtime, published, deliverInbound, drain, handlers };
}

const SOURCE = { principal: "metafactory", agent: "cortex", instance: "local" };

// =============================================================================
// Cases
// =============================================================================

describe("BusDispatchListener — lifecycle", () => {
  test("start subscribes to runtime; stop unregisters", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const { runtime, handlers } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });

    expect(handlers.size).toBe(0);
    listener.start();
    expect(handlers.size).toBe(1);
    await listener.stop();
    expect(handlers.size).toBe(0);
  });

  test("start is idempotent — second call doesn't register twice", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const { runtime, handlers } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });

    listener.start();
    listener.start();
    expect(handlers.size).toBe(1);
    await listener.stop();
  });

  test("stop is idempotent — second call doesn't throw", async () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const { runtime } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });

    listener.start();
    await listener.stop();
    await expect(listener.stop()).resolves.toBeUndefined();
  });
});

describe("BusDispatchListener — peer-dispatch filter", () => {
  test("ignores envelopes that are not dispatch.task.dispatched", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, published, deliverInbound, drain } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });
    listener.start();

    deliverInbound(
      peerDispatchEnvelope({
        type: "dispatch.task.completed",
        signerPrincipal: "did:mf:echo",
      }),
    );
    await drain();

    // No visibility event published — wrong type was filtered.
    expect(published).toHaveLength(0);

    await listener.stop();
  });

  test("ignores envelopes whose source matches our own", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, published, deliverInbound, drain } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });
    listener.start();

    // Same source as us — should be ignored (it's our own publish
    // looping back via the local fan-out).
    deliverInbound(
      peerDispatchEnvelope({
        source: `${SOURCE.principal}.${SOURCE.agent}.${SOURCE.instance}`,
        signerPrincipal: "did:mf:luna",
      }),
    );
    await drain();

    expect(published).toHaveLength(0);
    await listener.stop();
  });
});

describe("BusDispatchListener — verification gate", () => {
  test("emits system.bus.peer_dispatch_received on valid peer dispatch", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, published, deliverInbound, drain } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "test-operator",
      source: SOURCE,
    });
    listener.start();

    deliverInbound(
      peerDispatchEnvelope({
        signerPrincipal: "did:mf:echo",
        correlationId: "00000000-0000-4000-8000-000000000200",
        id: "00000000-0000-4000-8000-000000000abc",
      }),
    );
    await drain();

    // Exactly one visibility event published.
    expect(published).toHaveLength(1);
    const event = published[0];
    expect(event?.type).toBe("system.bus.peer_dispatch_received");
    expect(event?.payload.receiving_agent_id).toBe("luna");
    expect(event?.payload.peer_source).toBe("metafactory.echo.local");
    expect(event?.payload.dispatch_envelope_id).toBe(
      "00000000-0000-4000-8000-000000000abc",
    );
    expect(event?.payload.correlation_id).toBe(
      "00000000-0000-4000-8000-000000000200",
    );

    await listener.stop();
  });

  test("drops an inbound envelope whose signer is not trusted (stderr + no visibility event)", async () => {
    // Holly's NKey is in the registry but not in luna's trust list.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const holly = agentFixture({
      id: "holly",
      displayName: "Holly",
      nkey_pub: "U" + "C".repeat(55),
    });
    const resolver = resolverWith(luna, echo, holly);
    const { runtime, published, deliverInbound, drain } = fakeRuntime();

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const listener = new BusDispatchListener({
        runtime,
        resolver,
        receivingAgentId: "luna",
        principalId: "test-operator",
        source: SOURCE,
      });
      listener.start();

      deliverInbound(
        peerDispatchEnvelope({ signerPrincipal: "did:mf:holly" }),
      );
      await drain();

      expect(published).toHaveLength(0);
      await listener.stop();
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-dispatch-listener:luna");
    expect(stderrOutput).toContain("signer_not_trusted");
  });

  test("[cortex#480] accepts an envelope self-signed by the receiving stack identity", async () => {
    // Pre-fix repro: an adapter-originated dispatch reaching the
    // dispatch-listener gets stamped by the stack identity
    // (`did:mf:<principal>-<stack>`). The stack is NOT in the agent
    // registry, so the pre-fix verifier rejected as `unknown_agent`.
    // With cortex#480 wiring the stack-identity option, the listener
    // short-circuits the registry lookup and emits the visibility
    // event.
    const stackIdentity = "did:mf:andreas-meta-factory";
    const stackNKeyPub = "U" + "D".repeat(55);
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = resolverWith(luna);
    const { runtime, published, deliverInbound, drain } = fakeRuntime();

    const listener = new BusDispatchListener({
      runtime,
      resolver,
      receivingAgentId: "luna",
      principalId: "andreas",
      source: SOURCE,
      // cryptoVerify default `false` here so we exercise structural-
      // only own-stack short-circuit (the prod default for this
      // listener until B.1c flag flip; the runner-side listener
      // tested in cortex.ts wiring runs cryptoVerify: true).
      stackIdentity,
      stackNKeyPub,
    });
    listener.start();

    deliverInbound(
      peerDispatchEnvelope({
        signerPrincipal: stackIdentity,
        source: "andreas.meta-factory.local",
        id: "00000000-0000-4000-8000-000000000def",
      }),
    );
    await drain();

    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("system.bus.peer_dispatch_received");

    await listener.stop();
  });
});
