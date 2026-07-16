// API-P1.2 (epic #2055, Phase 1, decision D2) — Chat Completions SSE stream
// parser: the PORTABLE CORE of streamed OpenAI-compatible responses. Design
// §"External protocol constraints → OpenAI-compatible services": target the
// portable core of streamed Chat Completions; "OpenAI-compatible" is a family of
// partial implementations, so parse defensively and never assume optional pieces
// (notably `usage`, which many compatible servers — Ollama, LM Studio — omit).
//
// This module is TRANSPORT- and POLICY-neutral: it consumes a stream of raw byte
// chunks and yields small, normalized parser events. It maps NOTHING to HTTP
// status and constructs NO `ProviderError` (that is the provider's job) — it only
// surfaces `stream-error` (an in-band `{"error": …}` frame) and `malformed`
// (a `data:` line whose JSON did not parse) for the provider to classify.
//
// It never throws on unknown/extra fields (unknown event variants are ignored,
// per the contract case) and never throws on its own; a truncated stream shows
// up as the underlying byte iterator throwing, which propagates to the caller.

import type { FinishReason } from "../../common/inference/types";

/**
 * One normalized event emitted by {@link parseChatCompletionsStream}. Deliberately
 * smaller than the wire chunk: the provider translates these onto the public
 * {@link import("../../common/inference/types").ModelEvent} union.
 */
export type ChatCompletionsParserEvent =
  /** A content delta from `choices[].delta.content`. */
  | { readonly kind: "text"; readonly text: string }
  /** A normalized `choices[].finish_reason`. */
  | { readonly kind: "finish"; readonly reason: FinishReason }
  /** A usage frame — emitted ONLY when the server actually sent `usage`. */
  | {
      readonly kind: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
    }
  /** An in-band error frame (`{"error": …}`) delivered AFTER a committed 200. */
  | { readonly kind: "stream-error"; readonly payload: unknown }
  /** A `data:` line whose JSON failed to parse (malformed stream). */
  | { readonly kind: "malformed"; readonly detail: string }
  /** The terminal `data: [DONE]` sentinel. */
  | { readonly kind: "done" };

/**
 * Map an OpenAI Chat Completions `finish_reason` onto the normalized
 * {@link FinishReason}. Unknown/absent reasons collapse to `"stop"` — the parser
 * only emits a `finish` event when the wire actually carried a non-null reason.
 */
function normalizeFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Narrow an unknown to a plain object without widening to `any`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Translate one already-parsed Chat Completions chunk object into zero or more
 * parser events. Defensive throughout: a chunk missing `choices`, `delta`, or
 * `usage` simply yields fewer events rather than erroring.
 */
function* eventsForChunk(
  obj: Record<string, unknown>,
): Generator<ChatCompletionsParserEvent> {
  // In-band error frame — a structured error delivered mid-stream (after 200).
  if ("error" in obj && obj.error != null) {
    yield { kind: "stream-error", payload: obj.error };
    return;
  }

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  // Chat Completions streams a single choice per chunk in the common case, but a
  // server MAY interleave several; walk them all rather than assuming index 0.
  for (const choice of choices) {
    const choiceObj = asRecord(choice);
    if (!choiceObj) continue;

    const delta = asRecord(choiceObj.delta);
    const content = delta?.content;
    if (typeof content === "string" && content.length > 0) {
      yield { kind: "text", text: content };
    }

    const finishReason = choiceObj.finish_reason;
    if (finishReason != null) {
      yield { kind: "finish", reason: normalizeFinishReason(finishReason) };
    }
  }

  // Usage arrives on a late chunk (typically with empty `choices`) ONLY when the
  // server honors `stream_options.include_usage`. Absence is normal — emit nothing.
  const usage = asRecord(obj.usage);
  if (usage) {
    const inputTokens = asNumber(usage.prompt_tokens) ?? 0;
    const outputTokens = asNumber(usage.completion_tokens) ?? 0;
    const cacheReadTokens = asNumber(
      asRecord(usage.prompt_tokens_details)?.cached_tokens,
    );
    yield cacheReadTokens !== undefined
      ? { kind: "usage", inputTokens, outputTokens, cacheReadTokens }
      : { kind: "usage", inputTokens, outputTokens };
  }
}

/**
 * Dispatch one fully-assembled SSE `data:` payload. Returns `true` when the
 * terminal `[DONE]` sentinel was seen so the caller can stop reading.
 */
function* dispatchData(
  data: string,
): Generator<ChatCompletionsParserEvent, boolean> {
  const trimmed = data.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "[DONE]") {
    yield { kind: "done" };
    return true;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // A `data:` frame that is not valid JSON — a malformed stream. Surface it and
    // let the provider classify; do NOT throw (keeps the generator well-behaved).
    yield { kind: "malformed", detail: "invalid JSON in SSE data frame" };
    return true;
  }
  const record = asRecord(obj);
  if (!record) {
    // Valid JSON that is not an object (e.g. a bare number/string) — an unknown
    // variant. Ignore it rather than aborting the stream.
    return false;
  }
  yield* eventsForChunk(record);
  return false;
}

/**
 * Parse a Chat Completions Server-Sent Events byte stream into normalized
 * {@link ChatCompletionsParserEvent}s.
 *
 * Handles:
 *   - UTF-8 multi-byte graphemes split across chunk boundaries (streaming decode);
 *   - `data:` lines split across arbitrary chunk boundaries (line buffering);
 *   - multi-line `data:` fields (joined with `\n` per the SSE spec);
 *   - the terminal `data: [DONE]` sentinel;
 *   - `finish_reason`, `usage` (when present), and in-band `{"error": …}` frames;
 *   - SSE comments (`:` lines) and non-`data` fields (`event:`/`id:`/`retry:`),
 *     which are ignored.
 *
 * Never throws on its own. A truncated stream manifests as `byteChunks` throwing,
 * which propagates to the caller (the provider maps it to a malformed response).
 */
export async function* parseChatCompletionsStream(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<ChatCompletionsParserEvent> {
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";
  // Accumulated `data:` field lines for the SSE event currently being assembled.
  let dataLines: string[] = [];

  // Flush the current event's accumulated data (on a blank separator line or at
  // end of stream). Yields its events and signals whether `[DONE]` was reached.
  function* flushEvent(): Generator<ChatCompletionsParserEvent, boolean> {
    if (dataLines.length === 0) return false;
    const data = dataLines.join("\n");
    dataLines = [];
    return yield* dispatchData(data);
  }

  function* handleLine(
    rawLine: string,
  ): Generator<ChatCompletionsParserEvent, boolean> {
    // Strip a trailing CR so CRLF-framed streams parse identically to LF.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      // Blank line — event boundary. Dispatch whatever data we accumulated.
      return yield* flushEvent();
    }
    if (line.startsWith(":")) {
      // SSE comment / keep-alive — ignore.
      return false;
    }
    if (line.startsWith("data:")) {
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
      return false;
    }
    // Other SSE fields (`event:`, `id:`, `retry:`) carry no content we normalize.
    return false;
  }

  for await (const chunk of byteChunks) {
    lineBuffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const done = yield* handleLine(rawLine);
      if (done) return;
      newlineIndex = lineBuffer.indexOf("\n");
    }
  }

  // Flush any trailing bytes the decoder held, then any unterminated final line
  // and pending event — some servers close without a trailing blank line.
  lineBuffer += decoder.decode();
  if (lineBuffer.length > 0) {
    const done = yield* handleLine(lineBuffer);
    if (done) return;
  }
  yield* flushEvent();
}
