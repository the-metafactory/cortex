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

/**
 * Local stand-in for the Cloudflare `Fetcher` binding type. The subpackage
 * tsconfig (`src/taps/gh-webhook/tsconfig.json`) loads `@cloudflare/workers-types`
 * which provides a richer `Fetcher`; this local interface lets root tsc
 * type-check the file too (the MIG-5.6 integration test transitively
 * imports `Env` via the Worker entry), without forcing CF types into the
 * root project. Same minimal shape as `Fetcher` for the operations the
 * Worker actually uses.
 */
interface ServiceBindingFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface Env {
  /** GitHub webhook HMAC secret — must match the secret configured on GitHub repos */
  GITHUB_WEBHOOK_SECRET: string;
  /** Service Binding to grove-api Worker — direct Worker-to-Worker tunnel */
  GROVE_API: ServiceBindingFetcher;
  /**
   * MIG-5.6 (cortex#37): optional public URL of the local cortex
   * `gh-webhook-receiver` (typically a tunnel exposing `127.0.0.1:8770`).
   * When set, the Worker forwards each validated webhook to this URL in
   * addition to `GROVE_API` so cortex can publish the
   * `local.{principal}.github.{event}.{action}` envelope onto the bus.
   *
   * Posture:
   *   - The forward is best-effort: a failure here does NOT change the
   *     response returned to GitHub (which always reflects `GROVE_API`'s
   *     status). GitHub never retries on a 2xx; we don't want a transient
   *     cortex-side outage to cause a retry storm against grove-api.
   *   - The cortex receiver re-verifies HMAC, so the forwarded request
   *     carries the original `X-Hub-Signature-256` verbatim — no
   *     re-signing, no shared-secret-between-Workers complexity.
   *   - When unset (empty / undefined), the Worker behaves identically to
   *     the pre-MIG-5.6 path: forward only to grove-api.
   */
  CORTEX_FORWARDER_URL?: string;
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

  // 5b. MIG-5.6 (cortex#37): if a cortex forwarder URL is configured,
  //     additionally fire-and-forget the webhook at the local cortex
  //     receiver so it can publish `local.{principal}.github.{event}.{action}`
  //     onto the bus. Failures are logged but never affect the response
  //     returned to GitHub — `GROVE_API` remains the authoritative store.
  const cortexUrl = c.env.CORTEX_FORWARDER_URL;
  if (cortexUrl) {
    c.executionCtx.waitUntil(
      forwardToCortex(cortexUrl, body, {
        event,
        deliveryId,
        signature,
        contentType: c.req.header("content-type") ?? "application/json",
      }),
    );
  }

  // 6. Return origin's response (preserve status code)
  const respBody = await resp.text();
  return c.text(respBody, resp.status as any);
});

/**
 * Fire-and-forget POST to the cortex local receiver. Awaited via
 * `executionCtx.waitUntil` so the Worker doesn't return before the
 * forward completes, but its outcome never alters the response code.
 *
 * Errors are caught and surfaced via `console.error` so the principal
 * sees them in `wrangler tail`; we deliberately do NOT propagate them.
 */
async function forwardToCortex(
  url: string,
  body: string,
  headers: {
    event: string;
    deliveryId: string;
    signature: string;
    contentType: string;
  },
): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": headers.contentType,
        "X-GitHub-Event": headers.event,
        "X-GitHub-Delivery": headers.deliveryId,
        "X-Hub-Signature-256": headers.signature,
      },
      body,
    });
    if (!resp.ok) {
      console.error(
        `grove-webhook-proxy: cortex forwarder returned non-2xx (status=${resp.status} delivery=${headers.deliveryId})`,
      );
    }
  } catch (err) {
    console.error(
      `grove-webhook-proxy: cortex forwarder fetch failed (delivery=${headers.deliveryId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// 404 fallback
app.notFound((c) => c.text("not found", 404));

export default app;
