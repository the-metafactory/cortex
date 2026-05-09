import { test, expect, describe } from "bun:test";
import { mapHookToEventType, EVENT_TYPES } from "../event-taxonomy";

describe("mapHookToEventType", () => {
  test("UserPromptSubmit → agent.task.started", () => {
    expect(mapHookToEventType("UserPromptSubmit")).toBe(EVENT_TYPES.TASK_STARTED);
  });

  test("Stop → agent.task.completed", () => {
    expect(mapHookToEventType("Stop")).toBe(EVENT_TYPES.TASK_COMPLETED);
  });

  test("SessionStart → session.started", () => {
    expect(mapHookToEventType("SessionStart")).toBe(EVENT_TYPES.SESSION_STARTED);
  });

  test("PostToolUse Write → tool.file.changed", () => {
    expect(mapHookToEventType("PostToolUse", "Write")).toBe(EVENT_TYPES.FILE_CHANGED);
  });

  test("PostToolUse Edit → tool.file.changed", () => {
    expect(mapHookToEventType("PostToolUse", "Edit")).toBe(EVENT_TYPES.FILE_CHANGED);
  });

  test("PostToolUse Bash → tool.bash.executed", () => {
    expect(mapHookToEventType("PostToolUse", "Bash")).toBe(EVENT_TYPES.BASH_EXECUTED);
  });

  test("PostToolUse Read → tool.file.read", () => {
    expect(mapHookToEventType("PostToolUse", "Read")).toBe(EVENT_TYPES.FILE_READ);
  });

  test("PostToolUse Agent → tool.agent.spawned", () => {
    expect(mapHookToEventType("PostToolUse", "Agent")).toBe(EVENT_TYPES.AGENT_SPAWNED);
  });

  test("PostToolUse MultiTool → tool.file.changed", () => {
    expect(mapHookToEventType("PostToolUse", "MultiTool")).toBe(EVENT_TYPES.FILE_CHANGED);
  });

  test("PostToolUse unknown tool → fallback pattern", () => {
    expect(mapHookToEventType("PostToolUse", "UnknownTool")).toBe("tool.unknowntool.used");
  });

  test("PostToolUse no tool name → tool.unknown.used", () => {
    expect(mapHookToEventType("PostToolUse")).toBe("tool.unknown.used");
  });

  test("unknown hook type → fallback pattern", () => {
    expect(mapHookToEventType("CustomHook")).toBe("hook.customhook");
  });
});
