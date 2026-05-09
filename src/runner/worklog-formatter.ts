/**
 * G-200: Worklog Event Formatter
 * Clean, aggregated formatting for #agent-log activity feed.
 *
 * Design goals:
 * - User-facing prompts shown as clean quoted text, not raw system prompts
 * - Sub-agent / moderator / participant prompts suppressed from channel-level
 * - Completion messages show duration and meaningful summary
 * - Thread names are human-scannable at a glance
 */

import type { PublishedEvent } from "../taps/cc-events/hooks/lib/event-types";
import { formatDuration } from "./event-utils";

/**
 * Detect whether an event is from a sub-agent (moderator, participant, internal).
 * These should be grouped under the parent task, not shown as top-level entries.
 */
export function isSubAgentEvent(event: PublishedEvent): boolean {
  const preview = String(event.payload.prompt_preview ?? "");
  // Moderator and participant system prompts from agent-team.ts
  if (/^You are a moderator coordinating/i.test(preview)) return true;
  if (/^You are "[^"]+", a specialist participant/i.test(preview)) return true;
  if (/^All participants have responded/i.test(preview)) return true;
  // Internal sub-agent prompts (Agent tool spawns)
  if (/^(Explore|Search|Research|Analyze|Check|Verify|Find|Look)\s/i.test(preview) && preview.length < 80) return true;
  return false;
}

/**
 * Extract a clean, human-readable task description from event payload.
 * Strips grove-bot wrapper text, system prompts, and truncates sensibly.
 */
export function extractTaskDescription(event: PublishedEvent): string {
  const raw = String(
    event.payload.prompt_preview
    ?? event.payload.description
    ?? event.payload.summary
    ?? event.payload.active_task
    ?? ""
  );

  // Strip common grove-bot prompt wrappers
  let clean = raw
    .replace(/^Latest message from .+?:\n/s, "")
    .replace(/^The user who mentioned you is .+?\.\s*/s, "")
    .replace(/^\(mentioned in conversation\)$/, "")
    .trim();

  // If it's a feature ID pattern, keep it as-is
  const taskMatch = clean.match(/^[A-Z]-\d+[:\s].*/);
  if (taskMatch) return truncate(taskMatch[0].trim(), 80);

  // Strip leading system-prompt boilerplate
  if (clean.length > 120 && /^(You are|As a|Given the|Based on|Please|I need you to)/i.test(clean)) {
    // Try to find the actual instruction after boilerplate
    const instructionMatch = clean.match(/(?::\s*|\.\.?\s+)([A-Z][^.]{10,80})/);
    if (instructionMatch?.[1]) clean = instructionMatch[1];
  }

  return truncate(clean, 80) || "Task";
}

/**
 * Format a thread name from an event.
 * Pattern: "{agent_name} — {clean_description}"
 */
export function formatThreadName(event: PublishedEvent): string {
  const agentName = event.agent_name ?? event.agent_id ?? "agent";
  const desc = extractTaskDescription(event);
  return `${agentName} — ${desc}`;
}

/**
 * Format a progress event for posting inside a worklog thread.
 * Returns null if the event shouldn't be posted (noise reduction).
 */
export function formatEventForThread(event: PublishedEvent): string | null {
  switch (event.event_type) {
    case "tool.file.changed": {
      const path = event.payload.path ? String(event.payload.path) : null;
      if (!path) return null;
      // Show just the filename, not the full path
      const filename = path.split("/").pop() ?? path;
      return `\u{1F4DD} \`${filename}\``; // 📝
    }

    case "tool.todo.updated": {
      const activeTask = event.payload.active_task ? String(event.payload.active_task) : null;
      const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
      const progress = summary ? `${summary.completed ?? 0}/${summary.total ?? 0}` : null;
      const parts = ["\u{1F4CB}"]; // 📋
      if (progress) parts.push(`**${progress}**`);
      if (activeTask) parts.push(truncate(activeTask, 60));
      return parts.length > 1 ? parts.join(" ") : null;
    }

    case "tool.agent.spawned": {
      const desc = event.payload.agent_description
        ? String(event.payload.agent_description)
        : event.payload.summary
          ? String(event.payload.summary)
          : null;
      if (!desc) return null;
      return `\u{1F916} \u2192 ${truncate(desc, 120)}`; // 🤖 →
    }

    case "tool.bash.executed": {
      const command = event.payload.command_preview
        ? String(event.payload.command_preview)
        : event.payload.command
          ? String(event.payload.command)
          : null;
      if (!command) return null;
      // Skip noisy internal commands
      if (/^(cat|echo|ls|pwd|cd)\s/.test(command)) return null;
      return `\u{1F4BB} \`${truncate(command, 100)}\``; // 💻
    }

    default:
      return null;
  }
}

/**
 * Format a completion summary for posting at the end of a worklog thread.
 */
export function formatCompletionSummary(event: PublishedEvent): string {
  const icon = event.event_type === "agent.task.completed" ? "\u2705" : "\u274C"; // ✅ or ❌
  const status = event.event_type === "agent.task.completed" ? "Completed" : "Failed";

  const parts: string[] = [`${icon} **${status}**`];

  // Duration
  const durationMs = event.payload.duration_ms ? Number(event.payload.duration_ms) : null;
  if (durationMs) {
    parts.push(`**Duration:** ${formatDuration(durationMs)}`);
  }

  // Summary (truncated for thread, full detail is in the response itself)
  if (event.payload.summary) {
    parts.push(truncate(String(event.payload.summary), 300));
  }

  // PR link
  if (event.payload.pr_url) {
    parts.push(`**PR:** ${event.payload.pr_url}`);
  }

  return parts.join("\n");
}

/**
 * Format a clean channel-level start message.
 * Pattern: "🏃 Agent — "description" — source"
 */
export function formatChannelStart(event: PublishedEvent): string {
  const agentName = event.agent_name ?? event.agent_id ?? "agent";
  const desc = extractTaskDescription(event);
  const channel = event.grove_channel ? `#${event.grove_channel}` : "";

  let msg = `\u{1F3C3} **${agentName}** \u2014 "${desc}"`;
  if (channel) msg += ` \u2014 ${channel}`;
  return msg;
}

/**
 * Format a clean channel-level completion message.
 * Pattern: "✅ Agent — "description" — duration"
 */
export function formatChannelCompletion(event: PublishedEvent): string {
  const agentName = event.agent_name ?? event.agent_id ?? "agent";
  const desc = extractTaskDescription(event);
  const durationMs = event.payload.duration_ms ? Number(event.payload.duration_ms) : null;
  const icon = event.event_type === "agent.task.completed" ? "\u2705" : "\u274C";

  let msg = `${icon} **${agentName}** \u2014 "${desc}"`;
  if (durationMs) msg += ` \u2014 ${formatDuration(durationMs)}`;

  // PR link inline
  if (event.payload.pr_url) {
    msg += ` \u2022 [PR](${String(event.payload.pr_url)})`;
  }

  return msg;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}
