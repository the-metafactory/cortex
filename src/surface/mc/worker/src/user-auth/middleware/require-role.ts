/**
 * GA-1: requireRole() — role-based authorization middleware.
 * Uses authenticateUser() for auth, then checks role hierarchy.
 * Design: docs/design-auth-aaa.md v2
 */

import type { Context, Next } from "hono";
import type { AuthBindings, Role, UserRecord } from "../types";
import { checkRole } from "../authorize";
import { authenticateUser } from "./require-auth";
import { logAuditEvent, getClientIp } from "./audit";

/**
 * Middleware factory that requires a minimum role level.
 * Authenticates via CF Access JWT + D1 lookup, then checks role hierarchy.
 * Sets c.set("user", userRecord) on success for downstream use.
 *
 * Returns 401 if no CF Access identity or user not provisioned.
 * Returns 403 if user role is below the required minimum.
 */
export function requireRole(minRole: Role) {
  return async function (c: Context<{ Bindings: AuthBindings; Variables: { user: UserRecord } }>, next: Next) {
    const ip = getClientIp(c);
    const endpoint = new URL(c.req.url).pathname;
    const method = c.req.method;

    const auth = await authenticateUser(c.env, c.req);
    if (!auth.ok) {
      logAuditEvent(c.env.CORTEX_DB, {
        eventType: "role_check", result: "failure", ip, endpoint, method,
        identity: auth.email, detail: auth.error,
      });
      return c.json({ error: "authentication required" }, 401);
    }

    const result = checkRole(auth.user.role, minRole);
    if (!result.allowed) {
      logAuditEvent(c.env.CORTEX_DB, {
        eventType: "role_check", result: "failure", ip, endpoint, method,
        identity: auth.email, detail: `insufficient_role: has ${auth.user.role}, needs ${minRole}`,
      });
      return c.json({ error: result.error, required: result.required, current: result.current }, 403);
    }

    logAuditEvent(c.env.CORTEX_DB, {
      eventType: "role_check", result: "success", ip, endpoint, method,
      identity: auth.email, detail: `role=${auth.user.role} meets ${minRole}`,
    });
    c.set("user", auth.user);
    await next();
  };
}
