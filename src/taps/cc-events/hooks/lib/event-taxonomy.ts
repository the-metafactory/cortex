/**
 * T-1.4: Event Type Taxonomy
 * Maps Claude Code hook inputs to Grove event types.
 */

// =============================================================================
// Event Type Constants
// =============================================================================

export const EVENT_TYPES = {
  // Agent lifecycle
  TASK_STARTED: "agent.task.started",
  TASK_COMPLETED: "agent.task.completed",
  TASK_FAILED: "agent.task.failed",
  TASK_CANCELLED: "agent.task.cancelled",

  // Tool usage
  BASH_EXECUTED: "tool.bash.executed",
  FILE_CHANGED: "tool.file.changed",
  FILE_READ: "tool.file.read",
  AGENT_SPAWNED: "tool.agent.spawned",
  TODO_UPDATED: "tool.todo.updated",

  // Account usage (G-206)
  USAGE_UPDATE: "agent.usage.update",

  // Session lifecycle
  SESSION_STARTED: "session.started",
  SESSION_ENDED: "session.ended",

  // H-005: Heartbeat for long-running sessions
  SESSION_HEARTBEAT: "agent.session.heartbeat",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// =============================================================================
// Hook → Event Type Mapping
// =============================================================================

const TOOL_EVENT_MAP: Record<string, string> = {
  Bash: EVENT_TYPES.BASH_EXECUTED,
  Edit: EVENT_TYPES.FILE_CHANGED,
  Write: EVENT_TYPES.FILE_CHANGED,
  Read: EVENT_TYPES.FILE_READ,
  Agent: EVENT_TYPES.AGENT_SPAWNED,
  MultiTool: EVENT_TYPES.FILE_CHANGED,
  TodoWrite: EVENT_TYPES.TODO_UPDATED,
};

export function mapHookToEventType(
  hookType: string,
  toolName?: string
): string {
  switch (hookType) {
    case "UserPromptSubmit":
      return EVENT_TYPES.TASK_STARTED;

    case "Stop":
      return EVENT_TYPES.TASK_COMPLETED;

    case "SessionStart":
      return EVENT_TYPES.SESSION_STARTED;

    case "PostToolUse":
      if (toolName) {
        const mapped = TOOL_EVENT_MAP[toolName];
        if (mapped) return mapped;
      }
      return `tool.${(toolName ?? "unknown").toLowerCase()}.used`;

    default:
      return `hook.${hookType.toLowerCase()}`;
  }
}
