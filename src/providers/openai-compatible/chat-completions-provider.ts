// API-P1.2 (epic #2055, Phase 1, decision D2) — `OpenAICompatibleProvider`: a
// `ModelProvider` for the PORTABLE CORE of streamed OpenAI Chat Completions, so
// Cortex can call OpenAI-compatible services incl. local ones (Ollama, LM Studio).
//
// Design §"External protocol constraints → OpenAI-compatible services" +
// decision D2: "OpenAI-compatible" is a family of PARTIAL implementations, NOT a
// capability guarantee. So this adapter declares capabilities from config and
// REJECTS unsupported requests rather than assuming features silently discard.
// It shares the normalized contract (`src/common/inference/`) with the native
// Anthropic adapter but keeps its own request construction, stream parsing, error
// classification, and request-id handling (D2: adapters are NOT merged).
//
// Phase 1 is TEXT ONLY. The OpenAI Responses API, stateful continuation, hosted
// tools, and tool execution are explicitly OUT OF SCOPE (design open Q6, Phase 4;
// tools → Phase 3). No secret (API key, Authorization header, raw body) ever
// reaches a `ProviderError.summary`, a `ModelEvent`, or a log line.

import type {
  FinishReason,
  MessageContent,
  MessageRole,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderCapabilities,
} from "../../common/inference/types";
import type { ProviderError, ProviderErrorKind } from "../../common/inference/errors";
import { parseChatCompletionsStream } from "./stream-parser";

/** Minimal `fetch` shape the provider depends on — injectable for tests. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<Response>;

/**
 * Construction config for {@link OpenAICompatibleProvider}. Deliberately
 * self-contained: it accepts the pieces an inference profile (API-P0.2) resolves
 * — `baseUrl`, resolved `apiKey`, and a `capabilities` override — without coupling
 * to that not-yet-landed schema. When the profile schema lands, its resolver maps
 * onto this shape.
 */
export interface OpenAICompatibleProviderConfig {
  /** Stable provider id surfaced on {@link ModelProvider.id}. */
  readonly id?: string;
  /**
   * API base URL, e.g. `https://api.openai.com/v1` or a local
   * `http://127.0.0.1:11434/v1`. `/chat/completions` is appended.
   */
  readonly baseUrl: string;
  /**
   * Resolved API key. Optional — local OpenAI-compatible servers (Ollama,
   * LM Studio) commonly need none. When present it is sent as a Bearer token and
   * NEVER surfaces in an error, event, or log.
   */
  readonly apiKey?: string;
  /**
   * Capability overrides. Defaults are CONSERVATIVE (streaming on; tools, images,
   * structured output, etc. off) because compatibility does not imply support;
   * a profile turns a feature on only when the target endpoint genuinely has it.
   */
  readonly capabilities?: Partial<ProviderCapabilities>;
  /**
   * The `ModelRequest.options` namespace whose bag is merged onto the wire body.
   * Defaults to `"openai"`.
   */
  readonly optionsNamespace?: string;
  /** Extra request headers (e.g. an org id). Never a place for secrets in logs. */
  readonly headers?: Record<string, string>;
  /** Injected `fetch` (tests); defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Conservative capability defaults. `streaming` is the one thing every
 * OpenAI-compatible Chat Completions endpoint supports; everything else is OFF
 * until a profile explicitly enables it (design: reject rather than assume).
 * `serverContinuation` and `promptCaching` are always false on this protocol —
 * those live on the Responses API / native adapters, not portable Chat Completions.
 */
const CONSERVATIVE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: false,
  parallelTools: false,
  images: false,
  documents: false,
  structuredOutput: false,
  serverContinuation: false,
  promptCaching: false,
};

function makeError(
  kind: ProviderErrorKind,
  retryable: boolean,
  summary: string,
  extra?: { retryAfterMs?: number; providerRequestId?: string },
): ProviderError {
  const err: ProviderError = { kind, retryable, summary };
  if (extra?.retryAfterMs !== undefined) err.retryAfterMs = extra.retryAfterMs;
  if (extra?.providerRequestId !== undefined) {
    err.providerRequestId = extra.providerRequestId;
  }
  return err;
}

/** Provider request id for correlation — safe to log (never a secret). */
function extractRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("x-requestid") ??
    undefined
  );
}

/** Parse `retry-after-ms` / `retry-after` (seconds) into milliseconds. */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const secs = headers.get("retry-after");
  if (secs) {
    const n = Number(secs);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return undefined;
}

/**
 * Map an HTTP status onto a normalized {@link ProviderError}. Summaries carry the
 * status ONLY — never the response body (which may echo request content) and
 * never any header value beyond the safe request id.
 */
function statusToProviderError(response: Response): ProviderError {
  const providerRequestId = extractRequestId(response);
  const retryAfterMs = parseRetryAfterMs(response.headers);
  const status = response.status;
  switch (status) {
    case 401:
      return makeError("authentication", false, "authentication failed (HTTP 401)", {
        providerRequestId,
      });
    case 403:
      return makeError("authorization", false, "authorization failed (HTTP 403)", {
        providerRequestId,
      });
    case 408:
      return makeError("timeout", true, "provider request timed out (HTTP 408)", {
        providerRequestId,
      });
    case 429:
      return makeError("rate_limit", true, "rate limited (HTTP 429)", {
        retryAfterMs,
        providerRequestId,
      });
    case 400:
      return makeError("invalid_request", false, "invalid request (HTTP 400)", {
        providerRequestId,
      });
    case 529:
      return makeError("overloaded", true, "provider overloaded (HTTP 529)", {
        retryAfterMs,
        providerRequestId,
      });
    case 503:
      return makeError("unavailable", true, "provider unavailable (HTTP 503)", {
        retryAfterMs,
        providerRequestId,
      });
    default:
      break;
  }
  if (status >= 500) {
    return makeError("unavailable", true, `provider error (HTTP ${status})`, {
      retryAfterMs,
      providerRequestId,
    });
  }
  if (status >= 400) {
    return makeError("invalid_request", false, `request rejected (HTTP ${status})`, {
      providerRequestId,
    });
  }
  // Non-2xx that is neither 4xx nor 5xx — unexpected; treat as unavailable.
  return makeError("unavailable", true, `unexpected status (HTTP ${status})`, {
    providerRequestId,
  });
}

/**
 * Map an in-band `{"error": …}` frame (delivered AFTER a committed 200) onto a
 * normalized error. Classifies by the OpenAI-style `type`/`code` STRINGS only —
 * the free-form `message` is deliberately excluded from the summary so no echoed
 * request content can leak.
 */
function inStreamPayloadToError(payload: unknown): ProviderError {
  const obj =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  const signal = `${type ?? ""} ${code ?? ""}`;

  let kind: ProviderErrorKind = "unavailable";
  let retryable = true;
  if (/rate.?limit/i.test(signal)) {
    kind = "rate_limit";
    retryable = true;
  } else if (/content.?filter/i.test(signal)) {
    kind = "content_filter";
    retryable = false;
  } else if (/overloaded/i.test(signal)) {
    kind = "overloaded";
    retryable = true;
  } else if (/invalid.?request/i.test(signal)) {
    kind = "invalid_request";
    retryable = false;
  } else if (/auth/i.test(signal)) {
    kind = "authentication";
    retryable = false;
  }

  const detail = [
    type ? `type=${type}` : undefined,
    code ? `code=${code}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const summary = detail
    ? `in-stream provider error (${detail})`
    : "in-stream provider error";
  return makeError(kind, retryable, summary);
}

/** OpenAI-compatible wire role for a normalized message role. */
function toWireRole(role: MessageRole): "system" | "user" | "assistant" | "tool" {
  return role;
}

/** Flatten a message's content parts to plain text (Phase 1 is text only). */
function textOfContent(content: readonly MessageContent[]): string {
  return content
    .filter((part): part is Extract<MessageContent, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Detect a request that asks for a capability the provider has NOT declared, so
 * it can be rejected BEFORE dispatch (design: reject unsupported rather than let
 * the provider silently discard). Returns a reason string, or `undefined` if the
 * request is serviceable.
 */
function unsupportedReason(
  request: ModelRequest,
  capabilities: ProviderCapabilities,
): string | undefined {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === "image_ref" && !capabilities.images) {
        return "request includes image content but the provider's images capability is disabled";
      }
      if (
        (part.type === "tool_call" || part.type === "tool_result") &&
        !capabilities.tools
      ) {
        return "request includes tool content but the provider's tools capability is disabled";
      }
    }
  }
  return undefined;
}

/**
 * Iterate a `ReadableStream<Uint8Array>` as an async generator, cancelling the
 * reader on early exit. Abandoning the provider's stream (the harness cancelling)
 * runs this `finally`, which cancels the reader and tears down the fetch body —
 * the provider's resource-release contract, with limits owned by the harness (D1).
 */
async function* readableToByteChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (_err) {
        // A mid-stream read rejection — an aborted / truncated connection (incl.
        // the way `ReadableStreamDefaultController.error()` surfaces under Bun,
        // which rejects the pending `read()` rather than EOF-ing). END ITERATION
        // CLEANLY so the provider's structural check ("stream ended without a
        // terminal frame") classifies it as a normalized `malformed_response`,
        // instead of letting the raw abort escape as an uncaught error. `_err`
        // may carry raw provider/connection detail; it is deliberately dropped —
        // nothing from it reaches a summary, event, or log.
        return;
      }
      const { done, value } = result;
      if (done) return;
      yield value;
    }
  } finally {
    // Best-effort cancel; releases the underlying connection on early abandonment.
    void reader.cancel().catch(() => {
      /* reader may already be closed/errored — nothing actionable to do. */
    });
  }
}

/**
 * `ModelProvider` over streamed OpenAI-compatible Chat Completions. Text only for
 * Phase 1; see the file header for scope and the capability contract.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly optionsNamespace: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.id = config.id ?? "openai-compatible";
    this.capabilities = { ...CONSERVATIVE_CAPABILITIES, ...(config.capabilities ?? {}) };
    this.endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey;
    this.optionsNamespace = config.optionsNamespace ?? "openai";
    this.extraHeaders = { ...(config.headers ?? {}) };
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Assemble the Chat Completions wire body from the normalized request. */
  private buildBody(request: ModelRequest): Record<string, unknown> {
    const messages: { role: string; content: string }[] = [];
    if (request.instructions) {
      messages.push({ role: "system", content: request.instructions });
    }
    for (const message of request.messages) {
      messages.push({
        role: toWireRole(message.role),
        content: textOfContent(message.content),
      });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      // Ask for usage in the terminal frame; compatible servers MAY ignore this,
      // which the parser + provider handle by emitting no usage event.
      stream_options: { include_usage: true },
    };
    if (typeof request.maxOutputTokens === "number") {
      body.max_tokens = request.maxOutputTokens;
    }
    // The single namespaced provider-only escape hatch (design open Q5). Merged
    // last so a profile can set sampling knobs the core contract does not model.
    const extra = request.options?.[this.optionsNamespace];
    if (extra) Object.assign(body, extra);
    return body;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    // 1. Reject unsupported capabilities BEFORE any network call.
    const reason = unsupportedReason(request, this.capabilities);
    if (reason) {
      yield { type: "error", error: makeError("unsupported_capability", false, reason) };
      return;
    }

    // 2. POST the streamed request. A pre-response failure (DNS, refused) → unavailable.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildBody(request)),
      });
    } catch {
      // The thrown error may reference the URL but never the key; use a fixed,
      // secret-free summary regardless.
      yield {
        type: "error",
        error: makeError("unavailable", true, "failed to reach provider"),
      };
      return;
    }

    // 3. Non-2xx → normalized error, no stream started.
    if (!response.ok) {
      yield { type: "error", error: statusToProviderError(response) };
      return;
    }

    // 4. Committed 200 — the response has started.
    const providerRequestId = extractRequestId(response);
    yield providerRequestId !== undefined
      ? { type: "response.started", providerRequestId }
      : { type: "response.started" };

    if (!response.body) {
      // A 200 with no body is a malformed response for a streaming endpoint.
      yield {
        type: "error",
        error: makeError("malformed_response", true, "empty response stream"),
      };
      return;
    }

    // 5. Parse the SSE stream, mapping parser events onto normalized ModelEvents.
    // A well-formed Chat Completions stream terminates with a `finish_reason`
    // and/or the `[DONE]` sentinel; a clean close with NEITHER is a truncated
    // stream (the common shape when a connection is reset after a committed 200).
    let finishReason: FinishReason | undefined;
    try {
      for await (const ev of parseChatCompletionsStream(
        readableToByteChunks(response.body),
      )) {
        switch (ev.kind) {
          case "text":
            yield { type: "text.delta", text: ev.text };
            break;
          case "finish":
            finishReason = ev.reason;
            break;
          case "usage":
            yield ev.cacheReadTokens !== undefined
              ? {
                  type: "usage",
                  inputTokens: ev.inputTokens,
                  outputTokens: ev.outputTokens,
                  cacheReadTokens: ev.cacheReadTokens,
                }
              : {
                  type: "usage",
                  inputTokens: ev.inputTokens,
                  outputTokens: ev.outputTokens,
                };
            break;
          case "stream-error":
            // An error frame after 200 — terminal; no completed event.
            yield { type: "error", error: inStreamPayloadToError(ev.payload) };
            return;
          case "malformed":
            yield {
              type: "error",
              error: makeError("malformed_response", false, "malformed response stream"),
            };
            return;
          case "done":
            // Terminal sentinel — stop reading and finish cleanly below.
            yield { type: "response.completed", finishReason: finishReason ?? "stop" };
            return;
        }
      }
    } catch {
      // The byte stream threw mid-read — a truncated/aborted stream after 200.
      yield {
        type: "error",
        error: makeError("malformed_response", true, "response stream ended unexpectedly"),
      };
      return;
    }

    // 6. Stream ended without `[DONE]`. If a `finish_reason` was seen, the server
    // simply closed after the final frame (tolerated). If NOTHING terminal was
    // seen, the stream was truncated after 200 — surface it as malformed.
    if (finishReason === undefined) {
      yield {
        type: "error",
        error: makeError(
          "malformed_response",
          true,
          "response stream ended without a terminal frame",
        ),
      };
      return;
    }
    yield { type: "response.completed", finishReason };
  }
}
