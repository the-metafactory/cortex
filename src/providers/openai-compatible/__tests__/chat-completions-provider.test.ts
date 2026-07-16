// API-P1.2 (issue #2062) — LIVE contract tests for `OpenAICompatibleProvider`,
// driven against the shared fake streaming server (API-P1.5 scaffold).
//
// REUSE WITHOUT TOUCHING THE SHARED METER: the shared `src/providers/__tests__/
// contract.ts` holds the epic progress meter (one `test.todo` per case per gated
// slice) and is edited by a SIBLING slice — we must not touch it. Instead we
// import its exported case-name constant (`PROVIDER_CONTRACT_CASES`) and the
// exported fake server (`startFakeStreamingServer`) and name our live tests with
// those exact strings, so this file is the openai-compatible slice's live proof
// of the same cases the meter tracks — with zero edits to the shared files.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PROVIDER_CONTRACT_CASES,
} from "../../__tests__/contract";
import {
  startFakeStreamingServer,
  type FakeStreamingServer,
  type StreamChunk,
} from "../../__tests__/fake-streaming-server";
import type { ModelEvent, ModelRequest } from "../../../common/inference/types";
import { OpenAICompatibleProvider } from "../chat-completions-provider";

// Stable indices into the shared case list, so our test names stay verbatim in
// sync with the meter even if the list is reordered.
const CASE = (needle: string): string => {
  const found = PROVIDER_CONTRACT_CASES.find((c) => c.includes(needle));
  if (!found) throw new Error(`no shared contract case matching "${needle}"`);
  return found;
};

const SSE_HEADERS = { "content-type": "text/event-stream" } as const;
const API_KEY = "sk-secret-DO-NOT-LEAK-abc123";

let server: FakeStreamingServer;

beforeEach(() => {
  server = startFakeStreamingServer();
});
afterEach(async () => {
  await server.stop();
});

function makeProvider(overrides?: {
  capabilities?: ConstructorParameters<typeof OpenAICompatibleProvider>[0]["capabilities"];
  apiKey?: string;
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: `${server.url}/v1`,
    apiKey: overrides?.apiKey ?? API_KEY,
    ...(overrides?.capabilities ? { capabilities: overrides.capabilities } : {}),
  });
}

const REQUEST: ModelRequest = {
  model: "test-model",
  instructions: "be terse",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

// ── SSE frame builders ────────────────────────────────────────────────────────
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
const contentChunk = (text: string): string =>
  sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const finishChunk = (reason = "stop"): string =>
  sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (input: number, output: number): string =>
  sse({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });

function singleByteChunks(s: string): StreamChunk[] {
  const bytes = new TextEncoder().encode(s);
  return Array.from(bytes, (b) => ({ data: new Uint8Array([b]) }));
}

async function drain(provider: OpenAICompatibleProvider): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const ev of provider.stream(REQUEST)) events.push(ev);
  return events;
}

function textOf(events: readonly ModelEvent[]): string {
  let out = "";
  for (const e of events) if (e.type === "text.delta") out += e.text;
  return out;
}

function firstError(events: readonly ModelEvent[]) {
  const ev = events.find((e) => e.type === "error");
  return ev?.type === "error" ? ev.error : undefined;
}

describe("provider contract · openai-compatible (live, #2062)", () => {
  test(CASE("Unicode grapheme split across frame boundaries"), async () => {
    // A 4-byte emoji plus surrounding ASCII, streamed ONE BYTE PER FRAME so every
    // multi-byte codepoint AND every `data:` line is split across chunk
    // boundaries — the strongest form of the split-frame stress.
    const payload = contentChunk("a🌱b") + finishChunk("stop") + DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: singleByteChunks(payload) });

    const events = await drain(makeProvider());

    expect(events[0]?.type).toBe("response.started");
    expect(textOf(events)).toBe("a🌱b");
    const last = events[events.length - 1];
    expect(last?.type).toBe("response.completed");
    if (last?.type === "response.completed") expect(last.finishReason).toBe("stop");
  });

  test(CASE("unknown / unrecognized event variants"), async () => {
    const payload =
      sse({ object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] }) +
      sse({ foo: "bar", weird: true }) +
      "data: 42\n\n" + // valid JSON, non-object — must be ignored, not fatal
      contentChunk("ok") +
      finishChunk("stop") +
      DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await drain(makeProvider());

    expect(textOf(events)).toBe("ok");
    expect(events[events.length - 1]?.type).toBe("response.completed");
    expect(firstError(events)).toBeUndefined();
  });

  test(CASE("authentication (401)"), async () => {
    server.enqueue({ status: 401, chunks: [{ data: '{"error":{"message":"nope"}}' }] });
    const events = await drain(makeProvider());
    expect(events.some((e) => e.type === "response.started")).toBe(false);
    const err = firstError(events);
    expect(err?.kind).toBe("authentication");
    expect(err?.retryable).toBe(false);
  });

  test(CASE("rate_limit (429)"), async () => {
    server.enqueue({ status: 429, headers: { "retry-after": "2" }, chunks: [{ data: "{}" }] });
    const err = firstError(await drain(makeProvider()));
    expect(err?.kind).toBe("rate_limit");
    expect(err?.retryable).toBe(true);
    expect(err?.retryAfterMs).toBe(2000);
  });

  test(CASE("overloaded (529)"), async () => {
    server.enqueue({ status: 529, chunks: [{ data: "{}" }] });
    const err = firstError(await drain(makeProvider()));
    expect(err?.kind).toBe("overloaded");
    expect(err?.retryable).toBe(true);
  });

  test(CASE("unavailable (503)"), async () => {
    server.enqueue({ status: 503, chunks: [{ data: "{}" }] });
    const err = firstError(await drain(makeProvider()));
    expect(err?.kind).toBe("unavailable");
    expect(err?.retryable).toBe(true);
  });

  test("maps invalid_request (400) responses to the normalized invalid_request error", async () => {
    server.enqueue({ status: 400, chunks: [{ data: '{"error":{"message":"bad"}}' }] });
    const err = firstError(await drain(makeProvider()));
    expect(err?.kind).toBe("invalid_request");
    expect(err?.retryable).toBe(false);
  });

  test(CASE("in-stream error that arrives AFTER a committed HTTP 200"), async () => {
    const payload =
      contentChunk("partial ") +
      sse({ error: { type: "server_error", code: "internal", message: "boom-should-not-leak" } });
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await drain(makeProvider());

    expect(events.some((e) => e.type === "response.started")).toBe(true);
    expect(textOf(events)).toBe("partial ");
    const err = firstError(events);
    expect(err).toBeDefined();
    // No completed event once an in-stream error is surfaced.
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
    // The free-form provider message must NOT leak into the redacted summary.
    expect(err?.summary).not.toContain("boom-should-not-leak");
  });

  test(CASE("malformed / truncated streams") + " · malformed JSON frame", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: "data: {this is not json}\n\n" }],
    });
    const events = await drain(makeProvider());
    expect(events.some((e) => e.type === "response.started")).toBe(true);
    expect(firstError(events)?.kind).toBe("malformed_response");
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });

  test(CASE("malformed / truncated streams") + " · truncated after 200", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("half") }],
      abortAfterChunks: true, // abrupt close, no terminal frame
    });
    const events = await drain(makeProvider());
    expect(events.some((e) => e.type === "response.started")).toBe(true);
    expect(firstError(events)?.kind).toBe("malformed_response");
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
    // The async iterable completes normally (no throw) and its FINAL event is the
    // normalized error — the read-loop swallows the abort and ends cleanly.
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.error.kind).toBe("malformed_response");
  });

  test(CASE("normalizes usage from a final usage frame"), async () => {
    const payload = contentChunk("hello") + finishChunk("stop") + usageChunk(11, 7) + DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await drain(makeProvider());
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.inputTokens).toBe(11);
      expect(usage.outputTokens).toBe(7);
    }
    expect(events[events.length - 1]?.type).toBe("response.completed");
  });

  test(CASE("omits the final usage frame (missing usage)"), async () => {
    // Ollama-style: content + finish + [DONE], NO usage object at all.
    const payload = contentChunk("hello") + finishChunk("stop") + DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const events = await drain(makeProvider());

    // Provider completes cleanly and emits NO usage event (not a zeroed one).
    expect(events.some((e) => e.type === "usage")).toBe(false);
    expect(textOf(events)).toBe("hello");
    const last = events[events.length - 1];
    expect(last?.type).toBe("response.completed");
    if (last?.type === "response.completed") expect(last.finishReason).toBe("stop");
  });

  test(CASE("rejects an unsupported_capability request before dispatch"), async () => {
    // Default capabilities have images:false — an image request must be rejected
    // BEFORE any network call.
    const provider = makeProvider();
    const request: ModelRequest = {
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [{ type: "image_ref", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    };
    const events: ModelEvent[] = [];
    for await (const ev of provider.stream(request)) events.push(ev);

    expect(events).toHaveLength(1);
    expect(firstError(events)?.kind).toBe("unsupported_capability");
    expect(server.requests).toHaveLength(0); // never dispatched
  });

  test("capabilities default conservative and are overridable from profile config", async () => {
    const dflt = makeProvider();
    expect(dflt.capabilities).toEqual({
      streaming: true,
      tools: false,
      parallelTools: false,
      images: false,
      documents: false,
      structuredOutput: false,
      serverContinuation: false,
      promptCaching: false,
    });

    // An override flipping images on lets an image request through to dispatch.
    const withImages = makeProvider({ capabilities: { images: true } });
    expect(withImages.capabilities.images).toBe(true);
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: DONE }] });
    const events: ModelEvent[] = [];
    for await (const ev of withImages.stream({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [{ type: "image_ref", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    })) {
      events.push(ev);
    }
    expect(firstError(events)?.kind).not.toBe("unsupported_capability");
    expect(server.requests).toHaveLength(1); // it WAS dispatched
  });

  test(CASE("keeps secrets absent from errors, events, snapshots, and logs"), async () => {
    // Success path.
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("hi") + finishChunk("stop") + DONE }],
    });
    const ok = await drain(makeProvider());
    // Error path.
    server.enqueue({ status: 401, chunks: [{ data: '{"error":{"message":"denied"}}' }] });
    const bad = await drain(makeProvider());

    const serialized = JSON.stringify([...ok, ...bad]);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized).not.toContain("Bearer");

    // The key WAS actually sent to the provider (proving redaction, not omission).
    const authHeaders = server.requests.map((r) => r.headers.authorization);
    expect(authHeaders).toContain(`Bearer ${API_KEY}`);
  });
});
