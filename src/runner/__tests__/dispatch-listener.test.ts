/**
 * MIG-4.5/4.6 — tests for the runner dispatch listener.
 *
 * Coverage axes:
 *   1. Registration shape — surfaceConfig matches G-1111 §4 SurfaceAdapter
 *      contract; default subjects derive from source.principal.
 *   2. Lifecycle — on success: started → completed; on non-zero exit:
 *      started → failed; on factory throw: started → failed; on exit 143:
 *      started → aborted.
 *   3. Correlation — all four lifecycle envelopes for one task share one
 *      correlation_id (the task_id).
 *   4. Malformed payload — listener no-ops cleanly without crashing the
 *      router (per surface-router §5.3 isolation).
 *   5. Start/stop — idempotent; stop() unregisters from router; restart
 *      re-registers.
 *
 * NO real CC processes are spawned — every test injects a fake
 * `ccSessionFactory` that returns a deterministic stub.
 */

import { describe, expect, test } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import { createSurfaceRouter, type SurfaceRouter } from "../../bus/surface-router";
import type { SystemEventSource } from "../../bus/system-events";
import {
  createDispatchListener,
  type CCSessionFactory,
  type DispatchTaskReceivedPayload,
} from "../dispatch-listener";
import type { AgentTeamFactory, AgentTeamOpts } from "../agent-team";
import type { CCSessionResult } from "../cc-session";
import { PolicyEngine } from "../../common/policy/engine";
import type { Intent } from "../../common/policy/types";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import type { Agent } from "../../common/types/cortex-config";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SOURCE: SystemEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const TASK_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Canonical Tasks-Domain chat subject for cortex (`@did-mf-cortex`). Shared
 * across every `trigger()` call so a future canonical-grammar change is a
 * one-line edit here rather than a mechanical sweep of every test (cortex#409
 * sage review).
 */
const CANONICAL_CORTEX_CHAT_SUBJECT =
  "local.metafactory.tasks.@did-mf-cortex.chat";

/**
 * A MyelinRuntime stub that records every published envelope. Used by
 * tests to assert lifecycle events fire in the expected order with the
 * expected correlation_id.
 */
function recordingRuntime(): {
  runtime: MyelinRuntime;
  published: Envelope[];
  /** Trigger a manual onEnvelope call for the surface-router to process. */
  trigger: (env: Envelope, subject: string) => void;
  /**
   * cortex#477 — patterns the listener has self-subscribed to via
   * `runtime.subscribe(...)`. Asserts the dispatch-listener's
   * `start()` no longer relies on `nats.subjects[]` covering its
   * canonical pattern.
   */
  subscribedPatterns: string[];
  /** Subscribers handed out by `subscribe()` — for stop()-side assertions. */
  subscribers: { pattern: string; stopped: boolean }[];
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const published: Envelope[] = [];
  const subscribedPatterns: string[] = [];
  const subscribers: { pattern: string; stopped: boolean }[] = [];
  return {
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async (env) => {
        published.push(env);
      },
      // cortex#477 — surface the push-mode subscribe path so the
      // listener's `start()` can self-subscribe via the runtime
      // rather than relying on `nats.subjects[]`. The stub records
      // every pattern + returns a minimal subscriber so the
      // listener's `stop()` drain path is exercised end-to-end.
      subscribe: async (pattern) => {
        subscribedPatterns.push(pattern);
        const entry = { pattern, stopped: false };
        subscribers.push(entry);
        return {
          pattern,
          ready: Promise.resolve(),
          stop: async () => {
            entry.stopped = true;
          },
        } as unknown as Awaited<
          ReturnType<NonNullable<MyelinRuntime["subscribe"]>>
        >;
      },
      stop: async () => {},
    },
    published,
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
    subscribedPatterns,
    subscribers,
  };
}

/**
 * Build a `dispatch.task.received` envelope with a canonical payload shape.
 * Tests vary the fields they care about and let the helper fill the rest.
 */
function makeReceivedEnvelope(
  payloadOverrides: Partial<DispatchTaskReceivedPayload> = {},
): Envelope {
  const payload: DispatchTaskReceivedPayload = {
    task_id: TASK_ID,
    agent_id: "cortex",
    prompt: "say hello",
    ...payloadOverrides,
  };
  return {
    id: "00000000-0000-4000-8000-000000000000",
    source: "metafactory.dispatch-handler.local",
    type: "dispatch.task.received",
    distribution_mode: "direct",
    target_assistant: `did:mf:${payload.agent_id}`,
    timestamp: "2026-05-09T12:00:00Z",
    correlation_id: payload.task_id,
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Fake CC session factory. Returns a session-like object whose `wait()`
 * resolves with the configured result. Captures the opts passed to the
 * factory for assertions.
 */
function fakeFactory(result: CCSessionResult): {
  factory: CCSessionFactory;
  optsCaptured: Parameters<CCSessionFactory>[0][];
} {
  const optsCaptured: Parameters<CCSessionFactory>[0][] = [];
  const factory: CCSessionFactory = (opts) => {
    optsCaptured.push(opts);
    const session = {
      start() { return session; },
      async wait() { return result; },
    };
    return session;
  };
  return { factory, optsCaptured };
}

function fakeAgentTeamFactory(result: string): {
  factory: AgentTeamFactory;
  optsCaptured: AgentTeamOpts[];
} {
  const optsCaptured: AgentTeamOpts[] = [];
  const factory: AgentTeamFactory = (opts) => {
    optsCaptured.push(opts);
    return {
      start() {
        return undefined;
      },
      async wait() {
        return result;
      },
      on() {
        return undefined;
      },
      getTraceContext() {
        return {
          traceId: "trace-dispatch-listener-test",
          teamId: "team-dispatch-listener-test",
        };
      },
    };
  };
  return { factory, optsCaptured };
}

const SUCCESS_RESULT: CCSessionResult = {
  success: true,
  response: "Hello!\nMore details follow.",
  exitCode: 0,
  durationMs: 100,
  sessionId: "session-abc",
};

const FAIL_RESULT: CCSessionResult = {
  success: false,
  response: "",
  exitCode: 1,
  durationMs: 50,
};

const TIMEOUT_RESULT: CCSessionResult = {
  success: false,
  response: "",
  exitCode: 143, // SIGTERM — cc-session's inactivity-timeout signature
  durationMs: 120_000,
};

/**
 * The canonical inactivity-timeout outcome from cc-session.ts:
 * `wait()` settles via the "error" listener (timeout fires emit("error"))
 * with exitCode: 1 BEFORE wireExit() observes the eventual SIGTERM/143.
 * Previously the dispatch-listener missed this case (W1 in Echo round-1),
 * so we test it explicitly to ensure abort detection now uses
 * `result.aborted` rather than relying on exit code 143.
 */
const ABORTED_BY_FLAG_RESULT: CCSessionResult = {
  success: false,
  response: "",
  exitCode: 1,
  durationMs: 120_000,
  aborted: true,
  abortReason: "timeout",
};

// ---------------------------------------------------------------------------
// Surface-adapter shape
// ---------------------------------------------------------------------------

describe("createDispatchListener — surfaceConfig", () => {
  test("default subjects derive from source.principal", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    // Direction A Stage 4-B (cortex#409) — production defaults subscribe
    // to the canonical Tasks Domain pattern. Legacy subjects remain
    // available only through explicit test/principal overrides.
    expect(listener.subjects).toEqual([
      "local.metafactory.tasks.*.>",
    ]);
  });

  test("custom subjects honored when provided", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      subjects: ["local.test.dispatch.task.received"],
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.subjects).toEqual([
      "local.test.dispatch.task.received",
    ]);
  });

  // cortex#267 — stack-aware default subjects. When the boot path
  // supplies `stack` (from `deriveStackId(loadedConfig).stack`), the
  // listener subscribes on the 6-segment canonical tasks grammar matching
  // sage's emit-side post-IAW A.5.
  test("default subjects use 6-segment grammar when stack is supplied (cortex#267)", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      stack: "default",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    // Direction A Stage 4-B (cortex#409) — stack-aware default subjects
    // use only the canonical `tasks.*.>` pattern.
    expect(listener.subjects).toEqual([
      "local.metafactory.default.tasks.*.>",
    ]);
  });

  test("default subjects honour multi-stack principal config", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      stack: "research",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.subjects).toEqual([
      "local.metafactory.research.tasks.*.>",
    ]);
  });

  test("custom subjects bypass stack-aware default", () => {
    // Operators supplying explicit `subjects` keep full control; the
    // listener does not re-write their patterns.
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      stack: "default",
      subjects: ["federated.{net}.dispatch.task.received"],
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.subjects).toEqual([
      "federated.{net}.dispatch.task.received",
    ]);
  });

  test("adapter id defaults to runner-dispatch-listener", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.id).toBe("runner-dispatch-listener");
  });

  test("custom adapter id honored", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      source: SOURCE,
      adapterId: "runner-dispatch-listener-test",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.id).toBe("runner-dispatch-listener-test");
  });
});

// ---------------------------------------------------------------------------
// cortex#477 — self-subscribe via runtime.subscribe()
// ---------------------------------------------------------------------------

describe("createDispatchListener — runtime self-subscribe (cortex#477)", () => {
  test("start() self-subscribes to canonical pattern via runtime.subscribe()", async () => {
    // Pre-#477 the listener relied on `nats.subjects[]` in cortex.yaml
    // being a superset of its canonical pattern — an unenforced
    // cross-config invariant that silently broke deployments whose
    // config wasn't kept in lockstep. Now the listener self-subscribes
    // at start() time via the runtime, symmetric with ReviewConsumer's
    // subscribePull model.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      stack: "meta-factory",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });

    expect(r.subscribedPatterns).toEqual([]);
    await listener.start();
    expect(r.subscribedPatterns).toEqual([
      "local.metafactory.meta-factory.tasks.*.>",
    ]);
  });

  test("start() with stack omitted falls back to 5-segment canonical", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    expect(r.subscribedPatterns).toEqual(["local.metafactory.tasks.*.>"]);
  });

  test("start() with explicit subjects passes them all to runtime.subscribe()", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      subjects: ["local.test.a.>", "local.test.b.>"],
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    expect(r.subscribedPatterns).toEqual(["local.test.a.>", "local.test.b.>"]);
  });

  test("stop() drains the runtime subscribers the listener owns", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      stack: "meta-factory",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    expect(r.subscribers.every((s) => !s.stopped)).toBe(true);
    await listener.stop();
    expect(r.subscribers.every((s) => s.stopped)).toBe(true);
  });

  test("start() tolerates a runtime stub that lacks subscribe() (additivity contract)", async () => {
    // Mirrors the ReviewConsumer subscribePull contract — older fake
    // runtime stubs may not expose `subscribe`. The listener treats an
    // undefined property as "no push-mode subscriptions wired" and
    // stays dormant on that path (router registration still happens).
    const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
    const minimalRuntime: MyelinRuntime = {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async () => {},
      stop: async () => {},
    };
    const router = createSurfaceRouter(minimalRuntime);
    const listener = createDispatchListener({
      runtime: minimalRuntime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await listener.stop();
    // No assertion beyond "doesn't throw" — the listener registered
    // with the router and skipped self-subscribe without error.
    expect(true).toBe(true);
  });

  test("start() tolerates runtime.subscribe() returning null (bus dormant)", async () => {
    // When the runtime is disabled (no NATS configured / connect
    // failed), `subscribe()` returns null. The listener treats that
    // as a legitimate dormant state, not an error.
    const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
    const dormantRuntime: MyelinRuntime = {
      enabled: false,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async () => {},
      subscribe: async () => null,
      stop: async () => {},
    };
    const router = createSurfaceRouter(dormantRuntime);
    const listener = createDispatchListener({
      runtime: dormantRuntime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await listener.stop();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — success path
// ---------------------------------------------------------------------------

describe("dispatch-listener — success path", () => {
  test("emits started → completed; correlation_id matches task_id", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    // Trigger an envelope through the runtime fan-out path
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);

    // Wait briefly for async render to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // v2.0.1: policy engine is active, so an audit envelope precedes lifecycle.
    expect(r.published).toHaveLength(3);
    const types = r.published.map((e) => e.type);
    expect(types).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    // All envelopes share one correlation_id (the task_id).
    for (const env of r.published) {
      expect(env.correlation_id).toBe(TASK_ID);
    }
    // task_id/agent_id only appear on the lifecycle envelopes (the audit
    // envelope's payload shape is different per C.4 SystemAccessAllowed).
    for (const env of r.published.slice(1)) {
      expect(env.payload.task_id).toBe(TASK_ID);
      expect(env.payload.agent_id).toBe("cortex");
    }
  });

  test("completed payload carries result_summary (first line, truncated)", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = r.published.find((e) => e.type === "dispatch.task.completed");
    expect(completed).toBeDefined();
    expect(completed?.payload.result_summary).toBe("Hello!");
    // cortex#491 — the completed envelope ALSO carries the full,
    // untruncated reply (`chat_response`) for the dispatch sink to post
    // back as the chat round-trip; `result_summary` stays the first-line
    // dashboard label.
    expect(completed?.payload.chat_response).toBe("Hello!\nMore details follow.");
  });

  test("cortex#491 — echoes response_routing onto every lifecycle envelope", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    const routing = {
      adapter_instance: "discord-pai-collab",
      channel_id: "C123",
      thread_id: "T456",
    };
    r.trigger(
      makeReceivedEnvelope({
        response_routing: routing,
      }),
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Every LIFECYCLE envelope (started/completed) carries the echoed
    // routing so the dispatch sink can target the reply. The audit
    // envelope (system.access.allowed) is not a lifecycle envelope.
    const lifecycle = r.published.filter((e) => e.type.startsWith("dispatch.task."));
    expect(lifecycle.length).toBeGreaterThan(0);
    for (const env of lifecycle) {
      expect(env.payload.response_routing).toEqual(routing);
    }
  });

  test("cortex#491 — no response_routing on lifecycle when the inbound carried none", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    // bus-peer / Offer style inbound — no response_routing on the payload.
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const lifecycle = r.published.filter((e) => e.type.startsWith("dispatch.task."));
    expect(lifecycle.length).toBeGreaterThan(0);
    for (const env of lifecycle) {
      expect(env.payload.response_routing).toBeUndefined();
    }
  });

  test("CC opts plumbed from payload to factory (snake_case → camelCase)", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope({
        prompt: "do the work",
        grove_channel: "test-channel",
        grove_network: "test-network",
        agent_name: "Cortex",
        allowed_tools: ["Read", "Edit"],
        disallowed_tools: ["Bash"],
        allowed_dirs: ["/tmp"],
        timeout_ms: 60_000,
        cwd: "/tmp",
        additional_args: ["--verbose"],
        project: "cortex",
        entity: "issue/12",
        principal: "andreas",
        resume_session_id: "prior-session",
      }),
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(optsCaptured).toHaveLength(1);
    const opts = optsCaptured[0]!;
    expect(opts.prompt).toBe("do the work");
    expect(opts.groveChannel).toBe("test-channel");
    expect(opts.groveNetwork).toBe("test-network");
    expect(opts.agentName).toBe("Cortex");
    expect(opts.agentId).toBe("cortex"); // sourced from payload.agent_id
    expect(opts.allowedTools).toEqual(["Read", "Edit"]);
    expect(opts.disallowedTools).toEqual(["Bash"]);
    expect(opts.allowedDirs).toEqual(["/tmp"]);
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.cwd).toBe("/tmp");
    expect(opts.additionalArgs).toEqual(["--verbose"]);
    expect(opts.project).toBe("cortex");
    expect(opts.entity).toBe("issue/12");
    expect(opts.principal).toBe("andreas");
    expect(opts.resumeSessionId).toBe("prior-session");
  });

  test("agent_name falls back to agent_id when omitted (A.1b flip)", async () => {
    // A.1b refactor: the listener builds a `DispatchRequest` whose
    // `agent.displayName` falls back to `agent_id` when `agent_name` is
    // missing on the payload. The harness then surfaces `displayName`
    // as `CCSessionOpts.agentName` — so the absence of payload.agent_name
    // should NOT produce undefined `opts.agentName`.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    // No agent_name on the payload — only agent_id.
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(optsCaptured).toHaveLength(1);
    const opts = optsCaptured[0]!;
    expect(opts.agentId).toBe("cortex");
    expect(opts.agentName).toBe("cortex"); // falls back to agent_id
  });

  test("payload with no runtime knobs produces a minimal CCSessionOpts (A.1b flip)", async () => {
    // A.1b refactor: the listener only attaches `req.runtime` when the
    // payload actually carries one or more runtime knobs. With a bare
    // payload (task_id + agent_id + prompt only), CCSessionOpts MUST
    // NOT include cwd/allowedDirs/etc. — every CC-knob stays undefined
    // so the substrate falls back to its built-in defaults.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(optsCaptured).toHaveLength(1);
    const opts = optsCaptured[0]!;
    expect(opts.cwd).toBeUndefined();
    expect(opts.allowedDirs).toBeUndefined();
    expect(opts.additionalArgs).toBeUndefined();
    expect(opts.groveChannel).toBeUndefined();
    expect(opts.groveNetwork).toBeUndefined();
    expect(opts.resumeSessionId).toBeUndefined();
    expect(opts.bashAllowlist).toBeUndefined();
    expect(opts.bashGuardDisabled).toBeUndefined();
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.principal).toBeUndefined();
    expect(opts.entity).toBeUndefined();
    expect(opts.project).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
  });

  test("delegate distribution mode routes to AgentTeamHarness", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const cc = fakeFactory(SUCCESS_RESULT);
    const team = fakeAgentTeamFactory("Team answer");
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: cc.factory,
      agentTeamFactory: team.factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(
      {
        ...makeReceivedEnvelope(),
        distribution_mode: "delegate",
        target_assistant: "did:mf:cortex",
      },
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cc.optsCaptured).toHaveLength(0);
    expect(team.optsCaptured).toHaveLength(1);
    expect(team.optsCaptured[0]?.participants.length).toBeGreaterThanOrEqual(2);
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    expect(r.published.at(-1)?.payload.result_summary).toBe("Team answer");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — failure paths
// ---------------------------------------------------------------------------

describe("dispatch-listener — failure paths", () => {
  test("canonical direct subject whose assistant segment mismatches target emits failed and skips harness", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const cc = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: cc.factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(
      {
        ...makeReceivedEnvelope(),
        target_assistant: "did:mf:other-agent",
      },
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cc.optsCaptured).toHaveLength(0);
    expect(r.published).toHaveLength(1);
    expect(r.published[0]?.type).toBe("dispatch.task.failed");
    expect((r.published[0]?.payload.reason as { kind?: string } | undefined)?.kind).toBe(
      "cant_do",
    );
  });

  test("non-zero exit code → started → failed", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(FAIL_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    const failed = r.published[2]!;
    expect(failed.payload.error_summary).toBe("claude exited 1");
    expect(failed.correlation_id).toBe(TASK_ID);
  });

  test("exit code 143 (SIGTERM/timeout) → started → aborted", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(TIMEOUT_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.aborted",
    ]);
    expect(r.published[2]!.payload.reason).toBe("timeout");
  });

  test("aborted=true + exitCode=1 (canonical inactivity timeout) → started → aborted", async () => {
    // Echo round-1 W1 regression: the inactivity-timeout path settles
    // wait() via the "error" listener with exitCode: 1, NOT 143. The
    // listener must use result.aborted as the source of truth.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(ABORTED_BY_FLAG_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.aborted",
    ]);
    expect(r.published[2]!.payload.reason).toBe("timeout");
  });

  test("factory throws → started → failed", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const throwingFactory: CCSessionFactory = () => {
      throw new Error("session spawn failed: claude binary missing");
    };
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: throwingFactory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    expect(r.published[2]!.payload.error_summary).toContain("session spawn failed");
  });
});

// ---------------------------------------------------------------------------
// Malformed payloads
// ---------------------------------------------------------------------------

describe("dispatch-listener — malformed payload", () => {
  test("missing prompt → no-op (no envelopes published, no crash)", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await router.start();

    const malformed: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.dispatch-handler.local",
      type: "dispatch.task.received",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { task_id: TASK_ID, agent_id: "cortex" }, // no prompt
    };
    r.trigger(malformed, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });

  test("missing task_id → no-op", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await router.start();

    const malformed: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.dispatch-handler.local",
      type: "dispatch.task.received",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: { agent_id: "cortex", prompt: "x" },
    };
    r.trigger(malformed, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });

  test("non-UUID task_id → rejected at parse time (no envelopes published, no CC spawned)", async () => {
    // Per Echo's review (cortex#34): payload-level UUID gate. A producer that
    // slips a non-UUID `task_id` past the envelope validator must not result
    // in a CC process spawn or any downstream `started`/`completed` envelope —
    // those would be uncorrelated and break the §3.3.4 ordering contract.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
    });
    await listener.start();
    await router.start();

    const malformed: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.dispatch-handler.local",
      type: "dispatch.task.received",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      // shape is wrong on multiple axes: bare string, no hyphens, wrong length
      payload: { task_id: "not-a-uuid", agent_id: "cortex", prompt: "x" },
    };
    r.trigger(malformed, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
    expect(optsCaptured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Start/stop lifecycle
// ---------------------------------------------------------------------------

describe("dispatch-listener — start/stop", () => {
  test("start() is idempotent — second call is a no-op", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await listener.start(); // should be a no-op
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Single registration → exactly one started + one completed (not double)
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("stop() unregisters; subsequent envelopes are dropped", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();
    await listener.stop();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });

  test("stop() is idempotent — second call is a no-op", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await listener.stop();
    await listener.stop(); // safe to call again
  });
});

// ---------------------------------------------------------------------------
// Subject filtering
// ---------------------------------------------------------------------------

describe("dispatch-listener — subject filtering", () => {
  test("envelope on a non-matching subject is ignored", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await router.start();

    // Same envelope, different subject — should not match
    r.trigger(makeReceivedEnvelope(), "local.othermetafactory.tasks.@did-mf-cortex.chat");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IAW Phase C.3.1 — PolicyEngine gating
// ---------------------------------------------------------------------------

/**
 * Build a single-principal engine for gating tests. The principal id
 * matches the envelope helper's default `agent_id` of `"cortex"` so
 * the implicit capability `dispatch.cortex` resolves cleanly.
 */
function engineGranting(capabilities: readonly string[]): PolicyEngine {
  return new PolicyEngine({
    principals: [
      {
        id: "cortex",
        home_operator: "andreas",
        home_stack: "andreas/research",
        role: ["operator"],
        trust: [],
      },
    ],
    roles: [{ id: "operator", capabilities }],
  });
}

describe("dispatch-listener — policy gating (C.3.1)", () => {
  test("no engine → fail-closed (denied with policy_engine_uninitialised — v2.0.1 cortex#311)", async () => {
    // v2.0.1 (cortex#311): the legacy `if (policyEngine !== undefined)`
    // pass-through is retired. When the listener is constructed without
    // an engine (deployment declared empty `policy.principals[]`), every
    // dispatch fails closed with a clear deny reason — there's no
    // authorisation surface to consult.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      // no policyEngine → fail-closed deny
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual(["dispatch.task.failed"]);
    const failed = r.published[0]!;
    const reason = failed.payload.reason as { kind: string; deny: { kind: string } };
    expect(reason.kind).toBe("policy_denied");
    expect(reason.deny.kind).toBe("policy_engine_uninitialised");
  });

  test("engine + allow → dispatch proceeds normally", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // C.4.1 — system.access.allowed audit envelope precedes the
    // lifecycle envelopes on the allow path.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("engine + deny (insufficient_role) → emits dispatch.task.failed with policy_denied reason; no harness call", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      // Grant a *different* capability so dispatch.cortex misses.
      policyEngine: engineGranting(["other.thing"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // C.4.2 — deny path emits both system.access.denied (audit) +
    // dispatch.task.failed (lifecycle terminal — Echo cortex#220 M-1).
    expect(r.published).toHaveLength(2);
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const failed = r.published[1]!;
    expect(failed.type).toBe("dispatch.task.failed");
    expect(failed.correlation_id).toBe(TASK_ID);
    expect(failed.payload.task_id).toBe(TASK_ID);
    expect(failed.payload.agent_id).toBe("cortex");
    const reason = failed.payload.reason as {
      kind: string;
      deny: { kind: string; missing_capability?: string };
    };
    expect(reason.kind).toBe("policy_denied");
    expect(reason.deny.kind).toBe("insufficient_role");
    expect(reason.deny.missing_capability).toBe("dispatch.cortex");
    // Harness never constructed.
    expect(optsCaptured).toHaveLength(0);
  });

  test("engine + deny (unknown_principal) → emits dispatch.task.failed with policy_denied reason", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    // Engine has only `cortex`; envelope targets `ghost-agent` which
    // is not declared as a principal.
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.ghost-agent"]),
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope({ agent_id: "ghost-agent" }),
      "local.metafactory.tasks.@did-mf-ghost-agent.chat",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const failed = r.published[1]!;
    expect(failed.type).toBe("dispatch.task.failed");
    const reason = failed.payload.reason as {
      kind: string;
      deny: { kind: string; principal_id?: string };
    };
    expect(reason.kind).toBe("policy_denied");
    expect(reason.deny.kind).toBe("unknown_principal");
    expect(reason.deny.principal_id).toBe("ghost-agent");
    expect(optsCaptured).toHaveLength(0);
  });

  test("engine receives envelope.sovereignty verbatim on intent (S-3)", async () => {
    // Echo cortex#220 round 2 S-3 — assert sovereignty flows envelope
    // → intent → engine.check() so C.4 audit envelopes carry the same
    // constraints the engine saw without an extra read path.
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine: PolicyEngine = new PolicyEngine({
      principals: [
        {
          id: "cortex",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    // Wrap engine.check to capture inputs.
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    // Envelope with a non-default sovereignty block — the values
    // below must surface on `Intent.sovereignty` exactly.
    const env = makeReceivedEnvelope();
    env.sovereignty = {
      classification: "federated",
      data_residency: "DE",
      max_hop: 3,
      frontier_ok: true,
      model_class: "frontier",
    };

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    const seen = captured[0]!;
    expect(seen.principalId).toBe("cortex");
    expect(seen.intent.capability).toBe("dispatch.cortex");
    expect(seen.intent.sovereignty).toEqual({
      classification: "federated",
      data_residency: "DE",
      max_hop: 3,
      frontier_ok: true,
      model_class: "frontier",
    });
  });

  test("engine + signed_by[0].identity as did:mf:NAME → prefix stripped, principal resolved", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [
      {
        method: "ed25519",
        identity: "did:mf:cortex",
        signature: "a".repeat(88),
        at: "2026-05-15T12:00:00Z",
      },
    ];

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    // C.4.3 — system.access.allowed carries signed_by from the
    // originating envelope verbatim.
    const allowed = r.published[0]!;
    const signedBy = allowed.payload.signed_by as { identity: string }[];
    expect(signedBy).toHaveLength(1);
    expect(signedBy[0]!.identity).toBe("did:mf:cortex");
  });

  test("C.4.1 — system.access.allowed payload shape (capability, capabilities, sovereignty, signed_by)", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex", "extra.cap"]),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const allowed = r.published.find((e) => e.type === "system.access.allowed");
    expect(allowed).toBeDefined();
    if (!allowed) return;
    expect(allowed.correlation_id).toBe(TASK_ID);
    expect(allowed.payload.principal_id).toBe("cortex");
    expect(allowed.payload.capability).toBe("dispatch.cortex");
    expect(allowed.payload.capabilities).toEqual(["dispatch.cortex", "extra.cap"]);
    expect(allowed.payload.envelope_id).toBe("00000000-0000-4000-8000-000000000000");
    expect(allowed.payload.envelope_subject).toBe(
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    expect(allowed.payload.intent_sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    // No signed_by on the envelope → audit carries empty array,
    // never undefined.
    expect(allowed.payload.signed_by).toEqual([]);
  });

  test("C.4.3 — multi-stamp signed_by chain (origin + hub-stamp) carried verbatim onto audit", async () => {
    // Echo cortex#221 round 1 — lock the federation-case
    // attribution contract: a hub-stamped envelope's full chain
    // must round-trip onto `system.access.allowed.payload.signed_by`
    // exactly as emitted, so future federation audit consumers
    // can verify the hub re-stamp without re-parsing the
    // originating envelope.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [
      {
        method: "ed25519",
        identity: "did:mf:cortex",
        signature: "a".repeat(88),
        at: "2026-05-15T12:00:00Z",
        role: "origin",
      },
      {
        method: "hub-stamp",
        identity: "did:mf:cortex",
        stamped_by: "did:mf:metafactory-hub",
        signature: "b".repeat(88),
        at: "2026-05-15T12:00:01Z",
        role: "accountability",
      },
    ];
    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const allowed = r.published.find((e) => e.type === "system.access.allowed");
    expect(allowed).toBeDefined();
    if (!allowed) return;
    const signedBy = allowed.payload.signed_by as {
      method: string;
      principal: string;
      role?: string;
      stamped_by?: string;
    }[];
    expect(signedBy).toHaveLength(2);
    expect(signedBy[0]!.method).toBe("ed25519");
    expect(signedBy[0]!.role).toBe("origin");
    expect(signedBy[1]!.method).toBe("hub-stamp");
    expect(signedBy[1]!.stamped_by).toBe("did:mf:metafactory-hub");
    expect(signedBy[1]!.role).toBe("accountability");
  });

  // -------------------------------------------------------------------------
  // IAW Phase D.3 (cortex#116) — per-network slicing on federated dispatches
  // -------------------------------------------------------------------------

  /**
   * Engine for D.3 tests — declares one principal (`cortex` with
   * `home_stack=andreas/research`) and one federated network
   * (`research-collab`) whose peer roster includes that home_stack.
   * Capability set is parameterised so individual tests can flip
   * allow/deny on the role grant.
   */
  function engineWithFederation(opts: {
    capabilities: readonly string[];
    networkId?: string;
    peerStackIds?: readonly string[];
    homeStack?: string;
  }): PolicyEngine {
    const networkId = opts.networkId ?? "research-collab";
    const peerStackIds = opts.peerStackIds ?? ["andreas/research"];
    const homeStack = opts.homeStack ?? "andreas/research";
    return new PolicyEngine({
      principals: [
        {
          id: "cortex",
          home_operator: "andreas",
          home_stack: homeStack,
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: opts.capabilities }],
      federated: {
        networks: [
          {
            id: networkId,
            peers: peerStackIds.map((stack_id) => ({ stack_id })),
          },
        ],
      },
    });
  }

  test("D.3 — federated dispatch + principal in peer roster → allow path matches local C.3 behaviour", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      // Subscribe to the federated subject so the router fans the
      // envelope to this listener.
      subjects: ["federated.research-collab.dispatch.task.received"],
      ccSessionFactory: factory,
      policyEngine: engineWithFederation({ capabilities: ["dispatch.cortex"] }),
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope(),
      "federated.research-collab.dispatch.task.received",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    // The audit envelope carries the federated wire subject verbatim
    // — pre-D.3 synthesised `local.{principal}...` regardless.
    const allowed = r.published[0]!;
    expect(allowed.payload.envelope_subject).toBe(
      "federated.research-collab.dispatch.task.received",
    );
  });

  test("D.3 — federated dispatch + principal NOT in peer roster → stack_not_in_network deny", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      subjects: ["federated.partner-only.dispatch.task.received"],
      ccSessionFactory: factory,
      policyEngine: engineWithFederation({
        capabilities: ["dispatch.cortex"],
        networkId: "partner-only",
        // Network's peers do NOT include andreas/research — cortex's
        // home_stack misses.
        peerStackIds: ["jcfischer/sage-host"],
      }),
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope(),
      "federated.partner-only.dispatch.task.received",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const reason = denied.payload.reason as {
      kind: string;
      principal_id?: string;
      source_network?: string;
      home_stack?: string;
    };
    expect(reason.kind).toBe("stack_not_in_network");
    expect(reason.principal_id).toBe("cortex");
    expect(reason.source_network).toBe("partner-only");
    expect(reason.home_stack).toBe("andreas/research");
    // Harness never constructed.
    expect(optsCaptured).toHaveLength(0);
  });

  test("D.3 — federated dispatch + unknown network id → unknown_network deny", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      // Subscribe to the catch-all federated dispatch pattern so the
      // listener receives envelopes from networks it doesn't know.
      subjects: ["federated.>"],
      ccSessionFactory: factory,
      policyEngine: engineWithFederation({
        capabilities: ["dispatch.cortex"],
        networkId: "research-collab",
      }),
    });
    await listener.start();
    await router.start();

    // Envelope arrives on a federated subject whose network id isn't
    // declared in policy.federated.networks[].
    r.trigger(
      makeReceivedEnvelope(),
      "federated.phantom-network.dispatch.task.received",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const reason = denied.payload.reason as {
      kind: string;
      source_network?: string;
      principal_id?: string;
    };
    expect(reason.kind).toBe("unknown_network");
    expect(reason.source_network).toBe("phantom-network");
    expect(reason.principal_id).toBe("cortex");
  });

  test("D.3.2 — source_network is stamped onto reason for non-federation deny kinds too (insufficient_role on a federated dispatch)", async () => {
    // The capability check fires before the federation branch, so a
    // federated dispatch whose principal lacks the capability denies
    // with `insufficient_role` (the C.3 reason kind). D.3.2 still
    // requires the audit envelope to carry `source_network` so
    // operators can see which network the deny came from.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      subjects: ["federated.research-collab.dispatch.task.received"],
      ccSessionFactory: factory,
      policyEngine: engineWithFederation({
        // No dispatch.cortex grant — capability check misses.
        capabilities: ["other.cap"],
      }),
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope(),
      "federated.research-collab.dispatch.task.received",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const denied = r.published.find((e) => e.type === "system.access.denied");
    expect(denied).toBeDefined();
    if (!denied) return;
    const reason = denied.payload.reason as {
      kind: string;
      missing_capability?: string;
      source_network?: string;
    };
    expect(reason.kind).toBe("insufficient_role");
    expect(reason.missing_capability).toBe("dispatch.cortex");
    // D.3.2 — source_network rides on the reason payload even for
    // non-federation deny kinds.
    expect(reason.source_network).toBe("research-collab");
  });

  test("D.3 — local dispatch path is unaffected even when federated config is present (no source_network on intent)", async () => {
    // Belt-and-braces: a fully-configured federated engine must still
    // pass-through local dispatches. The federation branch is gated
    // on `intent.source_network`; subjects starting with `local.>`
    // yield `undefined` and skip the branch.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineWithFederation({
        capabilities: ["dispatch.cortex"],
        // No peer matches cortex's home_stack — would deny on the
        // federation branch IF the dispatch was federated.
        peerStackIds: ["jcfischer/sage-host"],
      }),
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    // Audit envelope carries the original local subject, no
    // source_network stamped on the allow path (it's a deny-side
    // concern for audit consumers correlating denied federated
    // traffic).
    const allowed = r.published[0]!;
    expect(allowed.payload.envelope_subject).toBe(
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
  });

  test("D.3 — engine sees source_network on Intent when dispatch arrives via federated subject (S-3 analogue)", async () => {
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = engineWithFederation({ capabilities: ["dispatch.cortex"] });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      subjects: ["federated.research-collab.dispatch.task.received"],
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    r.trigger(
      makeReceivedEnvelope(),
      "federated.research-collab.dispatch.task.received",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.intent.source_network).toBe("research-collab");
  });

  test("C.4.2 — system.access.denied carries structured reason + signed_by", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["other.thing"]),
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [
      {
        method: "ed25519",
        identity: "did:mf:cortex",
        signature: "a".repeat(88),
        at: "2026-05-15T12:00:00Z",
      },
    ];
    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const denied = r.published.find((e) => e.type === "system.access.denied");
    expect(denied).toBeDefined();
    if (!denied) return;
    expect(denied.correlation_id).toBe(TASK_ID);
    expect(denied.payload.principal_id).toBe("cortex");
    expect(denied.payload.capability).toBe("dispatch.cortex");
    const reason = denied.payload.reason as {
      kind: string;
      missing_capability?: string;
    };
    expect(reason.kind).toBe("insufficient_role");
    expect(reason.missing_capability).toBe("dispatch.cortex");
    // C.4.3 — signed_by chain carried verbatim from originating envelope.
    const signedBy = denied.payload.signed_by as { identity: string }[];
    expect(signedBy).toHaveLength(1);
    expect(signedBy[0]!.identity).toBe("did:mf:cortex");
  });
});

// ---------------------------------------------------------------------------
// IAW Phase B wiring (cortex#320) — chain verification
// ---------------------------------------------------------------------------

/**
 * Test fixtures for chain-verification tests. Mirrors the patterns in
 * `src/bus/__tests__/verify-signed-by-chain.test.ts` — minimal agent
 * shape + a `TrustResolver` factory. Crypto tests generate fresh
 * ed25519 NATS user keypairs and sign envelopes via myelin's
 * `signEnvelope`.
 */
function discordPresenceForRunner() {
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

function agentFixtureForRunner(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "cortex",
    displayName: "Cortex",
    persona: "./personas/cortex.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresenceForRunner() },
    ...overrides,
  } as Agent;
}

function runnerResolverWith(...agents: Agent[]): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents(agents));
}

function runnerEd25519Stamp(principal: string) {
  return {
    method: "ed25519" as const,
    // R11 — stamp DID key is `identity` post-myelin#184.
    identity: principal,
    signature: "A".repeat(88),
    at: "2026-05-15T12:00:00.000Z",
  };
}

function generateEd25519KeyPairForRunner(): {
  nkeyPub: string;
  privateKeyBase64: string;
} {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  const privateKeyBase64 = Buffer.from(rawSeed).toString("base64");
  return { nkeyPub, privateKeyBase64 };
}

describe("dispatch-listener — chain verification (cortex#320)", () => {
  test("[1] valid structural chain + PolicyEngine allow → audit + lifecycle envelopes flow", async () => {
    // Receiving agent `cortex` trusts itself; envelope is signed by
    // cortex (self-dispatch case modeled as the simplest happy path).
    // `cryptoVerify: false` here because the stamp signature is a
    // placeholder — structural-only path is exercised.
    const cortex = agentFixtureForRunner({
      id: "cortex",
      trust: ["cortex"],
      nkey_pub: "U" + "B".repeat(55),
    });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: false,
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [runnerEd25519Stamp("did:mf:cortex")];

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verifier accepts → policy gate sees verified principal → allow →
    // audit envelope + lifecycle pair.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("[2] empty chain + rejectEmpty:false (default) → falls through to PolicyEngine path", async () => {
    // Adapter-originated dispatches (Discord/Mattermost/Slack/cc-events)
    // arrive with no `signed_by[]`. The v2.0.2 default
    // `rejectEmpty: false` accepts them and falls through to the
    // policy gate, which decides on `payload.agent_id`.
    const cortex = agentFixtureForRunner({ id: "cortex" });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
    });
    await listener.start();
    await router.start();

    // No signed_by on the envelope — legitimate adapter shape.
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verifier sees empty chain, returns `valid: true` (rejectEmpty=false).
    // Policy gate sees the empty-chain fallback principal id (agent_id)
    // and allows; lifecycle envelopes flow.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("[3] signed chain with principal not in TrustResolver → chain_verification_failed deny", async () => {
    // Receiving agent `cortex` doesn't trust `ghost` (or even know it).
    // A signed envelope claiming `did:mf:ghost` as the principal must
    // be rejected with `unknown_agent`.
    const cortex = agentFixtureForRunner({ id: "cortex", trust: [] });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      // cryptoVerify omitted → defaults true; the structural check
      // rejects before crypto runs, so the test doesn't need real bytes.
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [runnerEd25519Stamp("did:mf:ghost")];

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const failed = r.published[1]!;

    const auditReason = denied.payload.reason as {
      kind: string;
      chain_reason?: { kind: string };
    };
    expect(auditReason.kind).toBe("chain_verification_failed");
    expect(auditReason.chain_reason?.kind).toBe("unknown_agent");

    const failedReason = failed.payload.reason as {
      kind: string;
      deny: { kind: string; chain_reason?: { kind: string } };
    };
    expect(failedReason.kind).toBe("policy_denied");
    expect(failedReason.deny.kind).toBe("chain_verification_failed");
    expect(failedReason.deny.chain_reason?.kind).toBe("unknown_agent");

    // Harness never constructed — verification short-circuits before
    // the policy gate, never mind the substrate.
    expect(optsCaptured).toHaveLength(0);
  });

  test("[4] empty chain + explicit rejectEmpty override → not reachable; verifier wired with rejectEmpty:false; empty must pass", async () => {
    // The listener intentionally pins `rejectEmpty: false` so adapter
    // dispatches always pass. This test documents the contract: a
    // listener constructed with the default options cannot be made
    // to reject empty chains. The "opt-in rejectEmpty" path is not
    // exposed (operators wanting that flip a yet-to-ship config knob
    // — see cortex#320 follow-up). We assert here that even with
    // `cryptoVerify: true`, an empty-chain envelope is accepted.
    const cortex = agentFixtureForRunner({ id: "cortex" });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Empty chain accepted; lifecycle flows.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("[5] cryptoVerify:true + crypto-valid signed chain → allow path", async () => {
    const { nkeyPub, privateKeyBase64 } = generateEd25519KeyPairForRunner();
    const cortex = agentFixtureForRunner({
      id: "cortex",
      trust: ["cortex"],
      nkey_pub: nkeyPub,
    });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
    });
    await listener.start();
    await router.start();

    // Build an envelope with no signed_by, sign it via myelin so the
    // chain is canonically bound to the envelope bytes.
    const base = makeReceivedEnvelope() as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, privateKeyBase64, "did:mf:cortex");

    r.trigger(signed, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("[cortex#480] cryptoVerify:true + envelope self-signed by stack identity → allow (own-stack short-circuit)", async () => {
    // Pre-fix repro: adapter-originated dispatches (Discord chat) reach
    // the runner stamped by the stack identity `did:mf:<principal>-
    // <stack>`. The stack is NOT in the agent registry, so the verifier
    // rejected as `unknown_agent` and the CC session never spawned.
    // cortex#480 wires `stackIdentity` + `stackNKeyPub` through so the
    // verifier short-circuits the registry lookup AND the crypto pass
    // has the stack pubkey registered as a Principal for bytes-check.
    const { nkeyPub: stackNKey, privateKeyBase64: stackSeed } =
      generateEd25519KeyPairForRunner();
    const stackIdentity = "did:mf:andreas-meta-factory";
    // Agent registry holds ONLY cortex/luna. The stack DID is not in
    // it. Pre-fix would reject this as `unknown_agent` agentId=
    // `andreas-meta-factory`.
    const cortex = agentFixtureForRunner({ id: "cortex", trust: [] });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
      stackIdentity,
      stackNKeyPub: stackNKey,
    });
    await listener.start();
    await router.start();

    const base = makeReceivedEnvelope() as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, stackSeed, stackIdentity);

    r.trigger(signed, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verifier short-circuits on stackIdentity match (no registry hit
    // needed); crypto pass finds the stack registered in the bridged
    // IdentityRegistry and verifies bytes. The policy engine in this
    // test's fixture doesn't list the stack DID as a principal, so
    // the dispatch is denied DOWNSTREAM of the verifier with
    // `unknown_principal` — NOT with `chain_verification_failed`.
    // That distinction is the entire point of this test: pre-fix the
    // verifier rejected as `unknown_agent` and no policy gate ran.
    const denied = r.published.find((e) => e.type === "system.access.denied");
    expect(denied).toBeDefined();
    const reason = denied!.payload.reason as { kind: string };
    expect(reason.kind).not.toBe("chain_verification_failed");
    // unknown_principal is the expected post-verifier policy decision
    // for a stack DID that isn't enumerated in the test's
    // PolicyEngine principals[].
    expect(reason.kind).toBe("unknown_principal");
  });

  test("[6] cryptoVerify:true + tampered signature → chain_verification_failed deny", async () => {
    const { nkeyPub, privateKeyBase64 } = generateEd25519KeyPairForRunner();
    const cortex = agentFixtureForRunner({
      id: "cortex",
      trust: ["cortex"],
      nkey_pub: nkeyPub,
    });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
    });
    await listener.start();
    await router.start();

    const base = makeReceivedEnvelope() as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, privateKeyBase64, "did:mf:cortex");

    // Tamper: flip the signature so the bytes no longer match.
    const chain = Array.isArray(signed.signed_by)
      ? signed.signed_by
      : signed.signed_by
        ? [signed.signed_by]
        : [];
    const firstStamp = chain[0];
    if (firstStamp?.method !== "ed25519") {
      throw new Error("test fixture: expected ed25519 stamp at index 0");
    }
    const tamperedSig = firstStamp.signature.startsWith("A")
      ? "B" + firstStamp.signature.slice(1)
      : "A" + firstStamp.signature.slice(1);
    const tampered: Envelope = {
      ...(signed as Envelope),
      signed_by: [{ ...firstStamp, signature: tamperedSig }],
    };

    r.trigger(tampered, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const reason = denied.payload.reason as {
      kind: string;
      chain_reason?: { kind: string };
    };
    expect(reason.kind).toBe("chain_verification_failed");
    expect(reason.chain_reason?.kind).toBe("crypto_verify_failed");
    expect(optsCaptured).toHaveLength(0);
  });

  test("PR #322 r1 M-1 — trustResolver wired but receivingAgentId undefined → fail-closed deny", async () => {
    // Echo PR #322 r1 caught: when cortex.ts builds the listener with
    // `mergedAgents` empty (principal's config declares no agents), the
    // call site spreads `receivingAgentId` conditionally and the prior
    // bypass branch silently skipped verification while the boot log
    // claimed `signed_by chain verified` — re-opening cortex#220 r1's
    // gap. Fix: fail-closed inside the handler with a `receiving_agent
    // _unconfigured` deny so the contract is enforced regardless of
    // caller wiring.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      // trustResolver wired but receivingAgentId deliberately omitted
      // — simulates the cortex.ts:mergedAgents-empty boot state.
      trustResolver: new TrustResolver(AgentRegistry.fromAgents([])),
      // receivingAgentId: undefined (omitted)
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Both audit (system.access.denied) and lifecycle (dispatch.task.failed)
    // envelopes emitted; harness never constructed.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const reason = denied.payload.reason as { kind: string };
    expect(reason.kind).toBe("receiving_agent_unconfigured");
    expect(optsCaptured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cortex#346 — myelin#161 originator field consumed via getActorPrincipal
// ---------------------------------------------------------------------------

/**
 * cortex#346 — runner consumes the new `Envelope.originator` field (myelin#161).
 *
 * Precedence rule we assert (delegates to myelin's `getActorPrincipal`):
 *   1. `envelope.originator?.identity`  ← policy-attribution claim
 *      (originator still dual-reads the deprecated `principal` key
 *      during the R2 transition window)
 *   2. `envelope.signed_by[0]?.identity` ← legacy compat for pre-#161 envelopes
 *      (stamp-level `principal` was retired in myelin#184 / R11)
 *   3. `payload.agent_id`                 ← adapter-direct dispatches with no chain
 *
 * Tamper case is covered by the chain-verification suite above — `originator`
 * is in myelin's SIGNABLE_FIELDS, so mutating either `identity`/`principal`
 * or `attribution` after signing invalidates the chain. We add one explicit
 * tamper test here to pin the contract from cortex's side.
 */
describe("dispatch-listener — originator (cortex#346 / myelin#161)", () => {
  test("originator.principal wins over signed_by[0].identity for engine lookup", async () => {
    // When both are present, the policy engine must see the originator's
    // principal id (the actor the signer is attesting on behalf of), NOT
    // the signer's principal id. This decouples policy attribution from
    // signer identity — the cortex-as-relay case.
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = new PolicyEngine({
      principals: [
        {
          id: "alice",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    // Signer is the cortex agent; the originator is alice (the human the
    // agent is acting on behalf of). Engine must resolve `alice`, not `cortex`.
    env.signed_by = [
      {
        method: "ed25519",
        identity: "did:mf:cortex",
        signature: "a".repeat(88),
        at: "2026-05-19T12:00:00Z",
      },
    ];
    env.originator = {
      // R2 (originator dual-read still active): the `principal` key is
      // accepted alongside `identity` until the originator R2 lockstep
      // PR. Stamp-level `principal` was retired in myelin#184 / R11.
      principal: "did:mf:alice",
      attribution: "adapter-resolved",
    };

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.principalId).toBe("alice");
  });

  test("originator absent + signed_by[0].identity present → falls back to signer (legacy compat)", async () => {
    // Pre-myelin#161 envelopes have no `originator`. Behaviour must remain
    // identical to the pre-#346 path: principal id is taken from the
    // first stamp in the chain.
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = new PolicyEngine({
      principals: [
        {
          id: "cortex",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.signed_by = [
      {
        method: "ed25519",
        identity: "did:mf:cortex",
        signature: "a".repeat(88),
        at: "2026-05-19T12:00:00Z",
      },
    ];
    // No env.originator on purpose — legacy envelope.

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.principalId).toBe("cortex");
  });

  test("originator + signed_by both absent → falls back to payload.agent_id", async () => {
    // Adapter-direct (non-bus) dispatch path: no signed chain, no
    // originator. Runner accepts the payload's `agent_id` as the
    // principal id (belt-and-braces fallback called out in cortex#346
    // "Out of scope" — keep behaviour).
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = new PolicyEngine({
      principals: [
        {
          id: "cortex",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    // makeReceivedEnvelope defaults `payload.agent_id = "cortex"` and
    // adds no signed_by / no originator.
    r.trigger(
      makeReceivedEnvelope(),
      CANONICAL_CORTEX_CHAT_SUBJECT,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.principalId).toBe("cortex");
  });

  test("cryptoVerify:true — tampered originator on signed envelope → chain_verification_failed deny", async () => {
    // myelin#161 added `originator` to SIGNABLE_FIELDS. Mutating either
    // sub-field (principal OR attribution) after signing must invalidate
    // the chain — proving cortex inherits the protection automatically
    // by delegating verification to myelin's canonicalize.
    const { nkeyPub, privateKeyBase64 } = generateEd25519KeyPairForRunner();
    const cortex = agentFixtureForRunner({
      id: "cortex",
      trust: ["cortex"],
      nkey_pub: nkeyPub,
    });
    const resolver = runnerResolverWith(cortex);

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: true,
    });
    await listener.start();
    await router.start();

    // Sign the envelope WITH originator → signature commits to it.
    const base = makeReceivedEnvelope() as Parameters<typeof signEnvelope>[0];
    const baseWithOriginator = {
      ...base,
      originator: {
        principal: "did:mf:cortex",
        attribution: "adapter-resolved",
      },
    } as unknown as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(
      baseWithOriginator,
      privateKeyBase64,
      "did:mf:cortex",
    );

    // Tamper: swap the originator principal to a different DID
    // post-sign. Chain bytes no longer match the signature.
    const tampered: Envelope = {
      ...(signed as Envelope),
      originator: {
        principal: "did:mf:mallory",
        attribution: "adapter-resolved",
      },
    };

    r.trigger(tampered, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.denied",
      "dispatch.task.failed",
    ]);
    const denied = r.published[0]!;
    const reason = denied.payload.reason as {
      kind: string;
      chain_reason?: { kind: string };
    };
    expect(reason.kind).toBe("chain_verification_failed");
    expect(reason.chain_reason?.kind).toBe("crypto_verify_failed");
    expect(optsCaptured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cortex#486 — originator-DID resolution at the dispatch listener.
//
// Pre-#486 history: cortex#482 + PR #483 (Echo R1 major) wired a resolver-
// side reverse-lookup that mapped platform-prefixed originator DIDs
// (`did:mf:<platform>-<authorId>`) back to a registered principal id via
// `engine.lookupPrincipalIdByPlatformId`. That cleared the chat round-
// trip but at the wrong layer: per CONTEXT.md §Dispatch-source the
// adapter is required to populate `originator.identity` with the
// RESOLVED principal DID at publish time. cortex#486 moved the lookup to
// `adapterOriginatorIdentity` in `src/bus/dispatch-source-publisher.ts`,
// so by the time an envelope reaches the listener the originator is
// already `did:mf:<principal-id>` — a simple `did:mf:` strip suffices.
//
// These tests pin the post-#486 listener contract: round-trip principal
// DIDs through unchanged, and fail closed on platform-prefixed shapes
// that should never appear on the wire anymore.
// ---------------------------------------------------------------------------

describe("dispatch-listener — originator DID resolution (cortex#486)", () => {
  test("originator.identity = did:mf:<principal-id> → strips prefix, no reverse lookup", async () => {
    // Post-#486 contract: the adapter has already resolved
    // `(platform, authorId)` to `andreas` at publish time. The
    // listener strips `did:mf:` and forwards `andreas` to the engine.
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = new PolicyEngine({
      principals: [
        {
          id: "andreas",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
          // platform_ids stays on the principal — still used by the
          // engine's `lookupPrincipalIdByPlatformId` surface (consumed
          // at publish time by the dispatch-source).
          platform_ids: { discord: ["1134325176796987522"] },
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.originator = {
      identity: "did:mf:andreas",
      attribution: "adapter-resolved",
    };

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.principalId).toBe("andreas");
    // Allow path: engine grants dispatch.cortex → success lifecycle.
    expect(r.published.map((e) => e.type)).toEqual([
      "system.access.allowed",
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("platform-prefixed originator DID (`did:mf:discord-<id>`) → forwarded raw, engine denies unknown_principal", async () => {
    // Defence-in-depth — pre-#486 the listener would back-resolve this
    // shape. Post-#486 it MUST NOT: a platform-prefixed DID landing on
    // the wire indicates either (a) a stale pre-#486 publisher (bug),
    // (b) a forged envelope, or (c) a non-cortex publisher with broken
    // semantics. The listener forwards the raw `discord-<id>` tail; the
    // engine denies `unknown_principal`. No security regression.
    const captured: { principalId: string; intent: Intent }[] = [];
    const engine = new PolicyEngine({
      principals: [
        {
          id: "andreas",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
          platform_ids: { discord: ["1134325176796987522"] },
        },
      ],
      roles: [{ id: "operator", capabilities: ["dispatch.cortex"] }],
    });
    const origCheck = engine.check.bind(engine);
    engine.check = (principalId, intent) => {
      captured.push({ principalId, intent });
      return origCheck(principalId, intent);
    };

    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engine,
    });
    await listener.start();
    await router.start();

    const env = makeReceivedEnvelope();
    env.originator = {
      // This shape is no longer produced by `adapterOriginatorIdentity`
      // post-#486. If it lands here, treat it as opaque and let the
      // engine deny — no implicit back-resolution.
      identity: "did:mf:discord-1134325176796987522",
      attribution: "adapter-resolved",
    };

    r.trigger(env, CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(captured).toHaveLength(1);
    // Listener strips `did:mf:` and forwards the raw tail verbatim.
    expect(captured[0]!.principalId).toBe("discord-1134325176796987522");
    const types = r.published.map((e) => e.type);
    expect(types).toContain("system.access.denied");
    expect(types).toContain("dispatch.task.failed");
  });
});

// ---------------------------------------------------------------------------
// cortex#492 — dispatch-stage tracing
// ---------------------------------------------------------------------------

/**
 * Extract the ordered `stage` values from every `system.dispatch.stage`
 * envelope in publish order. The join key (`correlation_id` / `task_id`)
 * and `outcome` ride the payload — tests assert on the sequence + the
 * payload shape.
 */
function traceStages(published: Envelope[]): string[] {
  return published
    .filter((e) => e.type === "system.dispatch.stage")
    .map((e) => e.payload.stage as string);
}

function traceEnvelopes(published: Envelope[]): Envelope[] {
  return published.filter((e) => e.type === "system.dispatch.stage");
}

describe("dispatch-listener — stage tracing (cortex#492)", () => {
  test("OFF by default → no system.dispatch.stage envelopes emitted", async () => {
    // Guard against an ambient env var leaking into the default path.
    const prior = process.env.CORTEX_TRACE_DISPATCH;
    delete process.env.CORTEX_TRACE_DISPATCH;
    try {
      const r = recordingRuntime();
      const { factory } = fakeFactory(SUCCESS_RESULT);
      const listener = createDispatchListener({
        runtime: r.runtime,
        source: SOURCE,
        ccSessionFactory: factory,
        policyEngine: engineGranting(["dispatch.cortex"]),
        // traceDispatch omitted → reads env (unset) → off
      });
      await listener.start();

      r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Lifecycle + audit envelopes still flow; ZERO trace envelopes.
      expect(traceEnvelopes(r.published)).toHaveLength(0);
      expect(r.published.map((e) => e.type)).toEqual([
        "system.access.allowed",
        "dispatch.task.started",
        "dispatch.task.completed",
      ]);
    } finally {
      if (prior === undefined) delete process.env.CORTEX_TRACE_DISPATCH;
      else process.env.CORTEX_TRACE_DISPATCH = prior;
    }
  });

  test("CORTEX_TRACE_DISPATCH=1 env var enables tracing", async () => {
    const prior = process.env.CORTEX_TRACE_DISPATCH;
    process.env.CORTEX_TRACE_DISPATCH = "1";
    try {
      const r = recordingRuntime();
      const { factory } = fakeFactory(SUCCESS_RESULT);
      const listener = createDispatchListener({
        runtime: r.runtime,
        source: SOURCE,
        ccSessionFactory: factory,
        policyEngine: engineGranting(["dispatch.cortex"]),
      });
      await listener.start();

      r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(traceEnvelopes(r.published).length).toBeGreaterThan(0);
    } finally {
      if (prior === undefined) delete process.env.CORTEX_TRACE_DISPATCH;
      else process.env.CORTEX_TRACE_DISPATCH = prior;
    }
  });

  test("allow path emits the full ordered stage trace through harness-dispatched", async () => {
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      traceDispatch: true,
    });
    await listener.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // No trustResolver wired → chain-verify-start / chain-verified stages
    // are skipped (the verifier is the only legitimate skip path). Every
    // other gate the allow path passes through emits a trace, in order,
    // ending with session-spawning → started.
    expect(traceStages(r.published)).toEqual([
      "received",
      "subject-matched",
      "parsed",
      "recipient-validated",
      "policy-decision",
      "session-spawning",
      "started",
    ]);
    // Each trace carries the dispatch's correlation/task join key.
    for (const env of traceEnvelopes(r.published)) {
      expect(env.payload.correlation_id).toBe(TASK_ID);
      expect(env.payload.task_id).toBe(TASK_ID);
    }
    // session-spawning records the substrate that was spawned.
    const spawning = traceEnvelopes(r.published).find(
      (e) => e.payload.stage === "session-spawning",
    );
    expect(spawning?.payload.outcome).toBe("info");
    expect(spawning?.payload.detail).toBe("claude-code");
  });

  test("subject-rejected: the cortex#491 silent gap is now a visible trace", async () => {
    // An envelope whose wire subject matches NO declared pattern used to
    // vanish silently (the `return` at the top of the onEnvelope handler).
    // With tracing on, a `received` → `subject-rejected` pair is emitted
    // and the dispatch goes no further.
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      traceDispatch: true,
    });
    await listener.start();

    // A subject for a DIFFERENT principal — won't match the listener's
    // `local.metafactory.tasks.*.>` pattern.
    r.trigger(
      makeReceivedEnvelope(),
      "local.someoneelse.tasks.@did-mf-other.chat",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(traceStages(r.published)).toEqual(["received", "subject-rejected"]);
    const rejected = traceEnvelopes(r.published).find(
      (e) => e.payload.stage === "subject-rejected",
    );
    expect(rejected?.payload.outcome).toBe("fail");
    expect(rejected?.payload.detail).toContain("matched none of");
    // No lifecycle / harness envelopes — the dispatch stopped at the gate.
    expect(
      r.published.filter((e) => e.type.startsWith("dispatch.task.")),
    ).toHaveLength(0);
  });

  test("policy-deny path emits a policy-decided fail trace before short-circuit", async () => {
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      // Grant a different capability so `dispatch.cortex` misses.
      policyEngine: engineGranting(["other.thing"]),
      traceDispatch: true,
    });
    await listener.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stages = traceStages(r.published);
    expect(stages).toEqual([
      "received",
      "subject-matched",
      "parsed",
      "recipient-validated",
      "policy-decision",
    ]);
    const policy = traceEnvelopes(r.published).find(
      (e) => e.payload.stage === "policy-decision",
    );
    expect(policy?.payload.outcome).toBe("fail");
    // detail carries the engine deny reason kind.
    expect(typeof policy?.payload.detail).toBe("string");
  });

  test("policy-engine-uninitialised path emits a policy-decided fail trace", async () => {
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      // no policyEngine → fail-closed
      traceDispatch: true,
    });
    await listener.start();

    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(traceStages(r.published)).toEqual([
      "received",
      "subject-matched",
      "parsed",
      "recipient-validated",
      "policy-decision",
    ]);
    const policy = traceEnvelopes(r.published).find(
      (e) => e.payload.stage === "policy-decision",
    );
    expect(policy?.payload.detail).toBe("policy_engine_uninitialised");
  });

  test("chain-verify-start brackets the verify await (hang-proof) then chain-verified on pass", async () => {
    // With a trustResolver wired, the verify await runs — and the
    // `chain-verify-start` trace is emitted SYNCHRONOUSLY before it, so a
    // hang inside verifySignedByChain would leave chain-verify-start in
    // the log with no chain-verified. An adapter-originated dispatch has
    // an empty signed_by[] (rejectEmpty: false) → verification passes.
    const cortex = agentFixtureForRunner({
      id: "cortex",
      trust: ["cortex"],
      nkey_pub: "U" + "B".repeat(55),
    });
    const resolver = runnerResolverWith(cortex);
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      trustResolver: resolver,
      receivingAgentId: "cortex",
      principalId: "andreas",
      cryptoVerify: false,
      traceDispatch: true,
    });
    await listener.start();

    // Empty signed_by[] (adapter-originated) → verification passes.
    r.trigger(makeReceivedEnvelope(), CANONICAL_CORTEX_CHAT_SUBJECT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stages = traceStages(r.published);
    // chain-verify-start lands immediately before chain-verified, between
    // recipient-validated and policy-decision.
    expect(stages).toEqual([
      "received",
      "subject-matched",
      "parsed",
      "recipient-validated",
      "chain-verify-start",
      "chain-verified",
      "policy-decision",
      "session-spawning",
      "started",
    ]);
    const start = stages.indexOf("chain-verify-start");
    const verified = stages.indexOf("chain-verified");
    expect(start).toBeGreaterThanOrEqual(0);
    // start strictly precedes verified — the bracket is correctly ordered.
    expect(start).toBeLessThan(verified);
  });

  test("recipient-mismatch path emits a recipient-validated fail trace", async () => {
    const r = recordingRuntime();
    const { factory } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      source: SOURCE,
      ccSessionFactory: factory,
      policyEngine: engineGranting(["dispatch.cortex"]),
      traceDispatch: true,
    });
    await listener.start();

    // Canonical subject targets cortex, but the envelope's target_assistant
    // / payload agent disagree → recipient mismatch.
    const env = makeReceivedEnvelope({ agent_id: "cortex" });
    // Subject's assistant segment (@did-mf-other) won't match the
    // envelope target (did:mf:cortex) → mismatch.
    r.trigger(env, "local.metafactory.tasks.@did-mf-other.chat");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stages = traceStages(r.published);
    // received → subject-matched (tasks.*.> matches) → parsed →
    // recipient-mismatch FAIL (stops here).
    expect(stages).toEqual([
      "received",
      "subject-matched",
      "parsed",
      "recipient-mismatch",
    ]);
    const recipient = traceEnvelopes(r.published).find(
      (e) => e.payload.stage === "recipient-mismatch",
    );
    expect(recipient?.payload.outcome).toBe("fail");
  });
});
