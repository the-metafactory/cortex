/**
 * Shared utilities for extracting metadata from published events.
 * Used by both dashboard-state and worklog-manager to avoid duplication.
 *
 * TODO(MIG-7): This is the bot/lib version of event-utils, distinct from
 * `src/common/event-utils.ts` (the mc/tap version). They cover different
 * event shapes (`PublishedEvent` here vs `IngestEvent` there) — overlapping
 * function names work on different surfaces. Consolidation pass scheduled
 * at MIG-7 alongside the broader common/types reorg.
 */

import type { PublishedEvent } from "../taps/cc-events/hooks/lib/event-types";
import { formatDuration } from "../shared/format-utils";

/**
 * Detect which project a task relates to from event text.
 * Looks for feature ID patterns: I-4xx = meta-factory, G-2xx = grove, F-1xx/F-2xx/F-3xx = meta-factory.
 * Returns lowercase project IDs for consistency (e.g. "meta-factory", "grove").
 *
 * Returns null when no known pattern matches — callers should treat this as
 * "project unknown" (not an error). If new numbering ranges are added,
 * extend the patterns here.
 */
export function detectProject(text: string): string | null {
  // Issue-series: I-400..999 = meta-factory (backlog items)
  if (/\bI-[4-9]\d{2}\b/.test(text)) return "meta-factory";
  // G-series: G-200..999 = grove (cross-cutting features)
  if (/\bG-[2-9]\d{2}\b/.test(text)) return "grove";
  // F-series: F-100..399 = meta-factory (core bot features)
  if (/\bF-[1-3]\d{2}\b/.test(text)) return "meta-factory";
  return null;
}

/**
 * Detect project from a published event's payload fields.
 * H-001: Prefers explicit metadata (GROVE_PROJECT env var) over regex detection.
 * Falls back to: regex on text → grove_channel.
 */
export function detectProjectFromEvent(event: PublishedEvent): string | null {
  // H-001: Explicit project metadata takes priority
  if (event.payload.project) return String(event.payload.project);

  const text = String(
    event.payload.prompt_preview
    ?? event.payload.description
    ?? event.payload.active_task
    ?? ""
  );
  return detectProject(text) ?? event.grove_channel ?? null;
}

/**
 * Extract GitHub issue reference from text.
 * Matches full URLs (https://github.com/.../issues/123) or hash refs (#123).
 */
export function extractGitHubIssue(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/);
  if (match) return match[0];

  const hashMatch = text.match(/#(\d+)/);
  if (hashMatch) return `#${hashMatch[1]}`;

  return null;
}

/** G-205a: Structured activity entry extracted from a published event. */
export interface SessionActivity {
  timestamp: string;
  icon: string;
  label: string;
  detail: string;
}

/** G-205a: Extract a structured activity entry from a published event, or null if not displayable. */
export function extractActivityEntry(event: PublishedEvent): SessionActivity | null {
  switch (event.event_type) {
    case "tool.file.changed": {
      const path = event.payload.path ? String(event.payload.path) : null;
      if (!path) return null;
      const filename = path.split("/").pop() ?? path;
      const toolInput = event.payload.tool_input as Record<string, unknown> | undefined;
      const toolName = event.payload.tool_name ?? (toolInput?.content ? "Write" : "Edit");
      return { timestamp: event.timestamp, icon: "\u{1F4DD}", label: "file changed", detail: `${toolName === "Write" ? "Writing" : "Editing"} ${filename}` };
    }
    case "tool.file.read": {
      const toolInputRead = event.payload.tool_input as Record<string, unknown> | undefined;
      const path = event.payload.path ?? (toolInputRead?.file_path ? String(toolInputRead.file_path) : null);
      if (!path) return null;
      const filename = String(path).split("/").pop() ?? String(path);
      return { timestamp: event.timestamp, icon: "\u{1F4D6}", label: "reading", detail: `Reading ${filename}` };
    }
    case "tool.bash.executed": {
      const cmd = String(event.payload.command_preview ?? event.payload.command ?? "");
      if (!cmd || /^(cat|echo|ls|pwd|cd)\s/.test(cmd)) return null;
      const detail = cmd.length > 100 ? cmd.slice(0, 97) + "..." : cmd;
      return { timestamp: event.timestamp, icon: "\u{1F4BB}", label: "command", detail };
    }
    case "tool.agent.spawned": {
      const desc = String(event.payload.agent_description ?? event.payload.summary ?? "");
      if (!desc) return null;
      const detail = desc.length > 100 ? desc.slice(0, 97) + "..." : desc;
      return { timestamp: event.timestamp, icon: "\u{1F916}", label: "subagent", detail };
    }
    case "tool.todo.updated": {
      const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
      const task = event.payload.active_task ? String(event.payload.active_task) : "";
      const progress = summary ? `${summary.completed ?? 0}/${summary.total ?? 0}` : "";
      const detail = [progress, task].filter(Boolean).join(" ");
      if (!detail) return null;
      return { timestamp: event.timestamp, icon: "\u{1F4CB}", label: "progress", detail };
    }
    default: {
      // Handle generic tool.*.used events (Grep, Glob, WebSearch, etc.)
      if (event.event_type.startsWith("tool.") && event.event_type.endsWith(".used")) {
        const toolName = String(event.payload.tool_name ?? event.event_type.split(".")[1] ?? "tool");
        const input = event.payload.tool_input as Record<string, unknown> | undefined;
        let detail = `Using ${toolName}`;
        if (toolName === "Grep" || toolName === "grep") {
          detail = `Searching for \`${String(input?.pattern ?? "").slice(0, 60)}\``;
        } else if (toolName === "Glob" || toolName === "glob") {
          detail = `Finding files matching \`${String(input?.pattern ?? "")}\``;
        } else if (toolName === "WebSearch" || toolName === "websearch") {
          detail = `Searching web: ${String(input?.query ?? "").slice(0, 60)}`;
        } else if (toolName === "WebFetch" || toolName === "webfetch") {
          detail = `Fetching ${String(input?.url ?? "").slice(0, 60)}`;
        } else if (toolName === "Skill" || toolName === "skill") {
          detail = `Using skill: ${String(input?.skill ?? "")}`;
        }
        return { timestamp: event.timestamp, icon: "\u{1F527}", label: toolName, detail };
      }
      return null;
    }
  }
}

// Re-export formatDuration from shared utilities for convenience
export { formatDuration };
