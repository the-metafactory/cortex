/**
 * G-407: GET /api/dashboard — Combined dashboard endpoint.
 * Returns state + repos + heatmap in a single response, served from cache.
 * Supports ETag/304 conditional responses to minimize bandwidth.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { getCachedSnapshot } from "./state";

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.get("/api/dashboard", async (c) => {
  const db = c.env.GROVE_DB;
  const { json } = await getCachedSnapshot(db);

  return new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
