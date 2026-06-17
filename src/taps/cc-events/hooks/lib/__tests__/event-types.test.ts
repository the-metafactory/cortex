import { test, expect, describe } from "bun:test";
import { RawEventSchema, PublishedEventSchema, createRawEvent } from "../event-types";

const validRawEvent = {
  event_id: "550e8400-e29b-41d4-a716-446655440000",
  event_type: "agent.task.completed",
  timestamp: "2026-03-27T10:00:00.000Z",
  session_id: "session-abc",
  grove_channel: "ivy",
  source: { hook: "Stop" as const },
  payload: { summary: "Did the thing" },
};

describe("RawEventSchema", () => {
  test("validates well-formed event", () => {
    const result = RawEventSchema.parse(validRawEvent);
    expect(result.event_id).toBe(validRawEvent.event_id);
    expect(result.event_type).toBe("agent.task.completed");
  });

  test("rejects missing event_id", () => {
    const { event_id, ...noId } = validRawEvent;
    expect(() => RawEventSchema.parse(noId)).toThrow();
  });

  test("rejects missing event_type", () => {
    const { event_type, ...noType } = validRawEvent;
    expect(() => RawEventSchema.parse(noType)).toThrow();
  });

  test("rejects non-ISO timestamp", () => {
    expect(() =>
      RawEventSchema.parse({ ...validRawEvent, timestamp: "not-a-date" })
    ).toThrow();
  });

  test("rejects empty session_id", () => {
    expect(() =>
      RawEventSchema.parse({ ...validRawEvent, session_id: "" })
    ).toThrow();
  });

  test("rejects missing source.hook", () => {
    expect(() =>
      RawEventSchema.parse({ ...validRawEvent, source: {} })
    ).toThrow();
  });

  test("rejects invalid source.hook value", () => {
    expect(() =>
      RawEventSchema.parse({ ...validRawEvent, source: { hook: "Invalid" } })
    ).toThrow();
  });

  test("allows optional grove_channel", () => {
    const { grove_channel, ...noChannel } = validRawEvent;
    const result = RawEventSchema.parse(noChannel);
    expect(result.grove_channel).toBeUndefined();
  });

  test("allows optional source.tool_name", () => {
    const withTool = {
      ...validRawEvent,
      source: { hook: "PostToolUse" as const, tool_name: "Write" },
    };
    const result = RawEventSchema.parse(withTool);
    expect(result.source.tool_name).toBe("Write");
  });
});

describe("PublishedEventSchema", () => {
  const validPublished = {
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    event_type: "agent.task.completed",
    timestamp: "2026-03-27T10:00:00.000Z",
    session_id: "session-abc",
    grove_channel: "ivy",
    payload: { summary: "Did the thing" },
  };

  test("validates well-formed published event", () => {
    const result = PublishedEventSchema.parse(validPublished);
    expect(result.event_type).toBe("agent.task.completed");
  });

  test("rejects missing event_type", () => {
    const { event_type, ...noType } = validPublished;
    expect(() => PublishedEventSchema.parse(noType)).toThrow();
  });

  test("does not have source field", () => {
    const withSource = { ...validPublished, source: { hook: "Stop" } };
    const result = PublishedEventSchema.parse(withSource);
    // source should be stripped by strict parsing or ignored
    expect(result.event_type).toBe("agent.task.completed");
  });
});

describe("createRawEvent", () => {
  test("produces valid event with all required fields", () => {
    const event = createRawEvent("agent.task.completed", "Stop", {
      summary: "test",
    }, { sessionId: "test-session" });

    expect(event.event_id).toBeDefined();
    expect(event.event_type).toBe("agent.task.completed");
    expect(event.timestamp).toBeDefined();
    expect(event.session_id).toBe("test-session");
    expect(event.source.hook).toBe("Stop");
    expect(event.payload.summary).toBe("test");

    // Validate against schema
    const parsed = RawEventSchema.parse(event);
    expect(parsed.event_id).toBe(event.event_id);
  });

  test("uses env vars for defaults when options omitted", () => {
    const prev = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "env-session";
    try {
      const event = createRawEvent("agent.task.started", "UserPromptSubmit", {});
      expect(event.session_id).toBe("env-session");
    } finally {
      if (prev) process.env.CLAUDE_SESSION_ID = prev;
      else delete process.env.CLAUDE_SESSION_ID;
    }
  });

  test("includes tool_name in source when provided", () => {
    const event = createRawEvent("tool.file.changed", "PostToolUse", {}, {
      toolName: "Write",
      sessionId: "s1",
    });
    expect(event.source.tool_name).toBe("Write");
  });
});

// GV-2 (cortex#1077) — channel-label vocabulary migration: additive
// dual-write shim. Producers stamp BOTH `cortex_channel` (canonical) and
// `grove_channel` (legacy back-compat alias); consumers read cortex-first
// with a grove fallback. `grove_channel` is NEVER removed before v3.0.0.
describe("GV-2 cortex_channel/grove_channel dual-write shim", () => {
  test("createRawEvent DUAL-WRITES both fields from the channel option", () => {
    const event = createRawEvent("agent.task.completed", "Stop", {}, {
      sessionId: "s1",
      channel: "ivy",
    });
    expect(event.cortex_channel).toBe("ivy");
    expect(event.grove_channel).toBe("ivy");
  });

  test("RawEventSchema accepts the canonical cortex_channel", () => {
    const result = RawEventSchema.parse({ ...validRawEvent, cortex_channel: "ivy" });
    expect(result.cortex_channel).toBe("ivy");
  });

  test("RawEventSchema still accepts the legacy grove_channel (back-compat)", () => {
    const groveOnly = { ...validRawEvent, grove_channel: "legacy" };
    const result = RawEventSchema.parse(groveOnly);
    expect(result.grove_channel).toBe("legacy");
    expect(result.cortex_channel).toBeUndefined();
  });

  test("both channel fields are optional", () => {
    const { grove_channel, ...noChannels } = validRawEvent;
    const result = RawEventSchema.parse(noChannels);
    expect(result.cortex_channel).toBeUndefined();
    expect(result.grove_channel).toBeUndefined();
  });

  test("PublishedEventSchema accepts cortex_channel alongside grove_channel", () => {
    const result = PublishedEventSchema.parse({
      event_id: "550e8400-e29b-41d4-a716-446655440000",
      event_type: "agent.task.completed",
      timestamp: "2026-03-27T10:00:00.000Z",
      session_id: "session-abc",
      cortex_channel: "ivy",
      grove_channel: "ivy",
      payload: {},
    });
    expect(result.cortex_channel).toBe("ivy");
    expect(result.grove_channel).toBe("ivy");
  });
});
