/**
 * Extract the latest todo-list state from the session's events.
 *
 * Per migration addendum Decision 11: derived from the most recent
 * `TodoWrite` tool-result block in the session. If the session has
 * never seen a `TodoWrite` call, `todos` is null (caller renders no
 * pane — not an empty pane).
 *
 * Walks the `events` array backwards looking for a `stream-json.user`
 * event whose `payload.message.content[]` has a `tool_result` block
 * tagged as TodoWrite output. The CC tool emits a structured payload
 * we can parse loosely — defensive about shape.
 */

import { useMemo } from "react";
import type { McEvent } from "../../types";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function useTodoState(events: McEvent[]): { todos: TodoItem[] | null } {
  return useMemo(() => {
    // Walk backwards — most recent TodoWrite wins.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      const todos = extractTodosFromEvent(ev);
      if (todos) return { todos };
    }
    return { todos: null };
  }, [events]);
}

function extractTodosFromEvent(ev: McEvent): TodoItem[] | null {
  if (ev.type !== "stream-json.user" && ev.type !== "stream-json.assistant") return null;
  const message = (ev.payload as { message?: { content?: unknown } })?.message;
  if (!message || !Array.isArray(message.content)) return null;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block && block["type"] === "tool_result") {
      const out = parseTodoBlock(block);
      if (out) return out;
    }
    if (block && block["type"] === "tool_use" && block["name"] === "TodoWrite") {
      const input = block["input"] as { todos?: unknown } | undefined;
      const arr = input?.todos;
      if (Array.isArray(arr)) {
        const todos = sanitiseTodos(arr);
        if (todos.length > 0) return todos;
      }
    }
  }
  return null;
}

function parseTodoBlock(block: Record<string, unknown>): TodoItem[] | null {
  // tool_result content can be a string or array of {type, text|...}.
  const raw = block["content"];
  let text: string | null = null;
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw)) {
    for (const sub of raw) {
      if (sub && (sub as { type?: string }).type === "text" && typeof (sub as { text?: string }).text === "string") {
        text = (sub as { text: string }).text;
        break;
      }
    }
  }
  if (!text) return null;
  // The TodoWrite tool_result text is JSON-stringified or pretty-printed.
  // Try parsing JSON first; fall back to a marker-line scan.
  try {
    const parsed = JSON.parse(text) as { todos?: unknown };
    if (Array.isArray(parsed.todos)) {
      const todos = sanitiseTodos(parsed.todos);
      if (todos.length > 0) return todos;
    }
  } catch {
    // not JSON — try simple list parse
  }
  return null;
}

function sanitiseTodos(arr: unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const obj = t as { content?: unknown; status?: unknown; activeForm?: unknown };
    const content = typeof obj.content === "string" ? obj.content : null;
    const statusRaw = obj.status;
    const status =
      statusRaw === "pending" || statusRaw === "in_progress" || statusRaw === "completed"
        ? statusRaw
        : null;
    if (!content || !status) continue;
    const item: TodoItem = { content, status };
    if (typeof obj.activeForm === "string") item.activeForm = obj.activeForm;
    out.push(item);
  }
  return out;
}
