/**
 * T-4.2: Event Formatter
 * Formats published events for Discord #agent-log.
 */

import type { PublishedEvent } from "./events";

/**
 * cortex#1797 (S12) — inlined verbatim from cortex's `src/common/types/context.ts`
 * (plugin-owned duplicate; the canonical list stays in `context.ts` for the
 * dispatch-handler's context-fetch consumers, which are cortex-internal).
 */
const POSTABLE_EVENTS = [
  "agent.task.started",
  "agent.task.completed",
  "agent.task.failed",
  "tool.file.changed",
  "tool.agent.spawned",
  "tool.todo.updated",
] as const;

const MAX_SUMMARY_LENGTH = 400;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function isPostableEvent(eventType: string): boolean {
  return (POSTABLE_EVENTS as readonly string[]).includes(eventType);
}

/** Map event types to human-readable labels with emoji */
const EVENT_LABELS: Record<string, string> = {
  "agent.task.started": "\u{1F4AC} prompt",      // 💬
  "agent.task.completed": "\u2705 completed",     // ✅
  "agent.task.failed": "\u274C failed",           // ❌
  "tool.file.changed": "\u{1F4DD} file changed",  // 📝
  "tool.agent.spawned": "\u{1F916} spawned session",    // 🤖
  "tool.todo.updated": "\u{1F4CB} progress",     // 📋
};

export function formatEventForDiscord(event: PublishedEvent): string | null {
  if (!isPostableEvent(event.event_type)) return null;

  // GV-2 (cortex#1077): canonical `cortex_channel`, legacy `grove_channel` fallback.
  const channel = event.cortex_channel ?? event.grove_channel ?? "unknown";
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const label = EVENT_LABELS[event.event_type] ?? event.event_type.split(".").pop();

  let detail = "";
  const promptPreview = asString(event.payload.prompt_preview);
  const summaryText = asString(event.payload.summary);
  const pathText = asString(event.payload.path);
  const activeTask = asString(event.payload.active_task);
  const agentDescription = asString(event.payload.agent_description);
  if (promptPreview) {
    // User input — show as quote
    detail = `> ${promptPreview}`;
  } else if (summaryText) {
    detail = summaryText;
  } else if (pathText) {
    detail = `\`${pathText}\``;
  } else if (activeTask) {
    const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
    const progress = summary ? ` (${summary.completed ?? 0}/${summary.total ?? 0})` : "";
    detail = `${activeTask}${progress}`;
  } else if (agentDescription) {
    detail = agentDescription;
  }

  if (detail.length > MAX_SUMMARY_LENGTH) {
    detail = detail.slice(0, MAX_SUMMARY_LENGTH) + "...";
  }

  const durationStr = event.payload.duration_ms
    ? ` (${(Number(event.payload.duration_ms) / 1000).toFixed(1)}s)`
    : "";

  return `**${channel}** ${label}${durationStr} \u2022 ${time}\n${detail}`;
}
