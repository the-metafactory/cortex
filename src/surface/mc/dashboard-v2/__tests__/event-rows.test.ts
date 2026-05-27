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
