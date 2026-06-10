/**
 * G-1114.B.3 — runtime agent-presence registry (subscriber) tests.
 *
 * Coverage axes:
 *   1. Fold — a scripted online/heartbeat/offline/capabilities-changed stream
 *      produces the correct snapshot via `getAgents()`.
 *   2. Heartbeat-before-online — an unknown agent's heartbeat upserts it online.
 *   3. Change seam — `onChange` fires after each mutation with the new record.
 *   4. Malformed payload — dropped (not thrown), snapshot unchanged.
 *   5. Boundary — B records `lastHeartbeatAt` but NEVER times anything out
 *      (no TTL/FSM; Phase C).
 *   6. Wiring — `startAgentPresenceRegistry` self-subscribes + filters by
 *      subject; dormant when the runtime can't subscribe; `stop()` idempotent.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  AgentPresenceRegistry,
  agentPresenceSubject,
  startAgentPresenceRegistry,
} from "../registry";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  createAgentCapabilitiesChangedEvent,
  type AgentPresenceSource,
} from "../builders";
import type { Envelope } from "../../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../../myelin/runtime";
import type { MyelinSubscriber } from "../../myelin/subscriber";

const SOURCE: AgentPresenceSource = {
  principal: "andreas",
  stack: "meta-factory",
  instance: "local",
};
const IDENTITY = {
  nkey_public_key: "UABC1234567890",
  agent_id: "luna",
  assistant_name: "Luna",
};
const SCOPE = { principal: "andreas", stack: "meta-factory" };

function online(caps: string[] = ["code-review.typescript"]): Envelope {
  return createAgentOnlineEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    capabilities: caps,
    startedAt: new Date("2026-06-10T09:00:00.000Z"),
  });
}
function heartbeat(): Envelope {
  return createAgentHeartbeatEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    sentAt: new Date("2026-06-10T09:05:00.000Z"),
  });
}
function offline(): Envelope {
  return createAgentOfflineEvent({
    source: SOURCE,
    identity: IDENTITY,
    scope: SCOPE,
    reason: "shutdown",
    sentAt: new Date("2026-06-10T09:10:00.000Z"),
  });
}

describe("AgentPresenceRegistry.apply", () => {
  test("online → record present, online, capabilities + startedAt stored", () => {
    let clock = 1000;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 2000;
    reg.apply(online(["code-review.typescript", "research"]));
    const agents = reg.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0]).toMatchObject({
      key: "andreas/meta-factory/luna",
      agentId: "luna",
      nkeyPublicKey: "UABC1234567890",
      assistantName: "Luna",
      principal: "andreas",
      stack: "meta-factory",
      capabilities: ["code-review.typescript", "research"],
      state: "online",
      startedAt: "2026-06-10T09:00:00.000Z",
      lastSeenAt: 2000,
    });
  });

  test("scripted online→heartbeat→offline yields the correct final snapshot", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online());
    clock = 200;
    reg.apply(heartbeat());
    clock = 300;
    reg.apply(offline());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("offline");
    expect(rec?.offlineReason).toBe("shutdown");
    // heartbeat was recorded along the way and survives the offline.
    expect(rec?.lastHeartbeatAt).toBe(200);
    expect(rec?.lastSeenAt).toBe(300);
  });

  test("heartbeat bumps lastHeartbeatAt without losing capabilities", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online(["research"]));
    clock = 250;
    reg.apply(heartbeat());
    const [rec] = reg.getAgents();
    expect(rec?.capabilities).toEqual(["research"]);
    expect(rec?.lastHeartbeatAt).toBe(250);
    expect(rec?.state).toBe("online");
  });

  test("heartbeat for an UNKNOWN agent upserts it online (liveness signal)", () => {
    const clock = 500;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    reg.apply(heartbeat());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("online");
    expect(rec?.agentId).toBe("luna");
    expect(rec?.capabilities).toEqual([]);
    expect(rec?.lastHeartbeatAt).toBe(500);
  });

  test("online after offline clears the offline reason (re-online)", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online());
    reg.apply(offline());
    expect(reg.getAgents()[0]?.state).toBe("offline");
    reg.apply(online());
    const [rec] = reg.getAgents();
    expect(rec?.state).toBe("online");
    expect(rec?.offlineReason).toBeUndefined();
  });

  test("capabilities-changed stores the latest full set (B: latest only)", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online(["research"]));
    reg.apply(
      createAgentCapabilitiesChangedEvent({
        source: SOURCE,
        identity: IDENTITY,
        scope: SCOPE,
        capabilities: ["research", "code-review.typescript"],
        sentAt: new Date("2026-06-10T09:07:00.000Z"),
      }),
    );
    expect(reg.getAgents()[0]?.capabilities).toEqual([
      "research",
      "code-review.typescript",
    ]);
    // state unchanged — capabilities-changed does not assert liveness.
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("getAgents returns COPIES — caller mutation does not corrupt state", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online(["research"]));
    const snap = reg.getAgents();
    (snap[0] as { state: string }).state = "offline";
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("B records lastHeartbeatAt but NEVER expires a record (no TTL/FSM)", () => {
    let clock = 0;
    const reg = new AgentPresenceRegistry({ now: () => clock });
    clock = 100;
    reg.apply(online());
    clock = 100 + 10 * 60_000; // 10 minutes later — well past the 5-min TTL
    // No reaper in B: the record stays online until an explicit offline.
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("malformed payload is dropped, not thrown; snapshot unchanged", () => {
    const reg = new AgentPresenceRegistry();
    reg.apply(online());
    const bad = { ...heartbeat(), payload: { not: "a heartbeat" } } as Envelope;
    expect(() => reg.apply(bad)).not.toThrow();
    expect(reg.apply(bad)).toBeNull();
    expect(reg.getAgents().length).toBe(1);
    expect(reg.getAgents()[0]?.state).toBe("online");
  });

  test("non-presence envelope type is ignored", () => {
    const reg = new AgentPresenceRegistry();
    const notPresence: Envelope = { ...online(), type: "system.foo" };
    expect(reg.apply(notPresence)).toBeNull();
    expect(reg.getAgents().length).toBe(0);
  });
});

describe("AgentPresenceRegistry.onChange", () => {
  test("fires after each mutation with the affected key + new record", () => {
    const reg = new AgentPresenceRegistry();
    const seen: { key: string; state: string }[] = [];
    const sub = reg.onChange((key, rec) => {
      seen.push({ key, state: rec.state });
    });
    reg.apply(online());
    reg.apply(offline());
    expect(seen).toEqual([
      { key: "andreas/meta-factory/luna", state: "online" },
      { key: "andreas/meta-factory/luna", state: "offline" },
    ]);
    sub.unsubscribe();
    reg.apply(online());
    // No further events after unsubscribe.
    expect(seen.length).toBe(2);
  });

  test("a throwing listener does not break sibling listeners or apply", () => {
    const reg = new AgentPresenceRegistry();
    let secondFired = false;
    reg.onChange(() => {
      throw new Error("boom");
    });
    reg.onChange(() => {
      secondFired = true;
    });
    expect(() => reg.apply(online())).not.toThrow();
    expect(secondFired).toBe(true);
    expect(reg.getAgents().length).toBe(1);
  });
});

describe("agentPresenceSubject", () => {
  test("derives the stack-local agent.> pattern (no federated)", () => {
    expect(agentPresenceSubject("andreas", "meta-factory")).toBe(
      "local.andreas.meta-factory.agent.>",
    );
  });
});

// --- wiring -----------------------------------------------------------------

interface FakeRuntime extends MyelinRuntime {
  fire(envelope: Envelope, subject: string): void;
  subscribedPatterns: string[];
}

function makeFakeRuntime(opts: { enabled?: boolean; canSubscribe?: boolean } = {}): FakeRuntime {
  const enabled = opts.enabled ?? true;
  const canSubscribe = opts.canSubscribe ?? true;
  const handlers = new Set<EnvelopeHandler>();
  const subscribedPatterns: string[] = [];
  const subscriberStop = mock(() => Promise.resolve());
  const fakeSubscriber: MyelinSubscriber = {
    stop: subscriberStop,
  } as unknown as MyelinSubscriber;
  return {
    enabled,
    subscribedPatterns,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscribe: (pattern: string) => {
      subscribedPatterns.push(pattern);
      return Promise.resolve(canSubscribe ? fakeSubscriber : null);
    },
    fire(envelope, subject) {
      for (const h of handlers) h(envelope, subject);
    },
  };
}

describe("startAgentPresenceRegistry (wiring)", () => {
  test("self-subscribes to the stack-local pattern + folds matching envelopes", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    expect(runtime.subscribedPatterns).toEqual([
      "local.andreas.meta-factory.agent.>",
    ]);
    // Fire an online envelope on the matching subject.
    runtime.fire(online(), "local.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(1);
    expect(handle.registry.getAgents()[0]?.state).toBe("online");
    await handle.stop();
  });

  test("filters out envelopes on non-matching subjects", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    // A different stack's subject must not land in this stack's registry.
    runtime.fire(online(), "local.andreas.other-stack.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
    // A federated subject is NOT subscribed in B (Phase E).
    runtime.fire(online(), "federated.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("dormant when runtime cannot push-subscribe (returns null)", async () => {
    const runtime = makeFakeRuntime({ enabled: true, canSubscribe: false });
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    // Still constructed + queryable; onEnvelope still folds (the fan-out is
    // independent of the self-subscribe).
    expect(handle.registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("stop() is idempotent + unregisters the fan-out handler", async () => {
    const runtime = makeFakeRuntime();
    const handle = await startAgentPresenceRegistry({
      runtime,
      principal: "andreas",
      stack: "meta-factory",
    });
    await handle.stop();
    await handle.stop(); // no throw
    // After stop, fan-out is unregistered — new fires are ignored.
    runtime.fire(online(), "local.andreas.meta-factory.agent.online");
    expect(handle.registry.getAgents().length).toBe(0);
  });
});
