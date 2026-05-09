import { describe, test, expect } from "bun:test";
import { parseStreamLine, extractText, StreamLineBuffer } from "../stream-parser";

describe("parseStreamLine", () => {
  test("parses system init message", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("init");
    expect(event!.sessionId).toBe("abc-123-def");
  });

  test("parses assistant text message (string content)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Hello, world!" },
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("text");
    expect(event!.text).toBe("Hello, world!");
  });

  test("parses assistant text message (content block array)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "The answer is 42." },
        ],
      },
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("text");
    expect(event!.text).toBe("The answer is 42.");
  });

  test("parses result message with usage", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final response text",
      session_id: "sess-456",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
      },
      total_cost_usd: 0.05,
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    expect(event!.text).toBe("Final response text");
    expect(event!.sessionId).toBe("sess-456");
    expect(event!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      costUsd: 0.05,
    });
  });

  test("parses result message without usage", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done",
      session_id: "sess-789",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("result");
    expect(event!.usage).toBeUndefined();
  });

  test("returns null for empty lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("  ")).toBeNull();
    expect(parseStreamLine("\n")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("{broken")).toBeNull();
  });

  test("returns null for unrecognized message types", () => {
    const line = JSON.stringify({ type: "unknown", data: "foo" });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("returns tool_use for assistant message with only tool_use content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: {} }],
      },
    });
    const result = parseStreamLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_use");
    expect(result!.toolName).toBe("Read");
  });
});

describe("extractText", () => {
  test("extracts from string", () => {
    expect(extractText("hello")).toBe("hello");
  });

  test("extracts from content block array", () => {
    expect(extractText([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ])).toBe("onetwo");
  });

  test("filters non-text blocks", () => {
    expect(extractText([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
      { type: "tool_use", name: "Read" },
    ])).toBe("answer");
  });

  test("returns null for empty array", () => {
    expect(extractText([])).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(extractText(null)).toBeNull();
    expect(extractText(undefined)).toBeNull();
  });

  test("returns null for array with no text blocks", () => {
    expect(extractText([
      { type: "tool_use", name: "Bash" },
    ])).toBeNull();
  });
});

describe("StreamLineBuffer", () => {
  test("splits complete lines", () => {
    const buffer = new StreamLineBuffer();
    const lines = buffer.feed("line1\nline2\nline3\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  test("buffers partial lines", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.feed("partial")).toEqual([]);
    expect(buffer.feed(" line\n")).toEqual(["partial line"]);
  });

  test("handles multi-chunk lines", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.feed('{"type":'))
      .toEqual([]);
    expect(buffer.feed('"result","text":'))
      .toEqual([]);
    expect(buffer.feed('"done"}\n'))
      .toEqual(['{"type":"result","text":"done"}']);
  });

  test("flushes remaining buffer", () => {
    const buffer = new StreamLineBuffer();
    buffer.feed("last line without newline");
    expect(buffer.flush()).toBe("last line without newline");
  });

  test("flush returns null when empty", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.flush()).toBeNull();
  });

  test("handles empty input", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.feed("")).toEqual([]);
  });
});
