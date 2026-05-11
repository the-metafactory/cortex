/**
 * Tests for the shared `fetchBotUserId` helper (MIG-7.2c-mattermost).
 *
 * The helper is the consolidation point for what used to be three
 * near-identical inline `/api/v4/users/me` fetches (Holly W1 carry-from
 * cortex#45). Its load-bearing surface:
 *
 *   - throws on non-OK HTTP responses, tagged with the instanceId
 *   - throws on a 200 with a body that omits `id`
 *   - honours the configurable timeout via `AbortSignal.timeout`
 *   - returns the raw user id on success
 *
 * Each caller wraps the helper differently — adapter.getPlatformUserId
 * lets the throw propagate (PresenceBinding contract), poller wraps in
 * try/catch and returns null, notifyOperator inherits getPlatformUserId's
 * caching. Pinning the helper's contract here means future changes can't
 * silently relax those guarantees.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { fetchBotUserId } from "../bot-user";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

describe("fetchBotUserId", () => {
  test("returns the user id on a 200 response with an `id` field", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ id: "u-bot-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const id = await fetchBotUserId("https://mm.example", "test-token");
    expect(id).toBe("u-bot-123");
  });

  test("sends the bearer-token Authorization header", async () => {
    let captured: HeadersInit | undefined;
    stubFetch(async (_url, init) => {
      captured = init?.headers;
      return new Response(JSON.stringify({ id: "u-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await fetchBotUserId("https://mm.example", "secret-token");
    expect(captured).toEqual({ Authorization: "Bearer secret-token" });
  });

  test("requests the /api/v4/users/me path off the supplied apiUrl (strips trailing slash)", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ id: "u-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    // Trailing slash gets normalised so the path joins cleanly without
    // double-slash artefacts in the request URL (Holly cycle 2 nit).
    await fetchBotUserId("https://mm.example/", "t");
    expect(capturedUrl).toBe("https://mm.example/api/v4/users/me");
  });

  test("handles apiUrl WITHOUT a trailing slash identically", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ id: "u-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await fetchBotUserId("https://mm.example", "t");
    expect(capturedUrl).toBe("https://mm.example/api/v4/users/me");
  });

  test("throws a tagged error on a non-OK HTTP response", async () => {
    stubFetch(async () =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      fetchBotUserId("https://mm.example", "bad-token", { instanceId: "mm-test" }),
    ).rejects.toThrow(/mattermost-adapter\[mm-test\]: GET \/api\/v4\/users\/me failed with HTTP 403 Forbidden/);
  });

  test("throws a generic-tagged error when no instanceId is supplied", async () => {
    stubFetch(async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(
      fetchBotUserId("https://mm.example", "t"),
    ).rejects.toThrow(/^mattermost: GET/);
  });

  test("throws a tagged error when /users/me returns 200 but omits the id field", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ username: "no-id-here" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      fetchBotUserId("https://mm.example", "t", { instanceId: "mm-test" }),
    ).rejects.toThrow(/mattermost-adapter\[mm-test\]: \/api\/v4\/users\/me returned no id field/);
  });

  test("aborts the fetch after the timeout elapses", async () => {
    // Stub fetch to honour the AbortSignal — resolve only when the signal aborts.
    stubFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    });
    const start = Date.now();
    await expect(
      fetchBotUserId("https://mm.example", "t", { timeoutMs: 50 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // 50ms timeout — allow up to ~250ms for scheduling / runtime jitter.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(250);
  });
});
