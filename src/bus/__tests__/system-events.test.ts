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
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  adapterCorrelationKey,
  createSystemAdapterDegradedEvent,
  createSystemAdapterDisconnectedEvent,
  createSystemAdapterRecoveredEvent,
  createSystemInboundAbortedEvent,
} from "../system-events";

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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
    // Sovereignty defaults match operator-only / no frontier.
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "x",
      platform: "discord",
      disconnectedSince: new Date(),
      thresholdMs: 60_000,
    });
    const b = createSystemAdapterDegradedEvent({
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1234567890123456789",
      timeoutSource: "attachment_fetch",
      timeoutMs: 30_000,
      elapsedMs: 30_142,
      phase: "pre_dispatch",
    });
    expect(env.type).toBe("system.inbound.aborted");
    expect(env.payload).toMatchObject({
      adapter_id: "discord-luna",
      inbound_message_id: "1234567890123456789",
      timeout_source: "attachment_fetch",
      timeout_ms: 30_000,
      elapsed_ms: 30_142,
      phase: "pre_dispatch",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("correlation_id passed through when caller provides a UUID-format value", () => {
    const env = createSystemInboundAbortedEvent({
      source: { org: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1234567890123456789",
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
      source: { org: "metafactory", agent: "cortex", instance: "local" },
      adapterId: "discord-luna",
      inboundMessageId: "1234567890123456789",
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
        source: { org: "metafactory", agent: "cortex", instance: "local" },
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
