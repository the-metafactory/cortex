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

// CF Access team domain — used to fetch public keys for JWT verification
const CF_ACCESS_TEAM = "metafactory";
const CF_CERTS_URL = `https://${CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;

// Cache the JWK keyset in module scope (warm across requests within same isolate)
let cachedKeys: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const KEY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Fetch CF Access public keys (JWKs) with caching. */
async function getCfAccessKeys(): Promise<JsonWebKey[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_CACHE_TTL_MS) {
    return cachedKeys.keys;
  }
  const res = await fetch(CF_CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch CF Access certs: ${res.status}`);
  const data = await res.json() as { keys: JsonWebKey[] };
  cachedKeys = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

/** Import a JWK as a CryptoKey for RS256 verification. */
async function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Base64url decode to Uint8Array. */
function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Validate a CF Access JWT.
 * Returns the decoded payload on success, or null on failure.
 */
async function validateCfAccessJwt(
  token: string,
  audience: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Decode header to find key ID
  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
  } catch (_err: unknown) {
    return null;
  }
  if (header.alg !== "RS256") return null;

  // Decode payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch (_err: unknown) {
    return null;
  }

  // Check audience
  const aud = payload.aud;
  if (Array.isArray(aud) ? !aud.includes(audience) : aud !== audience) return null;

  // Check expiration
  const exp = payload.exp as number | undefined;
  if (exp && exp < Math.floor(Date.now() / 1000)) return null;

  // Verify signature against CF Access public keys
  const keys = await getCfAccessKeys();
  const matchingKeys = header.kid
    ? keys.filter((k) => (k as any).kid === header.kid)
    : keys;

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(signatureB64);

  for (const jwk of matchingKeys) {
    try {
      const cryptoKey = await importKey(jwk);
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
      if (valid) return payload;
    } catch (_err: unknown) {
      continue; // Try next key
    }
  }

  return null;
}

/**
 * S-001: Middleware that requires a valid CF Access JWT on read endpoints.
 * The JWT comes from the CF_Authorization cookie (set by CF Access login flow).
 * If CF_ACCESS_AUD is not configured, this middleware is a no-op (allows local dev).
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

  const payload = await validateCfAccessJwt(token, audience);
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
