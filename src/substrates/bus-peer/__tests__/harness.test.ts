/**
 * IAW Phase B.1b (cortex#114) — BusPeerHarness tests.
 *
 * Three coverage axes:
 *   1. Round-trip on a valid chain — verified inbound flows through to the
 *      consumer; the local `started` lifecycle envelope is yielded first.
 *   2. Verification gate — an inbound envelope whose chain fails the
 *      structural check is dropped at the boundary (not yielded) and the
 *      stderr line carries the rejection reason discriminator.
 *   3. Consumer-break — when the iterator is broken before a peer terminal
 *      arrives, the harness unregisters from the runtime fan-out. No
 *      synthetic terminal is yielded (async-generator semantics drop
 *      yields-in-finally after iterator return); the runner records the
 *      abort from its outside view. Matches `ClaudeCodeHarness`'s contract.
 */

import { describe, test, expect } from "bun:test";

import { AgentRegistry } from "../../../common/agents/registry";
import { TrustResolver } from "../../../common/agents/trust-resolver";
import type {
  EnvelopeHandler,
  MyelinRuntime,
} from "../../../bus/myelin/runtime";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { Agent } from "../../../common/types/cortex-config";
import type {
  DispatchRequest,
  MyelinEnvelope,
} from "../../../common/substrates/types";
import { BusPeerHarness } from "../harness";

// =============================================================================
// Fixtures
// =============================================================================

const NKEY_ECHO = "U" + "B".repeat(55);
const NKEY_HOLLY = "U" + "C".repeat(55);

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

/**
 * Minimal MyelinRuntime double — records every publish + lets the test
 * trigger inbound by invoking the registered onEnvelope handlers
 * synchronously. Matches the production runtime's contract: publishes
 * are fire-and-forget; onEnvelope returns an unregister token.
 */
function fakeRuntime() {
  const handlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];

  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope(handler) {
      handlers.add(handler);
      return {
        unregister: () => {
          handlers.delete(handler);
        },
      };
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

  return { runtime, published, deliverInbound, handlers };
}

function dispatchRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    prompt: "do the thing",
    tools: { allow: [], deny: [] },
    context: [],
    agent: { id: "luna", displayName: "Luna" },
    requestId: "00000000-0000-4000-8000-000000000099",
    ...overrides,
  };
}

function inboundEnvelope(opts: {
  correlationId: string;
  type: string;
  signerPrincipal?: string;
}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000aaa",
    source: "metafactory.echo.local",
    type: opts.type,
    timestamp: "2026-05-15T08:30:00.000Z",
    correlation_id: opts.correlationId,
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {},
    ...(opts.signerPrincipal !== undefined && {
      signed_by: {
        method: "ed25519" as const,
        // R11 — stamp DID key is `identity` post-myelin#184.
        identity: opts.signerPrincipal,
        signature: "A".repeat(88),
        at: "2026-05-15T08:30:00.000Z",
      },
    }),
  };
}

const SOURCE = { principal: "metafactory", agent: "cortex", instance: "local" };

// =============================================================================
// Cases
// =============================================================================

describe("BusPeerHarness — round-trip + verification gate", () => {
  test("publishes the request envelope and yields started + verified inbound + peer terminal", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, published, deliverInbound } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest();
    const yielded: MyelinEnvelope[] = [];

    // Drive the iterator. After yielding `started`, deliver an inbound
    // dispatch.task.completed from echo — that's the peer terminal and
    // triggers iterator close.
    const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

    const startedYield = await iterator.next();
    expect(startedYield.done).toBe(false);
    if (!startedYield.done) yielded.push(startedYield.value);

    // Now inject the peer terminal — verified principal echo, trusted by luna.
    deliverInbound(
      inboundEnvelope({
        correlationId: req.requestId,
        type: "dispatch.task.completed",
        signerPrincipal: "did:mf:echo",
      }),
    );

    const terminalYield = await iterator.next();
    expect(terminalYield.done).toBe(false);
    if (!terminalYield.done) yielded.push(terminalYield.value);

    // Iterator should close after the terminal.
    const closeYield = await iterator.next();
    expect(closeYield.done).toBe(true);

    // Outbound envelope: published exactly once.
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("dispatch.task.dispatched");
    expect(published[0]?.correlation_id).toBe(req.requestId);

    // Yielded sequence: started → completed (verified inbound).
    expect(yielded).toHaveLength(2);
    expect(yielded[0]?.type).toBe("dispatch.task.started");
    expect(yielded[1]?.type).toBe("dispatch.task.completed");
  });

  test("drops an inbound envelope whose signer is not in receiver's trust list", async () => {
    // Holly is registered with an NKey but NOT in luna's trust list.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const holly = agentFixture({
      id: "holly",
      displayName: "Holly",
      nkey_pub: NKEY_HOLLY,
    });
    const resolver = resolverWith(luna, echo, holly);
    const { runtime, deliverInbound } = fakeRuntime();

    // Capture stderr to assert the drop is logged with the structured
    // reason (mirrors what the harness writes).
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const harness = new BusPeerHarness({
        runtime,
        resolver,
        receivingAgentId: "luna",
        source: SOURCE,
      });

      const req = dispatchRequest();
      const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

      // Pull `started` first.
      const startedYield = await iterator.next();
      expect(startedYield.done).toBe(false);

      // Holly tries to claim the task — chain signer not trusted.
      deliverInbound(
        inboundEnvelope({
          correlationId: req.requestId,
          type: "dispatch.task.completed",
          signerPrincipal: "did:mf:holly",
        }),
      );

      // The untrusted envelope must be dropped, NOT yielded. Echo's
      // legitimate terminal arrives second; only THIS one should yield.
      deliverInbound(
        inboundEnvelope({
          correlationId: req.requestId,
          type: "dispatch.task.completed",
          signerPrincipal: "did:mf:echo",
        }),
      );

      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        // The yielded envelope's signer must be echo, not holly.
        const signedBy = next.value.signed_by;
        const stamp = Array.isArray(signedBy) ? signedBy[0] : signedBy;
        expect(stamp?.identity).toBe("did:mf:echo");
      }

      const done = await iterator.next();
      expect(done.done).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-peer:luna");
    expect(stderrOutput).toContain("signer_not_trusted");
  });

  test("unregisters the runtime handler when the consumer breaks before peer terminal", async () => {
    // Per the SessionHarness contract (and matching ClaudeCodeHarness),
    // consumer-break does NOT yield a synthetic terminal envelope —
    // async-generator semantics drop yields-in-finally after iterator
    // return. The harness's job on break is to clean up its NATS
    // subscription so the runtime doesn't fan out to a dropped handler.
    // The runner / dispatch-listener observes iterator close and
    // records an aborted lifecycle envelope from its outside view.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, handlers } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest();
    const yielded: MyelinEnvelope[] = [];

    // Consume `started` then break — no peer terminal ever delivered.
    for await (const env of harness.dispatch(req)) {
      yielded.push(env);
      if (env.type === "dispatch.task.started") break;
    }

    // Only `started` should be observable (the break is the iterator's
    // last call) — no synthetic-aborted in the consumer's view.
    expect(yielded).toHaveLength(1);
    expect(yielded[0]?.type).toBe("dispatch.task.started");

    // Critical contract: the runtime handler must be unregistered so
    // future bus traffic doesn't leak to a closed dispatch.
    expect(handlers.size).toBe(0);
  });

  test("preserves arrival order across progress + terminal (Echo cortex#200 race regression)", async () => {
    // Regression for Echo's B.1c finding #1+#2: with the async-IIFE
    // pattern, a later-arriving terminal envelope's verify could
    // resolve BEFORE an earlier progress envelope's verify, dropping
    // the progress from the consumer's view (queue closed before
    // pushInbound ran). Serialisation via the `inFlight` chain pins
    // arrival order — the race is hard to deterministically trigger
    // in a unit test, but this case proves that progress + terminal
    // both reach the consumer in arrival order even when delivered
    // back-to-back into the same chain.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, deliverInbound } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest();
    const yielded: MyelinEnvelope[] = [];

    const iterator = harness.dispatch(req)[Symbol.asyncIterator]();
    const started = await iterator.next();
    if (!started.done) yielded.push(started.value);

    // Deliver progress + terminal back-to-back. The serialised
    // verify chain must push both before close fires, and in arrival
    // order.
    deliverInbound({
      id: "11111111-1111-4111-8111-111111111111",
      source: "metafactory.echo.local",
      type: "dispatch.task.progress",
      timestamp: "2026-05-15T10:30:00.000Z",
      correlation_id: req.requestId,
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 4,
        frontier_ok: false,
        model_class: "any",
      },
      payload: { step: 1 },
      signed_by: {
        method: "ed25519",
        identity: "did:mf:echo",
        signature: "A".repeat(88),
        at: "2026-05-15T10:30:00.000Z",
      },
    });
    deliverInbound(
      inboundEnvelope({
        correlationId: req.requestId,
        type: "dispatch.task.completed",
        signerPrincipal: "did:mf:echo",
      }),
    );

    // Drain the iterator — both envelopes must yield in arrival order
    // (progress first, terminal second), then the iterator closes.
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yielded.push(next.value);
    }

    expect(yielded).toHaveLength(3);
    expect(yielded[0]?.type).toBe("dispatch.task.started");
    expect(yielded[1]?.type).toBe("dispatch.task.progress");
    expect(yielded[2]?.type).toBe("dispatch.task.completed");
  });

  test("ignores envelopes whose correlation_id does not match this dispatch", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, deliverInbound } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest({
      requestId: "00000000-0000-4000-8000-000000000111",
    });
    const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.done).toBe(false);

    // Inject a DIFFERENT-correlation-id envelope — must not yield.
    deliverInbound(
      inboundEnvelope({
        correlationId: "00000000-0000-4000-8000-000000000222",
        type: "dispatch.task.completed",
        signerPrincipal: "did:mf:echo",
      }),
    );

    // Now deliver the actual matching terminal.
    deliverInbound(
      inboundEnvelope({
        correlationId: req.requestId,
        type: "dispatch.task.completed",
        signerPrincipal: "did:mf:echo",
      }),
    );

    const matching = await iterator.next();
    expect(matching.done).toBe(false);
    expect(matching.value?.correlation_id).toBe(req.requestId);

    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  test("dispatch.task.failed terminal closes the iterator (cortex#197 gap 1)", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, deliverInbound } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest();
    const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.done).toBe(false);

    deliverInbound(
      inboundEnvelope({
        correlationId: req.requestId,
        type: "dispatch.task.failed",
        signerPrincipal: "did:mf:echo",
      }),
    );

    const terminal = await iterator.next();
    expect(terminal.done).toBe(false);
    expect(terminal.value?.type).toBe("dispatch.task.failed");

    const closed = await iterator.next();
    expect(closed.done).toBe(true);
  });

  test("dispatch.task.aborted terminal closes the iterator (cortex#197 gap 2)", async () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, deliverInbound } = fakeRuntime();

    const harness = new BusPeerHarness({
      runtime,
      resolver,
      receivingAgentId: "luna",
      source: SOURCE,
    });

    const req = dispatchRequest();
    const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.done).toBe(false);

    deliverInbound(
      inboundEnvelope({
        correlationId: req.requestId,
        type: "dispatch.task.aborted",
        signerPrincipal: "did:mf:echo",
      }),
    );

    const terminal = await iterator.next();
    expect(terminal.done).toBe(false);
    expect(terminal.value?.type).toBe("dispatch.task.aborted");

    const closed = await iterator.next();
    expect(closed.done).toBe(true);
  });

  test("filters own outbound envelope re-delivered by runtime fan-out (cortex#197 gap 3)", async () => {
    // Single-process runtimes can fan out a published envelope back to
    // the same harness's onEnvelope handler. The harness drops these
    // by `envelope.id === requestEnvelope.id` so the consumer never
    // sees its own outbound as inbound. Without this filter, the
    // `started` yield could be followed by a phantom self-yield before
    // any real peer envelope arrives.
    // Capture stderr so we can prove the id-filter (NOT verifySignedByChain's
    // `empty_chain` reject) is what dropped the loop-back. The harness's
    // outbound envelope has no `signed_by` stamp, so a missing id-filter
    // would fall through to verify and log `empty_chain` for the outbound's
    // id. The id-filter returns early BEFORE the verify chain, so the
    // outbound's id must NEVER appear in stderr.
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const luna = agentFixture({ id: "luna", trust: ["echo"] });
      const echo = agentFixture({
        id: "echo",
        displayName: "Echo",
        nkey_pub: NKEY_ECHO,
      });
      const resolver = resolverWith(luna, echo);
      const { runtime, published, deliverInbound } = fakeRuntime();

      const harness = new BusPeerHarness({
        runtime,
        resolver,
        receivingAgentId: "luna",
        source: SOURCE,
      });

      const req = dispatchRequest();
      const yielded: MyelinEnvelope[] = [];

      const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

      const started = await iterator.next();
      expect(started.done).toBe(false);
      if (!started.done) yielded.push(started.value);

      // Loop the harness's own outbound back into its inbound stream —
      // exactly what a single-process runtime does when publish + onEnvelope
      // share fan-out. The id and correlation_id both match this dispatch,
      // so without the self-filter this would be yielded.
      expect(published).toHaveLength(1);
      const ownOutbound = published[0];
      expect(ownOutbound).toBeDefined();
      if (ownOutbound) deliverInbound(ownOutbound);

      // The actual peer terminal arrives next; only this should yield.
      deliverInbound(
        inboundEnvelope({
          correlationId: req.requestId,
          type: "dispatch.task.completed",
          signerPrincipal: "did:mf:echo",
        }),
      );

      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) yielded.push(next.value);

      const closed = await iterator.next();
      expect(closed.done).toBe(true);

      // started → completed; the looped-back outbound must NOT appear.
      expect(yielded).toHaveLength(2);
      expect(yielded[0]?.type).toBe("dispatch.task.started");
      expect(yielded[1]?.type).toBe("dispatch.task.completed");
      // Sanity: the self-filter is by id, so prove the outbound and the
      // terminal don't share an id (otherwise we'd be filtering the wrong
      // envelope).
      expect(yielded[1]?.id).not.toBe(ownOutbound?.id);

      // The discriminating assertion (mutation test): if the id-filter at
      // harness.ts:266 were removed, the unsigned outbound would still be
      // dropped — but by `verifySignedByChain` returning `empty_chain` —
      // and that path writes to stderr referencing the outbound's id.
      // The id-filter short-circuits BEFORE verify, so no stderr line
      // should mention the outbound's id.
      const stderrOutput = stderrLines.join("");
      expect(stderrOutput).not.toContain(ownOutbound?.id ?? "<none>");
      expect(stderrOutput).not.toContain("empty_chain");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("rejects an unsigned inbound envelope (rejectEmpty: true) (cortex#197 gap 4)", async () => {
    // The harness passes `rejectEmpty: true` to verifySignedByChain,
    // so an inbound with no signed_by stamp is rejected at the boundary.
    // The drop must be logged to stderr with `empty_chain` and the
    // consumer must not see the envelope.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);
    const { runtime, deliverInbound } = fakeRuntime();

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const harness = new BusPeerHarness({
        runtime,
        resolver,
        receivingAgentId: "luna",
        source: SOURCE,
      });

      const req = dispatchRequest();
      const iterator = harness.dispatch(req)[Symbol.asyncIterator]();

      const started = await iterator.next();
      expect(started.done).toBe(false);

      // Unsigned inbound matching this correlation — must be dropped.
      // `signerPrincipal` omitted → no signed_by stamp on the envelope.
      deliverInbound(
        inboundEnvelope({
          correlationId: req.requestId,
          type: "dispatch.task.completed",
        }),
      );

      // Legitimate signed terminal from echo must still pass.
      deliverInbound(
        inboundEnvelope({
          correlationId: req.requestId,
          type: "dispatch.task.completed",
          signerPrincipal: "did:mf:echo",
        }),
      );

      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        // Must be the signed envelope, not the unsigned one.
        const signedBy = next.value.signed_by;
        const stamp = Array.isArray(signedBy) ? signedBy[0] : signedBy;
        expect(stamp?.identity).toBe("did:mf:echo");
      }

      const closed = await iterator.next();
      expect(closed.done).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("bus-peer:luna");
    expect(stderrOutput).toContain("empty_chain");
  });
});
