import { describe, expect, test } from "bun:test";
import { processSessionEvent } from "../event-processor";
import type { IngestEvent } from "../types";

/**
 * IAW D.5 — sovereignty propagation through the event-processor.
 *
 * The processor is the single funnel from wire `IngestEvent` into typed
 * `SessionUpsertData` for the cloud worker's D1 layer. These tests pin the
 * three sovereignty pathways (task_started, task_completed fallback,
 * progress fallback) so a future refactor of the lifter (`extractSovereignty`)
 * can't silently drop fields between wire and persistence.
 */

function baseEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    event_id: "evt-1",
    event_type: "agent.task.started",
    timestamp: "2026-05-16T00:00:00.000Z",
    session_id: "sess-1",
    agent_id: "luna",
    agent_name: "Luna",
    payload: {},
    ...overrides,
  };
}

describe("processSessionEvent — sovereignty propagation (IAW D.5)", () => {
  test("task_started lifts sovereignty into session upsert", () => {
    const event = baseEvent({
      event_type: "agent.task.started",
      sovereignty: {
        classification: "federated",
        data_residency: "nz",
        home_operator: "jcfischer",
      },
    });
    const out = processSessionEvent("andreas", event);
    expect(out.type).toBe("task_started");
    if (out.type !== "task_started") return;
    expect(out.session.sovereignty).toEqual({
      classification: "federated",
      dataResidency: "nz",
      homeOperator: "jcfischer",
    });
  });

  test("task_completed fallback session carries sovereignty", () => {
    const event = baseEvent({
      event_type: "agent.task.completed",
      payload: { duration_ms: 1000 },
      sovereignty: {
        classification: "public",
        home_operator: "ops-mesh",
      },
    });
    const out = processSessionEvent("andreas", event);
    expect(out.type).toBe("task_completed");
    if (out.type !== "task_completed") return;
    expect(out.fallbackSession?.sovereignty).toEqual({
      classification: "public",
      dataResidency: null,
      homeOperator: "ops-mesh",
    });
  });

  test("progress fallback session carries sovereignty", () => {
    const event = baseEvent({
      event_type: "agent.progress",
      sovereignty: {
        classification: "local",
        data_residency: "eu",
        home_operator: "andreas",
      },
    });
    const out = processSessionEvent("andreas", event);
    expect(out.type).toBe("progress");
    if (out.type !== "progress") return;
    expect(out.fallbackSession?.sovereignty).toEqual({
      classification: "local",
      dataResidency: "eu",
      homeOperator: "andreas",
    });
  });

  test("absent sovereignty block yields undefined (pre-IAW publisher path)", () => {
    const event = baseEvent({ event_type: "agent.task.started" });
    const out = processSessionEvent("andreas", event);
    expect(out.type).toBe("task_started");
    if (out.type !== "task_started") return;
    expect(out.session.sovereignty).toBeUndefined();
  });

  test("empty sovereignty block yields undefined (all fields nullish)", () => {
    // Defensive — relay publishes the field but no values landed. Treat
    // as absent so the worker writes NULL across the columns rather than
    // an empty placeholder.
    const event = baseEvent({
      event_type: "agent.task.started",
      sovereignty: {},
    });
    const out = processSessionEvent("andreas", event);
    if (out.type !== "task_started") throw new Error("wrong branch");
    expect(out.session.sovereignty).toBeUndefined();
  });

  test("partial sovereignty (only data_residency) survives — classification null", () => {
    const event = baseEvent({
      event_type: "agent.task.started",
      sovereignty: { data_residency: "us-east" },
    });
    const out = processSessionEvent("andreas", event);
    if (out.type !== "task_started") throw new Error("wrong branch");
    expect(out.session.sovereignty).toEqual({
      classification: null,
      dataResidency: "us-east",
      homeOperator: null,
    });
  });
});
