/**
 * IAW D.4.2 — Capability search.
 *
 *   GET /capabilities?query=<substring>
 *     Capability search across networks. Substring match against
 *     `capability.id` and `capability.description` (case-insensitive).
 *     Response wrapped in a registry-signed assertion. v1 returns
 *     unsorted, unpaginated hits — pagination is a follow-up.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { signAssertion } from "./principals";
import { getStore, searchCapabilities } from "../store";

/** Hard cap on result count so pathological queries don't blow up. */
const MAX_HITS = 500;

export function capabilityRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/capabilities", async (c) => {
    const query = c.req.query("query") ?? "";
    if (query.length === 0) {
      return c.json({ error: "missing required query parameter 'query'" }, 400);
    }
    if (query.length > 128) {
      return c.json({ error: "query parameter too long (max 128 chars)" }, 400);
    }
    const store = getStore();
    const principals = await store.listPrincipals();
    const allHits = searchCapabilities(principals, query);
    const hits = allHits.slice(0, MAX_HITS);
    const assertion = await signAssertion(c.env, { query, hits, truncated: allHits.length > MAX_HITS });
    return c.json(assertion);
  });

  return app;
}
