/**
 * MIG-5b — cc-events helper tests.
 *
 * Covers envelope shape (ids, timestamps, source dotting, sovereignty,
 * payload merging, correlation_id UUID gating) and the publisher factory's
 * subject construction + error swallowing.
 */

import { describe, expect, test } from "bun:test";
import {
  createCcEventEnvelope,
  createCcEventPublisher,
  isUuid,
} from "../cc-events";
import type { PublishedEvent } from "../hooks/lib/event-types";
import { validateEnvelope } from "../../../bus/myelin/envelope-validator";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "agent.task.started",
    timestamp: "2026-05-09T10:00:00.000Z",
    session_id: "9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f",
    grove_channel: "andreas",
    agent_id: "luna",
    agent_name: "Luna",
    network_id: "metafactory",
    payload: { tool_name: "Bash", command_preview: "ls -la" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isUuid
// ---------------------------------------------------------------------------

describe("isUuid", () => {
  test("accepts canonical UUID v4", () => {
    expect(isUuid("9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f")).toBe(true);
  });

  test("accepts uppercase UUID", () => {
    expect(isUuid("9D2C4E8A-1B3F-4C5D-9E6F-7A8B9C0D1E2F")).toBe(true);
  });

  test("rejects 'unknown'", () => {
    expect(isUuid("unknown")).toBe(false);
  });

  test("rejects malformed string", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isUuid("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createCcEventEnvelope
// ---------------------------------------------------------------------------

describe("createCcEventEnvelope", () => {
  test("envelope.id is a fresh UUID per call", () => {
    const event = makeEvent();
    const e1 = createCcEventEnvelope({ event });
    const e2 = createCcEventEnvelope({ event });
    expect(e1.id).not.toBe(e2.id);
    expect(isUuid(e1.id)).toBe(true);
    expect(isUuid(e2.id)).toBe(true);
  });

  test("envelope.timestamp mirrors the published event timestamp", () => {
    const event = makeEvent({ timestamp: "2026-05-09T12:34:56.789Z" });
    const env = createCcEventEnvelope({ event });
    expect(env.timestamp).toBe("2026-05-09T12:34:56.789Z");
  });

  test("envelope.type equals the published event_type verbatim", () => {
    const env = createCcEventEnvelope({
      event: makeEvent({ event_type: "tool.bash.executed" }),
    });
    expect(env.type).toBe("tool.bash.executed");
  });

  test("source defaults to default.cortex.relay", () => {
    const env = createCcEventEnvelope({ event: makeEvent() });
    expect(env.source).toBe("default.cortex.relay");
  });

  test("source segments override defaults", () => {
    const env = createCcEventEnvelope({
      event: makeEvent(),
      source: { org: "metafactory", agent: "cortex", instance: "tap-relay" },
    });
    expect(env.source).toBe("metafactory.cortex.tap-relay");
  });

  test("correlation_id is set when session_id is UUID-shaped", () => {
    const sessionId = "9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f";
    const env = createCcEventEnvelope({ event: makeEvent({ session_id: sessionId }) });
    expect(env.correlation_id).toBe(sessionId);
  });

  test("correlation_id is omitted when session_id is non-UUID", () => {
    const env = createCcEventEnvelope({
      event: makeEvent({ session_id: "unknown" }),
    });
    expect(env.correlation_id).toBeUndefined();
    // Non-UUID session id is preserved in payload
    expect(env.payload.session_id).toBe("unknown");
  });

  test("sovereignty defaults to local-only NZ max_hop=0 frontier_ok=false", () => {
    const env = createCcEventEnvelope({ event: makeEvent() });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
  });

  test("sovereignty is a fresh literal per call (no aliasing)", () => {
    const e1 = createCcEventEnvelope({ event: makeEvent() });
    const e2 = createCcEventEnvelope({ event: makeEvent() });
    e1.sovereignty.max_hop = 99;
    expect(e2.sovereignty.max_hop).toBe(0);
  });

  test("source.dataResidency overrides the NZ default", () => {
    const env = createCcEventEnvelope({
      event: makeEvent(),
      source: { org: "metafactory", agent: "cortex", instance: "relay", dataResidency: "EU" },
    });
    expect(env.sovereignty.data_residency).toBe("EU");
  });

  test("payload includes top-level PublishedEvent fields plus payload spread", () => {
    const event = makeEvent({
      event_id: "evt-abc",
      session_id: "9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f",
      grove_channel: "andreas",
      agent_id: "luna",
      agent_name: "Luna",
      network_id: "metafactory",
      payload: { tool_name: "Bash", command_preview: "ls" },
    });
    const env = createCcEventEnvelope({ event });
    expect(env.payload.event_id).toBe("evt-abc");
    expect(env.payload.session_id).toBe("9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f");
    expect(env.payload.grove_channel).toBe("andreas");
    expect(env.payload.agent_id).toBe("luna");
    expect(env.payload.agent_name).toBe("Luna");
    expect(env.payload.network_id).toBe("metafactory");
    expect(env.payload.tool_name).toBe("Bash");
    expect(env.payload.command_preview).toBe("ls");
  });

  test("optional top-level fields omitted when absent", () => {
    const event: PublishedEvent = {
      event_id: crypto.randomUUID(),
      event_type: "session.started",
      timestamp: "2026-05-09T10:00:00.000Z",
      session_id: "9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f",
      payload: {},
      // grove_channel, agent_id, agent_name, network_id intentionally absent
    };
    const env = createCcEventEnvelope({ event });
    expect("grove_channel" in env.payload).toBe(false);
    expect("agent_id" in env.payload).toBe(false);
    expect("agent_name" in env.payload).toBe(false);
    expect("network_id" in env.payload).toBe(false);
    expect(env.payload.event_id).toBe(event.event_id);
    expect(env.payload.session_id).toBe(event.session_id);
  });

  test("envelope passes Ajv validation against vendored myelin schema", () => {
    const env = createCcEventEnvelope({
      event: makeEvent(),
      source: { org: "metafactory" },
    });
    const result = validateEnvelope(env);
    if (!result.ok) {
      // Surface ajv errors in test failure for fast diagnosis
      throw new Error(`envelope failed validation: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCcEventPublisher
// ---------------------------------------------------------------------------

describe("createCcEventPublisher", () => {
  /** Minimal NatsLink stub for assertion. */
  function makeLink() {
    const calls: { subject: string; payload: string }[] = [];
    let throwOnPublish: Error | undefined;
    return {
      calls,
      throwOnPublish(err: Error) {
        throwOnPublish = err;
      },
      stub: {
        publish(subject: string, payload: string | Uint8Array) {
          if (throwOnPublish) throw throwOnPublish;
          calls.push({
            subject,
            payload: typeof payload === "string" ? payload : new TextDecoder().decode(payload),
          });
        },
      } as unknown as Parameters<typeof createCcEventPublisher>[0]["link"],
    };
  }

  test("publishes to local.{org}.{type}", () => {
    const link = makeLink();
    const pub = createCcEventPublisher({ link: link.stub, org: "metafactory" });
    pub(makeEvent({ event_type: "tool.bash.executed" }));
    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]!.subject).toBe("local.metafactory.tool.bash.executed");
  });

  test("default org is 'default' when omitted", () => {
    const link = makeLink();
    const pub = createCcEventPublisher({ link: link.stub });
    pub(makeEvent({ event_type: "agent.task.started" }));
    expect(link.calls[0]!.subject).toBe("local.default.agent.task.started");
  });

  test("payload is JSON-serialised envelope", () => {
    const link = makeLink();
    const pub = createCcEventPublisher({ link: link.stub, org: "andreas" });
    pub(makeEvent({ event_type: "session.started" }));
    const env = JSON.parse(link.calls[0]!.payload);
    expect(env.type).toBe("session.started");
    expect(env.source).toBe("andreas.cortex.relay");
    expect(env.sovereignty.classification).toBe("local");
  });

  test("source segment overrides flow into envelope", () => {
    const link = makeLink();
    const pub = createCcEventPublisher({
      link: link.stub,
      org: "metafactory",
      agent: "cortex",
      instance: "tap-prod",
    });
    pub(makeEvent());
    const env = JSON.parse(link.calls[0]!.payload);
    expect(env.source).toBe("metafactory.cortex.tap-prod");
  });

  test("publish errors are swallowed (do not throw out)", () => {
    const link = makeLink();
    link.throwOnPublish(new Error("nats closed"));
    const pub = createCcEventPublisher({ link: link.stub, org: "default" });
    // Must not throw — the relay's primary path is JSONL append, not bus
    expect(() => pub(makeEvent())).not.toThrow();
  });

  test("buildEnvelope override is invoked per event", () => {
    const link = makeLink();
    let callCount = 0;
    const pub = createCcEventPublisher({
      link: link.stub,
      org: "default",
      buildEnvelope: (event, _source) => {
        callCount++;
        return {
          id: "fixed-uuid-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          source: "test.cortex.relay",
          type: event.event_type,
          timestamp: event.timestamp,
          sovereignty: {
            classification: "local",
            data_residency: "NZ",
            max_hop: 0,
            frontier_ok: false,
            model_class: "local-only",
          },
          payload: { custom: true },
        };
      },
    });
    pub(makeEvent({ event_type: "agent.task.completed" }));
    expect(callCount).toBe(1);
    const env = JSON.parse(link.calls[0]!.payload);
    expect(env.payload.custom).toBe(true);
  });
});
