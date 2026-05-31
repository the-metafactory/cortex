#!/usr/bin/env bun
/**
 * T-2.1 + T-2.2 + T-2.3: EventLogger Hook
 * Captures raw events to JSONL. Zero external dependencies beyond filesystem.
 * Only active when GROVE_CHANNEL env var is set (session scoping).
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createRawEvent, type RawEvent } from "./lib/event-types";
import { mapHookToEventType, EVENT_TYPES } from "./lib/event-taxonomy";
import { resolvePrincipalEnv } from "./lib/principal-env";

// =============================================================================
// Hook input shape — what Claude Code writes to stdin per hook firing.
// All fields are optional because different hook events surface different
// subsets (PostToolUse has tool_input/tool_output; UserPromptSubmit has
// prompt; Stop has summary/duration_ms; etc.). The runtime infers
// hook_event_name when CC omits it.
// =============================================================================

type HookEventName = RawEvent["source"]["hook"];

interface TodoEntry {
  content: string;
  status: "in_progress" | "completed" | "pending";
  activeForm?: string;
}

interface HookToolInput {
  file_path?: string;
  command?: string;
  description?: string;
  todos?: TodoEntry[];
}

interface HookInput {
  tool_name?: string;
  tool?: { name?: string };
  tool_input?: HookToolInput;
  tool_output?: unknown;
  hook_event_name?: HookEventName;
  hook_type?: HookEventName;
  prompt?: string;
  last_assistant_message?: string;
  transcript_path?: string;
  summary?: string;
  duration_ms?: number;
  session_id?: string;
}

interface UsageCache {
  five_hour?: unknown;
  seven_day?: unknown;
  seven_day_opus?: unknown;
  seven_day_sonnet?: unknown;
  extra_usage?: unknown;
}

const VALID_HOOK_EVENTS: readonly HookEventName[] = [
  "PostToolUse",
  "Stop",
  "UserPromptSubmit",
  "SessionStart",
];

function isHookEventName(v: string): v is HookEventName {
  return (VALID_HOOK_EVENTS as readonly string[]).includes(v);
}

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
// R9 (cortex#388 PR-3): the human-the-stack-owner concept is now `principal`.
// Read `CORTEX_PRINCIPAL` with a compat fallback to the legacy
// `CORTEX_OPERATOR` / `GROVE_OPERATOR` names (see principal-env.ts).
const principal = resolvePrincipalEnv();

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

    const hookInput = JSON.parse(input) as HookInput;

    const toolName: string | undefined =
      hookInput.tool_name ?? hookInput.tool?.name;

    // Infer hook type from input shape (CC doesn't always include hook_event_name).
    let hookType: HookEventName | "unknown" =
      hookInput.hook_event_name ?? hookInput.hook_type ?? "unknown";
    if (hookType === "unknown") {
      if (hookInput.tool_name !== undefined || hookInput.tool_input !== undefined) {
        hookType = "PostToolUse";
      } else if (hookInput.prompt !== undefined) {
        hookType = "UserPromptSubmit";
      } else if (
        hookInput.last_assistant_message !== undefined ||
        hookInput.transcript_path !== undefined
      ) {
        hookType = "Stop";
      }
    }
    const sessionId: string =
      hookInput.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

    if (hookType === "unknown" || !isHookEventName(hookType)) {
      // Unrecognised hook shape — write nothing, exit silently.
      process.exit(0);
    }

    const eventType = mapHookToEventType(hookType, toolName);

    // Build payload from hook input (raw — relay will filter)
    const payload: Record<string, unknown> = {};

    if (hookInput.tool_input !== undefined) payload.tool_input = hookInput.tool_input;
    if (hookInput.tool_output !== undefined) payload.tool_output = hookInput.tool_output;
    if (hookInput.prompt !== undefined) {
      let preview = hookInput.prompt;
      // Strip agent-prompt wrapper to show just the user's message
      const latestMatch = /Latest message from .+?:\n(.+)/s.exec(preview);
      const mentionMatch = /The user who mentioned you is .+?\.\s*$/.exec(preview);
      if (latestMatch?.[1] !== undefined) {
        preview = latestMatch[1];
      } else if (mentionMatch) {
        preview = "(mentioned in conversation)";
      }
      // Strip XML/system tags (e.g. <task-notification>, <tool-use-id>) —
      // Claude Code injects these as internal prompts, not user content.
      preview = preview.replace(/<[^>]+>/g, "").trim();
      if (preview) {
        payload.prompt_preview = preview.slice(0, 200);
      }
    }
    if (hookInput.summary !== undefined) payload.summary = hookInput.summary;
    if (hookInput.duration_ms !== undefined) payload.duration_ms = hookInput.duration_ms;
    if (toolName !== undefined) payload.tool_name = toolName;

    // File path from tool input (for file.changed events)
    if (hookInput.tool_input?.file_path !== undefined) {
      payload.path = hookInput.tool_input.file_path;
    }
    if (hookInput.tool_input?.command !== undefined) {
      payload.command_preview = hookInput.tool_input.command.slice(0, 200);
    }

    // H-001: Explicit metadata from spawn boundary. The `principal` payload
    // key is a wire field (relay policy + dashboard read it), renamed from
    // the legacy key under the vocabulary migration (R2).
    if (groveProject !== undefined) payload.project = groveProject;
    if (groveEntity !== undefined) payload.entity = groveEntity;
    if (principal !== undefined) payload.principal = principal;

    // TodoWrite payload: extract task names and statuses
    if (toolName === "TodoWrite" && hookInput.tool_input?.todos !== undefined) {
      const todos = hookInput.tool_input.todos;
      const inProgress = todos.filter((t) => t.status === "in_progress");
      const completed = todos.filter((t) => t.status === "completed");
      const pending = todos.filter((t) => t.status === "pending");
      payload.todo_summary = {
        total: todos.length,
        completed: completed.length,
        in_progress: inProgress.length,
        pending: pending.length,
      };
      const firstActive = inProgress[0];
      if (firstActive !== undefined) {
        payload.active_task = firstActive.activeForm ?? firstActive.content;
      }
    }

    // Agent/Task spawned: extract description
    if (
      toolName === "Agent" &&
      hookInput.tool_input?.description !== undefined
    ) {
      payload.agent_description = hookInput.tool_input.description;
    }

    const event = createRawEvent(eventType, hookType, payload, {
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
        hookType,
        { project: groveProject, entity: groveEntity, principal },
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
          const cached = JSON.parse(readFileSync(usageCachePath, "utf-8")) as UsageCache | null;
          if (cached && (cached.five_hour !== undefined || cached.seven_day !== undefined)) {
            const usageEvent = createRawEvent(
              EVENT_TYPES.USAGE_UPDATE,
              hookType,
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

void main();
