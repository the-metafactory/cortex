import { test, expect, describe } from "bun:test";
import { retryWithBackoff, isRetryableError } from "../retry";

const noSleep = () => Promise.resolve();

describe("isRetryableError", () => {
  test("5xx HTTPError is retryable", () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 599 })).toBe(true);
  });

  test("4xx is not retryable", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 429 })).toBe(false); // discord.js handles 429 internally
  });

  test("network error codes are retryable", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableError({ code: "ENOTFOUND" })).toBe(true);
    expect(isRetryableError({ code: "UND_ERR_SOCKET" })).toBe(true);
  });

  test("less-common transient codes are retryable (DNS flap, undici timeouts, broken pipe)", () => {
    // These are present in RETRYABLE_NETWORK_CODES but were untested — the
    // outage that motivated this PR exercised exactly these named-error paths.
    expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true); // transient DNS
    expect(isRetryableError({ code: "EPIPE" })).toBe(true);
    expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRetryableError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(true);
    expect(isRetryableError({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
    expect(isRetryableError({ code: "UND_ERR_BODY_TIMEOUT" })).toBe(true);
  });

  test("undici-wrapped network error via cause.code is retryable", () => {
    expect(isRetryableError({ message: "fetch failed", cause: { code: "ECONNRESET" } })).toBe(true);
    expect(isRetryableError({ message: "fetch failed", cause: { code: "EAI_AGAIN" } })).toBe(true);
    expect(isRetryableError({ message: "fetch failed", cause: { code: "UND_ERR_BODY_TIMEOUT" } })).toBe(true);
  });

  test("AbortError, TimeoutError, TimeoutSourceError are all retryable", () => {
    expect(isRetryableError({ name: "AbortError" })).toBe(true);
    expect(isRetryableError({ name: "TimeoutError" })).toBe(true);
    // Our wrapper around AbortError — we promote to TimeoutSourceError in
    // fetchWithTimeout to preserve source attribution. The retry helper has
    // to recognise it as transient or composition is broken.
    expect(isRetryableError({ name: "TimeoutSourceError" })).toBe(true);
  });

  test("AbortError surfaced via cause chain is retryable", () => {
    // E.g. a wrapper that decorates a fetch with extra context and stashes the
    // original AbortError as `.cause`.
    expect(isRetryableError({ name: "WrappedFetchError", cause: { name: "AbortError" } })).toBe(true);
    expect(isRetryableError({ name: "WrappedFetchError", cause: { name: "TimeoutError" } })).toBe(true);
  });

  test("plain errors are not retryable", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
    expect(isRetryableError({})).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError("string")).toBe(false);
  });
});

describe("retryWithBackoff", () => {
  test("returns immediately on success", async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      return 42;
    }, { sleep: noSleep });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries on retryable error then succeeds", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) {
          const e = new Error("transient") as Error & { status?: number };
          e.status = 503;
          throw e;
        }
        return "ok";
      },
      { sleep: noSleep, maxAttempts: 5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("gives up after maxAttempts on persistent retryable error", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      const e = new Error("always 500") as Error & { status?: number };
      e.status = 500;
      throw e;
    };
    await expect(
      retryWithBackoff(op, { sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toThrow("always 500");
    expect(calls).toBe(3);
  });

  test("does not retry non-retryable errors", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      const e = new Error("bad request") as Error & { status?: number };
      e.status = 400;
      throw e;
    };
    await expect(retryWithBackoff(op, { sleep: noSleep })).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  test("calls onRetry hook with attempt and delay", async () => {
    const retries: { attempt: number; delayMs: number }[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 2) {
          const e = new Error("once") as Error & { status?: number };
          e.status = 502;
          throw e;
        }
        return "done";
      },
      {
        sleep: noSleep,
        onRetry: (attempt, _err, delayMs) => retries.push({ attempt, delayMs }),
      },
    );
    expect(retries.length).toBe(1);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.delayMs).toBeGreaterThan(0);
  });

  test("delay grows with attempt (no jitter, easy to assert)", async () => {
    const delays: number[] = [];
    let calls = 0;
    const op = async () => {
      calls++;
      const e = new Error("again") as Error & { status?: number };
      e.status = 503;
      throw e;
    };
    await expect(
      retryWithBackoff(op, {
        sleep: async (ms) => {
          delays.push(ms);
        },
        maxAttempts: 4,
        baseMs: 100,
        jitter: false,
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);
  });

  test("respects maxDelayMs cap", async () => {
    const delays: number[] = [];
    const op = async () => {
      const e = new Error("again") as Error & { status?: number };
      e.status = 503;
      throw e;
    };
    await expect(
      retryWithBackoff(op, {
        sleep: async (ms) => { delays.push(ms); },
        maxAttempts: 6,
        baseMs: 1000,
        maxDelayMs: 2500,
        jitter: false,
      }),
    ).rejects.toThrow();
    // attempts: 1000, 2000, 2500 (capped), 2500, 2500
    expect(delays).toEqual([1000, 2000, 2500, 2500, 2500]);
  });

  test("honors err.retryAfterMs (milliseconds) when present, instead of exponential", async () => {
    const delays: number[] = [];
    let calls = 0;
    const op = async () => {
      calls++;
      const e = new Error("server says wait") as Error & {
        status?: number;
        retryAfterMs?: number;
      };
      e.status = 503;
      e.retryAfterMs = 750;
      throw e;
    };
    await expect(
      retryWithBackoff(op, {
        sleep: async (ms) => { delays.push(ms); },
        maxAttempts: 3,
        baseMs: 100,
        maxDelayMs: 5000,
        jitter: false,
      }),
    ).rejects.toThrow("server says wait");
    expect(calls).toBe(3);
    // Both retries should use the server-suggested delay, not exponential.
    expect(delays).toEqual([750, 750]);
  });

  test("honors err.retryAfter (seconds) when present, clamped to maxDelayMs", async () => {
    const delays: number[] = [];
    const op = async () => {
      const e = new Error("retry-after huge") as Error & {
        status?: number;
        retryAfter?: number;
      };
      e.status = 503;
      e.retryAfter = 60; // 60 seconds — way over maxDelayMs
      throw e;
    };
    await expect(
      retryWithBackoff(op, {
        sleep: async (ms) => { delays.push(ms); },
        maxAttempts: 2,
        maxDelayMs: 2_000,
        jitter: false,
      }),
    ).rejects.toThrow();
    // 60s suggestion should be clamped to maxDelayMs.
    expect(delays).toEqual([2_000]);
  });

  test("default maxAttempts and maxDelayMs absorb a multi-second 5xx wobble", async () => {
    // The 2026-05-09 outage post-mortem showed >8s of 5xx wobble. The default
    // budget needs to outlive that; verify it does.
    let calls = 0;
    let totalSlept = 0;
    const op = async () => {
      calls++;
      // Always retryable so we exhaust the default budget.
      const e = new Error("wobble") as Error & { status?: number };
      e.status = 502;
      throw e;
    };
    await expect(
      retryWithBackoff(op, {
        sleep: async (ms) => { totalSlept += ms; },
        // No maxAttempts override — exercise the new default (5).
        jitter: false,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(5);
    // Sum of capped exponential delays at default settings:
    //   500, 1000, 2000, 4000 = 7500ms accumulated wait between 5 attempts.
    // That's > 8s only if the per-call work matters too; the budget is
    // designed to cover the 8.4h outage shape, not a single multi-sec wobble.
    expect(totalSlept).toBeGreaterThan(7_000);
  });
});
