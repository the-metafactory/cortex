/**
 * ST-P1 (cortex#964, refs #952) — the cc-events envelope carries the
 * session-tree fields `parent_session_id` + `substrate` into the payload
 * when the PublishedEvent supplies them. Both ingest paths (local relay →
 * ingestor; cloud publisher → /api/ingest) read the envelope payload, so
 * carrying the fields here is what makes Phase 2's ingestor able to parent
 * a child session.
 */
import { describe, expect, test } from "bun:test";
import { createCcEventEnvelope } from "../cc-events";
import type { PublishedEvent } from "../hooks/lib/event-types";
import { validateEnvelope } from "../../../bus/myelin/envelope-validator";

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "agent.task.started",
    timestamp: "2026-06-11T10:00:00.000Z",
    session_id: "9d2c4e8a-1b3f-4c5d-9e6f-7a8b9c0d1e2f",
    grove_channel: "andreas",
    agent_id: "luna",
    agent_name: "Luna",
    network_id: "metafactory",
    payload: { tool_name: "Bash" },
    ...overrides,
  };
}

describe("createCcEventEnvelope — ST-P1 parent_session_id + substrate", () => {
  test("carries parent_session_id + substrate into the payload when present", () => {
    const envelope = createCcEventEnvelope({
      event: makeEvent({
        parent_session_id: "moderator-session",
        substrate: "claude-code",
      }),
    });

    expect(envelope.payload.parent_session_id).toBe("moderator-session");
    expect(envelope.payload.substrate).toBe("claude-code");
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  test("omits parent_session_id + substrate from the payload when absent", () => {
    const envelope = createCcEventEnvelope({
      event: makeEvent(),
    });

    expect(envelope.payload.parent_session_id).toBeUndefined();
    expect(envelope.payload.substrate).toBeUndefined();
  });
});
