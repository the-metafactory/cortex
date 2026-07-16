/**
 * API-P1.5 (issue #2065) — Reusable fake streaming HTTP server for the shared
 * provider contract-test suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every model-provider adapter (`src/providers/anthropic/`,
 * `src/providers/openai-compatible/`) and the API agent harness
 * (`src/substrates/api-agent/`) must pass the SAME contract suite
 * (`./contract.ts`), run against recorded fixtures + a LOCAL fake HTTP server —
 * never a live provider and never paid credentials (design
 * §"Verification strategy": "CI correctness must not depend on provider
 * availability or paid credentials"). This module is that fake server.
 *
 * It is a thin, dependency-free wrapper over `Bun.serve` that lets a test:
 *   - enqueue a scripted response (status, headers, and a stream of raw byte
 *     chunks emitted with controllable inter-chunk delays);
 *   - split a payload across ARBITRARY frame boundaries — the core stress the
 *     stream-parser cases need (Unicode split mid-codepoint, tool-call JSON
 *     split mid-token);
 *   - simulate an in-stream error AFTER a 200 has been committed (bytes then an
 *     abrupt close), a truncated/malformed stream, and an inactivity gap that
 *     trips the idle-timeout path;
 *   - assert on exactly what the adapter sent (captured requests), so the
 *     "secrets absent from logs" class has a request-capture surface to check.
 *
 * SCAFFOLD NOTE (Wave 1)
 * ----------------------
 * This branch is cut from origin/main, which does NOT yet contain
 * `src/common/inference/` (issue #2058 lands separately). This helper is
 * therefore deliberately typed ONLY in terms of Web/Bun primitives (`Request`,
 * `Response`, byte chunks) — it imports NO provider or inference types. When the
 * gated slices (#2061 anthropic / #2062 openai-compatible / #2063 harness) land,
 * their live `test(...)` bodies point a real provider factory at
 * `server.url` and drive these primitives; this file does not change shape.
 *
 * ZERO external network: `Bun.serve({ hostname: "127.0.0.1", port: 0 })` binds
 * loopback on an ephemeral port. Nothing here reaches the internet.
 */

/** A single scripted chunk in a streamed response body. */
export interface StreamChunk {
  /** Raw bytes (or UTF-8 string) to write. Strings are encoded as UTF-8. */
  readonly data: string | Uint8Array;
  /** Milliseconds to wait BEFORE writing this chunk (simulates network gaps / inactivity). */
  readonly delayMs?: number;
}

/** A scripted response the fake server will play back for the next request. */
export interface ScriptedResponse {
  /** HTTP status code (e.g. 200, 401, 429, 529, 503). */
  readonly status?: number;
  /** Response headers (e.g. `content-type: text/event-stream`). */
  readonly headers?: Record<string, string>;
  /**
   * Ordered chunks to stream once the 200 (or other status) is committed.
   * For non-stream error responses, pass a single chunk with the JSON error body.
   */
  readonly chunks?: readonly StreamChunk[];
  /**
   * End the response body (premature EOF) AFTER the scripted chunks are written,
   * WITHOUT a terminal SSE frame — models "an in-stream error after HTTP
   * success" and a "truncated stream". This is a deterministic abrupt CLOSE, not
   * a stream-error injection: `controller.error(...)` produced a
   * non-deterministic unhandled rejection under some Bun versions that bun's
   * test runner mis-attributed to the calling test. A premature close lets each
   * provider's "clean end with no terminal frame → malformed_response"
   * classifier fire deterministically across runtimes. Default false (the normal
   * path also closes cleanly, but with the terminal frame present in `chunks`).
   */
  readonly abortAfterChunks?: boolean;
  /**
   * Hang the connection open indefinitely after the last chunk instead of
   * closing — models the inactivity-timeout path (the adapter's idle timer must
   * fire, not the server). Default false.
   */
  readonly hangOpen?: boolean;
}

/** A request the fake server captured, for assertions (incl. secret-absence). */
export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface FakeStreamingServer {
  /** Base URL, e.g. `http://127.0.0.1:53411`. Point the provider `baseUrl` here. */
  readonly url: string;
  /** Bound loopback port. */
  readonly port: number;
  /** Queue a response to be played back for the next inbound request (FIFO). */
  enqueue(response: ScriptedResponse): void;
  /** All requests captured so far, in arrival order. */
  readonly requests: readonly CapturedRequest[];
  /** Clear captured requests and any queued responses. */
  reset(): void;
  /** Stop the server and free the port. Await in test teardown. */
  stop(): Promise<void>;
}

const encoder = new TextEncoder();

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a loopback fake streaming HTTP server on an ephemeral port.
 *
 * The server plays back enqueued {@link ScriptedResponse}s in FIFO order. If no
 * response is queued for an inbound request it replies `500 no scripted
 * response` so a test that forgets to `enqueue` fails loudly rather than hanging.
 */
export function startFakeStreamingServer(): FakeStreamingServer {
  const queue: ScriptedResponse[] = [];
  const captured: CapturedRequest[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await req.text();
      const { pathname } = new URL(req.url);
      captured.push({
        method: req.method,
        url: req.url,
        path: pathname,
        headers,
        body,
      });

      const scripted = queue.shift();
      if (!scripted) {
        return new Response("no scripted response", { status: 500 });
      }

      const status = scripted.status ?? 200;
      const respHeaders = scripted.headers ?? {};
      const chunks = scripted.chunks ?? [];

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (const chunk of chunks) {
              if (chunk.delayMs && chunk.delayMs > 0) {
                await sleep(chunk.delayMs);
              }
              controller.enqueue(toBytes(chunk.data));
            }
            if (scripted.hangOpen) {
              // Never close — force the adapter's inactivity timer to fire.
              return;
            }
            if (scripted.abortAfterChunks) {
              // Truncated stream = the response body ends (premature EOF) BEFORE
              // a terminal SSE frame, so we `close()` here — the same clean-EOF
              // primitive as the normal path, just without the terminal frame in
              // the enqueued chunks. We deliberately do NOT inject a stream error
              // (`controller.error(...)`): that surfaced a non-deterministic
              // unhandled rejection under some Bun versions (server-side, so no
              // client `reader.read()` try/catch could suppress it), which bun's
              // test runner attributed to the calling test and failed it in CI.
              // A premature `close()` faithfully models a truncated stream and
              // lets each provider's "clean end with no terminal frame →
              // malformed_response" classifier fire deterministically across
              // runtimes.
              controller.close();
              return;
            }
            controller.close();
          } catch (err) {
            controller.error(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        },
      });

      return new Response(stream, { status, headers: respHeaders });
    },
  });

  return {
    url: server.url.origin,
    // `port: 0` requested an ephemeral port; after `Bun.serve` returns, the OS
    // has bound a concrete port. Bun types `Server.port` as optional, so coerce
    // the (always-present here) value to satisfy the `number` interface.
    port: server.port ?? 0,
    enqueue(response: ScriptedResponse) {
      queue.push(response);
    },
    get requests() {
      return captured;
    },
    reset() {
      queue.length = 0;
      captured.length = 0;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
