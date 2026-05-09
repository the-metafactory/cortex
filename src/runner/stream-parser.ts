/**
 * JSONL parser for Claude Code's --output-format stream-json.
 * Adapted from Maestro's ClaudeOutputParser for Grove's simpler needs.
 */

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface StreamEvent {
  type: "init" | "text" | "tool_use" | "result" | "usage" | "error";
  sessionId?: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  usage?: UsageStats;
  raw: unknown;
}

/**
 * Parse a single JSONL line from CC stream-json output.
 * Returns null for empty lines or unrecognized message types.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // System init — contains session ID
  if (parsed.type === "system" && parsed.subtype === "init") {
    return { type: "init", sessionId: parsed.session_id, raw: parsed };
  }

  // Assistant message — incremental text and tool use
  if (parsed.type === "assistant") {
    const content = parsed.message?.content;
    // Check for tool_use blocks first
    const toolUse = extractToolUse(content);
    if (toolUse) return { type: "tool_use", toolName: toolUse.name, toolInput: toolUse.input, raw: parsed };
    // Then check for text
    const text = extractText(content);
    if (text) return { type: "text", text, raw: parsed };
  }

  // Final result — complete response + usage
  if (parsed.type === "result") {
    return {
      type: "result",
      text: parsed.result ?? "",
      sessionId: parsed.session_id,
      usage: normalizeUsage(parsed),
      raw: parsed,
    };
  }

  return null;
}

/**
 * Extract the first tool_use block from CC message content.
 */
function extractToolUse(content: unknown): { name: string; input: Record<string, unknown> } | null {
  if (!Array.isArray(content)) return null;
  const block = content.find((b: any) => b.type === "tool_use");
  if (!block) return null;
  return { name: block.name, input: block.input ?? {} };
}

/**
 * Extract text from CC message content (string or content block array).
 * Filters to type: "text" blocks only (excludes thinking, tool_use, etc).
 */
export function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    return text || null;
  }
  return null;
}

/** Normalize usage stats from CC result message */
function normalizeUsage(parsed: any): UsageStats | undefined {
  const usage = parsed.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens,
    costUsd: parsed.total_cost_usd,
  };
}

/**
 * Buffered line splitter for incremental stream processing.
 * Handles partial lines that arrive across chunk boundaries.
 */
export class StreamLineBuffer {
  private buffer = "";

  /** Feed a chunk of data. Returns complete lines ready for parsing. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Last element is either empty (if chunk ended with \n) or a partial line
    this.buffer = lines.pop() ?? "";
    return lines;
  }

  /** Flush any remaining buffered data as a final line. */
  flush(): string | null {
    if (!this.buffer) return null;
    const line = this.buffer;
    this.buffer = "";
    return line;
  }
}
