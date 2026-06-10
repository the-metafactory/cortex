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
