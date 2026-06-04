/**
 * G-400: Repo, issue, and PR endpoints.
 * GET /api/repos — list repos with issue/PR counts
 * GET /api/repos/:name/issues — issues for a repo
 * GET /api/repos/:name/pulls — PRs for a repo
 * GET /api/repos/:name/pulls/:n/comments — PR comments (from D1 events)
 *
 * All public (no auth) — same as local dashboard API.
 */

import { Hono } from "hono";
import type { Env } from "../index";

export const repoRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/repos
// ---------------------------------------------------------------------------

repoRoutes.get("/api/repos", async (c) => {
  const db = c.env.CORTEX_DB;

  const { results } = await db.prepare(`
    SELECT r.full_name, r.short_name, r.description, r.default_branch, r.synced_at,
           COALESCE(i.open_count, 0) AS open_issues,
           COALESCE(p.open_count, 0) AS open_prs
    FROM repos r
    LEFT JOIN (SELECT repo, COUNT(*) AS open_count FROM issues WHERE state = 'open' GROUP BY repo) i
      ON i.repo = r.full_name
    LEFT JOIN (SELECT repo, COUNT(*) AS open_count FROM pull_requests WHERE state = 'open' GROUP BY repo) p
      ON p.repo = r.full_name
    ORDER BY r.short_name
  `).all();

  const repos = (results ?? []).map((r: Record<string, unknown>) => ({
    fullName: r.full_name as string,
    shortName: r.short_name as string,
    description: r.description as string | null,
    defaultBranch: r.default_branch as string | null,
    openIssues: r.open_issues as number,
    openPRs: r.open_prs as number,
    syncedAt: r.synced_at as string,
  }));

  return c.json({ repos });
});

// ---------------------------------------------------------------------------
// GET /api/repos/:name/issues
// ---------------------------------------------------------------------------

repoRoutes.get("/api/repos/:name/issues", async (c) => {
  const db = c.env.CORTEX_DB;
  const repoName = c.req.param("name");
  const state = c.req.query("state") as "open" | "closed" | undefined;

  let sql = `
    SELECT id, repo, number, title, body, state, author, labels,
           created_at, updated_at, closed_at
    FROM issues
    WHERE (repo = ? OR SUBSTR(repo, INSTR(repo, '/') + 1) = ?)
  `;
  const params: unknown[] = [repoName, repoName];

  if (state) {
    sql += ` AND state = ?`;
    params.push(state);
  }

  sql += ` ORDER BY number DESC`;

  const { results } = await db.prepare(sql).bind(...params).all();

  const issues = (results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as number,
    repo: r.repo as string,
    number: r.number as number,
    title: r.title as string,
    body: r.body as string | null,
    state: r.state as "open" | "closed",
    author: r.author as string | null,
    labels: r.labels as string | null,
    createdAt: r.created_at as string | null,
    updatedAt: r.updated_at as string | null,
    closedAt: r.closed_at as string | null,
  }));

  return c.json({ issues });
});

// ---------------------------------------------------------------------------
// GET /api/repos/:name/pulls
// ---------------------------------------------------------------------------

repoRoutes.get("/api/repos/:name/pulls", async (c) => {
  const db = c.env.CORTEX_DB;
  const repoName = c.req.param("name");
  const state = c.req.query("state") as "open" | "closed" | "merged" | undefined;

  let sql = `
    SELECT id, repo, number, title, state, author, branch, base,
           agent_authored, linked_issues, created_at, updated_at, merged_at
    FROM pull_requests
    WHERE (repo = ? OR SUBSTR(repo, INSTR(repo, '/') + 1) = ?)
  `;
  const params: unknown[] = [repoName, repoName];

  if (state) {
    sql += ` AND state = ?`;
    params.push(state);
  }

  sql += ` ORDER BY number DESC`;

  const { results } = await db.prepare(sql).bind(...params).all();

  const pulls = (results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as number,
    repo: r.repo as string,
    number: r.number as number,
    title: r.title as string,
    state: r.state as "open" | "closed" | "merged",
    author: r.author as string | null,
    branch: r.branch as string | null,
    base: r.base as string | null,
    agentAuthored: (r.agent_authored as number) === 1,
    linkedIssues: r.linked_issues as string | null,
    createdAt: r.created_at as string | null,
    updatedAt: r.updated_at as string | null,
    mergedAt: r.merged_at as string | null,
  }));

  return c.json({ pulls });
});

// ---------------------------------------------------------------------------
// GET /api/repos/:name/pulls/:n/comments
// ---------------------------------------------------------------------------

repoRoutes.get("/api/repos/:name/pulls/:n/comments", async (c) => {
  const db = c.env.CORTEX_DB;
  const repoName = c.req.param("name");
  const prNumber = parseInt(c.req.param("n"));

  if (isNaN(prNumber)) {
    return c.json({ error: "invalid PR number" }, 400);
  }

  // Resolve short name to full name
  const repoRow = await db.prepare(
    `SELECT full_name FROM repos WHERE short_name = ? OR full_name = ? LIMIT 1`
  ).bind(repoName, repoName).first<{ full_name: string }>();

  if (!repoRow) {
    return c.json({ error: "repo not found" }, 404);
  }

  // In the cloud worker we can't shell out to `gh` CLI.
  // Instead, query GitHub comments from github_events where we store comment events.
  const { results } = await db.prepare(`
    SELECT author, title as body, created_at
    FROM github_events
    WHERE repo = ? AND event_type = 'comment' AND number = ?
    ORDER BY created_at ASC
  `).bind(repoRow.full_name, prNumber).all();

  const comments = (results ?? []).map((r: Record<string, unknown>) => ({
    author: r.author as string | null,
    body: r.body as string ?? "",
    createdAt: r.created_at as string | null,
    updatedAt: null,
  }));

  return c.json({ comments });
});
