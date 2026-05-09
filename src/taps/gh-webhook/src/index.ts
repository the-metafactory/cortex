/**
 * grove-webhook-proxy: Edge proxy for GitHub webhook delivery.
 *
 * Sits at hooks.meta-factory.ai (public, no CF Access). Receives GitHub
 * webhooks, validates HMAC-SHA256 signature, deduplicates by X-GitHub-Delivery,
 * then forwards valid requests to grove-api via Worker Service Binding.
 *
 * Flow:
 *   GitHub POST → grove-webhook-proxy (public)
 *     → Validate required headers
 *     → Validate HMAC-SHA256 signature
 *     → Check replay (X-GitHub-Delivery dedup, 5-min window)
 *     → Forward to grove-api via Service Binding (private Worker-to-Worker tunnel)
 *     → Return origin's response
 *
 * Security model:
 *   - No CF Access bypass policies needed — zero bypass
 *   - HMAC is the auth layer at the edge
 *   - Service Binding provides private, internal-only connection to grove-api
 *     (bypasses zone pipeline entirely — no network hop, no DNS, no CF Access needed)
 *   - grove-api still validates HMAC as defense-in-depth
 */

import { Hono } from "hono";
import { verify } from "@octokit/webhooks-methods";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  /** GitHub webhook HMAC secret — must match the secret configured on GitHub repos */
  GITHUB_WEBHOOK_SECRET: string;
  /** Service Binding to grove-api Worker — direct Worker-to-Worker tunnel */
  GROVE_API: Fetcher;
}

// ---------------------------------------------------------------------------
// Replay protection: in-memory LRU of recent delivery IDs
// Keeps last 5 minutes of deliveries to prevent replay attacks.
// In-memory is acceptable: Workers handle ~1 delivery/sec max, and a restart
// just means a brief window where replays could succeed (GitHub doesn't retry
// on 200, so this is defense-in-depth only).
// ---------------------------------------------------------------------------

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DELIVERY_CACHE = 1000;

const recentDeliveries = new Map<string, number>();

/** Exported for test cleanup — clears the in-memory delivery dedup cache. */
export function _resetDeliveryCache(): void {
  recentDeliveries.clear();
}

function isReplayDelivery(deliveryId: string): boolean {
  const now = Date.now();

  // Prune expired entries (lazy cleanup)
  if (recentDeliveries.size > MAX_DELIVERY_CACHE / 2) {
    for (const [id, ts] of recentDeliveries) {
      if (now - ts > REPLAY_WINDOW_MS) {
        recentDeliveries.delete(id);
      }
    }
  }

  if (recentDeliveries.has(deliveryId)) {
    const ts = recentDeliveries.get(deliveryId)!;
    if (now - ts < REPLAY_WINDOW_MS) {
      return true; // Duplicate within window
    }
  }

  recentDeliveries.set(deliveryId, now);

  // Hard cap: if we somehow exceed max, drop oldest entries
  if (recentDeliveries.size > MAX_DELIVERY_CACHE) {
    const oldest = recentDeliveries.keys().next().value;
    if (oldest) recentDeliveries.delete(oldest);
  }

  return false;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Health check — public, no auth
app.get("/health", (c) => c.json({ status: "ok", service: "grove-webhook-proxy" }));

// GitHub webhook proxy
app.post("/github", async (c) => {
  // 1. Validate configuration
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return c.text("not configured", 503);
  }

  // 2. Validate required GitHub headers
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const event = c.req.header("x-github-event") ?? "";
  const deliveryId = c.req.header("x-github-delivery") ?? "";

  if (!signature || !event || !deliveryId) {
    return c.text("missing headers", 400);
  }

  // 3. Read body and validate HMAC-SHA256 signature
  const body = await c.req.text();
  try {
    const valid = await verify(secret, body, signature);
    if (!valid) {
      return c.text("unauthorized", 401);
    }
  } catch (_err: unknown) {
    // verify() throws on malformed signatures (e.g. non-hex)
    return c.text("unauthorized", 401);
  }

  // 4. Replay protection: reject duplicate delivery IDs
  if (isReplayDelivery(deliveryId)) {
    return c.text("duplicate delivery", 409);
  }

  // 5. Forward to grove-api via Service Binding (Worker-to-Worker, no network hop)
  const resp = await c.env.GROVE_API.fetch(
    new Request("https://grove-api/api/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": c.req.header("content-type") ?? "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": signature,
      },
      body,
    }),
  );

  // 6. Return origin's response (preserve status code)
  const respBody = await resp.text();
  return c.text(respBody, resp.status as any);
});

// 404 fallback
app.notFound((c) => c.text("not found", 404));

export default app;
