import { describe, test, expect } from "bun:test";
import {
  createRawEvent,
  RawEventSchema,
  PublishedEventSchema,
} from "../event-types";

/**
 * ST-P1 (cortex#964, refs #952) — the cc-events RawEvent / PublishedEvent
 * schemas carry the session-tree fields `parent_session_id` + `substrate`,
 * and `createRawEvent` stamps them from its options.
 *
 * Wire-contract names are PINNED — `parent_session_id` and `substrate`
 * (snake_case on the event/payload schema, per the ST-P2 consumer). Do not
 * vary them.
 */
describe("ST-P1 — parent_session_id + substrate on cc-events schemas", () => {
  test("RawEventSchema accepts parent_session_id + substrate (both optional)", () => {
    const withFields = RawEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      event_type: "agent.task.started",
      timestamp: new Date().toISOString(),
      session_id: "child-session",
      parent_session_id: "moderator-session",
      substrate: "claude-code",
      source: { hook: "Stop" },
      payload: {},
    });
    expect(withFields.success).toBe(true);

    // Both fields are optional — a raw event without them still parses.
    const withoutFields = RawEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      event_type: "agent.task.started",
      timestamp: new Date().toISOString(),
      session_id: "root-session",
      source: { hook: "Stop" },
      payload: {},
    });
    expect(withoutFields.success).toBe(true);
  });

  test("PublishedEventSchema accepts parent_session_id + substrate (both optional)", () => {
    const parsed = PublishedEventSchema.safeParse({
      event_id: crypto.randomUUID(),
      event_type: "agent.task.started",
      timestamp: new Date().toISOString(),
      session_id: "child-session",
      parent_session_id: "moderator-session",
      substrate: "claude-code",
      payload: {},
    });
    expect(parsed.success).toBe(true);
  });

  test("createRawEvent stamps parentSessionId + substrate from options", () => {
    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "child-session",
      parentSessionId: "moderator-session",
      substrate: "claude-code",
    });

    expect(event.parent_session_id).toBe("moderator-session");
    expect(event.substrate).toBe("claude-code");
  });

  test("createRawEvent omits parent_session_id + substrate when not supplied", () => {
    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "root-session",
    });

    expect(event.parent_session_id).toBeUndefined();
    expect(event.substrate).toBeUndefined();
  });

  test("the stamped event round-trips through RawEventSchema", () => {
    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "child-session",
      parentSessionId: "moderator-session",
      substrate: "claude-code",
    });
    const parsed = RawEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });
});
