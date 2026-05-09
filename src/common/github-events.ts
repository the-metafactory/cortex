import type {
  GitHubEventData,
  IssueUpsertData,
  PullRequestUpsertData,
} from "./types";
import {
  hasBranchMatch,
  hasTrailerMatch,
  hasCommentMatch,
  DEFAULT_BRANCH_PATTERNS,
  DEFAULT_COMMIT_TRAILER,
  DEFAULT_COMMENT_PATTERNS,
} from "./agent-detection";

export interface AgentDetectionConfig {
  branchPatterns: RegExp[];
  commitTrailers: string[];
  commentPatterns: RegExp[];
}

export const DEFAULT_DETECTION_CONFIG: AgentDetectionConfig = {
  branchPatterns: DEFAULT_BRANCH_PATTERNS,
  commitTrailers: [DEFAULT_COMMIT_TRAILER],
  commentPatterns: DEFAULT_COMMENT_PATTERNS,
};

export interface ProcessedWebhookResult {
  event: GitHubEventData | null;
  issue?: IssueUpsertData;
  pullRequest?: PullRequestUpsertData;
}

/** Check if a repo is in the allowed list. Empty list = allow all. */
export function isAllowedRepo(
  repo: string,
  allowedRepos: string[],
): boolean {
  if (allowedRepos.length === 0) return true;
  return allowedRepos.includes(repo);
}

/** Process a pull_request webhook payload -> event + PR upsert data */
export function processPRWebhook(
  payload: Record<string, unknown>,
  config: AgentDetectionConfig = DEFAULT_DETECTION_CONFIG,
): ProcessedWebhookResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const action = p.action;
  let eventType: string;

  if (action === "opened") eventType = "pr_opened";
  else if (action === "closed" && p.pull_request.merged)
    eventType = "pr_merged";
  else if (action === "closed") eventType = "pr_closed";
  else if (action === "reopened") eventType = "pr_reopened";
  else return { event: null };

  const pr = p.pull_request;
  const agentAuthored =
    hasBranchMatch(pr.head?.ref, config.branchPatterns) ||
    hasTrailerMatch(pr.body ?? "", config.commitTrailers);

  let state: "open" | "closed" | "merged" = "open";
  if (action === "closed" && p.pull_request.merged) state = "merged";
  else if (action === "closed") state = "closed";

  const issueRefs = (pr.body ?? "").match(/#(\d+)/g);
  const linkedIssues = issueRefs
    ? JSON.stringify(issueRefs.map((r: string) => parseInt(r.slice(1))))
    : null;

  return {
    event: {
      eventId: `pr-${pr.id}-${action}`,
      repo: p.repository.full_name,
      eventType,
      title: pr.title,
      number: pr.number,
      url: pr.html_url,
      author: pr.user?.login ?? null,
      agentAuthored,
      linkedSession: null,
      payload: JSON.stringify({
        branch: pr.head?.ref,
        base: pr.base?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
      }),
      createdAt: pr.updated_at ?? pr.created_at,
    },
    pullRequest: {
      id: pr.id,
      repo: p.repository.full_name,
      number: pr.number,
      title: pr.title,
      state,
      author: pr.user?.login ?? null,
      branch: pr.head?.ref ?? null,
      base: pr.base?.ref ?? null,
      agentAuthored,
      linkedIssues,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at ?? null,
    },
  };
}

/** Process an issues webhook payload */
export function processIssueWebhook(
  payload: Record<string, unknown>,
): ProcessedWebhookResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const action = p.action;
  let eventType: string;

  if (action === "opened") eventType = "issue_opened";
  else if (action === "closed") eventType = "issue_closed";
  else if (action === "reopened") eventType = "issue_reopened";
  else return { event: null };

  const issue = p.issue;
  const labels = issue.labels?.map((l: { name: string }) => l.name);

  return {
    event: {
      eventId: `issue-${issue.id}-${action}`,
      repo: p.repository.full_name,
      eventType,
      title: issue.title,
      number: issue.number,
      url: issue.html_url,
      author: issue.user?.login ?? null,
      agentAuthored: false,
      linkedSession: null,
      payload: JSON.stringify({ labels }),
      createdAt: issue.updated_at ?? issue.created_at,
    },
    issue: {
      id: issue.id,
      repo: p.repository.full_name,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: (action === "closed" ? "closed" : "open") as "open" | "closed",
      author: issue.user?.login ?? null,
      labels: labels?.length > 0 ? JSON.stringify(labels) : null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at ?? null,
    },
  };
}

/** Process an issue_comment webhook payload */
export function processCommentWebhook(
  payload: Record<string, unknown>,
  config: AgentDetectionConfig = DEFAULT_DETECTION_CONFIG,
): ProcessedWebhookResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  if (p.action !== "created") return { event: null };

  const comment = p.comment;
  const body: string = comment.body ?? "";
  const issueNum: number | null = p.issue?.number ?? null;

  const agentAuthored =
    hasCommentMatch(body, config.commentPatterns) ||
    hasTrailerMatch(body, config.commitTrailers);

  return {
    event: {
      eventId: `comment-${comment.id}`,
      repo: p.repository.full_name,
      eventType: "comment",
      title: body.slice(0, 120) + (body.length > 120 ? "..." : ""),
      number: issueNum,
      url: comment.html_url,
      author: comment.user?.login ?? null,
      agentAuthored,
      linkedSession: null,
      payload: null,
      createdAt: comment.created_at,
    },
  };
}

/** Process a push webhook payload */
export function processPushWebhook(
  payload: Record<string, unknown>,
  config: AgentDetectionConfig = DEFAULT_DETECTION_CONFIG,
): ProcessedWebhookResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const defaultBranch = p.repository.default_branch;
  const ref = p.ref;
  if (ref !== `refs/heads/${defaultBranch}`) return { event: null };

  const commits: Array<{
    message?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }> = p.commits ?? [];

  const agentAuthored = commits.some((c) =>
    hasTrailerMatch(c.message ?? "", config.commitTrailers),
  );

  const filesChanged = new Set<string>();
  for (const c of commits) {
    for (const f of c.added ?? []) filesChanged.add(f);
    for (const f of c.modified ?? []) filesChanged.add(f);
    for (const f of c.removed ?? []) filesChanged.add(f);
  }

  return {
    event: {
      eventId: `push-${p.after?.slice(0, 12) ?? p.head_commit?.id?.slice(0, 12) ?? Date.now()}`,
      repo: p.repository.full_name,
      eventType: "push",
      title:
        commits.length === 1
          ? (commits[0]?.message?.split("\n")[0] ?? "push")
          : `${commits.length} commits`,
      number: null,
      url: p.compare ?? null,
      author: p.pusher?.name ?? p.sender?.login ?? null,
      agentAuthored,
      linkedSession: null,
      payload: JSON.stringify({
        commits: commits.length,
        filesChanged: filesChanged.size,
        branch: defaultBranch,
      }),
      createdAt:
        p.head_commit?.timestamp ?? new Date().toISOString(),
    },
  };
}

/** Process a release webhook payload */
export function processReleaseWebhook(
  payload: Record<string, unknown>,
): ProcessedWebhookResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  if (p.action !== "published") return { event: null };

  const release = p.release;

  return {
    event: {
      eventId: `release-${release.id}`,
      repo: p.repository.full_name,
      eventType: "release",
      title: release.name ?? release.tag_name,
      number: null,
      url: release.html_url,
      author: release.author?.login ?? null,
      agentAuthored: false,
      linkedSession: null,
      payload: JSON.stringify({
        tag: release.tag_name,
        prerelease: release.prerelease,
      }),
      createdAt: release.published_at ?? release.created_at,
    },
  };
}
