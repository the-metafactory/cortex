/**
 * API-P1.1 (issue #2061) — live contract tests for the native Anthropic Messages
 * provider, run against the shared fake streaming HTTP server (API-P1.5).
 *
 * REUSE WITHOUT TOUCHING THE SHARED SCAFFOLD
 * ------------------------------------------
 * A sibling slice owns `src/providers/__tests__/contract.ts` (it flips the
 * `anthropic` `test.todo`s there). To avoid a parallel edit conflict this file
 * lives under `src/providers/anthropic/__tests__/` and IMPORTS — never edits —
 * the shared assets from that scaffold:
 *   - `PROVIDER_CONTRACT_CASES` (the canonical case-name list) from `contract.ts`;
 *   - `startFakeStreamingServer` from `fake-streaming-server.ts`.
 * Each live test is NAMED by looking its title up in `PROVIDER_CONTRACT_CASES`
 * (`caseName(...)`), so the suite stays a faithful burn-down of the shared cases
 * even though the todo flip itself happens in the sibling's file.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { ModelEvent, ModelRequest } from "../../../common/inference/types";
import { AnthropicMessagesProvider } from "../messages-provider";
import { mapAnthropicMessagesStream } from "../stream-parser";
import { PROVIDER_CONTRACT_CASES } from "../../__tests__/contract";
import {
  startFakeStreamingServer,
  type StreamChunk,
} from "../../__tests__/fake-streaming-server";

// A deliberately recognizable fake secret. Every test asserts it never escapes
// into an event, error, or serialized snapshot.
const SECRET = "sk-ant-SECRET-must-never-leak-0xDEADBEEF";

const server = startFakeStreamingServer();
afterAll(() => server.stop());
beforeEach(() => server.reset());

/** Resolve a shared contract-case title by a unique substring (keeps names in sync). */
function caseName(substring: string): string {
  const match = PROVIDER_CONTRACT_CASES.find((c) => c.includes(substring));
  if (!match) throw new Error(`no shared contract case matching: ${substring}`);
  return match;
}

function newProvider(): AnthropicMessagesProvider {
  return new AnthropicMessagesProvider({ apiKey: SECRET, baseUrl: server.url });
}

/** Serialize one SSE frame: `event:`/`data:` lines terminated by a blank line. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Split a UTF-8 string into raw N-byte slices — stresses frame AND codepoint splits. */
function byteChunks(text: string, size: number): StreamChunk[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: StreamChunk[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push({ data: bytes.slice(i, i + size) });
  }
  return chunks;
}

const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const JSON_HEADERS = { "content-type": "application/json" } as const;

async function collect(request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of newProvider().stream(request)) events.push(event);
  return events;
}

const textRequest: ModelRequest = {
  model: "claude-sonnet-test",
  instructions: "be terse",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxOutputTokens: 64,
};

describe("AnthropicMessagesProvider · native Messages contract", () => {
  test("advertises Anthropic capabilities (serverContinuation:false, promptCaching:true)", () => {
    const caps = newProvider().capabilities;
    expect(caps.serverContinuation).toBe(false);
    expect(caps.promptCaching).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.images).toBe(true);
    expect(caps.documents).toBe(true);
    expect(newProvider().id).toBe("anthropic-messages");
  });

  test(caseName("Unicode grapheme split across frame boundaries"), async () => {
    // A full text stream, incl. a 4-byte emoji, chopped into tiny raw byte
    // slices so both SSE frames AND the emoji's codepoint split across chunks.
    const payload =
      frame("message_start", {
        type: "message_start",
        message: { id: "msg_1", role: "assistant", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4 } },
      }) +
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world 🌍!" } }) +
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }) +
      frame("message_stop", { type: "message_stop" });

    server.enqueue({ status: 200, headers: { ...SSE_HEADERS, "request-id": "req_abc" }, chunks: byteChunks(payload, 5) });

    const events = await collect(textRequest);
    const started = events.find((e) => e.type === "response.started");
    expect(started).toEqual({ type: "response.started", providerRequestId: "req_abc" });

    const text = events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hello world 🌍!");

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 10, outputTokens: 12, cacheReadTokens: 4 });

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toEqual({ type: "response.completed", finishReason: "stop" });
  });

  test(caseName("reassembles tool-call JSON"), async () => {
    // Parser-level: an input_json_delta block whose JSON is split arbitrarily
    // must reassemble. Driven straight through the mapper (no tools sent in P1).
    const fullJson = '{"city":"Auckland 🌏","units":"metric"}';
    const parts = [fullJson.slice(0, 3), fullJson.slice(3, 10), fullJson.slice(10, 25), fullJson.slice(25)];
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_t", role: "assistant", usage: { input_tokens: 5, output_tokens: 1 } } }) +
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }) +
      parts.map((p) => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } })).join("") +
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }) +
      frame("message_stop", { type: "message_stop" });

    const events: ModelEvent[] = [];
    for await (const e of mapAnthropicMessagesStream(byteChunksAsync(payload, 4))) events.push(e);

    const deltaJson = events.filter((e) => e.type === "tool_call.delta").map((e) => (e as { json: string }).json).join("");
    expect(deltaJson).toBe(fullJson);

    const completed = events.find((e) => e.type === "tool_call.completed");
    expect(completed?.id).toBe("toolu_1");
    expect(completed?.name).toBe("get_weather");
    expect(completed?.input).toEqual({ city: "Auckland 🌏", units: "metric" });

    expect(events.at(-1)).toEqual({ type: "response.completed", finishReason: "tool_use" });
  });

  test(caseName("unknown / unrecognized event variants"), async () => {
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_u", role: "assistant", usage: { input_tokens: 2, output_tokens: 1 } } }) +
      frame("some_future_event", { type: "some_future_event", data: { anything: true } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
      frame("another_new_variant", { type: "another_new_variant" }) +
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
      frame("message_stop", { type: "message_stop" });

    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await collect(textRequest);
    expect(events.map((e) => e.type)).toEqual([
      "response.started",
      "text.delta",
      "usage",
      "response.completed",
    ]);
  });

  test(caseName("in-stream error that arrives AFTER a committed HTTP 200"), async () => {
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_e", role: "assistant", usage: { input_tokens: 3, output_tokens: 1 } } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }) +
      frame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });

    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await collect(textRequest);
    expect(events.some((e) => e.type === "response.started")).toBe(true);
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string } } | undefined;
    expect(err?.error.kind).toBe("overloaded");
    // No secret anywhere in the mid-stream error.
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  test(caseName("malformed / truncated streams"), async () => {
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_x", role: "assistant", usage: { input_tokens: 1, output_tokens: 1 } } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } });

    // abortAfterChunks: the connection drops mid-stream with no terminal frame.
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }], abortAfterChunks: true });

    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string } } | undefined;
    expect(err?.error.kind).toBe("malformed_response");
  });

  test(caseName("omits the final usage frame"), async () => {
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_n", role: "assistant", usage: { input_tokens: 7, output_tokens: 1 } } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }) +
      // message_delta carries a stop_reason but NO usage object.
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
      frame("message_stop", { type: "message_stop" });

    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await collect(textRequest);
    expect(events.some((e) => e.type === "usage")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "response.completed", finishReason: "stop" });
  });

  // ── HTTP error-status → ProviderErrorKind mapping ──────────────────────────

  test(caseName("authentication (401)"), async () => {
    server.enqueue({ status: 401, headers: JSON_HEADERS, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string; retryable: boolean; summary: string } };
    expect(err.error.kind).toBe("authentication");
    expect(err.error.retryable).toBe(false);
    expect(err.error.summary).not.toContain(SECRET);
  });

  test("maps authorization (403) responses to the normalized authorization error", async () => {
    server.enqueue({ status: 403, headers: JSON_HEADERS, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "permission_error", message: "forbidden" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string } };
    expect(err.error.kind).toBe("authorization");
  });

  test(caseName("rate_limit (429)"), async () => {
    server.enqueue({ status: 429, headers: { ...JSON_HEADERS, "retry-after": "3" }, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string; retryable: boolean; retryAfterMs?: number } };
    expect(err.error.kind).toBe("rate_limit");
    expect(err.error.retryable).toBe(true);
    expect(err.error.retryAfterMs).toBe(3000);
  });

  test(caseName("overloaded (529)"), async () => {
    server.enqueue({ status: 529, headers: JSON_HEADERS, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string; retryable: boolean } };
    expect(err.error.kind).toBe("overloaded");
    expect(err.error.retryable).toBe(true);
  });

  test(caseName("unavailable (503)"), async () => {
    server.enqueue({ status: 503, headers: JSON_HEADERS, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream unavailable" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string; retryable: boolean } };
    expect(err.error.kind).toBe("unavailable");
    expect(err.error.retryable).toBe(true);
  });

  test("maps invalid_request (400) responses to the normalized invalid_request error", async () => {
    server.enqueue({ status: 400, headers: JSON_HEADERS, chunks: [{ data: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad max_tokens" } }) }] });
    const events = await collect(textRequest);
    const err = events.find((e) => e.type === "error") as { type: "error"; error: { kind: string; retryable: boolean } };
    expect(err.error.kind).toBe("invalid_request");
    expect(err.error.retryable).toBe(false);
  });

  // ── Secret hygiene + request shape ─────────────────────────────────────────

  test(caseName("keeps secrets absent"), async () => {
    const payload =
      frame("message_start", { type: "message_start", message: { id: "msg_s", role: "assistant", usage: { input_tokens: 4, output_tokens: 1 } } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "safe" } }) +
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
      frame("message_stop", { type: "message_stop" });

    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await collect(textRequest);

    // The key WAS sent on the wire (x-api-key header) …
    const req = server.requests.at(-1);
    expect(req?.headers["x-api-key"]).toBe(SECRET);
    // … the native Messages request was well-formed (system + stream + max_tokens) …
    const sentBody = JSON.parse(req?.body ?? "{}");
    expect(sentBody.stream).toBe(true);
    expect(sentBody.system).toBe("be terse");
    expect(sentBody.max_tokens).toBe(64);
    expect(sentBody.model).toBe("claude-sonnet-test");
    // … but the secret appears in NONE of the normalized events.
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

/** `byteChunks` as an async byte iterable — for driving the mapper directly. */
async function* byteChunksAsync(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.slice(i, i + size);
  }
}
