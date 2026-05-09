/**
 * MIG-4.6: tests for `dispatch.task.*` envelope constructors.
 *
 * Mirrors the coverage axes of `system-events.test.ts`:
 *   1. Shape — fields match G-1111 §3.4 verbatim, lifecycle moments land
 *      in payload (not envelope top-level), optional fields are omitted
 *      (not `undefined`-valued) when callers don't pass them.
 *   2. Validation — every constructed envelope passes the vendored myelin
 *      schema. Catches regressions where someone adds a field but forgets
 *      to keep the envelope shape (sovereignty, source pattern, correlation
 *      UUID format).
 *   3. Correlation — `task_id` doubles as `correlation_id` by default; an
 *      explicit `correlationId` opt overrides. This is the load-bearing
 *      contract that lets surfaces stitch started → completed/failed/aborted.
 */

import { describe, expect, test } from "bun:test";
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
  type DispatchEventSource,
} from "../dispatch-events";

const SOURCE: DispatchEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-05-09T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-05-09T12:01:30.000Z");

describe("createDispatchTaskStartedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(env.type).toBe("dispatch.task.started");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("explicit correlationId overrides task_id default", () => {
    const customCorr = "22222222-2222-4222-8222-222222222222";
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      correlationId: customCorr,
    });
    expect(env.correlation_id).toBe(customCorr);
    // task_id stays in payload either way
    expect(env.payload.task_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    const b = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("createDispatchTaskCompletedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
    });
    expect(env.type).toBe("dispatch.task.completed");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      completed_at: "2026-05-09T12:01:30.000Z",
    });
    // result_summary omitted when not provided
    expect("result_summary" in env.payload).toBe(false);
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("result_summary lands in payload when provided", () => {
    const env = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      resultSummary: "Refactored two files; tests green.",
    });
    expect(env.payload).toMatchObject({
      result_summary: "Refactored two files; tests green.",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createDispatchTaskFailedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      failedAt: COMPLETED_AT,
      errorSummary: "claude exited 1: stderr noise",
    });
    expect(env.type).toBe("dispatch.task.failed");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      failed_at: "2026-05-09T12:01:30.000Z",
      error_summary: "claude exited 1: stderr noise",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createDispatchTaskAbortedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createDispatchTaskAbortedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      abortedAt: COMPLETED_AT,
      reason: "timeout",
    });
    expect(env.type).toBe("dispatch.task.aborted");
    expect(env.payload).toMatchObject({
      task_id: TASK_ID,
      agent_id: "cortex",
      started_at: "2026-05-09T12:00:00.000Z",
      aborted_at: "2026-05-09T12:01:30.000Z",
      reason: "timeout",
    });
    expect(env.correlation_id).toBe(TASK_ID);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("reason is preserved verbatim (free-form)", () => {
    const env = createDispatchTaskAbortedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
      abortedAt: COMPLETED_AT,
      reason: "operator-cancel: SIGINT received during shutdown drain",
    });
    expect(env.payload.reason).toBe(
      "operator-cancel: SIGINT received during shutdown drain",
    );
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("dispatch.task.* — correlation_id contract", () => {
  test("all four lifecycle events for one task share one correlation_id by default", () => {
    const common = {
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    };
    const started = createDispatchTaskStartedEvent(common);
    const completed = createDispatchTaskCompletedEvent({
      ...common,
      completedAt: COMPLETED_AT,
    });
    const failed = createDispatchTaskFailedEvent({
      ...common,
      failedAt: COMPLETED_AT,
      errorSummary: "x",
    });
    const aborted = createDispatchTaskAbortedEvent({
      ...common,
      abortedAt: COMPLETED_AT,
      reason: "timeout",
    });

    expect(started.correlation_id).toBe(TASK_ID);
    expect(completed.correlation_id).toBe(TASK_ID);
    expect(failed.correlation_id).toBe(TASK_ID);
    expect(aborted.correlation_id).toBe(TASK_ID);
  });
});

describe("dispatch.task.* — data_residency parameterisation", () => {
  test("source without dataResidency defaults to NZ", () => {
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    });
    expect(env.sovereignty.data_residency).toBe("NZ");
  });

  test("source.dataResidency overrides the default for every lifecycle helper", () => {
    const sourceAU: DispatchEventSource = { ...SOURCE, dataResidency: "AU" };
    const common = {
      source: sourceAU,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: STARTED_AT,
    };
    const envs = [
      createDispatchTaskStartedEvent(common),
      createDispatchTaskCompletedEvent({ ...common, completedAt: COMPLETED_AT }),
      createDispatchTaskFailedEvent({ ...common, failedAt: COMPLETED_AT, errorSummary: "x" }),
      createDispatchTaskAbortedEvent({ ...common, abortedAt: COMPLETED_AT, reason: "timeout" }),
    ];
    for (const env of envs) {
      expect(env.sovereignty.data_residency).toBe("AU");
    }
  });
});
