/**
 * grove-webhook-proxy: HMAC-validating proxy for GitHub webhooks.
 * Tests cover signature validation, header forwarding, replay protection,
 * and error handling.
 *
 * Uses @octokit/webhooks-methods for HMAC generation (same lib as production).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
import app from "../src/index";
import { _resetDeliveryCache } from "../src/index";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret-1234";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let fetchCalls: FetchCall[] = [];
let fetchResponseStatus = 200;
let fetchResponseBody = "ok";

/** Mock Fetcher that records calls (simulates the GROVE_API service binding) */
function makeMockFetcher(): Fetcher {
  return {
    fetch: async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      let url: string;
      let method = "GET";
      const headers: Record<string, string> = {};
      let body = "";

      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        url = input.url;
        method = input.method;
        for (const [k, v] of input.headers.entries()) {
          headers[k] = v;
        }
        body = await input.text();
      }

      if (init) {
        if (init.method) method = init.method;
        if (init.headers) {
          const h = init.headers as Record<string, string>;
          for (const [k, v] of Object.entries(h)) {
            headers[k] = v;
          }
        }
        if (init.body) body = typeof init.body === "string" ? init.body : "";
      }

      fetchCalls.push({ url, method, headers, body });
      return new Response(fetchResponseBody, { status: fetchResponseStatus });
    },
    connect: () => { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

interface TestEnv {
  GITHUB_WEBHOOK_SECRET: string;
  GROVE_API: Fetcher;
  CORTEX_FORWARDER_URL?: string;
}

function makeEnv(
  overrides: Partial<{
    GITHUB_WEBHOOK_SECRET: string;
    CORTEX_FORWARDER_URL: string;
  }> = {},
): TestEnv {
  const env: TestEnv = {
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? TEST_SECRET,
    GROVE_API: makeMockFetcher(),
  };
  if (overrides.CORTEX_FORWARDER_URL !== undefined) {
    env.CORTEX_FORWARDER_URL = overrides.CORTEX_FORWARDER_URL;
  }
  return env;
}

/**
 * Minimal `ExecutionContext` stand-in for tests that exercise the
 * cortex-forwarder branch. `waitUntil` resolves the supplied promise so the
 * test can await fan-out before assertions; `passThroughOnException` is a
 * no-op (the production Worker doesn't call it on the happy path).
 *
 * Returns `{ ctx, waitForFanout }` — `waitForFanout()` awaits every
 * promise that was passed to `waitUntil` since construction so a test can
 * assert on the side effects of the fire-and-forget forward.
 */
function makeExecutionCtx(): {
  ctx: ExecutionContext;
  waitForFanout: () => Promise<void>;
} {
  const pending: Array<Promise<unknown>> = [];
  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
    passThroughOnException(): void {
      /* no-op in tests */
    },
    props: {},
  };
  return {
    ctx,
    waitForFanout: async () => {
      // Drain all pending promises; new ones may be pushed during await
      // so we loop until the buffer is empty.
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.allSettled(batch);
      }
    },
  };
}

async function makeWebhookRequest(
  body: string,
  options: {
    secret?: string;
    event?: string;
    deliveryId?: string;
    skipSignature?: boolean;
    skipEvent?: boolean;
    skipDelivery?: boolean;
    tamperSignature?: string;
  } = {},
): Promise<Request> {
  const secret = options.secret ?? TEST_SECRET;
  const event = options.event ?? "push";
  const deliveryId = options.deliveryId ?? `delivery-${Math.random().toString(36).slice(2)}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (!options.skipSignature) {
    const sig = options.tamperSignature ?? (await sign(secret, body));
    headers["X-Hub-Signature-256"] = sig;
  }
  if (!options.skipEvent) {
    headers["X-GitHub-Event"] = event;
  }
  if (!options.skipDelivery) {
    headers["X-GitHub-Delivery"] = deliveryId;
  }

  return new Request("http://localhost/github", {
    method: "POST",
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grove-webhook-proxy", () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchResponseStatus = 200;
    fetchResponseBody = "ok";
    _resetDeliveryCache();
  });

  // -----------------------------------------------------------------------
  // Health endpoint
  // -----------------------------------------------------------------------

  describe("GET /health", () => {
    test("returns ok with service name", async () => {
      const req = new Request("http://localhost/health");
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(200);
      const json = await res.json() as { status: string; service: string };
      expect(json.status).toBe("ok");
      expect(json.service).toBe("grove-webhook-proxy");
    });
  });

  // -----------------------------------------------------------------------
  // Missing headers -> 400
  // -----------------------------------------------------------------------

  describe("missing headers", () => {
    test("returns 400 when X-Hub-Signature-256 is missing", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { skipSignature: true });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("missing headers");
    });

    test("returns 400 when X-GitHub-Event is missing", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { skipEvent: true });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("missing headers");
    });

    test("returns 400 when X-GitHub-Delivery is missing", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { skipDelivery: true });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("missing headers");
    });
  });

  // -----------------------------------------------------------------------
  // HMAC signature validation
  // -----------------------------------------------------------------------

  describe("HMAC validation", () => {
    test("returns 401 for invalid signature", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, {
        tamperSignature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("unauthorized");
    });

    test("returns 401 for wrong secret", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { secret: "wrong-secret" });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("unauthorized");
    });

    test("accepts valid HMAC signature", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body);
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Forwarding behavior (via Service Binding)
  // -----------------------------------------------------------------------

  describe("forwarding", () => {
    test("forwards to grove-api via service binding with correct headers", async () => {
      const body = JSON.stringify({ action: "opened", repository: { full_name: "the-metafactory/grove" } });
      const req = await makeWebhookRequest(body, { event: "issues", deliveryId: "delivery-fwd-001" });
      const res = await app.fetch(req, makeEnv());

      expect(res.status).toBe(200);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.url).toBe("https://grove-api/api/github/webhook");

      const headers = fetchCalls[0]!.headers;
      expect(headers["x-github-event"]).toBe("issues");
      expect(headers["x-github-delivery"]).toBe("delivery-fwd-001");
      expect(headers["x-hub-signature-256"]).toBeTruthy();
      expect(headers["content-type"]).toBe("application/json");
    });

    test("forwards the original body unchanged", async () => {
      const body = JSON.stringify({ action: "opened", number: 42 });
      const req = await makeWebhookRequest(body, { deliveryId: "delivery-body-001" });
      await app.fetch(req, makeEnv());

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.body).toBe(body);
    });

    test("returns origin response status code", async () => {
      fetchResponseStatus = 500;
      fetchResponseBody = "processing error";
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { deliveryId: "delivery-500-001" });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // Configuration errors
  // -----------------------------------------------------------------------

  describe("configuration errors", () => {
    test("returns 503 when GITHUB_WEBHOOK_SECRET is missing", async () => {
      const body = JSON.stringify({ action: "opened" });
      const sig = await sign(TEST_SECRET, body);
      const req = new Request("http://localhost/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sig,
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "d-1",
        },
        body,
      });
      const res = await app.fetch(req, makeEnv({ GITHUB_WEBHOOK_SECRET: "" }));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("not configured");
    });
  });

  // -----------------------------------------------------------------------
  // 404 for unknown routes
  // -----------------------------------------------------------------------

  describe("unknown routes", () => {
    test("returns 404 for GET /", async () => {
      const req = new Request("http://localhost/");
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(404);
    });

    test("returns 404 for POST /unknown", async () => {
      const req = new Request("http://localhost/unknown", { method: "POST" });
      const res = await app.fetch(req, makeEnv());
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Replay protection (delivery ID dedup)
  // -----------------------------------------------------------------------

  describe("replay protection", () => {
    test("rejects duplicate X-GitHub-Delivery within window", async () => {
      const body = JSON.stringify({ action: "opened" });
      const deliveryId = "replay-test-001";

      // First request — should succeed
      const req1 = await makeWebhookRequest(body, { deliveryId });
      const res1 = await app.fetch(req1, makeEnv());
      expect(res1.status).toBe(200);

      // Second request with same delivery ID — should be rejected
      const req2 = await makeWebhookRequest(body, { deliveryId });
      const res2 = await app.fetch(req2, makeEnv());
      expect(res2.status).toBe(409);
      expect(await res2.text()).toBe("duplicate delivery");
    });

    test("accepts different delivery IDs", async () => {
      const body = JSON.stringify({ action: "opened" });

      const req1 = await makeWebhookRequest(body, { deliveryId: "unique-001" });
      const res1 = await app.fetch(req1, makeEnv());
      expect(res1.status).toBe(200);

      const req2 = await makeWebhookRequest(body, { deliveryId: "unique-002" });
      const res2 = await app.fetch(req2, makeEnv());
      expect(res2.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // MIG-5.6 (cortex#37): CORTEX_FORWARDER_URL — additional forward to the
  // local cortex receiver so it can publish onto the bus.
  // -----------------------------------------------------------------------

  describe("cortex forwarder (MIG-5.6)", () => {
    // The forwarder uses global `fetch` (cortex isn't a Service Binding —
    // it's accessed via a public/tunnel URL). Stub it for these tests.
    let originalFetch: typeof fetch;
    let cortexFetchCalls: FetchCall[];
    let cortexFetchStatus: number;

    beforeEach(() => {
      cortexFetchCalls = [];
      cortexFetchStatus = 200;
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        // Only intercept calls to the test forwarder URL — other fetches
        // (none expected in these tests) flow through to the real fetch.
        if (url.startsWith("https://cortex-forwarder.test")) {
          const headers: Record<string, string> = {};
          if (init?.headers) {
            for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
              headers[k.toLowerCase()] = v;
            }
          }
          cortexFetchCalls.push({
            url,
            method: init?.method ?? "GET",
            headers,
            body: typeof init?.body === "string" ? init.body : "",
          });
          return new Response("ok", { status: cortexFetchStatus });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("forwards to CORTEX_FORWARDER_URL when set, preserving headers + body", async () => {
      const body = JSON.stringify({
        action: "opened",
        repository: { full_name: "the-metafactory/cortex" },
      });
      const req = await makeWebhookRequest(body, {
        event: "issues",
        deliveryId: "fwd-cortex-001",
      });
      const env = makeEnv({
        CORTEX_FORWARDER_URL: "https://cortex-forwarder.test/internal/webhook",
      });
      const { ctx, waitForFanout } = makeExecutionCtx();
      const res = await app.fetch(req, env, ctx);
      await waitForFanout();

      expect(res.status).toBe(200);
      // grove-api still received the call (existing path unchanged).
      expect(fetchCalls.length).toBe(1);
      // cortex receiver got a parallel forward with the same headers + body.
      expect(cortexFetchCalls.length).toBe(1);
      const cortexCall = cortexFetchCalls[0]!;
      expect(cortexCall.url).toBe("https://cortex-forwarder.test/internal/webhook");
      expect(cortexCall.method).toBe("POST");
      expect(cortexCall.headers["x-github-event"]).toBe("issues");
      expect(cortexCall.headers["x-github-delivery"]).toBe("fwd-cortex-001");
      expect(cortexCall.headers["x-hub-signature-256"]).toBeTruthy();
      expect(cortexCall.body).toBe(body);
    });

    test("does NOT forward when CORTEX_FORWARDER_URL is unset", async () => {
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { deliveryId: "fwd-cortex-002" });
      const { ctx, waitForFanout } = makeExecutionCtx();
      const res = await app.fetch(req, makeEnv(), ctx);
      await waitForFanout();
      expect(res.status).toBe(200);
      expect(cortexFetchCalls.length).toBe(0);
    });

    test("forwarder 5xx response does not affect the proxy's response", async () => {
      cortexFetchStatus = 503;
      const body = JSON.stringify({ action: "opened" });
      const req = await makeWebhookRequest(body, { deliveryId: "fwd-cortex-003" });
      const env = makeEnv({
        CORTEX_FORWARDER_URL: "https://cortex-forwarder.test/internal/webhook",
      });
      const { ctx, waitForFanout } = makeExecutionCtx();
      const res = await app.fetch(req, env, ctx);
      await waitForFanout();
      // Proxy returns the grove-api status, not the cortex one.
      expect(res.status).toBe(200);
      expect(cortexFetchCalls.length).toBe(1);
    });

    test("forwarder thrown error is logged but does not affect response", async () => {
      const errors: string[] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        // Override global fetch to throw for the cortex URL specifically.
        const originalFetchInner = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          if (url.startsWith("https://cortex-forwarder.test")) {
            throw new Error("connection refused");
          }
          return originalFetchInner(input, init);
        }) as typeof fetch;

        const body = JSON.stringify({ action: "opened" });
        const req = await makeWebhookRequest(body, { deliveryId: "fwd-cortex-004" });
        const env = makeEnv({
          CORTEX_FORWARDER_URL: "https://cortex-forwarder.test/internal/webhook",
        });
        const { ctx, waitForFanout } = makeExecutionCtx();
        const res = await app.fetch(req, env, ctx);
        await waitForFanout();

        expect(res.status).toBe(200);
        expect(errors.some((e) => e.includes("cortex forwarder fetch failed"))).toBe(true);
      } finally {
        console.error = origConsoleError;
      }
    });
  });
});
