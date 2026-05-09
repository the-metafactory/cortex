/**
 * T-4.2: Event Formatter
 * Formats published events for Discord #agent-log.
 */

import type { PublishedEvent } from "../../taps/cc-events/hooks/lib/event-types";
import { POSTABLE_EVENTS } from "../../common/types/context";

const MAX_SUMMARY_LENGTH = 400;

export function isPostableEvent(eventType: string): boolean {
  return (POSTABLE_EVENTS as readonly string[]).includes(eventType);
}

/** Map event types to human-readable labels with emoji */
const EVENT_LABELS: Record<string, string> = {
  "agent.task.started": "\u{1F4AC} prompt",      // 💬
  "agent.task.completed": "\u2705 completed",     // ✅
  "agent.task.failed": "\u274C failed",           // ❌
  "tool.file.changed": "\u{1F4DD} file changed",  // 📝
  "tool.agent.spawned": "\u{1F916} subagent",    // 🤖
  "tool.todo.updated": "\u{1F4CB} progress",     // 📋
};

export function formatEventForDiscord(event: PublishedEvent): string | null {
  if (!isPostableEvent(event.event_type)) return null;

  const channel = event.grove_channel ?? "unknown";
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const label = EVENT_LABELS[event.event_type] ?? event.event_type.split(".").pop();

  let detail = "";
  if (event.payload.prompt_preview) {
    // User input — show as quote
    detail = `> ${String(event.payload.prompt_preview)}`;
  } else if (event.payload.summary) {
    detail = String(event.payload.summary);
  } else if (event.payload.path) {
    detail = `\`${event.payload.path}\``;
  } else if (event.payload.active_task) {
    const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
    const progress = summary ? ` (${summary.completed ?? 0}/${summary.total ?? 0})` : "";
    detail = `${event.payload.active_task}${progress}`;
  } else if (event.payload.agent_description) {
    detail = String(event.payload.agent_description);
  }

  if (detail.length > MAX_SUMMARY_LENGTH) {
    detail = detail.slice(0, MAX_SUMMARY_LENGTH) + "...";
  }

  const durationStr = event.payload.duration_ms
    ? ` (${(Number(event.payload.duration_ms) / 1000).toFixed(1)}s)`
    : "";

  return `**${channel}** ${label}${durationStr} \u2022 ${time}\n${detail}`;
}
