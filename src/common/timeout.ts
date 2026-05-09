/**
 * AbortSignal.timeout helpers that preserve diagnostic context on abort.
 *
 * The bare `AbortSignal.timeout(ms)` produces a DOMException with name
 * "AbortError" and message "The operation was aborted." On Bun the JS stack
 * is "abort@[native code]", so when the abort surfaces from inside a fetch
 * deep in the router pipeline, it's impossible to tell *which* timeout fired
 * (attachment fetch? cloud publisher? usage monitor?).
 *
 * The 2026-05-09 outage burned hours of operator time on exactly this gap:
 * `router error: AbortError` with no source attribution.
 *
 * Use `fetchWithTimeout({ source, ms, ... })` instead. On abort it produces a
 * `TimeoutSourceError` carrying:
 *   - `.source` — the named call site (e.g. "attachment_fetch")
 *   - `.timeoutMs` — the timeout that fired
 *   - `.message` — "${source} aborted after ${ms}ms"
 *
 * The `source` enum is mirrored in the `system.dispatch.aborted` event
 * payload (G-1111 §3.5.4) so log scraping and event emission share a
 * vocabulary.
 */

export type TimeoutSource =
  | "attachment_fetch"
  | "cloud_publisher"
  | "usage_monitor"
  // Forward-compat for G-1111.G bus wiring; usage_fetcher and cc_session_spawn
  // have no in-tree caller yet but the event-payload schema already references
  // these names.
  | "usage_fetcher"
  | "startup_sync"
  | "cc_session_spawn"
  | "unknown";

export class TimeoutSourceError extends Error {
  override readonly name = "TimeoutSourceError";
  readonly source: TimeoutSource;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(source: TimeoutSource, timeoutMs: number, elapsedMs: number, cause?: unknown) {
    // ES2022 native cause: `super(message, { cause })`. Skip the options object
    // entirely when cause is undefined so we don't attach a `cause: undefined`
    // own-property to the error instance.
    super(
      `${source} aborted after ${elapsedMs}ms (timeout ${timeoutMs}ms)`,
      cause !== undefined ? { cause } : undefined,
    );
    this.source = source;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Wrap a promise so any AbortError it throws is rewritten to a
 * TimeoutSourceError that names the source. Non-AbortError rejections are
 * passed through unchanged.
 */
export async function withTimeoutContext<T>(
  source: TimeoutSource,
  timeoutMs: number,
  start: number,
  promise: Promise<T>,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isAbortError(err)) {
      throw new TimeoutSourceError(source, timeoutMs, Date.now() - start, err);
    }
    throw err;
  }
}

/**
 * Convenience: `fetch(input, init)` with a named timeout. Replaces:
 *
 *   fetch(url, { signal: AbortSignal.timeout(5_000) })
 *
 * with:
 *
 *   fetchWithTimeout("cloud_publisher", 5_000, url, { method: "POST" })
 *
 * Aborts surface as TimeoutSourceError, not bare AbortError.
 */
export async function fetchWithTimeout(
  source: TimeoutSource,
  timeoutMs: number,
  input: RequestInfo | URL,
  init: Omit<RequestInit, "signal"> = {},
): Promise<Response> {
  const start = Date.now();
  return withTimeoutContext(
    source,
    timeoutMs,
    start,
    fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  );
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}
