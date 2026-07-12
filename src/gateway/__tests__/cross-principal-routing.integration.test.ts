/**
 * F-2 (TC-F2, cortex#630) — cross-principal collaboration, end-to-end.
 *
 * The HEADLINE PROOF for the federation-routing track: two principals
 * collaborating through ONE shared surface gateway on ONE bus, UNSIGNED.
 *
 * F-1 (#629) relaxed the single-principal guard and added multi-principal
 * subject derivation (outbound reply leg). F-1b (#651) completed the inbound
 * request leg (`subjectPrincipal`). F-2 adds NO new routing code — it stands up
 * the real wiring (`startGatewayIfEnabled` → `BusInboundSink` inbound +
 * `createDispatchSink` outbound) against a capturing mock runtime and proves
 * the cross-principal flow behaves end-to-end:
 *
 *   1. An inbound message on principal-A's binding (`andreas/research`)
 *      publishes on principal-A's OWN subject
 *      (`local.andreas.research.tasks.@…luna.chat`) — NOT the gateway principal.
 *   2. An inbound message on principal-B's binding (`joel/production`)
 *      publishes on principal-B's OWN subject
 *      (`local.joel.production.tasks.@…sage.chat`).
 *   3. The OUTBOUND dispatch sink subscribes to BOTH principals' lifecycle
 *      subjects (derived from F-1's `principalStacks`), and routes a
 *      `dispatch.task.completed` reply for EACH back to the correct adapter
 *      instance — no cross-posting between principals.
 *   4. Cross-principal bindings start with a WARN (not a throw) — the F-1
 *      relaxation of the a.3d single-principal hard guard.
 *
 * The gateway principal is `andreas`; `joel/production` is the cross-principal
 * binding. Everything runs with signing OFF (the gateway publishes
 * originator-stamped + unsigned on the intra-/cross-principal hop — dev/trusted
 * only; see CONTEXT.md §Dispatch-source + the UNSIGNED warning in
 * start-gateway.ts).
 *
 * No reinvention: real `BusInboundSink` + `createDispatchSink`, the real
 * `SurfaceGateway`, real `MockAdapter`s (capturing onMessage + postResponse),
 * and the real `publishInboundChatDispatchEnvelope` publisher — only the NATS
 * runtime and the policy engine are faked (one capturing object each).
 */

import { describe, expect, test } from "bun:test";
import { BusInboundSink } from "../bus-inbound-sink";
import { startGatewayWithPlan } from "./start-gateway-test-helper";
import { createDispatchSink } from "../../adapters/dispatch-sink";
import { MockAdapter } from "../../adapters/mock";
import type { GatewayAdapterFactory } from "../gateway-adapters";
import type { PlatformAdapter, InboundMessage } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import type { SystemEventSource } from "../../bus/system-events";
import type { PolicyEngine } from "../../common/policy/engine";

// =============================================================================
// Fakes — one capturing runtime + one resolving policy engine. Everything else
// (gateway, sinks, adapters, publisher) is the real production code.
// =============================================================================

/**
 * Capturing mock runtime. Records inbound publishes (`publishOnSubject` →
 * `{ subject, envelope }`) AND outbound subscribes (`subscribe` → pattern), and
 * lets a test fan an envelope through every registered `onEnvelope` handler
 * (the outbound dispatch-sink delivery path). Mirrors the recordingRuntime in
 * dispatch-sink.test.ts, extended with `publishOnSubject` for the inbound leg.
 */
function makeCapturingRuntime(): {
  runtime: MyelinRuntime;
  published: { subject: string; envelope: Envelope }[];
  subscribedPatterns: string[];
  fan: (env: Envelope) => void;
} {
  const handlers = new Set<EnvelopeHandler>();
  const published: { subject: string; envelope: Envelope }[] = [];
  const subscribedPatterns: string[] = [];

  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope: (handler: EnvelopeHandler) => {
      handlers.add(handler);
      return { unregister: () => { handlers.delete(handler); } };
    },
    publish: async () => {},
    publishOnSubject: async (envelope: Envelope, subject: string) => {
      published.push({ subject, envelope });
    },
    subscribe: async (pattern: string) => {
      subscribedPatterns.push(pattern);
      return { stop: async () => {} } as unknown as MyelinSubscriber;
    },
    stop: async () => {},
  };

  return {
    runtime,
    published,
    subscribedPatterns,
    fan: (env) => {
      // onEnvelope fan-out hands (envelope, subject); the dispatch sink filters
      // by envelope.type, so the subject string here is informational.
      for (const h of handlers) h(env, "local.x.dispatch.task.completed");
    },
  };
}

/**
 * Fake policy engine resolving the two test authors to registered principal ids
 * so the inbound publisher does NOT refuse with `invalid-originator`. Only the
 * one method the publisher calls (`lookupPrincipalIdByPlatformId`) is
 * implemented; the rest of `PolicyEngine` is unused here.
 */
function makeResolvingPolicyEngine(
  map: Record<string, string>,
): PolicyEngine {
  return {
    lookupPrincipalIdByPlatformId: (_platform: string, authorId: string) =>
      map[authorId],
  } as unknown as PolicyEngine;
}

/** The gateway's own dispatch-source identity (gateway principal = "andreas"). */
const GATEWAY_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "gateway",
  instance: "gateway-0",
  dataResidency: "NZ",
};

/**
 * Adapter factory that returns a real {@link MockAdapter} per binding, keyed to
 * the gateway's interim instance id (`discord:{guildId}`), and records each
 * adapter so the test can drive inbound (`simulateMessage`) and assert outbound
 * (`sentMessages`). The gateway demuxes on the inbound message's own
 * `platform`/`guildId`, NOT on the adapter's `platform`, so a MockAdapter is a
 * faithful stand-in for the real Discord adapter on the routing path.
 */
function makeMockAdapterFactory(): {
  factory: GatewayAdapterFactory;
  byInstance: Map<string, MockAdapter>;
} {
  const byInstance = new Map<string, MockAdapter>();
  const build = (instanceId: string): PlatformAdapter => {
    const a = new MockAdapter(instanceId);
    byInstance.set(instanceId, a);
    return a;
  };
  const factory: GatewayAdapterFactory = {
    discord: (args) => build(args.instanceId),
    slack: (args) => build(args.instanceId),
    mattermost: (args) => build(args.instanceId),
  };
  return { factory, byInstance };
}

/**
 * Two principals on ONE gateway/bus:
 *   - andreas/research  (the gateway principal — intra-principal)
 *   - joel/production   (a SECOND principal — cross-principal, UNSIGNED)
 * Each is a Discord binding with a distinct guildId → distinct adapter instance.
 */
const TWO_PRINCIPAL_SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/research",
      binding: {
        token: "tok-andreas-research",
        guildId: "111111111111111111",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
    {
      agent: "sage",
      stack: "joel/production",
      binding: {
        token: "tok-joel-production",
        guildId: "222222222222222222",
        agentChannelId: "ccc000000000000003",
        logChannelId: "ddd000000000000004",
      },
    },
  ],
};

const INSTANCE_A = "discord:111111111111111111"; // andreas/research
const INSTANCE_B = "discord:222222222222222222"; // joel/production

/** Inbound message fixture for a given guild/instance/author. */
function inbound(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "discord",
    instanceId: INSTANCE_A,
    authorId: "author-default",
    authorName: "Tester",
    channelId: "chan-1",
    content: "hello",
    guildId: "111111111111111111",
    attachments: [],
    timestamp: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  };
}

/** A `dispatch.task.completed` lifecycle envelope echoing a response routing. */
// cortex#987 — unique id per fixture envelope: the dispatch sink dedupes
// renders by `envelope.id`, so a shared hardcoded id would make distinct
// replies look like duplicate deliveries of one envelope.
let completedSeq = 0;
function completedEnvelope(routing: {
  adapter_instance: string;
  channel_id: string;
  thread_id?: string;
}, chatResponse: string): Envelope {
  completedSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(completedSeq).padStart(10, "0")}aa`,
    source: "any.runner.local",
    type: "dispatch.task.completed",
    timestamp: "2026-06-03T00:01:00Z",
    correlation_id: "task-xyz",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {
      agent_id: "agent",
      chat_response: chatResponse,
      response_routing: routing,
    },
  };
}

/** Let queued microtasks (the sink's fire-and-forget `deliver`) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// =============================================================================
// The end-to-end proof
// =============================================================================

describe("F-2 — cross-principal collaboration through one gateway (unsigned)", () => {
  test("inbound on each principal's binding publishes on THAT principal's subject; outbound replies route back per-principal without cross-posting", async () => {
    const { runtime, published, subscribedPatterns, fan } = makeCapturingRuntime();
    const { factory, byInstance } = makeMockAdapterFactory();
    const policyEngine = makeResolvingPolicyEngine({
      "author-andreas": "andreas",
      "author-joel": "joel",
    });

    // ── Stand up the gateway LIVE (both opt-in flags) over two principals. ────
    // Capture stderr to assert the F-1 cross-principal WARN fired (not a throw).
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderr: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    let started;
    try {
      started = await startGatewayWithPlan({
        env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "1" },
        surfaces: TWO_PRINCIPAL_SURFACES,
        principal: "andreas", // gateway principal; joel is cross-principal
        runtime,
        source: GATEWAY_SOURCE,
        policyEngine,
        factory,
      });
    } finally {
      process.stderr.write = origWrite;
    }

    if (started === undefined) throw new Error("expected the gateway to start");

    // ── (4) Cross-principal binding WARNED (not threw) — the F-1 relaxation. ──
    const warning = stderr.join("");
    expect(warning).toMatch(/cross-principal/i);
    expect(warning).toMatch(/UNSIGNED/);
    expect(warning).toMatch(/joel\/production/);

    // LIVE: the double-opt-in selected the bus-publishing inbound sink.
    expect(started.gateway.inboundSink).toBeInstanceOf(BusInboundSink);

    // F-1: the started gateway exposes BOTH principals' (principal, stack) pairs,
    // each carrying its OWN parsed principal (joel NOT absorbed into andreas).
    expect(started.principalStacks).toEqual([
      { principal: "andreas", stack: "research" },
      { principal: "joel", stack: "production" },
    ]);

    // ── Wire the OUTBOUND dispatch sink over BOTH principals (F-1 subjects). ──
    const dispatchSink = createDispatchSink({
      runtime,
      adapters: started.adapters,
      principal: "andreas",
      principalStacks: started.principalStacks,
    });
    await dispatchSink.start();

    // (3a) The sink subscribes to BOTH principals' lifecycle subjects — each on
    // its OWN principal namespace, no collapse onto the gateway principal.
    expect(subscribedPatterns).toContain("local.andreas.research.dispatch.task.>");
    expect(subscribedPatterns).toContain("local.joel.production.dispatch.task.>");
    expect(subscribedPatterns).toHaveLength(2);

    // ── INBOUND leg: drive a message on EACH principal's binding. ─────────────
    const adapterA = byInstance.get(INSTANCE_A);
    const adapterB = byInstance.get(INSTANCE_B);
    if (adapterA === undefined || adapterB === undefined) {
      throw new Error("expected both gateway adapters to be constructed");
    }

    // Principal A (andreas/research) — guild 111…, author resolves to "andreas".
    await adapterA.simulateMessage(
      inbound({
        instanceId: INSTANCE_A,
        guildId: "111111111111111111",
        authorId: "author-andreas",
        channelId: "chan-A",
        content: "research please",
      }),
    );

    // Principal B (joel/production) — guild 222…, author resolves to "joel".
    await adapterB.simulateMessage(
      inbound({
        instanceId: INSTANCE_B,
        guildId: "222222222222222222",
        authorId: "author-joel",
        channelId: "chan-B",
        content: "ship it",
      }),
    );

    // (1)+(2) Two publishes, each on ITS OWN principal's subject. The agent DID
    // is encoded into the subject token (`@did-mf-{agent}`) by myelin's
    // directTaskSubject; assert the principal/stack prefix + chat suffix.
    expect(published).toHaveLength(2);

    const subjectA = published.find((p) =>
      p.subject.startsWith("local.andreas.research.tasks."),
    );
    const subjectB = published.find((p) =>
      p.subject.startsWith("local.joel.production.tasks."),
    );

    // (1) Principal A landed on andreas/research — NOT the gateway principal
    // alone, NOT joel.
    expect(subjectA).toBeDefined();
    expect(subjectA!.subject).toBe(
      "local.andreas.research.tasks.@did-mf-luna.chat",
    );
    // (2) Principal B landed on joel/production — the CROSS-principal subject,
    // on joel's namespace, not andreas's.
    expect(subjectB).toBeDefined();
    expect(subjectB!.subject).toBe(
      "local.joel.production.tasks.@did-mf-sage.chat",
    );

    // Sanity: no inbound publish leaked onto the OTHER principal's namespace.
    expect(
      published.some((p) => p.subject.startsWith("local.andreas.production.")),
    ).toBe(false);
    expect(
      published.some((p) => p.subject.startsWith("local.joel.research.")),
    ).toBe(false);

    // ── OUTBOUND leg: fan a completed reply for EACH principal's instance. ────
    // Principal A's runner replies, routed to instance A.
    fan(
      completedEnvelope(
        { adapter_instance: INSTANCE_A, channel_id: "chan-A" },
        "Research answer for andreas.",
      ),
    );
    // Principal B's runner replies, routed to instance B.
    fan(
      completedEnvelope(
        { adapter_instance: INSTANCE_B, channel_id: "chan-B" },
        "Production answer for joel.",
      ),
    );
    await flush();

    // (3b) Each reply posted to the CORRECT adapter instance — no cross-posting.
    expect(adapterA.sentMessages).toHaveLength(1);
    expect(adapterA.sentMessages[0]!.text).toBe("Research answer for andreas.");
    expect(adapterA.sentMessages[0]!.target).toEqual({
      instanceId: INSTANCE_A,
      channelId: "chan-A",
    });

    expect(adapterB.sentMessages).toHaveLength(1);
    expect(adapterB.sentMessages[0]!.text).toBe("Production answer for joel.");
    expect(adapterB.sentMessages[0]!.target).toEqual({
      instanceId: INSTANCE_B,
      channelId: "chan-B",
    });

    // The adapter_instance filter is the sole delivery gate: principal A's
    // adapter never saw principal B's reply and vice-versa.
    expect(
      adapterA.sentMessages.some((m) => m.text.includes("joel")),
    ).toBe(false);
    expect(
      adapterB.sentMessages.some((m) => m.text.includes("andreas")),
    ).toBe(false);

    await dispatchSink.stop();
    await started.gateway.stop();
  });

  test("a reply routed to an unknown instance is dropped (no cross-principal leak to either adapter)", async () => {
    const { runtime, fan } = makeCapturingRuntime();
    const { factory, byInstance } = makeMockAdapterFactory();
    const policyEngine = makeResolvingPolicyEngine({ "author-x": "andreas" });

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => true; // mute the F-1 cross-principal WARN
    let started;
    try {
      started = await startGatewayWithPlan({
        env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "1" },
        surfaces: TWO_PRINCIPAL_SURFACES,
        principal: "andreas",
        runtime,
        source: GATEWAY_SOURCE,
        policyEngine,
        factory,
      });
    } finally {
      process.stderr.write = origWrite;
    }
    if (started === undefined) throw new Error("expected the gateway to start");

    const dispatchSink = createDispatchSink({
      runtime,
      adapters: started.adapters,
      principal: "andreas",
      principalStacks: started.principalStacks,
    });
    await dispatchSink.start();

    // A reply addressed to an instance NEITHER principal owns.
    fan(
      completedEnvelope(
        { adapter_instance: "discord:999999999999999999", channel_id: "ghost" },
        "should reach nobody",
      ),
    );
    await flush();

    for (const a of byInstance.values()) {
      expect(a.sentMessages).toHaveLength(0);
    }

    await dispatchSink.stop();
    await started.gateway.stop();
  });
});
