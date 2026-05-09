import type { IngestEvent, SessionActivity } from "./types";

/** Detect project name from an ingest event's payload fields */
export function detectProjectFromIngestEvent(
  event: IngestEvent,
): string | null {
  const payload = event.payload;

  if (payload.project && typeof payload.project === "string")
    return payload.project;

  if (payload.cwd && typeof payload.cwd === "string") {
    const match = payload.cwd.match(/\/([^/]+)$/);
    if (match?.[1]) return match[1];
  }

  // Fallback: grove_channel (set by GROVE_CHANNEL env var in instrumented sessions)
  if (event.grove_channel) return event.grove_channel;

  return null;
}

/** Extract progress from todo events */
export function extractProgress(
  event: IngestEvent,
): { completed: number; total: number } | null {
  if (event.event_type !== "tool.todo.updated") return null;

  const summary = event.payload.todo_summary as
    | { total?: number; completed?: number }
    | undefined;
  if (!summary) return null;

  return { completed: summary.completed ?? 0, total: summary.total ?? 0 };
}

/** Strip secrets/tokens from command strings before persisting to activity log. */
function sanitizeCommand(cmd: string): string {
  return cmd
    .replace(/\b[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z_]*=[^\s]+/gi, "$&".replace(/=.*/, "=***"))
    .replace(/\b([A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z_]*)=\S+/gi, "$1=***")
    .replace(/grove_sk_[a-f0-9]+/g, "grove_sk_***");
}

/** Extract a structured activity entry from an ingest event, or null if not displayable. */
export function extractActivityEntry(event: IngestEvent): SessionActivity | null {
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
      const rawCmd = String(event.payload.command_preview ?? event.payload.command ?? "");
      if (!rawCmd || /^(cat|echo|ls|pwd|cd)\s/.test(rawCmd)) return null;
      const cmd = sanitizeCommand(rawCmd);
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

/** Extract GitHub issue reference from text (e.g. "#43" or full URL) */
export function extractGitHubIssue(text: string): string | null {
  const match = text.match(
    /https:\/\/github\.com\/[^\s)]+\/issues\/\d+/,
  );
  if (match) return match[0];

  const hashMatch = text.match(/#(\d+)/);
  if (hashMatch) return `#${hashMatch[1]}`;

  return null;
}
