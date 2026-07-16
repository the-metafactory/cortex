// API-P1.1 (epic #2055, Phase 1, decision D2) — the native Anthropic Messages
// API adapter. Implements the normalized {@link ModelProvider} contract against
// Anthropic's `POST /v1/messages` endpoint with `stream: true`. Native Messages,
// NOT the OpenAI-compat shim (design §Anthropic / D2: production traffic uses
// Messages directly, which the compat layer does not preserve).
//
// Phase 1 sends TEXT content only. The SSE parsing + native→normalized event
// mapping lives in `./stream-parser.ts`; this file owns request translation,
// the HTTP call, HTTP-status → `ProviderError` mapping, and capability
// advertisement.
//
// SECURITY: the API key travels ONLY in the `x-api-key` request header. It is
// never logged and never placed on any `ProviderError.summary`, event, or other
// output — those surfaces are published onto the bus and shown on the dashboard.

import type {
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ProviderCapabilities,
} from "../../common/inference/types";
import type {
  ProviderError,
  ProviderErrorKind,
} from "../../common/inference/errors";
import { mapAnthropicMessagesStream } from "./stream-parser";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
/**
 * The `max_tokens` cortex sends when a profile omits `maxOutputTokens` (issue
 * #2114).
 *
 * WHY A DEFAULT EXISTS AT ALL — and only here. The Anthropic Messages API makes
 * `max_tokens` a REQUIRED body field: omitting it is a 400, so cortex cannot
 * pass the omission through the way the OpenAI-compatible adapter can (there
 * the field is simply left off and the server's own default applies). Some
 * value must be chosen; the only question is whether it is chosen silently.
 *
 * It is therefore DECLARED, not silent: exported and named so the value is
 * greppable, assertable from a test, and documented in the design's
 * §Configuration table rather than buried as a magic number at a call site.
 * Overridable per provider instance via `defaultMaxOutputTokens`.
 *
 * A profile that states `maxOutputTokens` always wins — this constant applies
 * ONLY to profiles that omit it. Prefer stating the bound explicitly in the
 * profile: it is the principal's declared cost/length bound, and 4096 is a
 * conservative floor well below what current Anthropic models support.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Constructor options for {@link AnthropicMessagesProvider}. */
export interface AnthropicMessagesProviderOptions {
  /** The Anthropic API key. Sent ONLY as the `x-api-key` header; never logged. */
  readonly apiKey: string;
  /** API origin. Defaults to `https://api.anthropic.com`. Tests point this at a fake server. */
  readonly baseUrl?: string;
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  readonly anthropicVersion?: string;
  /** `max_tokens` used when a request omits `maxOutputTokens`. Defaults to 4096. */
  readonly defaultMaxOutputTokens?: number;
  /** Injected `fetch` (for tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Extra request headers merged in (must NOT be used to carry secrets into logs). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** The static capability matrix Anthropic Messages advertises (design §Anthropic). */
const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelTools: true,
  images: true,
  documents: true,
  structuredOutput: false,
  // Messages has no portable server-side session to resume across requests.
  serverContinuation: false,
  promptCaching: true,
};

/** Translate one normalized message into a native Anthropic message (text only). */
function toAnthropicMessage(message: ModelMessage): {
  role: "user" | "assistant";
  content: { type: "text"; text: string }[];
} {
  // Phase 1 is text-only; a `tool` role has no native Messages equivalent
  // without tool_result blocks (Phase 3), so it collapses onto `user`.
  const role = message.role === "assistant" ? "assistant" : "user";
  const content: { type: "text"; text: string }[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
  }
  return { role, content };
}

/** Build the native Messages request body from a normalized {@link ModelRequest}. */
function toAnthropicRequestBody(
  request: ModelRequest,
  defaultMaxOutputTokens: number,
): Record<string, unknown> {
  // The single namespaced escape hatch: opaque provider-only knobs merge in
  // first, then the core fields (which must win and never be overridden).
  const providerOptions = request.options?.anthropic ?? {};
  return {
    ...providerOptions,
    model: request.model,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    stream: true,
    ...(request.instructions ? { system: request.instructions } : {}),
    messages: request.messages.map(toAnthropicMessage),
  };
}

/** Parse `retry-after` (seconds) into milliseconds, when present and numeric. */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

/** Read the provider request id from response headers (never from the body). */
function providerRequestId(headers: Headers): string | undefined {
  return headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
}

/**
 * Map a non-2xx HTTP status onto a normalized {@link ProviderError}. The summary
 * carries only the status and, when the body is JSON, the provider-authored
 * `error.type`/`message` (secret-free) — NEVER a header value or the API key.
 */
function httpStatusToProviderError(
  status: number,
  headers: Headers,
  bodyText: string,
  reqId: string | undefined,
): ProviderError {
  let kind: ProviderErrorKind;
  let retryable: boolean;
  let retry: number | undefined;

  if (status === 401) {
    kind = "authentication";
    retryable = false;
  } else if (status === 403) {
    kind = "authorization";
    retryable = false;
  } else if (status === 429) {
    kind = "rate_limit";
    retryable = true;
    retry = retryAfterMs(headers);
  } else if (status === 529) {
    kind = "overloaded";
    retryable = true;
    retry = retryAfterMs(headers);
  } else if (status === 400) {
    kind = "invalid_request";
    retryable = false;
  } else if (status >= 500) {
    kind = "unavailable";
    retryable = true;
    retry = retryAfterMs(headers);
  } else {
    // Any other 4xx: treat as a client-side, non-retryable invalid request.
    kind = "invalid_request";
    retryable = false;
  }

  let summary = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
    const err = parsed.error;
    const typeStr = typeof err?.type === "string" ? err.type : undefined;
    const messageStr = typeof err?.message === "string" ? err.message : undefined;
    if (typeStr || messageStr) {
      summary = `HTTP ${status}: ${[typeStr, messageStr].filter(Boolean).join(" — ")}`;
    }
  } catch {
    // Non-JSON error body: keep the bare `HTTP <status>` summary. The raw body
    // is intentionally NOT echoed (it could be large / non-diagnostic).
  }

  return {
    kind,
    retryable,
    summary,
    ...(retry != null ? { retryAfterMs: retry } : {}),
    ...(reqId ? { providerRequestId: reqId } : {}),
  };
}

/**
 * Native Anthropic Messages API provider. Streams a normalized {@link ModelEvent}
 * sequence for a text request; HTTP and in-stream failures surface as a terminal
 * normalized `error` event (never a thrown raw error carrying secrets).
 */
export class AnthropicMessagesProvider implements ModelProvider {
  readonly id = "anthropic-messages";
  readonly capabilities: ProviderCapabilities = ANTHROPIC_CAPABILITIES;

  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #anthropicVersion: string;
  readonly #defaultMaxOutputTokens: number;
  readonly #fetchImpl: typeof fetch;
  readonly #extraHeaders: Record<string, string>;

  constructor(options: AnthropicMessagesProviderOptions) {
    this.#apiKey = options.apiKey;
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#endpoint = `${baseUrl}/v1/messages`;
    this.#anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.#defaultMaxOutputTokens =
      options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#extraHeaders = { ...(options.extraHeaders ?? {}) };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body = JSON.stringify(
      toAnthropicRequestBody(request, this.#defaultMaxOutputTokens),
    );
    const headers: Record<string, string> = {
      ...this.#extraHeaders,
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": this.#anthropicVersion,
      "x-api-key": this.#apiKey,
    };

    let response: Response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers,
        body,
      });
    } catch (_err) {
      // Transport-level failure (DNS/connect/reset). Surface a normalized error
      // event; the raw error is NOT interpolated so nothing (e.g. a URL with an
      // embedded credential) can leak onto the summary.
      yield {
        type: "error",
        error: {
          kind: "unavailable",
          retryable: true,
          summary: "request transport failure",
        },
      };
      return;
    }

    const reqId = providerRequestId(response.headers);

    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (_err) {
        // Body already consumed / connection dropped — fall back to the bare
        // status summary. Safe to ignore: the status alone drives the kind.
        text = "";
      }
      yield {
        type: "error",
        error: httpStatusToProviderError(response.status, response.headers, text, reqId),
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: {
          kind: "malformed_response",
          retryable: true,
          summary: "response had no body",
          ...(reqId ? { providerRequestId: reqId } : {}),
        },
      };
      return;
    }

    yield* mapAnthropicMessagesStream(readBody(response.body), {
      providerRequestId: reqId,
    });
  }
}

/**
 * Adapt a `ReadableStream<Uint8Array>` (a fetch `Response.body`) to an
 * `AsyncIterable<Uint8Array>` via an explicit reader, so cancellation releases
 * the underlying connection deterministically across runtimes.
 *
 * A mid-stream read REJECTION — an aborted / truncated connection, e.g. the
 * peer erroring the stream (`controller.error`) after HTTP 200 — is caught and
 * ends iteration CLEANLY rather than propagating. Whether such an abort surfaces
 * as a rejected `read()` or a silent EOF is Bun/environment-sensitive (it threw
 * in CI but not locally), so we never depend on the throw reaching a caller: the
 * mapper classifies the resulting terminal-frame-less end as `malformed_response`.
 * The raw error is deliberately NOT surfaced (it could carry provider detail).
 */
async function* readBody(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (_err) {
        // Aborted / truncated stream. Stop yielding; the mapper sees a stream
        // that ended without a `message_stop` and emits a normalized
        // `malformed_response` error. Raw error intentionally swallowed.
        return;
      }
      if (chunk.done) break;
      yield chunk.value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_err) {
      // The reader may already be released/errored after an aborted stream;
      // releasing again is a no-op we can safely ignore.
    }
  }
}
