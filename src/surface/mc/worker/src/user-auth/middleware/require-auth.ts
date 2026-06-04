/**
 * GA-1: requireAuth() — authentication-only middleware.
 * Shared auth logic: CF Access JWT → D1 user lookup → set user.
 * Used directly by authRoutes and internally by requireRole().
 * Design: docs/design-auth-aaa.md v2
 */

import type { Context, Next } from "hono";
import type { AuthBindings, UserRecord } from "../types";
import { getCfAccessEmail } from "./cf-access";
import { logAuditEvent, getClientIp } from "./audit";

/** Look up a user in D1 by email. */
export async function getUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRecord>();
}

/**
 * Authenticate a user via CF Access JWT + D1 lookup.
 * Pure logic — no side effects (no audit logging, no c.set).
 */
export async function authenticateUser(
  env: AuthBindings,
  req: { header(name: string): string | undefined },
): Promise<
  | { ok: true; user: UserRecord; email: string }
  | { ok: false; error: string; email?: string }
> {
  const email = await getCfAccessEmail(env, req);
  if (!email) {
    return { ok: false, error: "no CF Access identity" };
  }
  const user = await getUserByEmail(env.CORTEX_DB, email);
  if (!user) {
    return { ok: false, error: "user not provisioned", email };
  }
  return { ok: true, user, email };
}

/**
 * Middleware that requires authentication via CF Access.
 * Extracts email from CF Access JWT, looks up user in D1.
 * Sets c.set("user", userRecord) on success for downstream use.
 *
 * Returns 401 if no CF Access identity or user not provisioned.
 */
export function requireAuth() {
  return async function (c: Context<{ Bindings: AuthBindings; Variables: { user: UserRecord } }>, next: Next) {
    const ip = getClientIp(c);
    const endpoint = new URL(c.req.url).pathname;
    const method = c.req.method;

    const auth = await authenticateUser(c.env, c.req);
    if (!auth.ok) {
      logAuditEvent(c.env.CORTEX_DB, {
        eventType: "auth", result: "failure", ip, endpoint, method,
        identity: auth.email, detail: auth.error,
      });
      return c.json({ error: "authentication required" }, 401);
    }

    logAuditEvent(c.env.CORTEX_DB, {
      eventType: "auth", result: "success", ip, endpoint, method,
      identity: auth.email,
    });
    c.set("user", auth.user);
    await next();
  };
}
