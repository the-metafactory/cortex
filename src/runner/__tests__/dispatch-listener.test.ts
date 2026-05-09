/**
 * MIG-4.5/4.6 — tests for the runner dispatch listener.
 *
 * Coverage axes:
 *   1. Registration shape — surfaceConfig matches G-1111 §4 SurfaceAdapter
 *      contract; default subjects derive from source.org.
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
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import { createSurfaceRouter, type SurfaceRouter } from "../../bus/surface-router";
import type { SystemEventSource } from "../../bus/system-events";
import {
  createDispatchListener,
  type CCSessionFactory,
  type DispatchTaskReceivedPayload,
} from "../dispatch-listener";
import type { CCSessionResult } from "../cc-session";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SOURCE: SystemEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

const TASK_ID = "11111111-1111-4111-8111-111111111111";

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
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  const published: Envelope[] = [];
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
      stop: async () => {},
    },
    published,
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
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
  optsCaptured: Array<Parameters<CCSessionFactory>[0]>;
} {
  const optsCaptured: Array<Parameters<CCSessionFactory>[0]> = [];
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
  test("default subjects derive from source.org", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.surfaceConfig.subjects).toEqual([
      "local.metafactory.dispatch.task.received",
    ]);
  });

  test("custom subjects honored when provided", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      router,
      source: SOURCE,
      subjects: ["local.test.dispatch.task.received"],
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.surfaceConfig.subjects).toEqual([
      "local.test.dispatch.task.received",
    ]);
  });

  test("adapter id defaults to runner-dispatch-listener", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.surfaceConfig.id).toBe("runner-dispatch-listener");
  });

  test("custom adapter id honored", () => {
    const { runtime } = recordingRuntime();
    const router = createSurfaceRouter(runtime);
    const listener = createDispatchListener({
      runtime,
      router,
      source: SOURCE,
      adapterId: "runner-dispatch-listener-test",
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    expect(listener.surfaceConfig.id).toBe("runner-dispatch-listener-test");
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
      router,
      source: SOURCE,
      ccSessionFactory: factory,
    });
    await listener.start();
    await router.start();

    // Trigger an envelope through the runtime fan-out path
    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");

    // Wait briefly for async render to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have emitted exactly two lifecycle events
    expect(r.published).toHaveLength(2);
    const types = r.published.map((e) => e.type);
    expect(types).toEqual([
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    // All share one correlation_id (the task_id)
    for (const env of r.published) {
      expect(env.correlation_id).toBe(TASK_ID);
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
      router,
      source: SOURCE,
      ccSessionFactory: factory,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = r.published.find((e) => e.type === "dispatch.task.completed");
    expect(completed).toBeDefined();
    expect(completed?.payload.result_summary).toBe("Hello!");
  });

  test("CC opts plumbed from payload to factory (snake_case → camelCase)", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const { factory, optsCaptured } = fakeFactory(SUCCESS_RESULT);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: factory,
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
        operator: "andreas",
        resume_session_id: "prior-session",
      }),
      "local.metafactory.dispatch.task.received",
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
    expect(opts.operator).toBe("andreas");
    expect(opts.resumeSessionId).toBe("prior-session");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — failure paths
// ---------------------------------------------------------------------------

describe("dispatch-listener — failure paths", () => {
  test("non-zero exit code → started → failed", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(FAIL_RESULT).factory,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    const failed = r.published[1]!;
    expect(failed.payload.error_summary).toBe("claude exited 1");
    expect(failed.correlation_id).toBe(TASK_ID);
  });

  test("exit code 143 (SIGTERM/timeout) → started → aborted", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(TIMEOUT_RESULT).factory,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.aborted",
    ]);
    expect(r.published[1]!.payload.reason).toBe("timeout");
  });

  test("aborted=true + exitCode=1 (canonical inactivity timeout) → started → aborted", async () => {
    // Echo round-1 W1 regression: the inactivity-timeout path settles
    // wait() via the "error" listener with exitCode: 1, NOT 143. The
    // listener must use result.aborted as the source of truth.
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(ABORTED_BY_FLAG_RESULT).factory,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.aborted",
    ]);
    expect(r.published[1]!.payload.reason).toBe("timeout");
  });

  test("factory throws → started → failed", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const throwingFactory: CCSessionFactory = () => {
      throw new Error("session spawn failed: claude binary missing");
    };
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: throwingFactory,
    });
    await listener.start();
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    expect(r.published[1]!.payload.error_summary).toContain("session spawn failed");
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
      router,
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
    r.trigger(malformed, "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });

  test("missing task_id → no-op", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
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
    r.trigger(malformed, "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
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
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await listener.start(); // should be a no-op
    await router.start();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Single registration → exactly one started + one completed (not double)
    expect(r.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
  });

  test("stop() unregisters; subsequent envelopes are dropped", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await router.start();
    await listener.stop();

    r.trigger(makeReceivedEnvelope(), "local.metafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });

  test("stop() is idempotent — second call is a no-op", async () => {
    const r = recordingRuntime();
    const router = createSurfaceRouter(r.runtime);
    const listener = createDispatchListener({
      runtime: r.runtime,
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
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
      router,
      source: SOURCE,
      ccSessionFactory: fakeFactory(SUCCESS_RESULT).factory,
    });
    await listener.start();
    await router.start();

    // Same envelope, different subject — should not match
    r.trigger(makeReceivedEnvelope(), "local.othermetafactory.dispatch.task.received");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(r.published).toHaveLength(0);
  });
});
