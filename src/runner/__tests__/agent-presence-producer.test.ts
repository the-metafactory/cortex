/**
 * G-1114.B.2 — agent-presence producer tests.
 *
 * Coverage axes:
 *   1. Boot — `start()` publishes one `agent.online` per agent, carrying
 *      identity + capabilities; the derived subject is the stack-local
 *      `local.{principal}.{stack}.agent.online`.
 *   2. Heartbeat — the injectable scheduler fires `agent.heartbeat` per agent
 *      per tick (NOT immediately — online already announced at t=0).
 *   3. Shutdown — `stop()` clears the ticker + publishes `agent.offline`
 *      (reason: shutdown) per agent; idempotent.
 *   4. Roundtrip — producer output → registry → snapshot shows the agent online
 *      (through the real builders + validator + registry).
 *   5. Mapping — `presenceAgentFromAgent` derives identity/scope/caps from an
 *      Agent; falls back to the stack key; skips when no key resolvable.
 */

import { describe, expect, test } from "bun:test";
import {
  AgentPresenceProducer,
  presenceAgentFromAgent,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  type PresenceAgent,
  type PresenceScheduler,
} from "../agent-presence-producer";
import { AgentPresenceRegistry } from "../../bus/agent-network/registry";
import {
  deriveNatsSubject,
  validateEnvelope,
  type Envelope,
} from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { Agent } from "../../common/types/cortex-config";

const SOURCE = { principal: "andreas", stack: "meta-factory", instance: "local" };

const AGENT_A: PresenceAgent = {
  identity: { nkey_public_key: "UAAA", agent_id: "luna", assistant_name: "Luna" },
  scope: { principal: "andreas", stack: "meta-factory" },
  capabilities: ["code-review.typescript"],
};
const AGENT_B: PresenceAgent = {
  identity: { nkey_public_key: "UBBB", agent_id: "echo", assistant_name: "Echo" },
  scope: { principal: "andreas", stack: "meta-factory" },
  capabilities: ["research"],
};

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}
function recordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  return {
    enabled: true,
    published,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: (env: Envelope) => {
      published.push(env);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

/** Controllable scheduler — `tick()` fires the registered interval handler. */
function manualScheduler(): PresenceScheduler & { tick(): void; cleared: boolean } {
  let handler: (() => void) | null = null;
  let cleared = false;
  return {
    setInterval: (h: () => void) => {
      handler = h;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      cleared = true;
      handler = null;
    },
    tick: () => {
      if (handler) handler();
    },
    get cleared() {
      return cleared;
    },
  };
}

describe("AgentPresenceProducer.start", () => {
  test("publishes one agent.online per agent with capabilities", () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: sched,
      now: () => new Date("2026-06-10T09:00:00.000Z"),
    });
    producer.start();
    const onlines = runtime.published.filter((e) => e.type === "agent.online");
    expect(onlines.length).toBe(2);
    const luna = onlines.find(
      (e) => (e.payload as { identity: { agent_id: string } }).identity.agent_id === "luna",
    );
    expect(luna).toBeDefined();
    expect((luna!.payload as { capabilities: string[] }).capabilities).toEqual([
      "code-review.typescript",
    ]);
    expect((luna!.payload as { started_at: string }).started_at).toBe(
      "2026-06-10T09:00:00.000Z",
    );
    // Subject derivation — stack-local agent.online.
    expect(deriveNatsSubject(luna!, "meta-factory")).toBe(
      "local.andreas.meta-factory.agent.online",
    );
    expect(validateEnvelope(luna!).ok).toBe(true);
  });

  test("does NOT publish a heartbeat at t=0 (online already announced)", () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: sched,
    }).start();
    expect(runtime.published.filter((e) => e.type === "agent.heartbeat").length).toBe(0);
  });

  test("empty roster: no publishes, no scheduled ticker", () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [],
      scheduler: sched,
    });
    producer.start();
    expect(runtime.published.length).toBe(0);
    sched.tick(); // no handler registered → no-op
    expect(runtime.published.length).toBe(0);
  });

  test("double start() is ignored", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    producer.start();
    expect(runtime.published.filter((e) => e.type === "agent.online").length).toBe(1);
  });
});

describe("AgentPresenceProducer heartbeat ticker", () => {
  test("each tick publishes agent.heartbeat per agent", async () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: sched,
      now: () => new Date("2026-06-10T09:01:00.000Z"),
    }).start();
    sched.tick();
    const hbs = runtime.published.filter((e) => e.type === "agent.heartbeat");
    expect(hbs.length).toBe(2);
    expect(deriveNatsSubject(hbs[0]!, "meta-factory")).toBe(
      "local.andreas.meta-factory.agent.heartbeat",
    );
    // Let the prior batch's allSettled().finally() clear the backpressure
    // guard (it resolves on the microtask queue), then the next tick → four.
    await new Promise((r) => setTimeout(r, 0));
    sched.tick();
    expect(runtime.published.filter((e) => e.type === "agent.heartbeat").length).toBe(4);
  });

  test("backpressure: a tick is skipped while the prior batch is in flight", () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: sched,
    }).start();
    // Two synchronous ticks with no microtask flush between → the second is
    // skipped (the first batch hasn't settled). Only one batch's worth emits.
    sched.tick();
    sched.tick();
    expect(runtime.published.filter((e) => e.type === "agent.heartbeat").length).toBe(2);
  });

  test("default interval is 60s, well under the 5-min liveness TTL", () => {
    expect(DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS).toBeLessThan(5 * 60_000);
  });
});

describe("AgentPresenceProducer.stop", () => {
  test("clears the ticker + publishes agent.offline per agent", async () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: sched,
    });
    producer.start();
    await producer.stop("shutdown");
    expect(sched.cleared).toBe(true);
    const offlines = runtime.published.filter((e) => e.type === "agent.offline");
    expect(offlines.length).toBe(2);
    expect((offlines[0]!.payload as { reason: string }).reason).toBe("shutdown");
    // Ticker is stopped — a post-stop tick publishes nothing new.
    const before = runtime.published.length;
    sched.tick();
    expect(runtime.published.length).toBe(before);
  });

  test("stop() is idempotent — no duplicate offline", async () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    await producer.stop();
    await producer.stop();
    expect(runtime.published.filter((e) => e.type === "agent.offline").length).toBe(1);
  });
});

describe("producer → registry roundtrip", () => {
  test("online output folds into the registry as an online agent", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    // Feed the real produced envelope through the real registry.
    const registry = new AgentPresenceRegistry();
    for (const env of runtime.published) registry.apply(env);
    const [rec] = registry.getAgents();
    expect(rec?.agentId).toBe("luna");
    expect(rec?.state).toBe("online");
    expect(rec?.capabilities).toEqual(["code-review.typescript"]);
    expect(rec?.assistantName).toBe("Luna");
  });

  test("online → heartbeat → offline roundtrip ends offline", async () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: sched,
    });
    producer.start();
    sched.tick();
    await producer.stop("shutdown");
    const registry = new AgentPresenceRegistry();
    for (const env of runtime.published) registry.apply(env);
    const [rec] = registry.getAgents();
    expect(rec?.state).toBe("offline");
    expect(rec?.offlineReason).toBe("shutdown");
  });
});

describe("AgentPresenceProducer.publishCapabilitiesChanged", () => {
  // G-1114.C.1 — the mid-life capability-mutation emit path. See the producer's
  // class doc + the FINDING in the PR: capabilities are restart-only at the
  // daemon today (ConfigWatcher carries no per-agent caps; AgentsDirectoryWatcher
  // isn't wired into cortex.ts), so this method exists for the moment a capability
  // hot-reload becomes possible — the diff logic is the load-bearing half.

  test("emits agent.capabilities-changed with the FULL new set + correct subject", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: manualScheduler(),
      now: () => new Date("2026-06-10T10:00:00.000Z"),
    });
    producer.start();
    const emitted = producer.publishCapabilitiesChanged("luna", [
      "code-review.typescript",
      "research",
    ]);
    expect(emitted).toBe(true);
    const changes = runtime.published.filter(
      (e) => e.type === "agent.capabilities-changed",
    );
    expect(changes.length).toBe(1);
    const env = changes[0]!;
    // FULL new set (not a diff) on the payload.
    expect((env.payload as { capabilities: string[] }).capabilities).toEqual([
      "code-review.typescript",
      "research",
    ]);
    // Identity is the agent's, not the other agent's.
    expect((env.payload as { identity: { agent_id: string } }).identity.agent_id).toBe(
      "luna",
    );
    expect((env.payload as { sent_at: string }).sent_at).toBe(
      "2026-06-10T10:00:00.000Z",
    );
    // Subject derives to the stack-local capabilities-changed subject.
    expect(deriveNatsSubject(env, "meta-factory")).toBe(
      "local.andreas.meta-factory.agent.capabilities-changed",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("diff: no-op (no emit) when the capability set is unchanged", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    // AGENT_A's caps are exactly ["code-review.typescript"] — same set.
    const emitted = producer.publishCapabilitiesChanged("luna", [
      "code-review.typescript",
    ]);
    expect(emitted).toBe(false);
    expect(
      runtime.published.filter((e) => e.type === "agent.capabilities-changed").length,
    ).toBe(0);
  });

  test("diff is order-insensitive: same set in different order is a no-op", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [
        {
          identity: { nkey_public_key: "UAAA", agent_id: "luna", assistant_name: "Luna" },
          scope: { principal: "andreas", stack: "meta-factory" },
          capabilities: ["a", "b", "c"],
        },
      ],
      scheduler: manualScheduler(),
    });
    producer.start();
    expect(producer.publishCapabilitiesChanged("luna", ["c", "a", "b"])).toBe(false);
    expect(
      runtime.published.filter((e) => e.type === "agent.capabilities-changed").length,
    ).toBe(0);
  });

  test("emits on a real delta (added capability) and updates the tracked set", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    // First change: add "research".
    expect(
      producer.publishCapabilitiesChanged("luna", [
        "code-review.typescript",
        "research",
      ]),
    ).toBe(true);
    // A repeat of the SAME new set is now a no-op — the producer tracks the
    // post-change set as the new baseline.
    expect(
      producer.publishCapabilitiesChanged("luna", [
        "code-review.typescript",
        "research",
      ]),
    ).toBe(false);
    expect(
      runtime.published.filter((e) => e.type === "agent.capabilities-changed").length,
    ).toBe(1);
  });

  test("emits when capabilities are fully revoked (new set is empty)", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    expect(producer.publishCapabilitiesChanged("luna", [])).toBe(true);
    const [env] = runtime.published.filter(
      (e) => e.type === "agent.capabilities-changed",
    );
    expect((env!.payload as { capabilities: string[] }).capabilities).toEqual([]);
  });

  test("returns false (no emit) for an unknown agent id", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    expect(producer.publishCapabilitiesChanged("nobody", ["x"])).toBe(false);
    expect(
      runtime.published.filter((e) => e.type === "agent.capabilities-changed").length,
    ).toBe(0);
  });

  test("roundtrip: capabilities-changed folds into the registry as the new set", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    producer.publishCapabilitiesChanged("luna", ["research", "code-review.typescript"]);
    const registry = new AgentPresenceRegistry();
    for (const env of runtime.published) registry.apply(env);
    const [rec] = registry.getAgents();
    expect(rec?.agentId).toBe("luna");
    expect(rec?.state).toBe("online");
    expect(rec?.capabilities).toEqual(["research", "code-review.typescript"]);
  });
});

describe("presenceAgentFromAgent", () => {
  const baseAgent = (over: Partial<Agent> = {}): Agent => ({
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    trust: [],
    presence: {},
    ...over,
  });

  test("maps id→agent_id, displayName→assistant_name, runtime caps→capabilities", () => {
    const pa = presenceAgentFromAgent(
      baseAgent({
        nkey_pub: "UAGENTKEY",
        runtime: {
          substrate: "claude-code",
          mode: "in-process",
          capabilities: ["code-review.typescript", "research"],
        },
      }),
      { principal: "andreas", stack: "meta-factory" },
      "USTACKKEY",
    );
    expect(pa).not.toBeNull();
    expect(pa!.identity).toEqual({
      nkey_public_key: "UAGENTKEY",
      agent_id: "luna",
      assistant_name: "Luna",
    });
    expect(pa!.scope).toEqual({ principal: "andreas", stack: "meta-factory" });
    expect(pa!.capabilities).toEqual(["code-review.typescript", "research"]);
  });

  test("falls back to the stack NKey when the agent declares none", () => {
    const pa = presenceAgentFromAgent(
      baseAgent(),
      { principal: "andreas", stack: "meta-factory" },
      "USTACKKEY",
    );
    expect(pa?.identity.nkey_public_key).toBe("USTACKKEY");
    expect(pa?.capabilities).toEqual([]);
  });

  test("returns null when no key resolvable (agent + stack both absent)", () => {
    const pa = presenceAgentFromAgent(
      baseAgent(),
      { principal: "andreas", stack: "meta-factory" },
      undefined,
    );
    expect(pa).toBeNull();
  });
});

// ===========================================================================
// G-1114.E.1 — federation opt-in (dual-emit local + federated)
// ===========================================================================

describe("AgentPresenceProducer federation opt-in (E.1)", () => {
  function classificationsFor(
    published: Envelope[],
    type: string,
  ): string[] {
    return published
      .filter((e) => e.type === type)
      .map((e) => e.sovereignty.classification);
  }

  test("DEFAULT (federate omitted): online emits ONLY local, never federated", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
    });
    producer.start();
    const cls = classificationsFor(runtime.published, "agent.online");
    expect(cls).toEqual(["local"]);
    // No federated.* presence on the wire when not opted in.
    expect(
      runtime.published.some((e) => e.sovereignty.classification === "federated"),
    ).toBe(false);
  });

  test("federate:true: online dual-emits BOTH local AND federated", () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
      federate: true,
    });
    producer.start();
    const cls = classificationsFor(runtime.published, "agent.online").sort();
    expect(cls).toEqual(["federated", "local"]);
    // The federated copy derives the federated.* subject.
    const fed = runtime.published.find(
      (e) => e.type === "agent.online" && e.sovereignty.classification === "federated",
    );
    expect(fed).toBeDefined();
    expect(deriveNatsSubject(fed!, "meta-factory")).toBe(
      "federated.andreas.meta-factory.agent.online",
    );
    expect(validateEnvelope(fed!).ok).toBe(true);
  });

  test("federate:true: heartbeat ticks dual-emit local + federated per agent", () => {
    const runtime = recordingRuntime();
    const sched = manualScheduler();
    new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A, AGENT_B],
      scheduler: sched,
      federate: true,
    }).start();
    sched.tick();
    const cls = classificationsFor(runtime.published, "agent.heartbeat");
    // 2 agents × {local, federated} = 4 heartbeats per tick.
    expect(cls.filter((c) => c === "local").length).toBe(2);
    expect(cls.filter((c) => c === "federated").length).toBe(2);
  });

  test("federate:true: offline dual-emits on shutdown", async () => {
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: SOURCE,
      agents: [AGENT_A],
      scheduler: manualScheduler(),
      federate: true,
    });
    producer.start();
    await producer.stop();
    const cls = classificationsFor(runtime.published, "agent.offline").sort();
    expect(cls).toEqual(["federated", "local"]);
  });
});
