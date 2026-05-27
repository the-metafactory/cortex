/**
 * G-401 + G-501: Cloud Publisher Tests
 * Tests for batched event publishing to the cloud Worker endpoint.
 */

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { CloudPublisher } from "../cloud-publisher";
import type { PublishedEvent } from "../hooks/lib/event-types";
import type { NetworkResolver, NetworkConfig } from "../../../common/types/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "agent.task.started",
    timestamp: new Date().toISOString(),
    session_id: "test-session",
    agent_id: "luna",
    agent_name: "Luna",
    payload: { task: "test" },
    ...overrides,
  };
}

/** G-501: Create a simple single-network resolver for tests */
function createTestNetworkResolver(endpoint: string, apiKey: string, principalId: string): NetworkResolver {
  return (networkId: string | undefined): NetworkConfig | null => {
    return {
      id: networkId ?? "default",
      endpoint,
      apiKey,
      // `NetworkConfig.operatorId` is the TS field name pending R2.I;
      // PR-R2d only renames the JSON wire field on the bus.
      operatorId: principalId,
    };
  };
}

/** Captured fetch calls for assertions. */
let fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchResponses: Response[] = [];
let fetchDelay = 0;

function pushOk() {
  fetchResponses.push(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function pushFail(status = 500) {
  fetchResponses.push(new Response("error", { status }));
}

// Replace global fetch with a mock that records calls
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  fetchDelay = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init: init! });
    if (fetchDelay > 0) {
      await new Promise((r) => setTimeout(r, fetchDelay));
    }
    const resp = fetchResponses.shift();
    if (resp) return resp;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloudPublisher", () => {
  test("constructor accepts config with required fields", () => {
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
    });
    expect(pub).toBeDefined();
    pub.close();
  });

  test("publish() buffers events without immediately sending", async () => {
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000, // long interval so it won't auto-flush
    });

    pub.publish(makeEvent());
    pub.publish(makeEvent());

    // No fetch calls yet -- events are buffered
    expect(fetchCalls.length).toBe(0);
    pub.close();
  });

  test("flush() sends all buffered events as a single batch", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
    });

    pub.publish(makeEvent({ event_id: "e1" }));
    pub.publish(makeEvent({ event_id: "e2" }));

    await pub.flush();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://grove-api.example.com/api/ingest");

    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(body.principal_id).toBe("andreas");
    expect(body.events).toHaveLength(2);

    pub.close();
  });

  test("flush() sends correct Authorization header", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_secret", "andreas"),
      batchIntervalMs: 60_000,
    });

    pub.publish(makeEvent());
    await pub.flush();

    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer grove_sk_secret");
    expect(headers["Content-Type"]).toBe("application/json");

    pub.close();
  });

  test("flush() with empty buffer is a no-op", async () => {
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
    });

    await pub.flush();
    expect(fetchCalls.length).toBe(0);

    pub.close();
  });

  test("batch size limit triggers immediate send", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
      batchSizeLimit: 3,
    });

    pub.publish(makeEvent());
    pub.publish(makeEvent());
    // Third event should trigger flush
    pub.publish(makeEvent());

    // Give the async flush a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(body.events).toHaveLength(3);

    pub.close();
  });

  test("interval-based flush sends buffered events", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 100, // 100ms for fast test
    });

    pub.publish(makeEvent());

    // Wait for interval to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchCalls.length).toBe(1);

    pub.close();
  });

  test("retries on failure with exponential backoff then drops", async () => {
    // 3 failures = all retries exhausted, batch dropped
    pushFail(500);
    pushFail(500);
    pushFail(500);

    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
      maxRetries: 3,
      retryBaseMs: 10, // fast for tests
    });

    pub.publish(makeEvent());
    await pub.flush();

    // Should have attempted 3 times total
    expect(fetchCalls.length).toBe(3);

    pub.close();
  });

  test("retries succeed on second attempt", async () => {
    pushFail(500);  // First attempt fails
    pushOk();       // Second attempt succeeds

    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
      maxRetries: 3,
      retryBaseMs: 10, // fast for tests
    });

    pub.publish(makeEvent());
    await pub.flush();

    // 1 fail + 1 success = 2 calls
    expect(fetchCalls.length).toBe(2);

    pub.close();
  });

  test("close() flushes remaining events then stops interval", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
    });

    pub.publish(makeEvent());
    await pub.close();

    expect(fetchCalls.length).toBe(1);
  });

  test("publish does not throw on network error", async () => {
    // Make fetch throw
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
      maxRetries: 1,
    });

    pub.publish(makeEvent());
    // flush should not throw, just log and drop
    await pub.flush();

    pub.close();
  });

  test("trailing slash on endpoint is normalized", async () => {
    pushOk();
    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
    });

    pub.publish(makeEvent());
    await pub.flush();

    expect(fetchCalls[0]!.url).toBe("https://grove-api.example.com/api/ingest");

    pub.close();
  });

  // ---------------------------------------------------------------------------
  // S-154: Redirect detection + startup health check
  // ---------------------------------------------------------------------------

  test("redirect response (302) is detected and not retried", async () => {
    // Mock returns 302 redirect — simulates stale CF Access endpoint
    fetchResponses.push(new Response(null, {
      status: 302,
      headers: { "Location": "https://auth.cloudflareaccess.com/cdn-cgi/access/login" },
    }));

    const pub = new CloudPublisher({
      networkResolver: createTestNetworkResolver("https://stale-api.example.com", "grove_sk_test123", "andreas"),
      batchIntervalMs: 60_000,
      maxRetries: 3,
      retryBaseMs: 10,
    });

    pub.publish(makeEvent());
    await pub.flush();

    // Should have made exactly 1 fetch call — no retries on redirects
    expect(fetchCalls.length).toBe(1);
    // Verify redirect: "manual" was set
    expect(fetchCalls[0]!.init.redirect).toBe("manual");

    pub.close();
  });

  test("checkEndpoints logs OK for healthy endpoint", async () => {
    // Mock returns 200 for health check
    pushOk();

    const resolver = createTestNetworkResolver("https://grove-api.example.com", "grove_sk_test123", "andreas");
    await CloudPublisher.checkEndpoints(resolver, ["default"]);

    // Should have called /api/health
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://grove-api.example.com/api/health");
    // Should use redirect: "manual"
    expect(fetchCalls[0]!.init.redirect).toBe("manual");
  });

  test("checkEndpoints detects redirect (stale endpoint)", async () => {
    // Mock returns 302 redirect
    fetchResponses.push(new Response(null, {
      status: 302,
      headers: { "Location": "https://auth.cloudflareaccess.com/cdn-cgi/access/login" },
    }));

    const resolver = createTestNetworkResolver("https://stale-api.example.com", "grove_sk_test123", "andreas");
    await CloudPublisher.checkEndpoints(resolver, ["default"]);

    // Should have called /api/health
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://stale-api.example.com/api/health");
  });

  test("checkEndpoints handles timeout/unreachable without throwing", async () => {
    // Make fetch throw (simulates network error / timeout)
    globalThis.fetch = (() => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    const resolver = createTestNetworkResolver("https://unreachable.example.com", "grove_sk_test123", "andreas");

    // Should NOT throw — errors are logged, not propagated
    await CloudPublisher.checkEndpoints(resolver, ["default"]);
  });
});
