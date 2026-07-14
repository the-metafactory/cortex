/**
 * IAW Phase B.4 (cortex#114) — cross-stack inbound integration tests.
 *
 * **Scope clarification post-Echo cortex#215 review.** This file
 * exercises the B.2a + B.1c cross-stack boundary: a signed envelope
 * arriving on a stack's bus is verified by the receiving stack's
 * `BusDispatchListener` and either admitted (visibility event
 * emitted) or rejected (stderr log + drop). The outbound-signing
 * production path (`MyelinRuntime.publish` driving the configured
 * signer) is unit-tested in `src/bus/myelin/__tests__/runtime.test.ts`;
 * here we use `signEnvelope` directly to construct on-the-wire
 * signed envelopes without standing up two full runtimes.
 *
 * Coverage:
 *   1. **Bidirectional independent dispatches** — α emits a signed
 *      envelope; β admits it and emits a visibility event. β emits
 *      its own signed envelope; α admits it and emits a visibility
 *      event. Each direction is asserted independently; this is
 *      explicitly NOT a causal request→reply chain (Echo Q-3 from
 *      cortex#215 review).
 *   2. **Forged signature** — α signs an envelope; attacker flips
 *      a signature byte before fan-out; β's listener rejects with
 *      `crypto_verify_failed` (stderr log; no visibility event).
 *   3. **Unknown signer** — γ publishes a correctly-signed envelope,
 *      but γ's DID isn't in β's agent registry at all. β rejects
 *      with `unknown_agent` at the structural check; the crypto
 *      layer never runs.
 *   4. **Untrusted signer** — δ is registered in β's agent registry
 *      with a valid `nkey_pub` but is NOT in β's `trust:` list.
 *      β rejects with `signer_not_trusted` at the structural check;
 *      the crypto layer never runs.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import { AgentRegistry } from "../common/agents/registry";
import { TrustResolver } from "../common/agents/trust-resolver";
import { BusDispatchListener } from "../bus/bus-dispatch-listener";
import type {
  EnvelopeHandler,
  MyelinRuntime,
} from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { Agent } from "../common/types/cortex-config";

// =============================================================================
// Stack fixture (B.4 test-only)
// =============================================================================

/**
 * Test-only stand-in for `MyelinRuntime` that exposes the handler
 * registry directly and captures every `publish` call. Used to wire
 * a shared bus between two stacks AND to assert that each stack's
 * `BusDispatchListener` emits the expected visibility envelope on a
 * verified inbound (Echo Q-1 — the runtime.publish capture is the
 * success-path signal the original test was missing).
 */
interface StackRuntime extends MyelinRuntime {
  _handlers: Set<EnvelopeHandler>;
  /** Every envelope this runtime saw via `publish`. */
  published: Envelope[];
}

interface StackHandle {
  runtime: StackRuntime;
  signer: { rawSeedBytes: Uint8Array; principal: string; nkeyPub: string };
}

function buildStack(stackId: string): StackHandle {
  const kp = createUser();
  const rawSeedBytes = (
    kp as unknown as { getRawSeed(): Uint8Array }
  ).getRawSeed();
  const nkeyPub = kp.getPublicKey();
  const principal = `did:mf:${stackId}`;

  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const runtime: StackRuntime = {
    enabled: true,
    _handlers: handlers,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },

    async publish(envelope) {
      published.push(envelope);
    },

    async stop() {
      handlers.clear();
    },
  };

  return {
    runtime,
    signer: { rawSeedBytes, principal, nkeyPub },
  };
}

/**
 * Fan an envelope from one stack to every stack's handlers (including
 * the publisher's own — matches the real MyelinRuntime contract where
 * onEnvelope fires for outbound publishes too; callers filter self).
 */
function fanOut(envelope: Envelope, stacks: StackHandle[]): void {
  const orgSegment = envelope.source.split(".")[0] ?? "unknown";
  const subject = `local.${orgSegment}.${envelope.type}`;
  for (const stack of stacks) {
    for (const handler of stack.runtime._handlers) {
      handler(envelope, subject);
    }
  }
}

/**
 * Build + sign a `dispatch.task.dispatched` envelope from a stack.
 * Production signs via `MyelinRuntime.publish`'s configured signer
 * (B.3); for this slice we drive `signEnvelope` directly so the
 * integration test stays focused on B.2a + B.1c (cross-stack inbound
 * verification). Outbound signing's full production path is
 * unit-tested at `runtime.test.ts:IAW B.3` cases.
 */
async function signedRequest(stack: StackHandle, args: {
  sourceOrg: string;
  correlationId: string;
  prompt: string;
}): Promise<Envelope> {
  const unsigned: Envelope = {
    id: `00000000-0000-4000-8000-${args.correlationId.slice(-12)}`,
    source: `${args.sourceOrg}.cortex.local`,
    type: "dispatch.task.dispatched",
    timestamp: new Date().toISOString(),
    correlation_id: args.correlationId,
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: { prompt: args.prompt },
  };
  const seedBase64 = Buffer.from(stack.signer.rawSeedBytes).toString("base64");
  const signed = await signEnvelope(
    unsigned as Parameters<typeof signEnvelope>[0],
    seedBase64,
    stack.signer.principal,
  );
  return signed;
}

// =============================================================================
// Agent fixtures (B.4-local; D-1 extraction tracked separately)
// =============================================================================

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1111111111111111111",
    agentChannelId: "2222222222222222222",
    logChannelId: "3333333333333333333",
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

/**
 * Required `id` + `displayName` per Echo Q-7 — silent default-id
 * collisions would mask multi-agent setup bugs.
 */
function agentFixture(
  required: { id: string; displayName: string },
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: required.id,
    displayName: required.displayName,
    persona: `./personas/${required.id}.md`,
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

// =============================================================================
// Cases
// =============================================================================

describe("IAW Phase B.4 — cross-stack inbound integration (refs cortex#114)", () => {
  test("bidirectional independent dispatches: α→β and β→α each emit one visibility event on the receiving stack", async () => {
    const alpha = buildStack("alpha-stack");
    const beta = buildStack("beta-stack");

    // Each stack's registry: own agent + the peer's agent listed
    // with the peer's nkey_pub. Trust runs from the local agent to
    // the peer stack-id (since the peer's stamp principal is
    // `did:mf:<peer stack id>`, the agent.id MUST match the
    // stack-id segment of the DID — convention enforced here).
    const alphaRegistry = AgentRegistry.fromAgents([
      agentFixture(
        { id: "alpha-agent", displayName: "Alpha" },
        {
          nkey_pub: alpha.signer.nkeyPub,
          trust: ["beta-stack"],
        },
      ),
      agentFixture(
        { id: "beta-stack", displayName: "Beta" },
        { nkey_pub: beta.signer.nkeyPub },
      ),
    ]);
    const betaRegistry = AgentRegistry.fromAgents([
      agentFixture(
        { id: "beta-agent", displayName: "Beta" },
        {
          nkey_pub: beta.signer.nkeyPub,
          trust: ["alpha-stack"],
        },
      ),
      agentFixture(
        { id: "alpha-stack", displayName: "Alpha" },
        { nkey_pub: alpha.signer.nkeyPub },
      ),
    ]);

    const alphaListener = new BusDispatchListener({
      runtime: alpha.runtime,
      resolver: new TrustResolver(alphaRegistry),
      receivingAgentId: "alpha-agent",
      principalId: "alpha",
      source: { principal: "alpha", agent: "cortex", instance: "local" },
      cryptoVerify: true,
    });
    const betaListener = new BusDispatchListener({
      runtime: beta.runtime,
      resolver: new TrustResolver(betaRegistry),
      receivingAgentId: "beta-agent",
      principalId: "beta",
      source: { principal: "beta", agent: "cortex", instance: "local" },
      cryptoVerify: true,
    });

    alphaListener.start();
    betaListener.start();

    // α emits a signed envelope onto the shared wire.
    const alphaRequest = await signedRequest(alpha, {
      sourceOrg: "alpha",
      correlationId: "00000000-0000-4000-8000-000000000aaa",
      prompt: "alpha to beta",
    });
    fanOut(alphaRequest, [alpha, beta]);

    // β emits its own (independent — NOT a causal reply) signed envelope.
    const betaIndependent = await signedRequest(beta, {
      sourceOrg: "beta",
      correlationId: "00000000-0000-4000-8000-000000000bbb",
      prompt: "beta to alpha",
    });
    fanOut(betaIndependent, [alpha, beta]);

    // Drain via stop() — listener's `stop()` awaits `inFlight`
    // promise set, which is a true post-stop cutoff (Echo Q-4).
    await alphaListener.stop();
    await betaListener.stop();

    // β's runtime.publish should have been called exactly once with
    // a `system.bus.peer-dispatch-received` envelope for α's request.
    const betaVisibility = beta.runtime.published.filter(
      (e) => e.type === "system.bus.peer-dispatch-received",
    );
    expect(betaVisibility).toHaveLength(1);
    expect(betaVisibility[0]?.payload.receiving_agent_id).toBe("beta-agent");
    expect(betaVisibility[0]?.payload.peer_source).toBe("alpha.cortex.local");
    expect(betaVisibility[0]?.payload.dispatch_envelope_id).toBe(alphaRequest.id);

    // α symmetrically: one visibility event for β's envelope.
    const alphaVisibility = alpha.runtime.published.filter(
      (e) => e.type === "system.bus.peer-dispatch-received",
    );
    expect(alphaVisibility).toHaveLength(1);
    expect(alphaVisibility[0]?.payload.receiving_agent_id).toBe("alpha-agent");
    expect(alphaVisibility[0]?.payload.peer_source).toBe("beta.cortex.local");
    expect(alphaVisibility[0]?.payload.dispatch_envelope_id).toBe(betaIndependent.id);
  });

  test("forged signature: α signs, attacker tampers, β rejects with crypto_verify_failed", async () => {
    const alpha = buildStack("alpha-stack");
    const beta = buildStack("beta-stack");

    const betaRegistry = AgentRegistry.fromAgents([
      agentFixture(
        { id: "beta-agent", displayName: "Beta" },
        {
          nkey_pub: beta.signer.nkeyPub,
          trust: ["alpha-stack"],
        },
      ),
      agentFixture(
        { id: "alpha-stack", displayName: "Alpha" },
        { nkey_pub: alpha.signer.nkeyPub },
      ),
    ]);

    const betaListener = new BusDispatchListener({
      runtime: beta.runtime,
      resolver: new TrustResolver(betaRegistry),
      receivingAgentId: "beta-agent",
      principalId: "beta",
      source: { principal: "beta", agent: "cortex", instance: "local" },
      cryptoVerify: true,
    });
    betaListener.start();

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const signed = await signedRequest(alpha, {
        sourceOrg: "alpha",
        correlationId: "00000000-0000-4000-8000-000000000bbb",
        prompt: "forgery attempt",
      });

      // Tamper with the signature byte (preserve the principal + at,
      // so the structural check still passes — only the bytes are
      // wrong, which is precisely what `crypto_verify_failed` is for).
      const chain = Array.isArray(signed.signed_by)
        ? signed.signed_by
        : signed.signed_by
          ? [signed.signed_by]
          : [];
      const firstStamp = chain[0];
      if (firstStamp?.method !== "ed25519") {
        throw new Error("test: expected ed25519 stamp from signEnvelope");
      }
      const tamperedSig = firstStamp.signature.startsWith("A")
        ? "B" + firstStamp.signature.slice(1)
        : "A" + firstStamp.signature.slice(1);
      const tampered: Envelope = {
        ...signed,
        signed_by: [{ ...firstStamp, signature: tamperedSig }],
      };

      fanOut(tampered, [alpha, beta]);
      await betaListener.stop();
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-dispatch-listener:beta-agent");
    expect(stderrOutput).toContain("crypto_verify_failed");

    // No visibility event — rejection drops the envelope.
    const betaVisibility = beta.runtime.published.filter(
      (e) => e.type === "system.bus.peer-dispatch-received",
    );
    expect(betaVisibility).toHaveLength(0);
  });

  test("unknown signer: γ's DID not in β's registry → β rejects with unknown_agent", async () => {
    const alpha = buildStack("alpha-stack");
    const beta = buildStack("beta-stack");
    const gamma = buildStack("gamma-stack");

    // β trusts ONLY alpha-stack. gamma is unregistered (no agent
    // fixture mentions gamma-stack at all).
    const betaRegistry = AgentRegistry.fromAgents([
      agentFixture(
        { id: "beta-agent", displayName: "Beta" },
        {
          nkey_pub: beta.signer.nkeyPub,
          trust: ["alpha-stack"],
        },
      ),
      agentFixture(
        { id: "alpha-stack", displayName: "Alpha" },
        { nkey_pub: alpha.signer.nkeyPub },
      ),
    ]);

    const betaListener = new BusDispatchListener({
      runtime: beta.runtime,
      resolver: new TrustResolver(betaRegistry),
      receivingAgentId: "beta-agent",
      principalId: "beta",
      source: { principal: "beta", agent: "cortex", instance: "local" },
      cryptoVerify: true,
    });
    betaListener.start();

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const signed = await signedRequest(gamma, {
        sourceOrg: "gamma",
        correlationId: "00000000-0000-4000-8000-000000000ccc",
        prompt: "from unknown gamma",
      });
      fanOut(signed, [alpha, beta, gamma]);
      await betaListener.stop();
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-dispatch-listener:beta-agent");
    expect(stderrOutput).toContain("unknown_agent");
    // No visibility event.
    expect(
      beta.runtime.published.filter(
        (e) => e.type === "system.bus.peer-dispatch-received",
      ),
    ).toHaveLength(0);
  });

  test("untrusted signer: δ is in β's registry but not in trust list → β rejects with signer_not_trusted", async () => {
    const beta = buildStack("beta-stack");
    const delta = buildStack("delta-stack");

    // δ IS registered with valid nkey_pub but NOT in β's trust list.
    // Distinct from the unknown_agent case above where δ's stack id
    // wasn't in the registry at all.
    const betaRegistry = AgentRegistry.fromAgents([
      agentFixture(
        { id: "beta-agent", displayName: "Beta" },
        {
          nkey_pub: beta.signer.nkeyPub,
          trust: [], // ← δ NOT in trust list
        },
      ),
      agentFixture(
        { id: "delta-stack", displayName: "Delta" },
        { nkey_pub: delta.signer.nkeyPub },
      ),
    ]);

    const betaListener = new BusDispatchListener({
      runtime: beta.runtime,
      resolver: new TrustResolver(betaRegistry),
      receivingAgentId: "beta-agent",
      principalId: "beta",
      source: { principal: "beta", agent: "cortex", instance: "local" },
      cryptoVerify: true,
    });
    betaListener.start();

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const signed = await signedRequest(delta, {
        sourceOrg: "delta",
        correlationId: "00000000-0000-4000-8000-000000000ddd",
        prompt: "from registered-but-untrusted delta",
      });
      fanOut(signed, [beta, delta]);
      await betaListener.stop();
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-dispatch-listener:beta-agent");
    expect(stderrOutput).toContain("signer_not_trusted");
    expect(
      beta.runtime.published.filter(
        (e) => e.type === "system.bus.peer-dispatch-received",
      ),
    ).toHaveLength(0);
  });
});
