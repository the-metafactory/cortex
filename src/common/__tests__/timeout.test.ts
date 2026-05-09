import { test, expect, describe } from "bun:test";
import { TimeoutSourceError, withTimeoutContext, fetchWithTimeout } from "../timeout";

describe("withTimeoutContext", () => {
  test("passes through normal resolved values", async () => {
    const result = await withTimeoutContext(
      "attachment_fetch",
      1000,
      Date.now(),
      Promise.resolve("ok"),
    );
    expect(result).toBe("ok");
  });

  test("passes through non-AbortError rejections unchanged", async () => {
    const original = new Error("not a timeout");
    await expect(
      withTimeoutContext("usage_monitor", 100, Date.now(), Promise.reject(original)),
    ).rejects.toBe(original);
  });

  test("rewrites AbortError into TimeoutSourceError with source + elapsed", async () => {
    const start = Date.now() - 250;
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    let caught: unknown = null;
    try {
      await withTimeoutContext("attachment_fetch", 30_000, start, Promise.reject(abort));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TimeoutSourceError);
    const tse = caught as TimeoutSourceError;
    expect(tse.source).toBe("attachment_fetch");
    expect(tse.timeoutMs).toBe(30_000);
    expect(tse.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(tse.message).toContain("attachment_fetch aborted after");
    expect(tse.message).toContain("timeout 30000ms");
    expect((tse as { cause?: unknown }).cause).toBe(abort);
  });

  test("rewrites TimeoutError (which AbortSignal.timeout actually emits) the same way", async () => {
    const start = Date.now();
    const abort = new Error("timeout");
    abort.name = "TimeoutError";
    await expect(
      withTimeoutContext("cloud_publisher", 5_000, start, Promise.reject(abort)),
    ).rejects.toBeInstanceOf(TimeoutSourceError);
  });
});

describe("fetchWithTimeout — integration with real AbortSignal.timeout", () => {
  test("aborts a slow fetch with TimeoutSourceError carrying the named source", async () => {
    // Spin up an HTTP server on an ephemeral port that never responds
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 5_000)); // longer than client timeout
        return new Response("late");
      },
    });
    try {
      const url = `http://localhost:${server.port}/`;
      let caught: unknown = null;
      try {
        await fetchWithTimeout("usage_monitor", 50, url);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TimeoutSourceError);
      const tse = caught as TimeoutSourceError;
      expect(tse.source).toBe("usage_monitor");
      expect(tse.timeoutMs).toBe(50);
      expect(tse.message).toContain("usage_monitor aborted after");
    } finally {
      server.stop(true);
    }
  });

  test("passes through a successful fetch unchanged", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() { return new Response("hi"); },
    });
    try {
      const url = `http://localhost:${server.port}/`;
      const res = await fetchWithTimeout("usage_monitor", 5_000, url);
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("hi");
    } finally {
      server.stop(true);
    }
  });
});
