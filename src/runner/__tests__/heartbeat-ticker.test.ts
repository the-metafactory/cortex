/**
 * cortex#361 — tests for `HeartbeatTicker`.
 *
 * Coverage axes:
 *   1. Lifecycle — `start()` publishes the first heartbeat immediately;
 *     `setInterval` fires subsequent heartbeats at `intervalMs`; `stop()`
 *     halts the recurring tick.
 *   2. Phase tracking — `notePhase()` updates the cached phase and resets
 *     the last-activity timestamp; the next tick carries the new phase.
 *   3. Iteration counter — monotonically increments, starts at 1.
 *   4. Failure mode — a rejecting `runtime.publish` is swallowed (caller's
 *     dispatch path must NOT see the failure).
 *   5. Idempotency — `stop()` is safe to call twice; `notePhase()` after
 *     `stop()` drops silently.
 *   6. Envelope shape — every emitted envelope is a valid
 *     `system.agent.heartbeat` envelope per the schema (no shape drift).
 *
 * Echo cortex#363 minor — uses short real `setTimeout` / `setInterval`
 * intervals (no fake-timer mocking). The bounds on tick-count
 * assertions are deliberately loose (`>= 2` rather than `>= 3`) so a
 * loaded CI runner's scheduling jitter doesn't flake the suite. The
 * `mock` import from `bun:test` is used only for the recording
 * `runtime.publish` stub, not for timer mocking.
 */

import { describe, expect, test, mock } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { validateEnvelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SystemEventSource } from "../../bus/system-events";
import { EventEmitter } from "events";
import type { CCSession } from "../cc-session";
import {
  HeartbeatTicker,
  attachHeartbeatToCCSession,
} from "../heartbeat-ticker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: SystemEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const CORRELATION_UUID = "11111111-1111-4111-8111-111111111111";

interface RecordingRuntime {
  runtime: MyelinRuntime;
  published: Envelope[];
}

function makeRecordingRuntime(opts?: {
  rejectWith?: Error;
}): RecordingRuntime {
  const published: Envelope[] = [];
  const runtime = {
    publish: mock(async (envelope: Envelope) => {
      published.push(envelope);
      if (opts?.rejectWith) {
        throw opts.rejectWith;
      }
    }),
    // Unused methods — the ticker only touches `publish`.
    onEnvelope: mock(() => ({ unregister: () => {} })),
  } as unknown as MyelinRuntime;
  return { runtime, published };
}

/**
 * Sleep helper — yields to the microtask queue so any pending
 * `void promise.catch(...)` callbacks run before assertions.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HeartbeatTicker.start", () => {
  test("publishes first heartbeat immediately", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
    });
    try {
      await flushMicrotasks();
      expect(published.length).toBe(1);
      const env = published[0]!;
      expect(env.type).toBe("system.agent.heartbeat");
      expect(env.source).toBe("metafactory.cortex.local");
      expect(env.payload).toMatchObject({
        agent_id: "echo",
        task_id: "task-abc",
        correlation_id: CORRELATION_UUID,
        phase: "thinking",
        iteration: 1,
      });
      expect(env.correlation_id).toBe(CORRELATION_UUID);
      expect(validateEnvelope(env).ok).toBe(true);
    } finally {
      ticker.stop();
    }
  });

  test("subsequent heartbeats fire on interval", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 25, // short interval so the test finishes fast
    });
    try {
      // Wait long enough for ≥ 2 ticks. Bun's setInterval is real; the
      // ticker emits the first heartbeat synchronously then schedules.
      // Loose bound to absorb CI scheduling jitter (Echo cortex#363
      // minor).
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      expect(published.length).toBeGreaterThanOrEqual(2);
      // iteration counter is monotonic + sequential.
      for (let i = 0; i < published.length; i++) {
        const env = published[i]!;
        expect(env.payload.iteration).toBe(i + 1);
      }
    } finally {
      ticker.stop();
    }
  });

  test("uses default interval when intervalMs is omitted", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      // intervalMs omitted -> 30_000 default
    });
    try {
      await flushMicrotasks();
      // Only the immediate first heartbeat — the 30 s interval hasn't
      // elapsed in this test.
      expect(published.length).toBe(1);
    } finally {
      ticker.stop();
    }
  });

  test("throws on double-start without stop", () => {
    const { runtime } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
    });
    try {
      expect(() =>
        ticker.start({
          runtime,
          source: SOURCE,
          agentId: "echo",
          taskId: "task-xyz",
          correlationId: CORRELATION_UUID,
          intervalMs: 10_000,
        }),
      ).toThrow(/start called twice/);
    } finally {
      ticker.stop();
    }
  });

  test("initialPhase overrides the default thinking phase", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
      initialPhase: "streaming_response",
    });
    try {
      await flushMicrotasks();
      expect(published[0]!.payload.phase).toBe("streaming_response");
    } finally {
      ticker.stop();
    }
  });
});

describe("HeartbeatTicker.notePhase", () => {
  test("next tick carries the updated phase", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 25,
    });
    try {
      await flushMicrotasks();
      ticker.notePhase("tool_use");
      // Wait for at least one more tick. Loose bound for CI jitter
      // (Echo cortex#363 minor).
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(published.length).toBeGreaterThanOrEqual(2);
      expect(published[published.length - 1]!.payload.phase).toBe("tool_use");
    } finally {
      ticker.stop();
    }
  });

  test("resets last_activity_ms_ago to ~0", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 25,
    });
    try {
      // Wait so the first heartbeat's last_activity creeps up.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      ticker.notePhase("text" as unknown as "streaming_response");
      // Tick interval is 25ms — wait one more tick.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const last = published[published.length - 1]!;
      const lastActivity = last.payload.last_activity_ms_ago as number;
      // Should be within one tick of zero (loose bound — CI clocks vary).
      expect(lastActivity).toBeLessThan(60);
    } finally {
      ticker.stop();
    }
  });

  test("dropped silently after stop()", () => {
    const { runtime } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
    });
    ticker.stop();
    // Should not throw and should not crash.
    expect(() => ticker.notePhase("tool_use")).not.toThrow();
  });
});

describe("HeartbeatTicker.stop", () => {
  test("halts the recurring tick", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 20,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const countBeforeStop = published.length;
    ticker.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(published.length).toBe(countBeforeStop);
  });

  test("is idempotent", () => {
    const { runtime } = makeRecordingRuntime();
    const ticker = new HeartbeatTicker();
    ticker.start({
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
    });
    expect(() => {
      ticker.stop();
      ticker.stop();
      ticker.stop();
    }).not.toThrow();
  });

  test("safe to call before start (no-op)", () => {
    const ticker = new HeartbeatTicker();
    expect(() => ticker.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// attachHeartbeatToCCSession (Echo cortex#363 major — extracted helper)
// ---------------------------------------------------------------------------

describe("attachHeartbeatToCCSession", () => {
  test("wires tool-use → tool_use phase", async () => {
    const { runtime, published } = makeRecordingRuntime();
    // EventEmitter stand-in for CCSession — production callers pass the
    // real class; the helper only needs `.on`.
    const session = new EventEmitter() as unknown as CCSession;
    const handle = attachHeartbeatToCCSession(session, {
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 25,
    });
    try {
      await flushMicrotasks();
      (session as unknown as EventEmitter).emit("tool-use", "Read", {});
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(
        published[published.length - 1]!.payload.phase,
      ).toBe("tool_use");
    } finally {
      handle.stop();
    }
  });

  test("session 'result' event stops the ticker", async () => {
    const { runtime, published } = makeRecordingRuntime();
    const session = new EventEmitter() as unknown as CCSession;
    const handle = attachHeartbeatToCCSession(session, {
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 25,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    (session as unknown as EventEmitter).emit("result", "done");
    const countAtStop = published.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(published.length).toBe(countAtStop);
    handle.stop(); // idempotent — already stopped via the listener
  });

  test("returned handle stop() is idempotent", () => {
    const { runtime } = makeRecordingRuntime();
    const session = new EventEmitter() as unknown as CCSession;
    const handle = attachHeartbeatToCCSession(session, {
      runtime,
      source: SOURCE,
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      intervalMs: 10_000,
    });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});

describe("HeartbeatTicker failure isolation", () => {
  test("rejecting runtime.publish does not bubble out", async () => {
    const { runtime, published } = makeRecordingRuntime({
      rejectWith: new Error("nats unavailable"),
    });
    const ticker = new HeartbeatTicker();
    expect(() =>
      ticker.start({
        runtime,
        source: SOURCE,
        agentId: "echo",
        taskId: "task-abc",
        correlationId: CORRELATION_UUID,
        intervalMs: 20,
      }),
    ).not.toThrow();
    try {
      // Let the first immediate publish + one interval tick settle. The
      // promise rejection from runtime.publish must be caught internally
      // (no unhandled-rejection escape).
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      // publish was still ATTEMPTED — failure mode is log+continue, not skip.
      // Loose bound for CI scheduling jitter (Echo cortex#363 minor).
      expect(published.length).toBeGreaterThanOrEqual(1);
    } finally {
      ticker.stop();
    }
  });
});
