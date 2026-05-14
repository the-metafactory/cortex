#!/usr/bin/env bun
/**
 * T-2.1 + T-2.2 + T-2.3: EventLogger Hook
 * Captures raw events to JSONL. Zero external dependencies beyond filesystem.
 * Only active when GROVE_CHANNEL env var is set (session scoping).
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createRawEvent } from "./lib/event-types";
import { mapHookToEventType, EVENT_TYPES } from "./lib/event-taxonomy";

// =============================================================================
// Configuration
// =============================================================================

const EVENTS_DIR = join(process.env.HOME ?? "~", ".claude", "events");
const RAW_DIR = join(EVENTS_DIR, "raw");
const INGEST_URL = "http://localhost:8766/api/events/ingest";

// =============================================================================
// Session Scoping (T-2.2)
// =============================================================================

const groveChannel = process.env.GROVE_CHANNEL;
if (!groveChannel) {
  process.exit(0); // Not a Grove session — silent exit
}

const groveNetwork = process.env.GROVE_NETWORK;
const groveProject = process.env.GROVE_PROJECT;
const groveEntity = process.env.GROVE_ENTITY;
const groveOperator = process.env.GROVE_OPERATOR;

// =============================================================================
// Directory Setup (T-2.3)
// =============================================================================

function ensureDir(dir: string, mode: number): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode });
  }
}

ensureDir(RAW_DIR, 0o700);
ensureDir(join(EVENTS_DIR, "published"), 0o755);

// =============================================================================
// H-004: HTTP POST ingestion (primary), JSONL fallback (secondary)
// =============================================================================

/** Try to POST an event to the dashboard API. Returns true on success. */
async function postEvent(event: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500), // 500ms max — never block the agent
    });
    return res.status === 202;
  } catch (_err: unknown) {
    return false; // Connection refused, timeout, etc. — expected when dashboard is down
  }
}

/** Always write to JSONL as a fallback/archive. */
function writeToJsonl(filePath: string, event: Record<string, unknown>): void {
  appendFileSync(filePath, JSON.stringify(event) + "\n");
  chmodSync(filePath, 0o600);
}

// =============================================================================
// Main: Read hook input, write raw JSONL
// =============================================================================

async function main() {
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    if (!input.trim()) process.exit(0);

    const hookInput = JSON.parse(input);

    const toolName: string | undefined = hookInput.tool_name ?? hookInput.tool?.name;

    // Infer hook type from input shape (CC doesn't always include hook_event_name)
    let hookType: string = hookInput.hook_event_name ?? hookInput.hook_type ?? "unknown";
    if (hookType === "unknown") {
      if (hookInput.tool_name || hookInput.tool_input) hookType = "PostToolUse";
      else if (hookInput.prompt) hookType = "UserPromptSubmit";
      else if (hookInput.last_assistant_message || hookInput.transcript_path) hookType = "Stop";
    }
    const sessionId: string =
      hookInput.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

    const eventType = mapHookToEventType(hookType, toolName);

    // Build payload from hook input (raw — relay will filter)
    const payload: Record<string, unknown> = {};

    if (hookInput.tool_input) payload.tool_input = hookInput.tool_input;
    if (hookInput.tool_output) payload.tool_output = hookInput.tool_output;
    if (hookInput.prompt) {
      let preview = hookInput.prompt;
      // Strip grove-bot wrapper to show just the user's message
      const latestMatch = preview.match(/Latest message from .+?:\n(.+)/s);
      const mentionMatch = preview.match(/The user who mentioned you is .+?\.\s*$/);
      if (latestMatch) {
        preview = latestMatch[1];
      } else if (mentionMatch) {
        preview = "(mentioned in conversation)";
      }
      // Strip XML/system tags (e.g. <task-notification>, <tool-use-id>) —
      // Claude Code injects these as internal prompts, not user content
      preview = preview.replace(/<[^>]+>/g, "").trim();
      if (preview) {
        payload.prompt_preview = preview.slice(0, 200);
      }
    }
    if (hookInput.summary) payload.summary = hookInput.summary;
    if (hookInput.duration_ms) payload.duration_ms = hookInput.duration_ms;
    if (toolName) payload.tool_name = toolName;

    // File path from tool input (for file.changed events)
    if (hookInput.tool_input?.file_path) {
      payload.path = hookInput.tool_input.file_path;
    }
    if (hookInput.tool_input?.command) {
      payload.command_preview = hookInput.tool_input.command.slice(0, 200);
    }

    // H-001: Explicit metadata from spawn boundary
    if (groveProject) payload.project = groveProject;
    if (groveEntity) payload.entity = groveEntity;
    if (groveOperator) payload.operator = groveOperator;

    // TodoWrite payload: extract task names and statuses
    if (toolName === "TodoWrite" && hookInput.tool_input?.todos) {
      const todos = hookInput.tool_input.todos as { content: string; status: string; activeForm?: string }[];
      const inProgress = todos.filter((t: { status: string }) => t.status === "in_progress");
      const completed = todos.filter((t: { status: string }) => t.status === "completed");
      const pending = todos.filter((t: { status: string }) => t.status === "pending");
      payload.todo_summary = {
        total: todos.length,
        completed: completed.length,
        in_progress: inProgress.length,
        pending: pending.length,
      };
      if (inProgress.length > 0) {
        payload.active_task = inProgress[0]!.activeForm ?? inProgress[0]!.content;
      }
    }

    // Agent/Task spawned: extract description
    if (toolName === "Agent" && hookInput.tool_input?.description) {
      payload.agent_description = hookInput.tool_input.description;
    }

    const event = createRawEvent(eventType, hookType as any, payload, {
      sessionId,
      toolName,
      networkId: groveNetwork,
    });

    // H-004: HTTP POST as primary delivery, JSONL as fallback/archive
    const filePath = join(RAW_DIR, `${sessionId}.jsonl`);
    await postEvent(event);
    writeToJsonl(filePath, event);

    // H-005: Emit heartbeat on UserPromptSubmit (keeps long sessions alive on dashboard)
    if (hookType === "UserPromptSubmit") {
      const heartbeat = createRawEvent(
        EVENT_TYPES.SESSION_HEARTBEAT,
        hookType as any,
        { project: groveProject, entity: groveEntity, operator: groveOperator },
        { sessionId, networkId: groveNetwork }
      );
      await postEvent(heartbeat);
      writeToJsonl(filePath, heartbeat);
    }

    // G-206b: On Stop/UserPromptSubmit, emit account usage from cached data
    if (hookType === "Stop" || hookType === "UserPromptSubmit") {
      try {
        const usageCachePath = join(
          process.env.HOME ?? "~",
          ".claude", "MEMORY", "STATE", "usage-cache.json"
        );
        if (existsSync(usageCachePath)) {
          const cached = JSON.parse(readFileSync(usageCachePath, "utf-8"));
          if (cached && (cached.five_hour || cached.seven_day)) {
            const usageEvent = createRawEvent(
              EVENT_TYPES.USAGE_UPDATE,
              hookType as any,
              {
                five_hour: cached.five_hour ?? null,
                seven_day: cached.seven_day ?? null,
                seven_day_opus: cached.seven_day_opus ?? null,
                seven_day_sonnet: cached.seven_day_sonnet ?? null,
                extra_usage: cached.extra_usage ?? null,
              },
              { sessionId, toolName }
            );
            await postEvent(usageEvent);
            writeToJsonl(filePath, usageEvent);
          }
        }
      } catch (err) {
        // Non-critical — log but don't block agent work
        if (err instanceof Error) {
          writeToJsonl(filePath, { event_type: "system.error", error: err.message, ts: new Date().toISOString() });
        }
      }
    }
  } catch (err) {
    // Never block agent work — log to stderr for debugging
    if (err instanceof Error) process.stderr.write(`EventLogger: ${err.message}\n`);
  }

  process.exit(0);
}

main();
