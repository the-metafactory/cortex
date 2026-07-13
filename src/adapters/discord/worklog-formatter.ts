/**
 * G-200: Worklog Event Formatter
 * Clean, aggregated formatting for #agent-log activity feed.
 *
 * Design goals:
 * - User-facing prompts shown as clean quoted text, not raw system prompts
 * - Spawned-session / moderator / participant prompts suppressed from channel-level
 * - Completion messages show duration and meaningful summary
 * - Thread names are human-scannable at a glance
 */

import type { PublishedEvent } from "./events";
import { formatDuration } from "./event-utils";

/**
 * Coerce an `unknown` payload field to string. `event.payload` fields are
 * typed `unknown` (Zod `z.record(z.string(), z.unknown())`) — string-only
 * narrowing prevents the `[object Object]` interpolation trap that
 * `String(value)` falls into for plain objects.
 */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Detect whether an event is from a spawned session (moderator, participant,
 * Agent-tool child CC session). These should be grouped under the parent task,
 * not shown as top-level entries.
 */
export function isSpawnedSessionEvent(event: PublishedEvent): boolean {
  const preview = asString(event.payload.prompt_preview);
  // Moderator and participant system prompts from agent-team.ts
  if (/^You are a moderator coordinating/i.test(preview)) return true;
  if (/^You are "[^"]+", a specialist participant/i.test(preview)) return true;
  if (/^All participants have responded/i.test(preview)) return true;
  // Internal spawned-session prompts (Agent-tool child CC sessions)
  if (/^(Explore|Search|Research|Analyze|Check|Verify|Find|Look)\s/i.test(preview) && preview.length < 80) return true;
  return false;
}

/**
 * Extract a clean, human-readable task description from event payload.
 * Strips agent-prompt-wrapper text, system prompts, and truncates sensibly.
 */
export function extractTaskDescription(event: PublishedEvent): string {
  const raw =
    asString(event.payload.prompt_preview) ||
    asString(event.payload.description) ||
    asString(event.payload.summary) ||
    asString(event.payload.active_task) ||
    "";

  // Strip common agent-prompt wrappers
  let clean = raw
    .replace(/^Latest message from .+?:\n/s, "")
    .replace(/^The user who mentioned you is .+?\.\s*/s, "")
    .replace(/^\(mentioned in conversation\)$/, "")
    .trim();

  // If it's a feature ID pattern, keep it as-is
  const taskMatch = /^[A-Z]-\d+[:\s].*/.exec(clean);
  if (taskMatch) return truncate(taskMatch[0].trim(), 80);

  // Strip leading system-prompt boilerplate
  if (clean.length > 120 && /^(You are|As a|Given the|Based on|Please|I need you to)/i.test(clean)) {
    // Try to find the actual instruction after boilerplate
    const instructionMatch = /(?::\s*|\.\.?\s+)([A-Z][^.]{10,80})/.exec(clean);
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
      const path = asString(event.payload.path);
      if (!path) return null;
      // Show just the filename, not the full path
      const filename = path.split("/").pop() ?? path;
      return `\u{1F4DD} \`${filename}\``; // 📝
    }

    case "tool.todo.updated": {
      const activeTask = asString(event.payload.active_task);
      const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
      const progress = summary ? `${summary.completed ?? 0}/${summary.total ?? 0}` : null;
      const parts = ["\u{1F4CB}"]; // 📋
      if (progress) parts.push(`**${progress}**`);
      if (activeTask) parts.push(truncate(activeTask, 60));
      return parts.length > 1 ? parts.join(" ") : null;
    }

    case "tool.agent.spawned": {
      const desc = asString(event.payload.agent_description) || asString(event.payload.summary);
      if (!desc) return null;
      return `\u{1F916} \u2192 ${truncate(desc, 120)}`; // 🤖 →
    }

    case "tool.bash.executed": {
      const command = asString(event.payload.command_preview) || asString(event.payload.command);
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
  const summary = asString(event.payload.summary);
  if (summary) {
    parts.push(truncate(summary, 300));
  }

  // PR link
  const prUrl = asString(event.payload.pr_url);
  if (prUrl) {
    parts.push(`**PR:** ${prUrl}`);
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
  // GV-2 (cortex#1077): canonical `cortex_channel`, legacy `grove_channel` fallback.
  const channelLabel = event.cortex_channel ?? event.grove_channel;
  const channel = channelLabel ? `#${channelLabel}` : "";

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
  const prUrl = asString(event.payload.pr_url);
  if (prUrl) {
    msg += ` \u2022 [PR](${prUrl})`;
  }

  return msg;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

// ---------------------------------------------------------------------------
// MIG-4.7: Bus-driven worklog formatting for `dispatch.task.*` envelopes.
//
// Why a separate formatter family:
//   The `formatEventForThread` / `formatCompletionSummary` / `formatChannelStart`
//   helpers above operate on `PublishedEvent` — the in-process CC-hook event
//   format. The bus path delivers G-1111 envelopes (different shape:
//   `envelope.payload.task_id`, `envelope.payload.agent_id`, etc.). Rather
//   than overloading the existing formatters with discriminated-union
//   payload handling, we add a parallel, intentionally-thin formatter for
//   envelope-shaped events. The two paths converge on the same Discord
//   thread idiom (start line / completion line).
// ---------------------------------------------------------------------------

/**
 * Lifecycle envelope shape — matches the four constructors in
 * `src/bus/dispatch-events.ts`. Re-declared here as a structural type to
 * avoid a circular import (`runner/` → `bus/dispatch-events`); the test
 * suite asserts the constructed envelopes match this shape.
 */
interface DispatchTaskLifecyclePayload {
  task_id?: unknown;
  agent_id?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  failed_at?: unknown;
  aborted_at?: unknown;
  result_summary?: unknown;
  error_summary?: unknown;
  reason?: unknown;
}

/**
 * Format a `dispatch.task.*` envelope for posting inside a worklog thread.
 *
 * Returns `null` for envelope types this formatter doesn't handle — the
 * worklog adapter's `render` will silently no-op, matching the §5.3
 * isolation contract.
 *
 * Output is intentionally compact (single line where possible) so a thread
 * full of lifecycle events stays scannable.
 */
export function formatDispatchEnvelopeForThread(
  envelopeType: string,
  payload: DispatchTaskLifecyclePayload,
): string | null {
  const taskId = typeof payload.task_id === "string" ? payload.task_id.slice(0, 8) : "?";
  const agent = typeof payload.agent_id === "string" ? payload.agent_id : "?";

  switch (envelopeType) {
    case "dispatch.task.started":
      return `\u{1F3C3} **${agent}** started task \`${taskId}\``;

    case "dispatch.task.completed": {
      const summary = typeof payload.result_summary === "string"
        ? truncate(payload.result_summary, 300)
        : null;
      const duration = computeDuration(payload.started_at, payload.completed_at);
      const parts = [`✅ **${agent}** completed \`${taskId}\``];
      if (duration) parts.push(`(${duration})`);
      const head = parts.join(" ");
      return summary ? `${head}\n${summary}` : head;
    }

    case "dispatch.task.failed": {
      const error = typeof payload.error_summary === "string"
        ? truncate(payload.error_summary, 300)
        : null;
      const duration = computeDuration(payload.started_at, payload.failed_at);
      const parts = [`❌ **${agent}** failed \`${taskId}\``];
      if (duration) parts.push(`(${duration})`);
      const head = parts.join(" ");
      return error ? `${head}\n${error}` : head;
    }

    case "dispatch.task.aborted": {
      const reason = typeof payload.reason === "string"
        ? truncate(payload.reason, 200)
        : null;
      const duration = computeDuration(payload.started_at, payload.aborted_at);
      const parts = [`⚠\u{FE0F} **${agent}** aborted \`${taskId}\``];
      if (duration) parts.push(`(${duration})`);
      const head = parts.join(" ");
      return reason ? `${head} — ${reason}` : head;
    }

    default:
      return null;
  }
}

function computeDuration(startedAt: unknown, endedAt: unknown): string | null {
  if (typeof startedAt !== "string" || typeof endedAt !== "string") return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  return formatDuration(ms);
}
