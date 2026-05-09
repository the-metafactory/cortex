import { describe, it, expect } from "bun:test";
import {
  buildStreamJsonMessage,
  type StreamJsonContentBlock,
} from "../session/stream-json";

describe("buildStreamJsonMessage (text overload)", () => {
  it("frames a simple text message", () => {
    const result = buildStreamJsonMessage("hello world");
    expect(result).toBe('{"type":"user_message","content":"hello world"}\n');
  });

  it("ends with a newline delimiter", () => {
    const result = buildStreamJsonMessage("test");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("produces valid JSON (without trailing newline)", () => {
    const result = buildStreamJsonMessage("test with 'quotes' and \"doubles\"");
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.type).toBe("user_message");
    expect(parsed.content).toBe("test with 'quotes' and \"doubles\"");
  });

  it("handles multiline content", () => {
    const result = buildStreamJsonMessage("line 1\nline 2\nline 3");
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.content).toBe("line 1\nline 2\nline 3");
  });

  it("handles empty string", () => {
    const result = buildStreamJsonMessage("");
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.content).toBe("");
  });

  it("handles unicode content", () => {
    const result = buildStreamJsonMessage("Hello, world");
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.content).toContain("Hello");
  });
});

describe("buildStreamJsonMessage (content-block overload)", () => {
  // Decision 2 of docs/design-mc-image-input.md: the rich overload sends
  // content as an array of blocks; the string overload still sends
  // content: "<string>" for backward compatibility with F-10 callers.
  // Any future refactor that collapses the overloads must preserve BOTH
  // wire shapes or the F-10 text path breaks silently.

  function parseFirstLine(raw: string): { type: string; content: unknown } {
    expect(raw.endsWith("\n")).toBe(true);
    return JSON.parse(raw.slice(0, -1)) as { type: string; content: unknown };
  }

  it("emits content: [...] for a content-block array", () => {
    const blocks: StreamJsonContentBlock[] = [{ type: "text", text: "hello" }];
    const parsed = parseFirstLine(buildStreamJsonMessage(blocks));
    expect(parsed.type).toBe("user_message");
    expect(Array.isArray(parsed.content)).toBe(true);
    expect(parsed.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("round-trips an image block", () => {
    const blocks: StreamJsonContentBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ];
    const parsed = parseFirstLine(buildStreamJsonMessage(blocks));
    expect(parsed.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ]);
  });

  it("preserves block order across mixed text + image + text", () => {
    const blocks: StreamJsonContentBlock[] = [
      { type: "text", text: "before" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BBBB" },
      },
      { type: "text", text: "after" },
    ];
    const parsed = parseFirstLine(buildStreamJsonMessage(blocks)) as {
      content: Array<{ type: string }>;
    };
    expect(parsed.content.map((b) => b.type)).toEqual([
      "text",
      "image",
      "text",
    ]);
  });

  it("empty array emits content: []", () => {
    const parsed = parseFirstLine(buildStreamJsonMessage([]));
    expect(parsed.content).toEqual([]);
  });
});
