/**
 * G-400: GET /api/stats/activity — Activity heatmap data.
 * Returns daily event counts bucketed by source (github/agent) and author.
 * Public endpoint, same contract as local API.
 */

import { Hono } from "hono";
import type { Env } from "../index";

export const statsRoutes = new Hono<{ Bindings: Env }>();

statsRoutes.get("/api/stats/activity", async (c) => {
  const db = c.env.CORTEX_DB;
  const days = Math.min(parseInt(c.req.query("days") ?? "7"), 90);

  const now = new Date();
  const startDate = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  // 4 queries total (not 4×N) — group by date across the entire range
  const [ghRows, sessionRows, authorRows, agentRows] = await Promise.all([
    db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as count
      FROM github_events
      WHERE created_at >= ? AND created_at < ?
      GROUP BY date(created_at)
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(completed_at) as day, COUNT(*) as count
      FROM sessions
      WHERE completed_at >= ? AND completed_at < ?
      GROUP BY date(completed_at)
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(created_at) as day, author, COUNT(*) as count
      FROM github_events
      WHERE created_at >= ? AND created_at < ? AND author IS NOT NULL
      GROUP BY date(created_at), author
    `).bind(startDate, endDate).all(),

    db.prepare(`
      SELECT date(completed_at) as day, agent_name, COUNT(*) as count
      FROM sessions
      WHERE completed_at >= ? AND completed_at < ? AND agent_name IS NOT NULL
      GROUP BY date(completed_at), agent_name
    `).bind(startDate, endDate).all(),
  ]);

  // Build lookup maps from grouped results
  const ghMap = new Map<string, number>();
  for (const row of (ghRows.results ?? [])) {
    ghMap.set(row.day as string, row.count as number);
  }

  const sessionMap = new Map<string, number>();
  for (const row of (sessionRows.results ?? [])) {
    sessionMap.set(row.day as string, row.count as number);
  }

  const authorMap = new Map<string, Record<string, number>>();
  for (const row of (authorRows.results ?? [])) {
    const day = row.day as string;
    if (!authorMap.has(day)) authorMap.set(day, {});
    authorMap.get(day)![row.author as string] = row.count as number;
  }
  for (const row of (agentRows.results ?? [])) {
    const day = row.day as string;
    if (!authorMap.has(day)) authorMap.set(day, {});
    const existing = authorMap.get(day)!;
    const name = row.agent_name as string;
    existing[name] = (existing[name] ?? 0) + (row.count as number);
  }

  // Build result array for all days in range
  const result: Array<{
    day: string;
    github: number;
    agent: number;
    byAuthor: Record<string, number>;
  }> = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const day = d.toISOString().slice(0, 10);
    result.push({
      day,
      github: ghMap.get(day) ?? 0,
      agent: sessionMap.get(day) ?? 0,
      byAuthor: authorMap.get(day) ?? {},
    });
  }

  return c.json({ days: result });
});
