/**
 * G-400/G-404: POST /api/sync — Trigger GitHub sync.
 * Fetches repos, issues, PRs from GitHub API and stores in D1.
 * Since the Worker can't shell out to `gh` CLI, we use the GitHub REST API directly.
 * Requires API key auth (same as ingest).
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { requireApiKey, type PrincipalKey } from "../auth";

type Variables = { principalId: string; principalKey: PrincipalKey };

export const syncRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

syncRoutes.post("/api/sync", requireApiKey, async (c) => {
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) {
    return c.json({ error: "GITHUB_TOKEN not configured" }, 503);
  }

  const reposConfig = (c.env.GITHUB_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (reposConfig.length === 0) {
    return c.json({ error: "GITHUB_REPOS not configured" }, 503);
  }

  const db = c.env.CORTEX_DB;
  const totals = { repos: 0, issues: 0, prs: 0, releases: 0, commits: 0 };

  for (const repoFullName of reposConfig) {
    try {
      const result = await syncRepo(db, githubToken, repoFullName);
      totals.repos++;
      totals.issues += result.issues;
      totals.prs += result.prs;
      totals.releases += result.releases;
      totals.commits += result.commits;
    } catch (err) {
      console.error(`sync failed for ${repoFullName}:`, err);
    }
  }

  // Prune D1 records for repos no longer in GITHUB_REPOS
  let pruned: string[] = [];
  try {
    const allRepos = await db.prepare("SELECT full_name FROM repos").all<{ full_name: string }>();
    const configSet = new Set(reposConfig);
    const stale = (allRepos.results ?? [])
      .map((r) => r.full_name)
      .filter((name) => !configSet.has(name));

    if (stale.length > 0) {
      for (const fullName of stale) {
        await db.batch([
          db.prepare("DELETE FROM github_events WHERE repo = ?").bind(fullName),
          db.prepare("DELETE FROM issues WHERE repo = ?").bind(fullName),
          db.prepare("DELETE FROM pull_requests WHERE repo = ?").bind(fullName),
          db.prepare("DELETE FROM repos WHERE full_name = ?").bind(fullName),
        ]);
      }
      pruned = stale;
    }
  } catch (err) {
    console.error("grove-worker: sync: prune failed:", err);
  }

  // Check webhook health for each repo
  const webhookHealth: Record<string, { hookId: number; active: boolean; lastCode: number } | { error: string }> = {};
  for (const repoFullName of reposConfig) {
    try {
      const hooks = await ghFetch<Array<{
        id: number;
        active: boolean;
        config: { url: string };
        last_response: { code: number };
      }>>(`https://api.github.com/repos/${repoFullName}/hooks`, githubToken);

      const groveHook = hooks.find((h) => h.config?.url?.includes("/api/github/webhook"));
      if (groveHook) {
        webhookHealth[repoFullName] = {
          hookId: groveHook.id,
          active: groveHook.active,
          lastCode: groveHook.last_response?.code ?? 0,
        };
      } else {
        webhookHealth[repoFullName] = { error: "no webhook configured" };
      }
    } catch (_err) {
      // GitHub token may lack admin:repo_hook scope — not fatal
      webhookHealth[repoFullName] = { error: "could not check (insufficient permissions?)" };
    }
  }

  return c.json({ ok: true, ...totals, pruned, webhookHealth });
});

// ---------------------------------------------------------------------------
// GitHub REST API sync
// ---------------------------------------------------------------------------

import { hasBranchMatch, hasTrailerMatch } from "../../../../../common/agent-detection";

async function ghFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "grove-cloud-api",
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

async function syncRepo(db: D1Database, token: string, fullName: string): Promise<{ issues: number; prs: number; releases: number; commits: number }> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullName}`);

  // Fetch repo metadata
  const repoData = await ghFetch<{
    name: string;
    full_name: string;
    description: string | null;
    default_branch: string;
  }>(`https://api.github.com/repos/${fullName}`, token);

  await db.prepare(`
    INSERT OR REPLACE INTO repos (full_name, short_name, description, default_branch, synced_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    repoData.full_name,
    repoData.name,
    repoData.description,
    repoData.default_branch,
    new Date().toISOString(),
  ).run();

  // Fetch open issues (up to 100)
  const openIssues = await ghFetch<any[]>(
    `https://api.github.com/repos/${fullName}/issues?state=open&per_page=100&sort=updated`,
    token,
  );

  // Fetch recently closed issues (up to 20)
  const closedIssues = await ghFetch<any[]>(
    `https://api.github.com/repos/${fullName}/issues?state=closed&per_page=20&sort=updated`,
    token,
  );

  // GitHub's /issues endpoint includes PRs — filter them out
  const allIssues = [...openIssues, ...closedIssues].filter((i) => !i.pull_request);

  // DELETE + INSERTs in same batch for atomicity (no data loss if sync fails mid-way)
  const issueStatements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM issues WHERE repo = ?`).bind(fullName),
  ];
  for (const issue of allIssues) {
    const labels = issue.labels?.map((l: any) => l.name);
    issueStatements.push(
      db.prepare(`
        INSERT INTO issues (id, repo, number, title, body, state, author, labels, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, number) DO UPDATE SET
          title = excluded.title, body = excluded.body, state = excluded.state, author = excluded.author,
          labels = excluded.labels, updated_at = excluded.updated_at, closed_at = excluded.closed_at
      `).bind(
        issue.id, fullName, issue.number, issue.title, issue.body ?? null,
        issue.state, issue.user?.login ?? null,
        labels?.length > 0 ? JSON.stringify(labels) : null,
        issue.created_at, issue.updated_at, issue.closed_at ?? null,
      )
    );
  }
  await db.batch(issueStatements);

  // Fetch open PRs (up to 50)
  const openPrs = await ghFetch<any[]>(
    `https://api.github.com/repos/${fullName}/pulls?state=open&per_page=50&sort=updated`,
    token,
  );

  // Fetch recently closed/merged PRs
  const closedPrs = await ghFetch<any[]>(
    `https://api.github.com/repos/${fullName}/pulls?state=closed&per_page=20&sort=updated`,
    token,
  );

  const allPrs = [...openPrs, ...closedPrs];
  // DELETE + INSERTs in same batch for atomicity
  const prStatements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM pull_requests WHERE repo = ?`).bind(fullName),
  ];

  for (const pr of allPrs) {
    const agentAuthored = hasBranchMatch(pr.head?.ref) || hasTrailerMatch(pr.body ?? "");
    const issueRefs = (pr.body ?? "").match(/#(\d+)/g);
    const linkedIssues = issueRefs ? JSON.stringify(issueRefs.map((r: string) => parseInt(r.slice(1)))) : null;
    const state = pr.merged_at ? "merged" : pr.state;

    prStatements.push(
      db.prepare(`
        INSERT INTO pull_requests (id, repo, number, title, state, author, branch, base,
           agent_authored, linked_issues, created_at, updated_at, merged_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, state = excluded.state, author = excluded.author,
           branch = excluded.branch, base = excluded.base, agent_authored = excluded.agent_authored,
           linked_issues = excluded.linked_issues, updated_at = excluded.updated_at,
           merged_at = excluded.merged_at
      `).bind(
        pr.id, fullName, pr.number, pr.title, state,
        pr.user?.login ?? null, pr.head?.ref ?? null, pr.base?.ref ?? null,
        agentAuthored ? 1 : 0, linkedIssues,
        pr.created_at, pr.updated_at, pr.merged_at ?? null,
      )
    );
  }
  await db.batch(prStatements);

  // Sync GitHub events from fetched data (with dedup via INSERT OR IGNORE)
  const eventStatements: D1PreparedStatement[] = [];

  for (const issue of allIssues) {
    // Issue opened event
    if (issue.created_at) {
      eventStatements.push(
        db.prepare(`
          INSERT OR IGNORE INTO github_events
          (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
        `).bind(
          `issue-${issue.id}-opened`,
          fullName, "issue_opened", issue.title, issue.number,
          issue.html_url, issue.user?.login ?? null,
          JSON.stringify({ labels: issue.labels?.map((l: any) => l.name) }),
          issue.created_at,
        )
      );
    }
    // Issue closed event
    if (issue.closed_at) {
      eventStatements.push(
        db.prepare(`
          INSERT OR IGNORE INTO github_events
          (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
        `).bind(
          `issue-${issue.id}-closed`,
          fullName, "issue_closed", issue.title, issue.number,
          issue.html_url, issue.user?.login ?? null,
          issue.closed_at,
        )
      );
    }
  }

  for (const pr of allPrs) {
    const agentAuthored = hasBranchMatch(pr.head?.ref) || hasTrailerMatch(pr.body ?? "");
    // PR opened
    if (pr.created_at) {
      eventStatements.push(
        db.prepare(`
          INSERT OR IGNORE INTO github_events
          (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).bind(
          `pr-${pr.id}-opened`,
          fullName, "pr_opened", pr.title, pr.number,
          pr.html_url, pr.user?.login ?? null,
          agentAuthored ? 1 : 0,
          JSON.stringify({ branch: pr.head?.ref, base: pr.base?.ref }),
          pr.created_at,
        )
      );
    }
    // PR merged
    if (pr.merged_at) {
      eventStatements.push(
        db.prepare(`
          INSERT OR IGNORE INTO github_events
          (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        `).bind(
          `pr-${pr.id}-closed`,
          fullName, "pr_merged", pr.title, pr.number,
          pr.html_url, pr.user?.login ?? null,
          agentAuthored ? 1 : 0,
          pr.merged_at,
        )
      );
    }
  }

  // Fetch releases (up to 30)
  let releases: any[] = [];
  try {
    releases = await ghFetch<any[]>(
      `https://api.github.com/repos/${fullName}/releases?per_page=30`,
      token,
    );
  } catch (err) {
    console.error(`grove-worker: sync: releases fetch failed for ${fullName}:`, err instanceof Error ? err.message : err);
  }

  for (const rel of releases) {
    if (!rel.published_at) continue;
    eventStatements.push(
      db.prepare(`
        INSERT OR IGNORE INTO github_events
        (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, ?)
      `).bind(
        `release-${rel.id}`,
        fullName, "release", rel.name ?? rel.tag_name,
        rel.html_url, rel.author?.login ?? null,
        JSON.stringify({ tag: rel.tag_name, prerelease: rel.prerelease }),
        rel.published_at,
      )
    );
  }

  // Fetch recent commits on default branch (up to 50)
  let commits: any[] = [];
  try {
    commits = await ghFetch<any[]>(
      `https://api.github.com/repos/${fullName}/commits?sha=${repoData.default_branch}&per_page=50`,
      token,
    );
  } catch (err) {
    console.error(`grove-worker: sync: commits fetch failed for ${fullName}:`, err instanceof Error ? err.message : err);
  }

  // Group commits by push (same committer within short time window) is complex —
  // instead, create one event per commit for the activity feed
  for (const commit of commits) {
    const msg = commit.commit?.message ?? "";
    const firstLine = msg.split("\n")[0];
    const agentAuthored = hasTrailerMatch(msg);
    eventStatements.push(
      db.prepare(`
        INSERT OR IGNORE INTO github_events
        (event_id, repo, event_type, title, number, url, author, agent_authored, linked_session, payload, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
      `).bind(
        `push-${commit.sha?.slice(0, 12) ?? Date.now()}`,
        fullName, "push", firstLine.slice(0, 200),
        commit.html_url, commit.author?.login ?? commit.commit?.author?.name ?? null,
        agentAuthored ? 1 : 0,
        JSON.stringify({ commits: 1, filesChanged: 0, branch: repoData.default_branch }),
        commit.commit?.author?.date ?? new Date().toISOString(),
      )
    );
  }

  // Clean up legacy sync-prefixed event IDs that caused duplicates with webhook events
  eventStatements.unshift(
    db.prepare(`DELETE FROM github_events WHERE repo = ? AND event_id LIKE 'sync-%'`).bind(fullName),
  );

  // Batch insert all events (D1 supports up to 100 statements per batch)
  if (eventStatements.length > 0) {
    // Split into chunks of 100 for D1 batch limit
    for (let i = 0; i < eventStatements.length; i += 100) {
      const chunk = eventStatements.slice(i, i + 100);
      await db.batch(chunk);
    }
  }

  return { issues: allIssues.length, prs: allPrs.length, releases: releases.length, commits: commits.length };
}
