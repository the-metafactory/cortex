/**
 * Retry helper for transient Discord REST failures.
 *
 * What we retry:
 *   - HTTPError with 5xx (Discord-side problem)
 *   - Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN,
 *     EPIPE, UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT,
 *     UND_ERR_BODY_TIMEOUT
 *   - AbortError / TimeoutError on signal timeout
 *   - TimeoutSourceError (our wrapper around AbortError; preserves source name)
 *   - undici-wrapped variants where the network code lives in `.cause.code`
 *     and abort errors live in `.cause.name`
 *
 * What we do NOT retry:
 *   - DiscordAPIError (4xx app-level: bad permissions, deleted channel, ...)
 *   - 429 rate limits — discord.js handles these in its internal queue before
 *     we ever see them.
 *   - Anything else — we bias toward fail-fast on programming errors.
 *
 * Defaults rationale (2026-05-09 outage post-mortem):
 *   maxAttempts=5, baseMs=500, maxDelayMs=30_000 absorbs ~30s of Discord 5xx
 *   wobble before failing. The original 3-attempt / 8s-cap budget gave up in
 *   ~1.5s, which was shorter than the actual incident's failure window.
 */

export interface RetryOptions {
  maxAttempts?: number;          // default 5
  baseMs?: number;               // default 500
  maxDelayMs?: number;           // default 30_000
  jitter?: boolean;              // default true
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_ABORT_NAMES = new Set([
  "AbortError",
  "TimeoutError",         // AbortSignal.timeout actually emits this name on Node/Bun
  "TimeoutSourceError",   // our own wrapper — see ./timeout.ts
]);

export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // discord.js HTTPError has numeric .status; 5xx is retryable.
  // DiscordAPIError (4xx) also has .status — those are not retryable.
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    return status >= 500 && status < 600;
  }

  // Network errors expose .code on the error or .cause.code (undici-wrapped).
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: string }).code;
    if (typeof causeCode === "string" && RETRYABLE_NETWORK_CODES.has(causeCode)) return true;
    // TimeoutSourceError wraps the original AbortError as `cause` — treat the
    // chain as retryable too, in case a caller throws the AbortError directly.
    const causeName = (cause as { name?: string }).name;
    if (typeof causeName === "string" && RETRYABLE_ABORT_NAMES.has(causeName)) return true;
  }

  // Abort/timeout names are transient — see RETRYABLE_ABORT_NAMES.
  const name = (err as { name?: string }).name;
  if (typeof name === "string" && RETRYABLE_ABORT_NAMES.has(name)) return true;

  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Pull a server-suggested retry delay from the error, if any.
 *
 * Sources we look at, in order:
 *   - `err.retryAfter` as number (seconds — discord.js RateLimitError convention,
 *     even though discord.js handles 429 internally; safety net for any future
 *     leak-through and for cases where wrappers attach this field)
 *   - `err.retryAfterMs` as number (milliseconds — explicit override)
 *
 * Returns null when nothing usable is present. The caller still clamps to
 * maxDelayMs so a hostile / huge value can't pause us forever.
 *
 * Note: Discord 5xx responses do NOT typically include Retry-After, and
 * discord.js's HTTPError shape doesn't expose response headers, so this is
 * primarily defensive — it covers any wrapper that attaches the field.
 */
function retryAfterFromError(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const ms = (err as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return ms;
  const sec = (err as { retryAfter?: unknown }).retryAfter;
  if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) return sec * 1000;
  return null;
}

/**
 * Retry an async operation with jittered exponential backoff.
 * Throws the last error if all attempts fail or if the error is non-retryable.
 */
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseMs = options.baseMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? true;
  const sleep = options.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxAttempts) {
        throw err;
      }
      // Prefer server-suggested retry-after when present (clamped); otherwise
      // jittered exponential backoff.
      const suggested = retryAfterFromError(err);
      let delayMs: number;
      if (suggested !== null) {
        delayMs = Math.min(suggested, maxDelayMs);
      } else {
        const expDelay = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
        delayMs = jitter ? expDelay / 2 + Math.random() * (expDelay / 2) : expDelay;
      }
      options.onRetry?.(attempt, err, delayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable — last iteration always throws — but TypeScript wants a return.
  throw lastErr;
}
