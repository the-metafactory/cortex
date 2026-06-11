/**
 * lib/event-rows unit tests — Decision 11 rendering rules.
 *
 * Verifies the per-event-type row expansion, tool_use ↔ tool_result
 * pairing by `tool_use_id`, and the suppression of `stream-json.user`
 * text blocks (principal.input is the authoritative H-source).
 */

import { describe, it, expect } from "bun:test";
import { eventToRows, eventsToRows } from "../lib/event-rows";
import type { McEvent } from "../../types";

function ev(type: string, payload: unknown, id = "e1", ts = "2026-04-24T00:00:00.000Z"): McEvent {
  return { id, session_id: "s1", type, payload: payload as Record<string, unknown>, timestamp: ts };
}

describe("lib/event-rows — eventToRows", () => {
  it("expands stream-json.assistant text + thinking + tool_use into separate rows", () => {
    const rows = eventToRows(ev("stream-json.assistant", {
      message: {
        content: [
          { type: "thinking", thinking: "let me check the file" },
          { type: "text", text: "Reading file." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    }));
    expect(rows.map((r) => r.kind)).toEqual([
      "assistant.thinking", "assistant.text", "tool_use",
    ]);
    expect(rows[0]?.weight).toBe("tertiary");      // thinking is tertiary
    expect(rows[1]?.color).toBe("a");              // text is amber (A)
    expect((rows[2] as { name: string }).name).toBe("Read");
  });

  it("suppresses stream-json.user text blocks (principal.input is authoritative)", () => {
    const rows = eventToRows(ev("stream-json.user", {
      message: {
        content: [
          { type: "text", text: "this should be suppressed" },
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
        ],
      },
    }));
    expect(rows.map((r) => r.kind)).toEqual(["tool_result"]);
  });

  it("flattens tool_result content from string and array forms", () => {
    const a = eventToRows(ev("stream-json.user", {
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "plain" }] },
    }))[0] as { text: string };
    expect(a.text).toBe("plain");
    const b = eventToRows(ev("stream-json.user", {
      message: { content: [{
        type: "tool_result", tool_use_id: "x",
        content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
      }] },
    }))[0] as { text: string };
    expect(b.text).toBe("line1\nline2");
  });

  it("emits a primary blocking state.transition with one-liner", () => {
    const row = eventToRows(ev("state.transition", {
      from: "running", to: "blocked",
      block_reason: { kind: "permission.request", payload: { requested_action: "Bash" } },
    }))[0] as { weight: string; blocking: boolean; blockReasonOneLiner?: string };
    expect(row.blocking).toBe(true);
    expect(row.weight).toBe("primary");
    expect(row.blockReasonOneLiner).toBe("approve: Bash");
  });

  it("emits a tertiary non-blocking state.transition with no block_reason", () => {
    const row = eventToRows(ev("state.transition", {
      from: "queued", to: "running",
    }))[0] as { weight: string; blocking: boolean };
    expect(row.blocking).toBe(false);
    expect(row.weight).toBe("tertiary");
  });

  it("emits principal.input row preserving images", () => {
    const row = eventToRows(ev("principal.input", {
      text: "hi",
      images: [{ media_type: "image/png", data: "abc" }],
    }))[0] as { kind: string; text: string; images?: unknown[] };
    expect(row.kind).toBe("principal.input");
    expect(row.text).toBe("hi");
    expect(row.images).toHaveLength(1);
  });

  it("falls back to a raw row for unknown event types", () => {
    const row = eventToRows(ev("future.unknown", { hello: 1 }))[0] as { kind: string; type: string };
    expect(row.kind).toBe("raw");
    expect(row.type).toBe("future.unknown");
  });
});

describe("lib/event-rows — observed-session hook events (U1.1 item 1)", () => {
  it("maps tool.bash.executed → a tool_use row carrying the command + paired output (NOT raw)", () => {
    const rows = eventToRows(ev("tool.bash.executed", {
      tool_name: "Bash",
      tool_input: { command: "bun test", description: "run tests" },
      command_preview: "bun test",
      tool_output: "42 pass\n0 fail",
      duration_ms: 1234,
    }));
    expect(rows).toHaveLength(1);
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Bash");
    // input is preserved so the expand-toggle shows the full args, same as controlled.
    expect((tu.input as { command?: string }).command).toBe("bun test");
    // the hook's tool_output is paired into the same row as a nested tool_result.
    expect(tu.result?.text).toContain("42 pass");
    expect(tu.durationMs).toBe(1234);
  });

  it("maps tool.file.changed → a tool_use row (Edit/Write) with the path", () => {
    const rows = eventToRows(ev("tool.file.changed", {
      tool_name: "Edit",
      tool_input: { file_path: "/src/x.ts", old_string: "a", new_string: "b" },
      path: "/src/x.ts",
    }));
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Edit");
    expect((tu.input as { file_path?: string }).file_path).toBe("/src/x.ts");
  });

  it("maps tool.file.read → a tool_use row (Read) with the path", () => {
    const rows = eventToRows(ev("tool.file.read", {
      tool_name: "Read",
      tool_input: { file_path: "/src/y.ts" },
      path: "/src/y.ts",
    }));
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Read");
  });

  it("maps a generic tool.{name}.used → a tool_use row using the payload tool_name", () => {
    const rows = eventToRows(ev("tool.grep.used", {
      tool_name: "Grep",
      tool_input: { pattern: "foo", path: "src" },
    }));
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Grep");
  });

  it("derives the tool name from the event type when tool_name is absent", () => {
    const rows = eventToRows(ev("tool.websearch.used", { tool_input: { query: "x" } }));
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    // capitalised from the type segment when no explicit tool_name.
    expect(tu.name.toLowerCase()).toBe("websearch");
  });

  it("maps agent.task.started → a principal.input row carrying the prompt_preview", () => {
    const rows = eventToRows(ev("agent.task.started", {
      prompt_preview: "implement the feature",
    }));
    expect(rows).toHaveLength(1);
    const row = rows[0] as { kind: string; text: string };
    expect(row.kind).toBe("principal.input");
    expect(row.text).toBe("implement the feature");
  });

  it("maps tool.agent.spawned → a tool_use row (Agent) carrying the description", () => {
    const rows = eventToRows(ev("tool.agent.spawned", {
      tool_name: "Agent",
      agent_description: "explore the codebase",
      tool_input: { description: "explore the codebase" },
    }));
    const tu = rows[0] as ToolUseRowShape;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Agent");
  });

  it("still raw-rows an observed event with no usable payload (graceful)", () => {
    const rows = eventToRows(ev("tool.bash.executed", {}));
    // No command/input at all — keep it as a tool_use shell, not a crash,
    // and never a bare RawRow JSON crumb.
    expect(rows[0]?.kind).toBe("tool_use");
  });

  it("pairs an observed tool.bash.executed even with no inline output (output arrives null)", () => {
    const rows = eventsToRows([
      ev("tool.bash.executed", { tool_name: "Bash", tool_input: { command: "ls" } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool_use");
  });
});

interface ToolUseRowShape {
  kind: string;
  name: string;
  input: unknown;
  durationMs?: number;
  result?: { text: string };
}

describe("lib/event-rows — eventsToRows pairing", () => {
  it("pairs tool_result back to tool_use via tool_use_id (no standalone tool_result row)", () => {
    const events: McEvent[] = [
      ev("stream-json.assistant", {
        message: { content: [{ type: "tool_use", id: "tu_42", name: "Read", input: {} }] },
      }, "e1"),
      ev("stream-json.user", {
        message: { content: [{ type: "tool_result", tool_use_id: "tu_42", content: "ok" }] },
      }, "e2"),
    ];
    const rows = eventsToRows(events);
    expect(rows).toHaveLength(1);
    const tu = rows[0] as { kind: string; result?: { text: string } };
    expect(tu.kind).toBe("tool_use");
    expect(tu.result?.text).toBe("ok");
  });

  it("renders an orphan tool_result as standalone when its tool_use is missing", () => {
    const rows = eventsToRows([
      ev("stream-json.user", {
        message: { content: [{ type: "tool_result", tool_use_id: "missing", content: "stray" }] },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool_result");
  });
});
