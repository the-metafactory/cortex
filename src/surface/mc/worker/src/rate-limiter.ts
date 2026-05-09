/**
 * S-003: Rate Limiting Middleware
 *
 * In-memory sliding window rate limiter for Cloudflare Workers.
 * Counters live in module scope (persist across requests within same isolate,
 * reset on isolate recycling — acceptable for basic abuse protection).
 *
 * For production-grade rate limiting, upgrade to CF Rate Limiting binding.
 */

import type { Context, Next } from "hono";

interface WindowEntry {
  count: number;
  windowStart: number;
}

// Per-IP counters keyed by "category:ip"
const counters = new Map<string, WindowEntry>();

// Cleanup stale entries every 5 minutes (prevents memory leak in long-lived isolates)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

/** Rate limit tiers by endpoint category */
export const RATE_LIMITS = {
  /** Public endpoints: /api/health, /api/pipeline/health */
  public: { windowMs: 60_000, maxRequests: 60 },
  /** Authenticated read endpoints: /api/state, /api/dashboard, /api/repos/*, /api/stats/* */
  read: { windowMs: 60_000, maxRequests: 120 },
  /** Write endpoints: /api/ingest, /api/sync */
  write: { windowMs: 60_000, maxRequests: 300 },
  /** Admin endpoints: /admin/* */
  admin: { windowMs: 60_000, maxRequests: 10 },
} as const;

export type RateLimitCategory = keyof typeof RATE_LIMITS;

function getClientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

function cleanupStaleEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of counters) {
    // Remove entries whose window has fully expired (2x window to be safe)
    if (now - entry.windowStart > 120_000) {
      counters.delete(key);
    }
  }
}

/**
 * Check rate limit for a category + IP combination.
 * Returns { allowed: true } or { allowed: false, retryAfterSec }.
 */
function checkLimit(
  category: RateLimitCategory,
  ip: string,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  cleanupStaleEntries();

  const limit = RATE_LIMITS[category];
  const key = `${category}:${ip}`;
  const now = Date.now();

  const entry = counters.get(key);

  if (!entry || now - entry.windowStart >= limit.windowMs) {
    // New window
    counters.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (entry.count >= limit.maxRequests) {
    const retryAfterSec = Math.ceil((entry.windowStart + limit.windowMs - now) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  entry.count++;
  return { allowed: true };
}

/**
 * Create a Hono middleware that enforces rate limiting for a given category.
 *
 * Usage:
 *   app.use("/api/health", rateLimit("public"));
 *   app.use("/api/state", rateLimit("read"));
 *   app.use("/api/ingest", rateLimit("write"));
 *   app.use("/admin/*", rateLimit("admin"));
 */
export function rateLimit(category: RateLimitCategory) {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const result = checkLimit(category, ip);

    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.json(
        { error: "rate limit exceeded", retry_after_seconds: result.retryAfterSec },
        429,
      );
    }

    // Add rate limit headers for transparency
    const limit = RATE_LIMITS[category];
    c.header("X-RateLimit-Limit", String(limit.maxRequests));
    c.header("X-RateLimit-Window", String(limit.windowMs / 1000));

    await next();
  };
}
