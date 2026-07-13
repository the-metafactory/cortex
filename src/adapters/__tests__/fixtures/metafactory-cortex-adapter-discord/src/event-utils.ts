/**
 * Event utilities for the `PublishedEvent` shape (CC hook events lifted by
 * the relay), used by the discord adapter's `worklog-manager` /
 * `worklog-formatter` to detect project / extract GitHub references /
 * surface activity entries. Moved here from `src/runner/` (cortex#1787 — S2)
 * alongside `worklog-manager.ts`, since it has no consumers outside the
 * worklog family.
 *
 * Distinct from `src/common/event-utils.ts`, which serves the `IngestEvent`
 * shape used by the mc API + cc-events tap. The two files share function
 * names (`detectProject`) but operate on different event types and live in
 * different surfaces of the codebase. The naming overlap is intentional —
 * each surface has its own canonical "given an event, infer the project"
 * implementation, and consolidating them would force a lossy union type
 * (PublishedEvent | IngestEvent) that obscures which surface a caller is
 * really on. No consolidation is planned.
 *
 * If you find yourself wanting to call one from the other, you're probably
 * on the wrong side of the surface boundary — the mc/tap layer shouldn't be
 * inspecting PublishedEvents. Reach for the projection at the boundary
 * instead.
 */

import type { PublishedEvent } from "./events";

/**
 * cortex#1797 (S12) — inlined verbatim from cortex's `src/shared/format-utils.ts`
 * (the long-form duration formatter only; `formatDurationCompact` has no
 * consumer in the worklog family). Not worth a cross-repo dependency for a
 * five-line pure function.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Coerce an `unknown` payload field to string. Avoids the
 * `[object Object]` stringification trap that `String(value)` falls into
 * when `value` is a plain object — `event.payload` fields are typed as
 * `unknown` (Zod `z.record(z.string(), z.unknown())`), so the
 * payload-bound code paths in this module need explicit string-only
 * narrowing before interpolating.
 */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

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
 * Falls back to: regex on text → channel label (GV-2 cortex#1077: canonical
 * `cortex_channel`, then legacy `grove_channel` alias).
 */
export function detectProjectFromEvent(event: PublishedEvent): string | null {
  // H-001: Explicit project metadata takes priority
  const project = asString(event.payload.project);
  if (project) return project;

  const text =
    asString(event.payload.prompt_preview) ||
    asString(event.payload.description) ||
    asString(event.payload.active_task) ||
    "";
  return detectProject(text) ?? event.cortex_channel ?? event.grove_channel ?? null;
}

/**
 * Extract GitHub issue reference from text.
 * Matches full URLs (https://github.com/.../issues/123) or hash refs (#123).
 */
export function extractGitHubIssue(text: string): string | null {
  const match = /https:\/\/github\.com\/[^\s)]+\/issues\/\d+/.exec(text);
  if (match) return match[0];

  const hashMatch = /#(\d+)/.exec(text);
  if (hashMatch?.[1] !== undefined) return `#${hashMatch[1]}`;

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
      const path = asString(event.payload.path);
      if (!path) return null;
      const filename = path.split("/").pop() ?? path;
      const toolInput = event.payload.tool_input as Record<string, unknown> | undefined;
      const toolName = asString(event.payload.tool_name) || (toolInput?.content ? "Write" : "Edit");
      return { timestamp: event.timestamp, icon: "\u{1F4DD}", label: "file changed", detail: `${toolName === "Write" ? "Writing" : "Editing"} ${filename}` };
    }
    case "tool.file.read": {
      const toolInputRead = event.payload.tool_input as Record<string, unknown> | undefined;
      const path = asString(event.payload.path) || asString(toolInputRead?.file_path);
      if (!path) return null;
      const filename = path.split("/").pop() ?? path;
      return { timestamp: event.timestamp, icon: "\u{1F4D6}", label: "reading", detail: `Reading ${filename}` };
    }
    case "tool.bash.executed": {
      const cmd = asString(event.payload.command_preview) || asString(event.payload.command);
      if (!cmd || /^(cat|echo|ls|pwd|cd)\s/.test(cmd)) return null;
      const detail = cmd.length > 100 ? cmd.slice(0, 97) + "..." : cmd;
      return { timestamp: event.timestamp, icon: "\u{1F4BB}", label: "command", detail };
    }
    case "tool.agent.spawned": {
      const desc = asString(event.payload.agent_description) || asString(event.payload.summary);
      if (!desc) return null;
      const detail = desc.length > 100 ? desc.slice(0, 97) + "..." : desc;
      return { timestamp: event.timestamp, icon: "\u{1F916}", label: "spawned-session", detail };
    }
    case "tool.todo.updated": {
      const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
      const task = asString(event.payload.active_task);
      const progress = summary ? `${summary.completed ?? 0}/${summary.total ?? 0}` : "";
      const detail = [progress, task].filter(Boolean).join(" ");
      if (!detail) return null;
      return { timestamp: event.timestamp, icon: "\u{1F4CB}", label: "progress", detail };
    }
    default: {
      // Handle generic tool.*.used events (Grep, Glob, WebSearch, etc.)
      if (event.event_type.startsWith("tool.") && event.event_type.endsWith(".used")) {
        const fallback = event.event_type.split(".")[1] ?? "tool";
        const toolName = asString(event.payload.tool_name) || fallback;
        const input = event.payload.tool_input as Record<string, unknown> | undefined;
        let detail = `Using ${toolName}`;
        if (toolName === "Grep" || toolName === "grep") {
          detail = `Searching for \`${asString(input?.pattern).slice(0, 60)}\``;
        } else if (toolName === "Glob" || toolName === "glob") {
          detail = `Finding files matching \`${asString(input?.pattern)}\``;
        } else if (toolName === "WebSearch" || toolName === "websearch") {
          detail = `Searching web: ${asString(input?.query).slice(0, 60)}`;
        } else if (toolName === "WebFetch" || toolName === "webfetch") {
          detail = `Fetching ${asString(input?.url).slice(0, 60)}`;
        } else if (toolName === "Skill" || toolName === "skill") {
          detail = `Using skill: ${asString(input?.skill)}`;
        }
        return { timestamp: event.timestamp, icon: "\u{1F527}", label: toolName, detail };
      }
      return null;
    }
  }
}

