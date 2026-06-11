import { test, expect, describe } from "bun:test";
import {
  isEventAllowed,
  filterFields,
  applyRedactions,
  shouldDrop,
  processEvent,
} from "../policy-engine";
import type { RawEvent } from "../../hooks/lib/event-types";
import type { RelayPolicy } from "../policy-schema";

function makeRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    event_type: "agent.task.completed",
    timestamp: "2026-03-27T10:00:00.000Z",
    session_id: "session-abc",
    grove_channel: "ivy",
    source: { hook: "Stop" },
    payload: { summary: "Did the thing", duration_ms: 5000 },
    ...overrides,
  };
}

const basePolicy: RelayPolicy = {
  allow_events: ["agent.task.completed", "agent.task.started", "tool.file.changed"],
  fields: {
    "agent.task.completed": { include: ["summary", "duration_ms"] },
    "agent.task.started": { include: ["prompt_preview"] },
    "tool.file.changed": { include: ["path", "change_type"] },
  },
  redact: [
    { pattern: "/home/[a-zA-Z0-9_-]+", replace: "~" },
    { pattern: "sk-ant-[a-zA-Z0-9-]+", replace: "[REDACTED:ANTHROPIC_KEY]" },
  ],
  drop_if: [
    { field: "payload.path", contains: [".env", "credentials"] },
  ],
};

describe("isEventAllowed", () => {
  test("returns true for allowed event type", () => {
    const event = makeRawEvent({ event_type: "agent.task.completed" });
    expect(isEventAllowed(event, basePolicy)).toBe(true);
  });

  test("returns false for disallowed event type", () => {
    const event = makeRawEvent({ event_type: "tool.bash.executed" });
    expect(isEventAllowed(event, basePolicy)).toBe(false);
  });
});

describe("filterFields", () => {
  test("retains only fields in include list", () => {
    const event = makeRawEvent({
      payload: { summary: "test", duration_ms: 100, secret: "hidden" },
    });
    const filtered = filterFields(event, basePolicy);
    expect(filtered).toEqual({ summary: "test", duration_ms: 100 });
    expect(filtered).not.toHaveProperty("secret");
  });

  test("returns empty for event type without field config", () => {
    const event = makeRawEvent({ event_type: "tool.bash.executed" });
    const filtered = filterFields(event, basePolicy);
    expect(filtered).toEqual({});
  });

  test("handles missing payload fields gracefully", () => {
    const event = makeRawEvent({ payload: {} });
    const filtered = filterFields(event, basePolicy);
    expect(filtered).toEqual({});
  });
});

describe("applyRedactions", () => {
  test("replaces home directory paths with ~", () => {
    const payload = { path: "/home/dev/work/grove/src/main.ts" };
    const result = applyRedactions(payload, basePolicy);
    expect(result.path).toBe("~/work/grove/src/main.ts");
  });

  test("redacts Anthropic API key patterns", () => {
    const payload = { key: "sk-ant-abc123-def456" };
    const result = applyRedactions(payload, basePolicy);
    expect(result.key).toBe("[REDACTED:ANTHROPIC_KEY]");
  });

  test("redacts nested string values", () => {
    const payload = { nested: { path: "/home/dev/file.ts" } };
    const result = applyRedactions(payload, basePolicy);
    expect((result.nested as Record<string, unknown>).path).toBe("~/file.ts");
  });

  test("redacts array string values", () => {
    const payload = { files: ["/home/dev/a.ts", "/home/dev/b.ts"] };
    const result = applyRedactions(payload, basePolicy);
    expect(result.files).toEqual(["~/a.ts", "~/b.ts"]);
  });

  test("returns payload unchanged with empty redact list", () => {
    const payload = { path: "/home/dev/file.ts" };
    const result = applyRedactions(payload, { ...basePolicy, redact: [] });
    expect(result.path).toBe("/home/dev/file.ts");
  });
});

describe("shouldDrop", () => {
  test("returns true for events with .env in path", () => {
    const event = makeRawEvent({ payload: { path: "/work/.env" } });
    expect(shouldDrop(event, basePolicy)).toBe(true);
  });

  test("returns true for events with credentials in path", () => {
    const event = makeRawEvent({ payload: { path: "/work/credentials.json" } });
    expect(shouldDrop(event, basePolicy)).toBe(true);
  });

  test("returns false for events without sensitive path", () => {
    const event = makeRawEvent({ payload: { path: "/work/src/main.ts" } });
    expect(shouldDrop(event, basePolicy)).toBe(false);
  });

  test("returns false when field doesn't exist", () => {
    const event = makeRawEvent({ payload: { summary: "no path here" } });
    expect(shouldDrop(event, basePolicy)).toBe(false);
  });
});

describe("processEvent", () => {
  test("returns PublishedEvent for allowed events", () => {
    const event = makeRawEvent();
    const result = processEvent(event, basePolicy);
    expect(result).not.toBeNull();
    expect(result!.event_id).toBe(event.event_id);
    expect(result!.event_type).toBe("agent.task.completed");
    expect(result!.payload.summary).toBe("Did the thing");
  });

  test("returns null for disallowed events", () => {
    const event = makeRawEvent({ event_type: "tool.bash.executed" });
    const result = processEvent(event, basePolicy);
    expect(result).toBeNull();
  });

  test("returns null for allowed but dropped events", () => {
    const event = makeRawEvent({
      event_type: "tool.file.changed",
      payload: { path: "/work/.env", change_type: "edit" },
    });
    const result = processEvent(event, basePolicy);
    expect(result).toBeNull();
  });

  test("filters fields in published payload", () => {
    const event = makeRawEvent({
      payload: { summary: "test", duration_ms: 100, secret: "hidden" },
    });
    const result = processEvent(event, basePolicy);
    expect(result!.payload).not.toHaveProperty("secret");
    expect(result!.payload.summary).toBe("test");
  });

  test("redacts sensitive data in published payload", () => {
    const event = makeRawEvent({
      payload: { summary: "Used key sk-ant-abc123-xyz at /home/dev/work" },
    });
    const result = processEvent(event, basePolicy);
    expect(result!.payload.summary).toContain("[REDACTED:ANTHROPIC_KEY]");
    expect(result!.payload.summary).toContain("~");
    expect(result!.payload.summary).not.toContain("sk-ant-");
    expect(result!.payload.summary).not.toContain("/home/testuser");
  });

  test("custom namespaced event passes through when in allow list", () => {
    const customPolicy: RelayPolicy = {
      ...basePolicy,
      allow_events: [...basePolicy.allow_events, "ivy.research.completed"],
      fields: {
        ...basePolicy.fields,
        "ivy.research.completed": { include: ["findings"] },
      },
    };
    const event = makeRawEvent({
      event_type: "ivy.research.completed",
      payload: { findings: "Interesting results" },
    });
    const result = processEvent(event, customPolicy);
    expect(result).not.toBeNull();
    expect(result!.event_type).toBe("ivy.research.completed");
    expect(result!.payload.findings).toBe("Interesting results");
  });

  test("preserves grove_channel in published event", () => {
    const event = makeRawEvent({ grove_channel: "luna" });
    const result = processEvent(event, basePolicy);
    expect(result!.grove_channel).toBe("luna");
  });

  // ST-P1 (cortex#964, refs #952) — the relay must carry the session-tree
  // fields through Raw → Published so the cc-events envelope can place them
  // on the payload for both ingest paths.
  test("propagates parent_session_id + substrate from raw to published", () => {
    const event = makeRawEvent({
      parent_session_id: "moderator-session",
      substrate: "claude-code",
    });
    const result = processEvent(event, basePolicy);
    expect(result!.parent_session_id).toBe("moderator-session");
    expect(result!.substrate).toBe("claude-code");
  });

  test("omits parent_session_id + substrate when the raw event has none", () => {
    const event = makeRawEvent();
    const result = processEvent(event, basePolicy);
    expect(result!.parent_session_id).toBeUndefined();
    expect(result!.substrate).toBeUndefined();
  });
});
