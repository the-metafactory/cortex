/**
 * grove-webhook-proxy: HMAC-validating proxy for GitHub webhooks.
 * Tests cover signature validation, header forwarding, replay protection,
 * and error handling.
 *
 * Uses @octokit/webhooks-methods for HMAC generation (same lib as production).
 */

import { describe, test, expect, beforeEach } from "bun:test";
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
}

function makeEnv(overrides: Partial<{ GITHUB_WEBHOOK_SECRET: string }> = {}): TestEnv {
  return {
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? TEST_SECRET,
    GROVE_API: makeMockFetcher(),
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
});
