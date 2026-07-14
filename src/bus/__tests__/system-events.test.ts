/**
 * MIG-3b-ii: tests for `system.*` envelope constructors.
 *
 * Two coverage axes:
 *   1. Shape — fields match G-1111 §3.5.4 verbatim, payload-only fields land
 *      in payload (not envelope top-level), optional fields are omitted (not
 *      `undefined`-valued) when callers don't pass them.
 *   2. Validation — every constructed envelope passes the vendored myelin
 *      schema. Catches regressions where someone adds a payload field but
 *      forgets to keep the schema-required envelope shape (sovereignty,
 *      source pattern, etc.).
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  adapterCorrelationKey,
  createAgentHeartbeatEvent,
  createSystemAccessDeniedEvent,
  createSystemAccessFilteredEvent,
  createSystemAdapterDegradedEvent,
  createSystemAdapterDisconnectedEvent,
  createSystemAdapterRecoveredEvent,
  createSystemDispatchStageEvent,
  createSystemInboundAbortedEvent,
  createSystemPluginControlRequestEvent,
  createSystemPluginControlResponseEvent,
  createSystemPluginReloadFailedEvent,
  createSystemPluginUnloadedEvent,
  type SystemEventSource,
} from "../system-events";
import { emitSystemAccessDenied } from "../emit-system-access-denied";
import { createAgentOnlineEvent } from "../agent-network/builders";
import type { MyelinRuntime } from "../myelin/runtime";

describe("adapterCorrelationKey", () => {
  test("formats `adapter:{id}:{iso}` per G-1111 §3.5.6", () => {
    const key = adapterCorrelationKey(
      "discord-luna",
      new Date("2026-05-09T12:34:56.789Z"),
    );
    expect(key).toBe("adapter:discord-luna:2026-05-09T12:34:56.789Z");
  });
});

describe("createSystemAdapterDegradedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemAdapterDegradedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
      thresholdMs: 60_000,
    });
    expect(env.type).toBe("system.adapter.degraded");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      platform: "discord",
      disconnected_since: "2026-05-09T12:00:00.000Z",
      threshold_ms: 60_000,
    });
    // No correlation_id (see file header — known spec gap).
    expect(env.correlation_id).toBeUndefined();
    // Sovereignty defaults match principal-only / no frontier.
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    const validation = validateEnvelope(env);
    expect(validation.ok).toBe(true);
  });

  test("optional fields land in payload when provided, omitted otherwise", () => {
    const withOpts = createSystemAdapterDegradedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
      thresholdMs: 60_000,
      lastConnected: new Date("2026-05-09T11:30:00.000Z"),
      reconnectAttempts: 4,
      shardId: 0,
    });
    expect(withOpts.payload).toMatchObject({
      last_connected: "2026-05-09T11:30:00.000Z",
      reconnect_attempts: 4,
      shard_id: 0,
    });

    const withoutOpts = createSystemAdapterDegradedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
      thresholdMs: 60_000,
    });
    expect("last_connected" in withoutOpts.payload).toBe(false);
    expect("reconnect_attempts" in withoutOpts.payload).toBe(false);
    expect("shard_id" in withoutOpts.payload).toBe(false);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createSystemAdapterDegradedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "x",
      platform: "discord",
      disconnectedSince: new Date(),
      thresholdMs: 60_000,
    });
    const b = createSystemAdapterDegradedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "x",
      platform: "discord",
      disconnectedSince: new Date(),
      thresholdMs: 60_000,
    });
    expect(a.id).not.toBe(b.id);
    // UUID v4 shape — Ajv's format check is the ground truth via validateEnvelope.
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("createSystemAdapterRecoveredEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemAdapterRecoveredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      degradedForMs: 14_200,
    });
    expect(env.type).toBe("system.adapter.recovered");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      platform: "discord",
      degraded_for_ms: 14_200,
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("disconnected_since lands in payload (used by surfaces to join the pair)", () => {
    const env = createSystemAdapterRecoveredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      degradedForMs: 14_200,
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
    });
    expect(env.payload).toMatchObject({
      disconnected_since: "2026-05-09T12:00:00.000Z",
    });
  });
});

describe("createSystemAdapterDisconnectedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemAdapterDisconnectedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date("2026-05-09T12:00:00.000Z"),
      wasClean: false,
    });
    expect(env.type).toBe("system.adapter.disconnected");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      platform: "discord",
      disconnected_since: "2026-05-09T12:00:00.000Z",
      was_clean: false,
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("close metadata lands in payload when provided", () => {
    const env = createSystemAdapterDisconnectedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date(),
      shardId: 0,
      closeCode: 1006,
      closeReason: "abnormal closure",
      wasClean: false,
    });
    expect(env.payload).toMatchObject({
      shard_id: 0,
      close_code: 1006,
      close_reason: "abnormal closure",
    });
  });
});

describe("createSystemInboundAbortedEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemInboundAbortedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1111111111111111111",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_142,
      phase: "pre_dispatch",
    });
    expect(env.type).toBe("system.inbound.aborted");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      inbound_message_id: "1111111111111111111",
      timeout_source: "attachment_fetch",
      timeout_ms: 30_000,
      elapsed_ms: 30_142,
      phase: "pre_dispatch",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("correlation_id passed through when caller provides a UUID-format value", () => {
    const env = createSystemInboundAbortedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1111111111111111111",
      correlationId: "11111111-1111-4111-8111-111111111111",
      timeoutSource: "cc_session_spawn",
      timeoutMs: 5_000,
      elapsedMs: 5_002,
      phase: "cc_session",
    });
    expect(env.correlation_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("correlation_id omitted when caller does not provide one", () => {
    const env = createSystemInboundAbortedEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1111111111111111111",
      timeoutSource: "unknown",
      timeoutMs: 1_000,
      elapsedMs: 1_001,
      phase: "post_response",
    });
    expect(env.correlation_id).toBeUndefined();
  });

  test("all timeout_source enum values produce schema-valid envelopes", () => {
    const sources = [
      "attachment_fetch",
      "cloud_publisher",
      "usage_monitor",
      "usage_fetcher",
      "startup_sync",
      "cc_session_spawn",
      "unknown",
    ] as const;
    for (const source of sources) {
      const env = createSystemInboundAbortedEvent({
        source: { principal: "metafactory", agent: "cortex", instance: "local" },
        adapterId: "discord-luna",
        inboundMessageId: "id",
        timeoutSource: source,
        timeoutMs: 1_000,
        elapsedMs: 1_000,
        phase: "pre_dispatch",
      });
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

describe("data_residency parameterisation", () => {
  test("omitting source.dataResidency defaults to NZ across all helpers", () => {
    const sourceNoRes = { principal: "metafactory", agent: "cortex", instance: "local" };
    const degraded = createSystemAdapterDegradedEvent({
      source: sourceNoRes,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), thresholdMs: 1,
    });
    const recovered = createSystemAdapterRecoveredEvent({
      source: sourceNoRes,
      adapterId: "x", platform: "discord", degradedForMs: 1,
    });
    const disconnected = createSystemAdapterDisconnectedEvent({
      source: sourceNoRes,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), wasClean: true,
    });
    const aborted = createSystemInboundAbortedEvent({
      source: sourceNoRes,
      adapterId: "x", inboundMessageId: "1",
      timeoutSource: "unknown", timeoutMs: 1, elapsedMs: 1,
      phase: "pre_dispatch",
    });
    for (const env of [degraded, recovered, disconnected, aborted]) {
      expect(env.sovereignty.data_residency).toBe("NZ");
    }
  });

  test("source.dataResidency overrides the default in every helper", () => {
    const sourceAU = { principal: "metafactory", agent: "cortex", instance: "local", dataResidency: "AU" };
    const degraded = createSystemAdapterDegradedEvent({
      source: sourceAU,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), thresholdMs: 1,
    });
    const recovered = createSystemAdapterRecoveredEvent({
      source: sourceAU,
      adapterId: "x", platform: "discord", degradedForMs: 1,
    });
    const disconnected = createSystemAdapterDisconnectedEvent({
      source: sourceAU,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), wasClean: true,
    });
    const aborted = createSystemInboundAbortedEvent({
      source: sourceAU,
      adapterId: "x", inboundMessageId: "1",
      timeoutSource: "unknown", timeoutMs: 1, elapsedMs: 1,
      phase: "pre_dispatch",
    });
    for (const env of [degraded, recovered, disconnected, aborted]) {
      expect(env.sovereignty.data_residency).toBe("AU");
      // Schema must still accept the override.
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

describe("classification parameterisation (IAW A.3)", () => {
  // Federation unblock — every `system.*` helper now accepts an optional
  // `classification` that flows into envelope.sovereignty.classification.
  // Defaults remain `"local"` for back-compat; opt-in `"federated"` /
  // `"public"` lets cortex emit envelopes that match myelin's namespace
  // grammar (and pass `validateSubjectEnvelopeAlignment` when paired with
  // the runtime's subject derivation).
  const source = { principal: "metafactory", agent: "cortex", instance: "local" };

  test("omitting classification defaults to local across all helpers", () => {
    const degraded = createSystemAdapterDegradedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), thresholdMs: 1,
    });
    const recovered = createSystemAdapterRecoveredEvent({
      source,
      adapterId: "x", platform: "discord", degradedForMs: 1,
    });
    const disconnected = createSystemAdapterDisconnectedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), wasClean: true,
    });
    const aborted = createSystemInboundAbortedEvent({
      source,
      adapterId: "x", inboundMessageId: "1",
      timeoutSource: "unknown", timeoutMs: 1, elapsedMs: 1,
      phase: "pre_dispatch",
    });
    for (const env of [degraded, recovered, disconnected, aborted]) {
      expect(env.sovereignty.classification).toBe("local");
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("classification: 'federated' opts into the federation namespace", () => {
    const degraded = createSystemAdapterDegradedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), thresholdMs: 1,
      classification: "federated",
    });
    const recovered = createSystemAdapterRecoveredEvent({
      source,
      adapterId: "x", platform: "discord", degradedForMs: 1,
      classification: "federated",
    });
    const disconnected = createSystemAdapterDisconnectedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), wasClean: true,
      classification: "federated",
    });
    const aborted = createSystemInboundAbortedEvent({
      source,
      adapterId: "x", inboundMessageId: "1",
      timeoutSource: "unknown", timeoutMs: 1, elapsedMs: 1,
      phase: "pre_dispatch",
      classification: "federated",
    });
    for (const env of [degraded, recovered, disconnected, aborted]) {
      expect(env.sovereignty.classification).toBe("federated");
      // Schema must still accept the federated classification.
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("classification: 'public' opts into the public namespace", () => {
    const degraded = createSystemAdapterDegradedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), thresholdMs: 1,
      classification: "public",
    });
    const recovered = createSystemAdapterRecoveredEvent({
      source,
      adapterId: "x", platform: "discord", degradedForMs: 1,
      classification: "public",
    });
    const disconnected = createSystemAdapterDisconnectedEvent({
      source,
      adapterId: "x", platform: "discord",
      disconnectedSince: new Date(), wasClean: true,
      classification: "public",
    });
    const aborted = createSystemInboundAbortedEvent({
      source,
      adapterId: "x", inboundMessageId: "1",
      timeoutSource: "unknown", timeoutMs: 1, elapsedMs: 1,
      phase: "pre_dispatch",
      classification: "public",
    });
    for (const env of [degraded, recovered, disconnected, aborted]) {
      expect(env.sovereignty.classification).toBe("public");
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// IAW Phase A.4 — system.access.filtered
// ---------------------------------------------------------------------------

describe("createSystemAccessFilteredEvent", () => {
  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemAccessFilteredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      rendererId: "dashboard",
      envelopeSubject: "federated.metafactory.review.cycle.completed",
      reason: "residency_blocked",
    });
    expect(env.type).toBe("system.access.filtered");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toEqual({
      renderer_id: "dashboard",
      envelope_subject: "federated.metafactory.review.cycle.completed",
      reason: "residency_blocked",
    });
    // No correlation_id by default — access decisions are independent events.
    expect(env.correlation_id).toBeUndefined();
    // Sovereignty defaults match the rest of system.* — principal-only, local.
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("all reason enum values produce schema-valid envelopes", () => {
    const reasons = [
      "residency_blocked",
      "model_class_blocked",
      "classification_exceeds_max",
    ] as const;
    for (const reason of reasons) {
      const env = createSystemAccessFilteredEvent({
        source: { principal: "metafactory", agent: "cortex", instance: "local" },
        rendererId: "dashboard",
        envelopeSubject: "local.metafactory.x.y.z",
        reason,
      });
      expect(env.payload.reason).toBe(reason);
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("source.dataResidency overrides the default residency stamp", () => {
    const env = createSystemAccessFilteredEvent({
      source: {
        principal: "metafactory",
        agent: "cortex",
        instance: "local",
        dataResidency: "DE",
      },
      rendererId: "pagerduty",
      envelopeSubject: "public.review.cycle.completed",
      reason: "classification_exceeds_max",
    });
    expect(env.sovereignty.data_residency).toBe("DE");
  });

  test("explicit classification override propagates to sovereignty", () => {
    // Mirrors the Phase A.3 pattern on the other system.* helpers — an
    // principal may opt the access-decision stream into federated reach so
    // peer dashboards can observe drops too.
    const env = createSystemAccessFilteredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      rendererId: "dashboard",
      envelopeSubject: "federated.metafactory.foo.bar.baz",
      reason: "model_class_blocked",
      classification: "federated",
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createSystemAccessFilteredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      rendererId: "dashboard",
      envelopeSubject: "x.y.z",
      reason: "residency_blocked",
    });
    const b = createSystemAccessFilteredEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      rendererId: "dashboard",
      envelopeSubject: "x.y.z",
      reason: "residency_blocked",
    });
    expect(a.id).not.toBe(b.id);
  });
});

// v2.0.0 (cortex#297) — `createSystemAccessDisagreementEvent` retired with
// the parallel-mode plumbing. The disagreement envelope existed only for
// the cortex#296 validation window; PolicyEngine is the sole gate now.

// ---------------------------------------------------------------------------
// cortex#361 — `system.agent.heartbeat`
// ---------------------------------------------------------------------------

describe("createAgentHeartbeatEvent", () => {
  const CORRELATION_UUID = "22222222-2222-4222-8222-222222222222";

  test("required fields populated; envelope passes schema validation", () => {
    const env = createAgentHeartbeatEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      phase: "tool_use",
      lastActivityMsAgo: 1500,
      iteration: 7,
    });
    expect(env.type).toBe("system.agent.heartbeat");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.correlation_id).toBe(CORRELATION_UUID);
    expect(env.payload).toEqual({
      agent_id: "echo",
      task_id: "task-abc",
      correlation_id: CORRELATION_UUID,
      phase: "tool_use",
      last_activity_ms_ago: 1500,
      iteration: 7,
    });
    // Sovereignty defaults match principal-only / no frontier.
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createAgentHeartbeatEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      phase: "thinking",
      lastActivityMsAgo: 0,
      iteration: 1,
    });
    const b = createAgentHeartbeatEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      phase: "thinking",
      lastActivityMsAgo: 0,
      iteration: 2,
    });
    expect(a.id).not.toBe(b.id);
  });

  test("federated classification opt-in for future cross-principal heartbeats", () => {
    const env = createAgentHeartbeatEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      agentId: "echo",
      taskId: "task-abc",
      correlationId: CORRELATION_UUID,
      phase: "thinking",
      lastActivityMsAgo: 0,
      iteration: 1,
      classification: "federated",
    });
    expect(env.sovereignty?.classification).toBe("federated");
  });

  test("all four phase enum values are accepted", () => {
    const phases = [
      "thinking",
      "tool_use",
      "streaming_response",
      "publishing_verdict",
    ] as const;
    for (const phase of phases) {
      const env = createAgentHeartbeatEvent({
        source: { principal: "metafactory", agent: "cortex", instance: "local" },
        agentId: "echo",
        taskId: "task-abc",
        correlationId: CORRELATION_UUID,
        phase,
        lastActivityMsAgo: 0,
        iteration: 1,
      });
      expect(env.payload.phase).toBe(phase);
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// cortex#492 — `system.dispatch.stage`
// ---------------------------------------------------------------------------

describe("createSystemDispatchStageEvent", () => {
  const CORRELATION_UUID = "33333333-3333-4333-8333-333333333333";
  const TASK_UUID = "44444444-4444-4444-8444-444444444444";

  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: CORRELATION_UUID,
      taskId: TASK_UUID,
      stage: "received",
      outcome: "info",
    });
    expect(env.type).toBe("system.dispatch.stage");
    expect(env.source).toBe("metafactory.cortex.local");
    // UUID correlation mirrors onto the envelope field AND the payload.
    expect(env.correlation_id).toBe(CORRELATION_UUID);
    expect(env.payload).toEqual({
      correlation_id: CORRELATION_UUID,
      task_id: TASK_UUID,
      stage: "received",
      outcome: "info",
    });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("optional subject / agent_id / detail land in payload when supplied", () => {
    const env = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: CORRELATION_UUID,
      taskId: TASK_UUID,
      stage: "policy-decision",
      outcome: "fail",
      subject: "local.metafactory.tasks.@did-mf-cortex.chat",
      agentId: "cortex",
      detail: "unknown_principal",
    });
    expect(env.payload).toEqual({
      correlation_id: CORRELATION_UUID,
      task_id: TASK_UUID,
      stage: "policy-decision",
      outcome: "fail",
      subject: "local.metafactory.tasks.@did-mf-cortex.chat",
      agent_id: "cortex",
      detail: "unknown_principal",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("non-UUID correlationId rides payload only (not the envelope field)", () => {
    // The envelope schema constrains correlation_id to UUID; a feature-id
    // style key (e.g. a task label) still has to join, so it lives on the
    // payload and is omitted from the envelope field rather than failing
    // validation.
    const env = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: "task-not-a-uuid",
      taskId: "task-not-a-uuid",
      stage: "subject-rejected",
      outcome: "fail",
      subject: "local.someoneelse.tasks.@did-mf-other.chat",
    });
    expect(env.correlation_id).toBeUndefined();
    expect(env.payload.correlation_id).toBe("task-not-a-uuid");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("every stage + outcome combination produces a schema-valid envelope", () => {
    const stages = [
      "received",
      "subject-matched",
      "subject-rejected",
      "federation-gated",
      "parsed",
      "malformed",
      "recipient-validated",
      "recipient-mismatch",
      "chain-verify-start",
      "chain-verified",
      "chain-rejected",
      "policy-decision",
      "session-spawning",
      "started",
    ] as const;
    const outcomes = ["pass", "fail", "info"] as const;
    for (const stage of stages) {
      for (const outcome of outcomes) {
        const env = createSystemDispatchStageEvent({
          source: {
            principal: "metafactory",
            agent: "cortex",
            instance: "local",
          },
          correlationId: CORRELATION_UUID,
          taskId: TASK_UUID,
          stage,
          outcome,
        });
        expect(env.payload.stage).toBe(stage);
        expect(env.payload.outcome).toBe(outcome);
        expect(validateEnvelope(env).ok).toBe(true);
      }
    }
  });

  test("explicit classification override propagates to sovereignty", () => {
    const env = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: CORRELATION_UUID,
      taskId: TASK_UUID,
      stage: "received",
      outcome: "info",
      classification: "federated",
    });
    expect(env.sovereignty?.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation returns a fresh UUID id", () => {
    const a = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: CORRELATION_UUID,
      taskId: TASK_UUID,
      stage: "received",
      outcome: "info",
    });
    const b = createSystemDispatchStageEvent({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
      correlationId: CORRELATION_UUID,
      taskId: TASK_UUID,
      stage: "received",
      outcome: "info",
    });
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// cortex#932 (P-14 U0.2) — createSystemAccessDeniedEvent + emitSystemAccessDenied
// ---------------------------------------------------------------------------

describe("createSystemAccessDeniedEvent — open reason record (cortex#932 kinds)", () => {
  const SOURCE: SystemEventSource = {
    principal: "metafactory",
    agent: "cortex",
    instance: "local",
  };

  test("carries the structured reason verbatim and passes schema validation", () => {
    const env = createSystemAccessDeniedEvent({
      source: SOURCE,
      principalId: "joel",
      capability: "agent.online",
      reason: { kind: "chain_verify_failed", verify_reason: "unknown_agent" },
      sovereignty: {
        classification: "federated",
        data_residency: "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "local-only",
      },
      correlationId: "00000000-0000-4000-8000-000000000001",
      envelopeId: "00000000-0000-4000-8000-000000000002",
      envelopeSubject: "federated.joel.research.agent.online",
      signedBy: [],
    });
    expect(env.type).toBe("system.access.denied");
    const payload = env.payload as { reason: { kind: string; verify_reason?: string } };
    expect(payload.reason.kind).toBe("chain_verify_failed");
    expect(payload.reason.verify_reason).toBe("unknown_agent");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("all four cortex#932 reason kinds produce schema-valid denied envelopes", () => {
    const reasons = [
      { kind: "sovereignty_model_class", reason: "x", enforced: true },
      { kind: "chain_verify_failed", verify_reason: "unknown_agent" },
      { kind: "chain_verify_fault", fault: "boom" },
      { kind: "originator_denied", detail: "not a peer" },
    ];
    for (const reason of reasons) {
      const env = createSystemAccessDeniedEvent({
        source: SOURCE,
        principalId: "joel",
        capability: "agent.online",
        reason,
        sovereignty: {
          classification: "local",
          data_residency: "NZ",
          max_hop: 0,
          frontier_ok: false,
          model_class: "local-only",
        },
        correlationId: "00000000-0000-4000-8000-000000000003",
        envelopeId: "00000000-0000-4000-8000-000000000004",
        envelopeSubject: "local.metafactory.x.y.z",
        signedBy: [],
      });
      expect((env.payload as { reason: { kind: string } }).reason.kind).toBe(
        reason.kind,
      );
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });
});

describe("emitSystemAccessDenied — drop-site emit helper (cortex#932)", () => {
  const SOURCE: SystemEventSource = {
    principal: "metafactory",
    agent: "cortex",
    instance: "local",
  };

  /** A fake runtime that records every published envelope. */
  function recordingRuntime(): { published: Envelope[]; runtime: MyelinRuntime } {
    const published: Envelope[] = [];
    const runtime = {
      enabled: true,
      publish: (env: Envelope) => {
        published.push(env);
        return Promise.resolve();
      },
    } as unknown as MyelinRuntime;
    return { published, runtime };
  }

  /** A foreign federated presence envelope to feed the helper. */
  function inbound(): Envelope {
    return createAgentOnlineEvent({
      source: { principal: "joel", stack: "research", instance: "local" },
      identity: {
        nkey_public_key: "UPEER1234567890",
        agent_id: "sage",
        assistant_name: "Sage",
      },
      scope: { principal: "joel", stack: "research" },
      capabilities: ["code-review.typescript"],
      startedAt: new Date("2026-06-11T09:00:00.000Z"),
      classification: "federated",
    });
  }

  test("publishes a system.access.denied envelope carrying the reason kind", () => {
    const { published, runtime } = recordingRuntime();
    emitSystemAccessDenied(runtime, SOURCE, inbound(), {
      envelopeSubject: "federated.joel.research.agent.online",
      principalId: "joel",
      capability: "agent.online",
      reason: { kind: "chain_verify_failed", verify_reason: "unknown_agent" },
    });
    expect(published.length).toBe(1);
    expect(published[0]!.type).toBe("system.access.denied");
    const reason = (published[0]!.payload as { reason: { kind: string } }).reason;
    expect(reason.kind).toBe("chain_verify_failed");
  });

  test("derives correlation + envelope_id from the dropped envelope", () => {
    const { published, runtime } = recordingRuntime();
    const env = inbound();
    emitSystemAccessDenied(runtime, SOURCE, env, {
      envelopeSubject: "federated.joel.research.agent.online",
      principalId: "joel",
      capability: "agent.online",
      reason: { kind: "chain_verify_fault", fault: "boom" },
    });
    const payload = published[0]!.payload as {
      envelope_id: string;
      envelope_subject: string;
    };
    expect(payload.envelope_id).toBe(env.id);
    expect(payload.envelope_subject).toBe("federated.joel.research.agent.online");
  });

  test("source-undefined guard: NO-OP, publishes nothing, does not throw", () => {
    const { published, runtime } = recordingRuntime();
    expect(() =>
      emitSystemAccessDenied(runtime, undefined, inbound(), {
        envelopeSubject: "federated.joel.research.agent.online",
        principalId: "joel",
        capability: "agent.online",
        reason: { kind: "chain_verify_failed", verify_reason: "unknown_agent" },
      }),
    ).not.toThrow();
    expect(published.length).toBe(0);
  });
});

describe("createSystemPluginUnloadedEvent (cortex#1793, S8)", () => {
  const SOURCE: SystemEventSource = {
    principal: "andreas",
    agent: "cortex",
    instance: "local",
  };

  test("required fields populated; envelope passes schema validation", () => {
    const env = createSystemPluginUnloadedEvent({
      source: SOURCE,
      bundleName: "cli-tail-renderer",
      kind: "renderer",
      pluginId: "cli-tail",
      instanceId: "cli-tail",
    });
    expect(env.type).toBe("system.plugin.unloaded");
    expect(env.source).toBe("andreas.cortex.local");
    expect(env.payload).toEqual({
      bundle_name: "cli-tail-renderer",
      kind: "renderer",
      plugin_id: "cli-tail",
      instance_id: "cli-tail",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("adapter kind — instance_id distinct from plugin_id", () => {
    const env = createSystemPluginUnloadedEvent({
      source: SOURCE,
      bundleName: "acme-chat-adapter",
      kind: "adapter",
      pluginId: "acme-chat",
      instanceId: "acme-chat:guild-123",
    });
    expect((env.payload as { plugin_id: string }).plugin_id).toBe("acme-chat");
    expect((env.payload as { instance_id: string }).instance_id).toBe("acme-chat:guild-123");
  });
});

describe("createSystemPluginReloadFailedEvent (cortex#1793, S8)", () => {
  const SOURCE: SystemEventSource = {
    principal: "andreas",
    agent: "cortex",
    instance: "local",
  };

  test("required fields only — optional fields omitted, not undefined-valued", () => {
    const env = createSystemPluginReloadFailedEvent({
      source: SOURCE,
      bundleName: "cli-tail-renderer",
      stage: "cache_bust_reimport",
      reason: "import() threw: SyntaxError",
    });
    expect(env.type).toBe("system.plugin.reload-failed");
    expect(env.payload).toEqual({
      bundle_name: "cli-tail-renderer",
      stage: "cache_bust_reimport",
      reason: "import() threw: SyntaxError",
    });
    expect(env.payload).not.toHaveProperty("kind");
    expect(env.payload).not.toHaveProperty("plugin_id");
    expect(env.payload).not.toHaveProperty("instance_id");
    // `reload-failed` (hyphen) — NOT `reload_failed`. Confirmed via a live
    // NATS round trip (S8 completion pass) that a type violating the
    // vendored `/type` pattern (`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$`
    // — no underscores) publishes without error but is SILENTLY DROPPED by
    // every standard push-mode subscriber (`runtime.subscribe()` +
    // `onEnvelope`, via `myelin/subscriber.ts`'s schema check). The
    // already-shipped sibling `system.plugin.load-failed` (S6, on `main`)
    // and several older `system.*` families (`system.bus.notify-discord`,
    // `system.bus.reflex-activation-failed`, `system.gateway.routing-decision`,
    // …) still carry this bug — out of scope to mass-fix here (separate,
    // coordinated change), but `reload-failed` is spelled correctly since
    // it ships in THIS slice.
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("all optional fields populated", () => {
    const env = createSystemPluginReloadFailedEvent({
      source: SOURCE,
      bundleName: "cli-tail-renderer",
      kind: "renderer",
      pluginId: "cli-tail",
      instanceId: "cli-tail",
      stage: "construct",
      reason: "createRenderer threw",
    });
    expect(env.payload).toEqual({
      bundle_name: "cli-tail-renderer",
      kind: "renderer",
      plugin_id: "cli-tail",
      instance_id: "cli-tail",
      stage: "construct",
      reason: "createRenderer threw",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("createSystemPluginControlRequestEvent / createSystemPluginControlResponseEvent (cortex#1793, S8)", () => {
  const SOURCE: SystemEventSource = {
    principal: "andreas",
    agent: "cortex",
    instance: "cli",
  };

  test("control-request: schema-valid, correlation_id echoes requestId", () => {
    const requestId = "072670f4-6128-4781-b82b-17a36af6060a";
    const env = createSystemPluginControlRequestEvent({
      source: SOURCE,
      requestId,
      action: "unload",
      instanceId: "discord:guild1",
    });
    expect(env.type).toBe("system.plugin.control-request");
    expect(env.correlation_id).toBe(requestId);
    expect(env.payload).toEqual({
      request_id: requestId,
      action: "unload",
      instance_id: "discord:guild1",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("control-request: bundleName-only (load) omits instance_id", () => {
    const env = createSystemPluginControlRequestEvent({
      source: SOURCE,
      requestId: "072670f4-6128-4781-b82b-17a36af6060a",
      action: "load",
      bundleName: "acme-bundle",
    });
    expect(env.payload).toEqual({
      request_id: "072670f4-6128-4781-b82b-17a36af6060a",
      action: "load",
      bundle_name: "acme-bundle",
    });
    expect(env.payload).not.toHaveProperty("instance_id");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("control-response: success carries rows, schema-valid", () => {
    const requestId = "072670f4-6128-4781-b82b-17a36af6060a";
    const env = createSystemPluginControlResponseEvent({
      source: SOURCE,
      requestId,
      ok: true,
      rows: [{ kind: "renderer", platformOrKind: "pagerduty", instanceId: "pagerduty", bundleName: "in-tree", running: true }],
    });
    expect(env.type).toBe("system.plugin.control-response");
    expect(env.correlation_id).toBe(requestId);
    expect(env.payload.ok).toBe(true);
    expect(env.payload.rows).toEqual([
      { kind: "renderer", platformOrKind: "pagerduty", instanceId: "pagerduty", bundleName: "in-tree", running: true },
    ]);
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("control-response: failure carries detail, no rows", () => {
    const env = createSystemPluginControlResponseEvent({
      source: SOURCE,
      requestId: "072670f4-6128-4781-b82b-17a36af6060a",
      ok: false,
      detail: "no plugin instance \"ghost\" is currently live",
    });
    expect(env.payload).toEqual({
      request_id: "072670f4-6128-4781-b82b-17a36af6060a",
      ok: false,
      detail: 'no plugin instance "ghost" is currently live',
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });
});
