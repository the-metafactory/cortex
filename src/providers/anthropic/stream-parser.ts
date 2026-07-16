// API-P1.1 (epic #2055, Phase 1, decision D2) — SSE stream parser for the native
// Anthropic Messages API. Two layers:
//
//   1. `parseSSE` — a generic, dependency-free Server-Sent-Events framer. It
//      buffers a byte stream, decodes UTF-8 with `{ stream: true }` so a
//      grapheme split mid-codepoint across a frame boundary is reassembled, and
//      yields `{ event, data }` records on each SSE dispatch (blank-line
//      terminated). It never inspects payload semantics.
//
//   2. `mapAnthropicMessagesStream` — consumes those records, JSON-parses each
//      `data` payload, and maps Anthropic's typed events (`message_start`,
//      `content_block_start/delta/stop`, `message_delta`, `message_stop`,
//      `ping`, `error`) onto the normalized {@link ModelEvent} union. Unknown
//      event types are ignored (design §Anthropic: "new event variants may be
//      added, so the adapter must ignore unknown events safely"). `input_json_delta`
//      deltas are accumulated per content-block index so a tool-call block whose
//      JSON is split across arbitrary chunk boundaries reassembles cleanly —
//      Phase 1 sends no tools, but the parser must not choke if a block appears.
//
// NO secret, API key, or header value is ever placed on a yielded event or an
// error summary — everything here may be logged / published / shown on the
// dashboard (see `ProviderError.summary`).

import type { FinishReason, ModelEvent } from "../../common/inference/types";
import type {
  ProviderError,
  ProviderErrorKind,
} from "../../common/inference/errors";

// ── Generic SSE framing ──────────────────────────────────────────────────────

/** One dispatched SSE record: the `event:` type and the joined `data:` payload. */
export interface SSEEvent {
  /** The `event:` field value, or `"message"` when the frame omitted one. */
  readonly event: string;
  /** The joined `data:` lines (multiple `data:` lines are `\n`-joined per spec). */
  readonly data: string;
}

/**
 * Frame a raw byte stream into SSE records. Tolerates fragmented frames (an
 * event split across chunk boundaries) and split UTF-8 (a multi-byte codepoint
 * split across chunks) via a streaming `TextDecoder`. Comment lines (`:` prefix,
 * e.g. keep-alive) and unknown fields (`id:`, `retry:`) are ignored.
 */
export async function* parseSSE(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  const dispatch = (): SSEEvent | undefined => {
    if (dataLines.length === 0 && eventType === "") return undefined;
    const record: SSEEvent = {
      event: eventType === "" ? "message" : eventType,
      data: dataLines.join("\n"),
    };
    eventType = "";
    dataLines = [];
    return record;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        const record = dispatch();
        if (record) yield record;
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") eventType = value;
      else if (field === "data") dataLines.push(value);
      // `id`, `retry`, and any other field are ignored.
    }
  }

  // Flush any bytes the streaming decoder was holding, then dispatch a trailing
  // record if the stream ended without a final blank line.
  buffer += decoder.decode();
  if (buffer.length > 0) {
    let line = buffer;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line !== "" && !line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventType = value;
      else if (field === "data") dataLines.push(value);
    }
  }
  const tail = dispatch();
  if (tail) yield tail;
}

// ── Anthropic-native → normalized event mapping ──────────────────────────────

/** Context the provider supplies to the mapper (id resolved from HTTP headers). */
export interface AnthropicStreamContext {
  /** Provider request id, read from the response headers (never from the body). */
  readonly providerRequestId?: string;
}

/** Map an Anthropic `stop_reason` onto the normalized {@link FinishReason}. */
export function mapStopReason(stopReason: unknown): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Map an Anthropic in-stream `error.type` onto a normalized error kind. */
export function mapAnthropicErrorType(type: unknown): {
  kind: ProviderErrorKind;
  retryable: boolean;
} {
  switch (type) {
    case "authentication_error":
      return { kind: "authentication", retryable: false };
    case "permission_error":
      return { kind: "authorization", retryable: false };
    case "rate_limit_error":
      return { kind: "rate_limit", retryable: true };
    case "overloaded_error":
      return { kind: "overloaded", retryable: true };
    case "invalid_request_error":
    case "not_found_error":
      return { kind: "invalid_request", retryable: false };
    case "api_error":
      return { kind: "unavailable", retryable: true };
    default:
      return { kind: "unavailable", retryable: true };
  }
}

/**
 * Build a redacted {@link ProviderError} from an Anthropic error object. Only the
 * provider-authored `type`/`message` (safe, secret-free) reach the summary.
 */
function toProviderError(
  errorObj: unknown,
  providerRequestId?: string,
): ProviderError {
  const err = (errorObj ?? {}) as { type?: unknown; message?: unknown };
  const { kind, retryable } = mapAnthropicErrorType(err.type);
  const typeStr = typeof err.type === "string" ? err.type : "error";
  const messageStr = typeof err.message === "string" ? err.message : "";
  const summary = messageStr ? `${typeStr}: ${messageStr}` : typeStr;
  return { kind, retryable, summary, ...(providerRequestId ? { providerRequestId } : {}) };
}

interface ToolBlockState {
  id: string;
  name: string;
  json: string;
}

/**
 * Consume a raw Anthropic Messages SSE byte stream and yield normalized
 * {@link ModelEvent}s. Ignores unknown event types safely; if the underlying
 * body read fails mid-stream (truncated / aborted connection after HTTP 200) it
 * yields a terminal `error` event with `malformed_response` rather than throwing.
 */
export async function* mapAnthropicMessagesStream(
  body: AsyncIterable<Uint8Array>,
  ctx: AnthropicStreamContext = {},
): AsyncGenerator<ModelEvent> {
  const reqId = ctx.providerRequestId;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let sawUsage = false;
  let finishReason: FinishReason | undefined;
  let startedEmitted = false;
  let terminated = false;
  const toolBlocks = new Map<number, ToolBlockState>();

  try {
    for await (const sse of parseSSE(body)) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        // A data frame that is not valid JSON: tolerate and skip it rather than
        // aborting the whole stream (design: be liberal in what we accept).
        continue;
      }
      const type = typeof evt.type === "string" ? evt.type : sse.event;

      switch (type) {
        case "message_start": {
          const message = evt.message as { usage?: Record<string, number> } | undefined;
          const usage = message?.usage;
          if (usage) {
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            if (typeof usage.cache_read_input_tokens === "number")
              cacheReadTokens = usage.cache_read_input_tokens;
          }
          if (!startedEmitted) {
            startedEmitted = true;
            yield { type: "response.started", ...(reqId ? { providerRequestId: reqId } : {}) };
          }
          break;
        }

        case "content_block_start": {
          const index = evt.index as number;
          const block = evt.content_block as
            | { type?: string; id?: string; name?: string }
            | undefined;
          if (block?.type === "tool_use") {
            toolBlocks.set(index, {
              id: typeof block.id === "string" ? block.id : "",
              name: typeof block.name === "string" ? block.name : "",
              json: "",
            });
          }
          break;
        }

        case "content_block_delta": {
          const index = evt.index as number;
          const delta = evt.delta as
            | { type?: string; text?: string; partial_json?: string }
            | undefined;
          if (delta?.type === "text_delta") {
            yield { type: "text.delta", text: delta.text ?? "" };
          } else if (delta?.type === "input_json_delta") {
            const state = toolBlocks.get(index);
            const fragment = delta.partial_json ?? "";
            if (state) {
              state.json += fragment;
              yield {
                type: "tool_call.delta",
                id: state.id,
                ...(state.name ? { name: state.name } : {}),
                json: fragment,
              };
            }
          }
          break;
        }

        case "content_block_stop": {
          const index = evt.index as number;
          const state = toolBlocks.get(index);
          if (state) {
            let input: unknown;
            try {
              input = state.json ? JSON.parse(state.json) : {};
            } catch {
              // Malformed accumulated JSON: keep the raw string rather than
              // throwing — the harness decides how to handle a bad tool call.
              input = state.json;
            }
            yield { type: "tool_call.completed", id: state.id, name: state.name, input };
            toolBlocks.delete(index);
          }
          break;
        }

        case "message_delta": {
          const delta = evt.delta as { stop_reason?: unknown } | undefined;
          if (delta && "stop_reason" in delta && delta.stop_reason != null) {
            finishReason = mapStopReason(delta.stop_reason);
          }
          const usage = evt.usage as Record<string, number> | undefined;
          if (usage) {
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            if (typeof usage.cache_read_input_tokens === "number")
              cacheReadTokens = usage.cache_read_input_tokens;
            sawUsage = true;
            yield {
              type: "usage",
              inputTokens,
              outputTokens,
              ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
            };
          }
          break;
        }

        case "message_stop": {
          terminated = true;
          yield { type: "response.completed", finishReason: finishReason ?? "stop" };
          break;
        }

        case "ping":
          // Keep-alive: meaningful activity for the harness's idle timer, but no
          // normalized event. Intentionally ignored here.
          break;

        case "error": {
          terminated = true;
          yield { type: "error", error: toProviderError(evt.error, reqId) };
          return;
        }

        default:
          // Unknown / future event variant — ignore safely (design §Anthropic).
          break;
      }
    }
  } catch (_err) {
    // The body read failed part-way (truncated / aborted stream after HTTP 200).
    // Surface a normalized terminal error rather than propagating the raw error,
    // whose message must never carry request/response detail onto the bus.
    yield {
      type: "error",
      error: {
        kind: "malformed_response",
        retryable: true,
        summary: "stream ended before completion",
        ...(reqId ? { providerRequestId: reqId } : {}),
      },
    };
    return;
  }

  // A stream that ends without a terminal `message_stop` (or `error`) frame was
  // truncated — the connection dropped mid-response after HTTP 200. Some runtimes
  // surface that as a silent EOF rather than a thrown read error, so detect it
  // structurally and emit a normalized terminal error.
  if (!terminated) {
    yield {
      type: "error",
      error: {
        kind: "malformed_response",
        retryable: true,
        summary: "stream ended before completion",
        ...(reqId ? { providerRequestId: reqId } : {}),
      },
    };
  }

  // `sawUsage` is intentionally read only to keep the missing-usage path
  // side-effect-free; a stream that never sent a usage frame simply yields no
  // `usage` event (design: tolerate disconnects before a final usage event).
  void sawUsage;
}
