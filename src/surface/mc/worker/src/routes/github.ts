/**
 * G-400/G-404: POST /api/github/webhook — GitHub webhook receiver.
 * Verifies HMAC signature, delegates event processing to shared modules, stores in D1.
 */

import { Hono } from "hono";
import { verify } from "@octokit/webhooks-methods";
import type { Env } from "../index";
import {
  isAllowedRepo,
  processPRWebhook,
  processIssueWebhook,
  processCommentWebhook,
  processPushWebhook,
  processReleaseWebhook,
  DEFAULT_DETECTION_CONFIG,
} from "../../../../../common/github-events";
import type {
  GitHubEventData,
  IssueUpsertData,
  PullRequestUpsertData,
} from "../../../../../common/types";
import { invalidateCache } from "./state";

export const githubRoutes = new Hono<{ Bindings: Env }>();

githubRoutes.post("/api/github/webhook", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return c.text("webhook not configured", 503);
  }

  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const event = c.req.header("x-github-event") ?? "";
  const deliveryId = c.req.header("x-github-delivery") ?? "";

  if (!signature || !event || !deliveryId) {
    return c.text("missing headers", 400);
  }

  // Verify HMAC signature
  const valid = await verify(secret, body, signature);
  if (!valid) {
    return c.text("unauthorized", 401);
  }

  const payload = JSON.parse(body);
  const db = c.env.GROVE_DB;

  // Get allowed repos from env (comma-separated)
  const allowedRepos = (c.env.GITHUB_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const repo = payload.repository?.full_name;

  if (repo && !isAllowedRepo(repo, allowedRepos)) {
    return c.text("ok", 200);
  }

  try {
    let result = { event: null as GitHubEventData | null } as {
      event: GitHubEventData | null;
      issue?: IssueUpsertData;
      pullRequest?: PullRequestUpsertData;
    };

    switch (event) {
      case "pull_request":
        result = processPRWebhook(payload, DEFAULT_DETECTION_CONFIG);
        break;
      case "issues":
        result = processIssueWebhook(payload);
        break;
      case "issue_comment":
        result = processCommentWebhook(payload, DEFAULT_DETECTION_CONFIG);
        break;
      case "push":
        result = processPushWebhook(payload, DEFAULT_DETECTION_CONFIG);
        break;
      case "release":
        result = processReleaseWebhook(payload);
        break;
    }

    // Persist to D1
    let dataWritten = false;
    if (result.event) {
      await insertGitHubEvent(db, result.event);
      dataWritten = true;
    }
    if (result.pullRequest) {
      await upsertPullRequest(db, result.pullRequest);
      dataWritten = true;
    }
    if (result.issue) {
      await upsertIssue(db, result.issue);
      dataWritten = true;
    }

    // G-406: Invalidate snapshot cache after successful writes
    if (dataWritten) {
      invalidateCache();
    }

    return c.text("ok", 200);
  } catch (err) {
    console.error("webhook processing error:", err);
    return c.text("processing error", 500);
  }
});

// ---------------------------------------------------------------------------
// D1 persistence helpers (D1-specific, not shareable)
// ---------------------------------------------------------------------------

async function insertGitHubEvent(db: D1Database, event: GitHubEventData): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO github_events
    (event_id, repo, event_type, title, number, url, author,
     agent_authored, linked_session, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventId,
    event.repo,
    event.eventType,
    event.title,
    event.number,
    event.url,
    event.author,
    event.agentAuthored ? 1 : 0,
    event.linkedSession,
    event.payload,
    event.createdAt,
  ).run();
}

async function upsertPullRequest(db: D1Database, pr: PullRequestUpsertData): Promise<void> {
  await db.prepare(`
    INSERT INTO pull_requests (id, repo, number, title, state, author, branch, base,
       agent_authored, linked_issues, created_at, updated_at, merged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, number) DO UPDATE SET
       title = excluded.title, state = excluded.state, author = excluded.author,
       branch = excluded.branch, base = excluded.base, agent_authored = excluded.agent_authored,
       linked_issues = excluded.linked_issues, updated_at = excluded.updated_at,
       merged_at = excluded.merged_at
  `).bind(
    pr.id, pr.repo, pr.number, pr.title, pr.state,
    pr.author, pr.branch, pr.base,
    pr.agentAuthored ? 1 : 0, pr.linkedIssues,
    pr.createdAt, pr.updatedAt, pr.mergedAt,
  ).run();
}

async function upsertIssue(db: D1Database, issue: IssueUpsertData): Promise<void> {
  await db.prepare(`
    INSERT INTO issues (id, repo, number, title, body, state, author, labels, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, number) DO UPDATE SET
       title = excluded.title, body = excluded.body, state = excluded.state, author = excluded.author,
       labels = excluded.labels, updated_at = excluded.updated_at, closed_at = excluded.closed_at
  `).bind(
    issue.id, issue.repo, issue.number, issue.title, issue.body,
    issue.state, issue.author, issue.labels,
    issue.createdAt, issue.updatedAt, issue.closedAt,
  ).run();
}
