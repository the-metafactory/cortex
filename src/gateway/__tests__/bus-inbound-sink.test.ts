/**
 * GW.a.3a — BusInboundSink tests (cortex#524, TDD Red→Green).
 *
 * Tests cover:
 *
 *   1. Routable decision → publishFn called once with correctly-mapped opts
 *      (stack / agentName / agentDisplayName / principal / prompt / msg)
 *   2. allowedDirs is always an empty array
 *   3. fail-closed Skill deny: disallowedTools === ["Skill"]
 *   4. taskId is non-empty on each call
 *   5. taskId is unique across two calls (crypto.randomUUID — no collision)
 *   6. Optional opts (resumeSessionId, channel, network, timeoutMs,
 *      cwd, additionalArgs, project, entity) are all undefined
 *   7. { published: false, reason: "invalid-originator" } → logged to stderr,
 *      no throw
 *   8. { published: false, reason: "missing-runtime" } → logged to stderr
 *   9. runtime: undefined → publishFn still called (publisher handles it)
 *  10. publishFn rejection propagates to the gateway's outer catch (sink is not the firewall)
 */

import { describe, expect, test } from "bun:test";
import { BusInboundSink, type BusInboundSinkDeps } from "../bus-inbound-sink";
import type { GatewayInboundDecision } from "../surface-gateway";
import type { InboundMessage } from "../../adapters/types";
import type { InboundChatDispatchPublishOpts, DispatchSourcePublishResult } from "../../bus/dispatch-source-publisher";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { PolicyEngine } from "../../common/policy/engine";
import type { SystemEventSource } from "../../bus/system-events";
import type { Envelope } from "../../bus/myelin/envelope-validator";

// =============================================================================
// Fixtures
// =============================================================================

/** Minimal stub — only the interface shape matters for these tests. */
const STUB_RUNTIME = {} as MyelinRuntime;

/** Stub policy engine — no lookups performed in the sink itself. */
const STUB_POLICY_ENGINE = {} as PolicyEngine;

/** Stub source identity. */
const STUB_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "gateway",
  instance: "gateway-0",
  dataResidency: "NZ",
};

/** Canonical routable inbound message fixture. */
function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "discord:111222333",
    authorId: "user-discord-12345",
    authorName: "TestUser",
    channelId: "channel-aaa",
    content: "Hello, Luna!",
    guildId: "111222333",
    attachments: [],
    timestamp: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

/** Routing decision fixture — Discord, stack present. */
function makeDecision(
  overrides: Partial<GatewayInboundDecision> = {},
): GatewayInboundDecision {
  return {
    match: {
      platform: "discord",
      agent: "luna",
      principal: "andreas",
      stack: "meta-factory",
      instance: "discord:111222333",
    },
    responseRouting: {
      adapter_instance: "discord:111222333",
      channel_id: "channel-aaa",
    },
    ...overrides,
  };
}

/** Build a sink with a capturing publishFn that records calls and returns success. */
function makeSink(
  publishResults: DispatchSourcePublishResult[] = [],
  depsOverrides: Partial<BusInboundSinkDeps> = {},
): {
  sink: BusInboundSink;
  calls: InboundChatDispatchPublishOpts[];
} {
  const calls: InboundChatDispatchPublishOpts[] = [];
  let callIndex = 0;

  const publishFn = async (
    opts: InboundChatDispatchPublishOpts,
  ): Promise<DispatchSourcePublishResult> => {
    calls.push(opts);
    const result = publishResults[callIndex] ?? { published: true, subject: "local.andreas.meta-factory.tasks.@luna.chat" };
    callIndex++;
    return result;
  };

  const sink = new BusInboundSink({
    runtime: STUB_RUNTIME,
    source: STUB_SOURCE,
    policyEngine: STUB_POLICY_ENGINE,
    publishFn,
    ...depsOverrides,
  });

  return { sink, calls };
}

// =============================================================================
// Tests
// =============================================================================

describe("BusInboundSink", () => {
  // ── Test 1: correct opts mapping ────────────────────────────────────────────

  test("routable decision → publishFn called once with correctly-mapped opts", async () => {
    const { sink, calls } = makeSink();
    const msg = makeMsg({ content: "Ping!" });
    const decision = makeDecision();

    await sink.publish(decision, msg);

    expect(calls).toHaveLength(1);
    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");

    // Stack, agent, principal from decision.match
    expect(opts.stack).toBe("meta-factory");
    expect(opts.agentName).toBe("luna");
    expect(opts.agentDisplayName).toBe("luna"); // placeholder — agent id used (documented gap)
    expect(opts.principal).toBe("andreas");

    // prompt = msg.content (raw inbound text)
    expect(opts.prompt).toBe("Ping!");

    // msg is passed through verbatim
    expect(opts.msg).toBe(msg);

    // deps passed through
    expect(opts.runtime).toBe(STUB_RUNTIME);
    expect(opts.source).toBe(STUB_SOURCE);
    expect(opts.policyEngine).toBe(STUB_POLICY_ENGINE);
  });

  // ── Test 2: allowedDirs always empty ────────────────────────────────────────

  test("allowedDirs is always an empty array", async () => {
    const { sink, calls } = makeSink();
    await sink.publish(makeDecision(), makeMsg());
    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");

    expect(opts.allowedDirs).toEqual([]);
  });

  // ── Test 3: fail-closed Skill deny on the gateway path (cortex#701) ──────────
  //
  // Regression for the gateway-path fail-open hole: the gateway publishes to
  // the bound stack's runner subscription, which is consumed by the harness
  // — NOT by dispatch-handler — so the skill gate never runs there. If the
  // gateway emitted an empty deny list, the spawned session would have the
  // `Skill` tool AVAILABLE BY DEFAULT (verified, CLI 2.1.158). The gateway
  // must therefore emit the bare `Skill` deny itself and grant nothing.
  // Per-skill grants on this path are the cortex#701 Part B follow-up.

  test("emits the bare Skill deny (fail-closed, grants nothing)", async () => {
    const { sink, calls } = makeSink();
    await sink.publish(makeDecision(), makeMsg());
    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");

    // Fail-closed: the bare `Skill` tool is denied so no installed skill is
    // reachable via the gateway-mediated runner path.
    expect(opts.disallowedTools).toEqual(["Skill"]);
  });

  // ── Test 4: taskId is non-empty ──────────────────────────────────────────────

  test("taskId is non-empty on each call", async () => {
    const { sink, calls } = makeSink();
    await sink.publish(makeDecision(), makeMsg());
    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");

    expect(opts.taskId).toBeTruthy();
    expect(typeof opts.taskId).toBe("string");
    expect(opts.taskId.length).toBeGreaterThan(0);
  });

  // ── Test 5: taskId is unique across two calls ────────────────────────────────

  test("taskId is unique across two calls", async () => {
    const { sink, calls } = makeSink([
      { published: true, subject: "s1" },
      { published: true, subject: "s2" },
    ]);

    await sink.publish(makeDecision(), makeMsg());
    await sink.publish(makeDecision(), makeMsg());

    expect(calls).toHaveLength(2);
    expect(calls[0]?.taskId).not.toBe(calls[1]?.taskId);
  });

  // ── Test 6: optional opts are all undefined ──────────────────────────────────

  test("optional opts are all undefined", async () => {
    const { sink, calls } = makeSink();
    await sink.publish(makeDecision(), makeMsg());

    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");

    expect(opts.resumeSessionId).toBeUndefined();
    expect(opts.channel).toBeUndefined();
    expect(opts.network).toBeUndefined();
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.cwd).toBeUndefined();
    expect(opts.additionalArgs).toBeUndefined();
    expect(opts.project).toBeUndefined();
    expect(opts.entity).toBeUndefined();
  });

  // ── Test 7: { published: false, reason: "invalid-originator" } → stderr, no throw

  test("{ published: false, reason: 'invalid-originator' } → logged to stderr, no throw", async () => {
    const { sink } = makeSink([
      { published: false, reason: "invalid-originator", subject: "local.andreas.meta-factory.tasks.@luna.chat" },
    ]);

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr output for this test
    process.stderr.write = (data: string | Uint8Array) => {
      if (typeof data === "string") stderrLines.push(data);
      return true;
    };

    try {
      // Must not throw
      await expect(sink.publish(makeDecision(), makeMsg())).resolves.toBeUndefined();
    } finally {
      process.stderr.write = originalWrite;
    }

    // Must have logged to stderr
    expect(stderrLines.length).toBeGreaterThan(0);
    const combined = stderrLines.join("");
    expect(combined).toContain("bus-inbound-sink");
    expect(combined).toContain("invalid-originator");
    expect(combined).toContain("luna"); // agent name
  });

  // ── Test 8: { published: false, reason: "missing-runtime" } → stderr ────────

  test("{ published: false, reason: 'missing-runtime' } → logged to stderr", async () => {
    const { sink } = makeSink([
      { published: false, reason: "missing-runtime" },
    ]);

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => {
      if (typeof data === "string") stderrLines.push(data);
      return true;
    };

    try {
      await expect(sink.publish(makeDecision(), makeMsg())).resolves.toBeUndefined();
    } finally {
      process.stderr.write = originalWrite;
    }

    const combined = stderrLines.join("");
    expect(combined).toContain("missing-runtime");
  });

  // ── Test 9: runtime: undefined → publishFn still called ──────────────────────

  test("runtime: undefined still maps opts (publisher handles missing-runtime)", async () => {
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => {
      if (typeof data === "string") stderrLines.push(data);
      return true;
    };

    const calls: InboundChatDispatchPublishOpts[] = [];
    const sink = new BusInboundSink({
      runtime: undefined,
      source: STUB_SOURCE,
      policyEngine: STUB_POLICY_ENGINE,
      publishFn: async (opts) => {
        calls.push(opts);
        return { published: false, reason: "missing-runtime" };
      },
    });

    try {
      await expect(sink.publish(makeDecision(), makeMsg())).resolves.toBeUndefined();
    } finally {
      process.stderr.write = originalWrite;
    }

    // publishFn was still called — opts mapping is unconditional
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runtime).toBeUndefined();

    // And the refusal was logged
    const combined = stderrLines.join("");
    expect(combined).toContain("missing-runtime");
  });

  // ── Test 10: publishFn rejects → no throw (safety net) ───────────────────────

  test("publishFn rejection propagates to the gateway's outer catch — sink is not the firewall", async () => {
    // The sink deliberately does NOT catch publishFn throws. It lets them
    // propagate to SurfaceGateway.handleInbound's outer try/catch, which IS the
    // adapter-loop firewall (see surface-gateway.ts). Keeping the firewall in one
    // place (the gateway) avoids a redundant second catch here. This test pins
    // that boundary: an unexpected publisher throw surfaces as a rejection.
    const sink = new BusInboundSink({
      runtime: STUB_RUNTIME,
      source: STUB_SOURCE,
      policyEngine: STUB_POLICY_ENGINE,
      publishFn: async () => {
        throw new Error("NATS connection lost");
      },
    });

    await expect(sink.publish(makeDecision(), makeMsg())).rejects.toThrow(
      "NATS connection lost",
    );
  });

  // ── Test 11: stack optional (undefined) → mapped as undefined ──────────────

  test("decision.match with no stack → stack mapped as undefined in opts", async () => {
    const { sink, calls } = makeSink();
    const decision = makeDecision();
    // Override to remove stack (gap 4 in binding-resolver)
    decision.match = {
      ...decision.match,
      stack: undefined,
      principal: undefined,
    };

    await sink.publish(decision, makeMsg());

    expect(calls[0]?.stack).toBeUndefined();
    expect(calls[0]?.principal).toBeUndefined();
  });

  // ── Test 12: msg with threadId → passed through intact ───────────────────────

  test("msg with threadId passed through intact to publishFn", async () => {
    const { sink, calls } = makeSink();
    const msg = makeMsg({ threadId: "thread-xyz-789" });

    await sink.publish(makeDecision(), msg);

    expect(calls[0]?.msg.threadId).toBe("thread-xyz-789");
  });

  // ── Test 13 (F-1b, cortex#651): subjectPrincipal = match.principal ───────────
  //
  // The gateway serves MULTIPLE principals on one shared bus. The inbound
  // request SUBJECT must be derived from the BINDING's parsed principal so a
  // cross-principal binding lands on the BOUND stack's runner subscription
  // (`local.{bindingPrincipal}.{stack}.tasks.*`), not the gateway principal.
  // The sink threads `match.principal` into the OPT-IN `subjectPrincipal` field;
  // the publisher derives the subject from it (fallback: source.principal).

  test("cross-principal binding → subjectPrincipal = match.principal (differs from gateway principal)", async () => {
    const { sink, calls } = makeSink();
    // STUB_SOURCE.principal is "andreas" (the gateway principal). The binding's
    // parsed principal is "holly" → a CROSS-principal binding.
    const decision = makeDecision({
      match: {
        platform: "discord",
        agent: "luna",
        principal: "holly",
        stack: "research",
        instance: "discord:111222333",
      },
    });

    await sink.publish(decision, makeMsg());

    const opts = calls[0];
    if (opts === undefined) throw new Error("expected publishFn to have been called");
    // The routing principal for the subject is the BINDING principal, not the gateway.
    expect(opts.subjectPrincipal).toBe("holly");
    // The payload `principal` field carries the same binding principal (F-1 behaviour).
    expect(opts.principal).toBe("holly");
  });

  test("same-principal binding → subjectPrincipal = match.principal (equals gateway principal)", async () => {
    const { sink, calls } = makeSink();
    // Default decision: match.principal === "andreas" === gateway principal.
    await sink.publish(makeDecision(), makeMsg());

    expect(calls[0]?.subjectPrincipal).toBe("andreas");
  });

  test("gap-4 binding (no principal) → subjectPrincipal undefined → publisher falls back to gateway principal", async () => {
    const { sink, calls } = makeSink();
    const decision = makeDecision();
    decision.match = {
      ...decision.match,
      stack: undefined,
      principal: undefined,
    };

    await sink.publish(decision, makeMsg());

    // undefined threads through; the publisher's `?? source.principal` yields
    // the gateway principal — the intended gap-4 default.
    expect(calls[0]?.subjectPrincipal).toBeUndefined();
  });

  // ── cortex#596: system.gateway.routing-decision bus events ──────────────────
  //
  // The sink emits a structured routing-decision event on both branches so
  // signal + Mission Control observe the gateway's demux decision instead of
  // tailing stdout. Emission is fire-and-forget via `runtime.publish` and
  // guarded on the optional runtime/source deps.

  /** Runtime stub that captures every published envelope. */
  function makeCapturingRuntime(): {
    runtime: MyelinRuntime;
    published: Envelope[];
  } {
    const published: Envelope[] = [];
    const runtime = {
      publish: (env: Envelope): Promise<void> => {
        published.push(env);
        return Promise.resolve();
      },
    } as unknown as MyelinRuntime;
    return { runtime, published };
  }

  test("routed publish → emits system.gateway.routing-decision { outcome: routed, stack, subject }", async () => {
    const { runtime, published } = makeCapturingRuntime();
    const { sink } = makeSink(
      [{ published: true, subject: "local.andreas.meta-factory.tasks.@luna.chat" }],
      { runtime },
    );

    await sink.publish(makeDecision(), makeMsg());

    const evt = published.find(
      (e) => e.type === "system.gateway.routing-decision",
    );
    expect(evt).toBeDefined();
    const payload = evt!.payload;
    expect(payload.outcome).toBe("routed");
    expect(payload.platform).toBe("discord");
    expect(payload.agent).toBe("luna");
    expect(payload.stack).toBe("meta-factory");
    expect(payload.principal).toBe("andreas");
    expect(payload.subject).toBe("local.andreas.meta-factory.tasks.@luna.chat");
    // No refusal reason on the routed branch.
    expect(payload.reason).toBeUndefined();
  });

  test("refused publish → emits system.gateway.routing-decision { outcome: unroutable, reason }", async () => {
    const { runtime, published } = makeCapturingRuntime();
    // Silence the expected stderr refusal breadcrumb.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    const { sink } = makeSink(
      [
        {
          published: false,
          reason: "invalid-originator",
          subject: "local.andreas.meta-factory.tasks.@luna.chat",
        },
      ],
      { runtime },
    );

    try {
      await sink.publish(makeDecision(), makeMsg());
    } finally {
      process.stderr.write = originalWrite;
    }

    const evt = published.find(
      (e) => e.type === "system.gateway.routing-decision",
    );
    expect(evt).toBeDefined();
    const payload = evt!.payload;
    expect(payload.outcome).toBe("unroutable");
    expect(payload.reason).toBe("invalid-originator");
    expect(payload.agent).toBe("luna");
    expect(payload.platform).toBe("discord");
  });

  test("source undefined → routing-decision emit is skipped (optional-dep guard, no throw)", async () => {
    const { runtime, published } = makeCapturingRuntime();
    const { sink } = makeSink([{ published: true, subject: "s" }], {
      runtime,
      source: undefined,
    });

    await expect(sink.publish(makeDecision(), makeMsg())).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  test("runtime without publish (stub) → routing-decision emit is skipped, no throw", async () => {
    // STUB_RUNTIME is `{}` — `typeof runtime.publish !== "function"` must
    // short-circuit the emit rather than throwing inside the sink.
    const { sink } = makeSink([{ published: true, subject: "s" }]);
    await expect(sink.publish(makeDecision(), makeMsg())).resolves.toBeUndefined();
  });
});
