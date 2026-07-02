/**
 * G-400/G-402: API Key Authentication Middleware
 * Validates Bearer tokens against Workers KV.
 * Keys are stored as: key => { principal_id, name, created_at }
 *
 * S-001: CF Access JWT validation for read endpoints.
 * Dashboard users authenticate via CF Access; the JWT is passed as CF_Authorization cookie.
 * Worker validates the JWT signature against CF's public key endpoint.
 */

import type { Context, Next } from "hono";
import type { Env } from "./index";
import { verifyCfAccessJwt } from "../../../../common/auth/cf-access-jwt";

// =============================================================================
// S-005: Audit Logging
// =============================================================================

/** Log an auth event to D1 audit_log table. Fire-and-forget (non-blocking). */
function logAuditEvent(
  db: D1Database,
  event: {
    eventType: string;
    result: "success" | "failure";
    ip: string;
    endpoint: string;
    method: string;
    identity?: string;
    detail?: string;
  },
): void {
  // Fire-and-forget — don't block the request on audit writes
  db.prepare(`
    INSERT INTO audit_log (event_type, result, ip, endpoint, method, identity, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventType,
    event.result,
    event.ip,
    event.endpoint,
    event.method,
    event.identity ?? null,
    event.detail ?? null,
  ).run().catch((_err: unknown) => {
    // Audit log write failures should not break the request — best-effort logging
  });
}

function getClientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

export interface PrincipalKey {
  principal_id: string;
  name: string;
  created_at: string;
}

/**
 * Middleware that validates the Authorization: Bearer header against KV.
 * On success, sets c.set("principalId", ...) and c.set("principalKey", ...).
 * On failure, returns 401.
 */
export async function requireApiKey(c: Context<{ Bindings: Env; Variables: { principalId: string; principalKey: PrincipalKey } }>, next: Next) {
  const ip = getClientIp(c);
  const endpoint = new URL(c.req.url).pathname;
  const method = c.req.method;
  const auth = c.req.header("Authorization");

  if (!auth || !auth.startsWith("Bearer ")) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "api_key_auth", result: "failure", ip, endpoint, method, detail: "missing bearer header" });
    return c.json({ error: "missing Authorization: Bearer header" }, 401);
  }

  const token = auth.slice(7);
  if (!token) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "api_key_auth", result: "failure", ip, endpoint, method, detail: "empty token" });
    return c.json({ error: "empty bearer token" }, 401);
  }

  const keyData = await c.env.CORTEX_KEYS.get(token, "json") as PrincipalKey | null;
  if (!keyData) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "api_key_auth", result: "failure", ip, endpoint, method, detail: "invalid or revoked key" });
    return c.json({ error: "invalid or revoked API key" }, 401);
  }

  // Single-cut (cortex#436 §2): keys must carry `principal_id`. No empty/legacy
  // fallback — a key missing it fails closed rather than authenticating with an
  // empty principal that ingest would then trust as the attribution identity.
  const principalId = keyData.principal_id;
  if (!principalId) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "api_key_auth", result: "failure", ip, endpoint, method, detail: "key missing principal_id" });
    return c.json({ error: "API key missing principal identity" }, 401);
  }
  logAuditEvent(c.env.CORTEX_DB, { eventType: "api_key_auth", result: "success", ip, endpoint, method, identity: principalId });
  c.set("principalId", principalId);
  c.set("principalKey", keyData);
  await next();
}

/**
 * Middleware that validates the admin secret from the ADMIN_SECRET env var.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const ip = getClientIp(c);
  const endpoint = new URL(c.req.url).pathname;
  const method = c.req.method;
  const auth = c.req.header("Authorization");

  if (!auth || !auth.startsWith("Bearer ")) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "admin_auth", result: "failure", ip, endpoint, method, detail: "missing bearer header" });
    return c.json({ error: "missing Authorization: Bearer header" }, 401);
  }

  const token = auth.slice(7);
  const adminSecret = c.env.ADMIN_SECRET;
  if (!adminSecret || token !== adminSecret) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "admin_auth", result: "failure", ip, endpoint, method, detail: "invalid admin secret" });
    return c.json({ error: "unauthorized" }, 403);
  }

  logAuditEvent(c.env.CORTEX_DB, { eventType: "admin_auth", result: "success", ip, endpoint, method, identity: "admin" });
  await next();
}

// =============================================================================
// S-001: CF Access JWT Validation
// =============================================================================

// CF Access team domain — used to fetch public keys for JWT verification.
const CF_ACCESS_TEAM = "metafactory";

/**
 * S-001: Middleware that requires a valid CF Access JWT on read endpoints.
 * The JWT comes from the CF_Authorization cookie (set by CF Access login flow).
 * If CF_ACCESS_AUD is not configured, this middleware is a no-op (allows local dev).
 *
 * cortex#1410: signature/claims verification is delegated to the shared,
 * runtime-agnostic verifier (`src/common/auth/cf-access-jwt.ts`) — which now
 * also checks `iss` + `nbf`/`iat` and requires `exp` — instead of the private
 * copy that used to live here.
 */
export async function requireCfAccess(c: Context<{ Bindings: Env; Variables: { cfAccessEmail: string } }>, next: Next) {
  const audience = c.env.CF_ACCESS_AUD;

  // If no audience configured, skip validation (local dev / not yet set up)
  if (!audience) {
    await next();
    return;
  }

  const ip = getClientIp(c);
  const endpoint = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Check CF_Authorization cookie
  const cookie = c.req.header("Cookie") ?? "";
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  const token = match?.[1];

  if (!token) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "cf_access_auth", result: "failure", ip, endpoint, method, detail: "no CF_Authorization cookie" });
    return c.json({ error: "authentication required" }, 403);
  }

  const payload = await verifyCfAccessJwt(token, { aud: audience, teamDomain: CF_ACCESS_TEAM });
  if (!payload) {
    logAuditEvent(c.env.CORTEX_DB, { eventType: "cf_access_auth", result: "failure", ip, endpoint, method, detail: "invalid or expired JWT" });
    return c.json({ error: "invalid or expired access token" }, 403);
  }

  // Attach identity to context for downstream use
  const email = (payload.email as string) ?? "unknown";
  logAuditEvent(c.env.CORTEX_DB, { eventType: "cf_access_auth", result: "success", ip, endpoint, method, identity: email });
  c.set("cfAccessEmail", email);
  await next();
}
