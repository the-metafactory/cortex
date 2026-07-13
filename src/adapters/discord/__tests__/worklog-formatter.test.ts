import { test, expect, describe } from "bun:test";
import { formatThreadName, formatEventForThread, formatCompletionSummary } from "../worklog-formatter";
import type { PublishedEvent } from "../events";

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "agent.task.started",
    timestamp: new Date().toISOString(),
    session_id: "test-session-123",
    agent_name: "Luna",
    payload: {},
    ...overrides,
  };
}

describe("formatThreadName", () => {
  test("extracts task identifier pattern", () => {
    const event = makeEvent({
      payload: { prompt_preview: "I-400: Test Stabilization — fix DUMMY_HASH crash" },
    });
    expect(formatThreadName(event)).toBe("Luna — I-400: Test Stabilization — fix DUMMY_HASH crash");
  });

  test("extracts G-series task identifier", () => {
    const event = makeEvent({
      payload: { prompt_preview: "G-200: Worklog Channel implementation" },
    });
    expect(formatThreadName(event)).toBe("Luna — G-200: Worklog Channel implementation");
  });

  test("truncates long descriptions without task ID", () => {
    const long = "A".repeat(100);
    const event = makeEvent({ payload: { prompt_preview: long } });
    const name = formatThreadName(event);
    expect(name).toContain("Luna —");
    expect(name.length).toBeLessThanOrEqual(90); // "Luna — " + truncated 80 + "..."
  });

  test("falls back to agent_id when no agent_name", () => {
    const event = makeEvent({
      agent_name: undefined,
      agent_id: "luna",
      payload: { prompt_preview: "Some task" },
    });
    expect(formatThreadName(event)).toContain("luna —");
  });

  test("falls back to 'agent' when neither name nor id", () => {
    const event = makeEvent({
      agent_name: undefined,
      agent_id: undefined,
      payload: { prompt_preview: "Some task" },
    });
    expect(formatThreadName(event)).toContain("agent —");
  });
});

describe("formatEventForThread", () => {
  test("formats file changed events", () => {
    const event = makeEvent({
      event_type: "tool.file.changed",
      payload: { path: "src/lib/crypto.ts" },
    });
    expect(formatEventForThread(event)).toBe("\u{1F4DD} `crypto.ts`");
  });

  test("returns null for file changed without path", () => {
    const event = makeEvent({
      event_type: "tool.file.changed",
      payload: {},
    });
    expect(formatEventForThread(event)).toBeNull();
  });

  test("formats todo updated with progress", () => {
    const event = makeEvent({
      event_type: "tool.todo.updated",
      payload: {
        active_task: "Fix migration numbering",
        todo_summary: { completed: 3, total: 6 },
      },
    });
    const result = formatEventForThread(event)!;
    expect(result).toContain("**3/6**");
    expect(result).toContain("Fix migration numbering");
  });

  test("formats agent spawned", () => {
    const event = makeEvent({
      event_type: "tool.agent.spawned",
      payload: { agent_description: "explore test failures" },
    });
    expect(formatEventForThread(event)).toContain("explore test failures");
  });

  test("returns null for unknown event types", () => {
    const event = makeEvent({
      event_type: "session.started",
      payload: {},
    });
    expect(formatEventForThread(event)).toBeNull();
  });
});

describe("formatCompletionSummary", () => {
  test("formats completed task with duration", () => {
    const event = makeEvent({
      event_type: "agent.task.completed",
      payload: {
        duration_ms: 754000,
        summary: "All tests passing",
      },
    });
    const result = formatCompletionSummary(event);
    expect(result).toContain("\u2705");
    expect(result).toContain("Completed");
    expect(result).toContain("12m 34s");
    expect(result).toContain("All tests passing");
  });

  test("formats failed task", () => {
    const event = makeEvent({
      event_type: "agent.task.failed",
      payload: { summary: "Timeout exceeded" },
    });
    const result = formatCompletionSummary(event);
    expect(result).toContain("\u274C");
    expect(result).toContain("Failed");
  });

  test("includes PR link when available", () => {
    const event = makeEvent({
      event_type: "agent.task.completed",
      payload: { pr_url: "https://github.com/the-metafactory/meta-factory/pull/26" },
    });
    const result = formatCompletionSummary(event);
    expect(result).toContain("PR:");
    expect(result).toContain("/pull/26");
  });
});
