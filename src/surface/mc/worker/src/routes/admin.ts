/**
 * G-400/G-402: Admin endpoints.
 * POST /admin/keys — create an operator API key (ADMIN_SECRET — bootstrap path)
 * DELETE /admin/keys/:key — revoke an API key (ADMIN_SECRET — bootstrap path)
 * GET /admin/audit — query audit log (requireRole("admin") — dashboard path)
 * DELETE /admin/repos/:owner/:name — remove repo records (ADMIN_SECRET — infrastructure)
 *
 * Two auth paths coexist:
 * - ADMIN_SECRET: for machine/bootstrap access (creating first API keys, infra ops)
 * - requireRole("admin"): for dashboard users with CF Access + admin role in D1
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { requireAdmin, type PrincipalKey } from "../auth";
import { requireRole } from "../user-auth";

export const adminRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /admin/keys — Create a new operator API key
// ---------------------------------------------------------------------------

adminRoutes.post("/admin/keys", requireAdmin, async (c) => {
  // PR-R2d renames the request wire field to `principal_id`. The
  // KV-stored `PrincipalKey.principal_id` symbol stays pending PR-R2.D
  // (MC API + auth-type rename — see plan §R2.D). The response wire
  // mirrors the request shape.
  let body: { principal_id: string; name: string };
  try {
    body = await c.req.json<{ principal_id: string; name: string }>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.principal_id || !body.name) {
    return c.json({ error: "principal_id and name are required" }, 400);
  }

  // Generate a key with grove_sk_ prefix + random hex
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  const hex = Array.from(random).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `grove_sk_${hex}`;

  const keyData: PrincipalKey = {
    principal_id: body.principal_id,
    name: body.name,
    created_at: new Date().toISOString(),
  };

  // Store in KV (key as key, metadata as value)
  await c.env.GROVE_KEYS.put(key, JSON.stringify(keyData));

  return c.json({
    key,
    principal_id: keyData.principal_id,
    name: keyData.name,
    created_at: keyData.created_at,
  }, 201);
});

// ---------------------------------------------------------------------------
// S-005: GET /admin/audit — Query recent auth events
// ---------------------------------------------------------------------------

adminRoutes.get("/admin/audit", requireRole("admin"), async (c) => {
  const db = c.env.GROVE_DB;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100"), 500);
  const eventType = c.req.query("type"); // Optional filter: api_key_auth, admin_auth, cf_access_auth
  const resultFilter = c.req.query("result"); // Optional filter: success, failure

  let query = "SELECT * FROM audit_log";
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (eventType) {
    conditions.push("event_type = ?");
    params.push(eventType);
  }
  if (resultFilter) {
    conditions.push("result = ?");
    params.push(resultFilter);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const rows = await db.prepare(query).bind(...params).all();
  return c.json({ entries: rows.results, count: rows.results.length });
});

// ---------------------------------------------------------------------------
// DELETE /admin/keys/:key — Revoke an API key
// ---------------------------------------------------------------------------

adminRoutes.delete("/admin/keys/:key", requireAdmin, async (c) => {
  const key = c.req.param("key") as string;

  if (!key) {
    return c.json({ error: "key parameter required" }, 400);
  }

  // Check if key exists
  const existing = await c.env.GROVE_KEYS.get(key);
  if (!existing) {
    return c.json({ error: "key not found" }, 404);
  }

  await c.env.GROVE_KEYS.delete(key);

  return c.json({ ok: true, revoked: key });
});

// ---------------------------------------------------------------------------
// DELETE /admin/repos/:owner/:name — Remove a repo's D1 records
// ---------------------------------------------------------------------------

adminRoutes.delete("/admin/repos/:owner/:name", requireAdmin, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  if (!owner || !name) {
    return c.json({ error: "owner and name parameters required" }, 400);
  }

  const fullName = `${owner}/${name}`;
  const db = c.env.GROVE_DB;

  // Delete from all tables that reference this repo
  const results = await db.batch([
    db.prepare("DELETE FROM github_events WHERE repo = ?").bind(fullName),
    db.prepare("DELETE FROM issues WHERE repo = ?").bind(fullName),
    db.prepare("DELETE FROM pull_requests WHERE repo = ?").bind(fullName),
    db.prepare("DELETE FROM repos WHERE full_name = ?").bind(fullName),
  ]);

  const deleted = {
    github_events: results[0]?.meta?.changes ?? 0,
    issues: results[1]?.meta?.changes ?? 0,
    pull_requests: results[2]?.meta?.changes ?? 0,
    repos: results[3]?.meta?.changes ?? 0,
  };

  return c.json({ ok: true, repo: fullName, deleted });
});
