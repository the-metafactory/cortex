/**
 * G-1113.D.7b — GitHub iteration-import payload parsers, behind the adapter
 * boundary.
 *
 * These are the GitHub-specific parsers that turn a raw GitHub `issues`
 * webhook envelope (or a `gh api` response) into the provider-neutral
 * `ParentIssueMetadata` / `SubIssueMetadata` shapes the iteration importer
 * consumes. Moved verbatim from `api/iteration-import.ts` (D.7b) so GitHub's
 * webhook payload schema lives in `adapters/github/`, not inline in the import
 * path — `iteration-import.ts` now deals only in the neutral metadata shapes.
 * Behaviour-preserving: no parsing logic changed, only relocated.
 */
import type { GitHubRef } from "./ref";

/**
 * Normalized parent-issue metadata — the shape both the webhook and the
 * principal-driven import paths collapse their raw inputs to before calling
 * `importIterationFromMetadata`.
 *
 * Field meanings track the GitHub REST `/repos/:owner/:repo/issues/:n`
 * response (also matches the webhook payload's `issue` key) but with the
 * surface narrowed to what the iteration row needs.
 */
export interface ParentIssueMetadata {
  /** GitHub `owner/repo`. */
  owner: string;
  repo: string;
  /** Issue number (positive integer). */
  number: number;
  /** Issue title. */
  title: string;
  /** Issue body, raw markdown. May be null. */
  body: string | null;
  /** Canonical `html_url` from GitHub. */
  htmlUrl: string;
  /** Label names attached to the issue at the moment of import. */
  labels: string[];
}

/** Minimal sub-issue shape — enough to attach a child task. */
export interface SubIssueMetadata {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub `state` — "open" | "closed". */
  state: string;
  /** Canonical `html_url` from GitHub. */
  htmlUrl: string;
}

/**
 * Subset of GitHub's `issues` webhook payload the importer narrows.
 *
 * Marked `unknown`-typed at the boundary — the caller passes the parsed JSON
 * straight in and we narrow as we extract. Keeping the surface this small means
 * the test fixtures don't have to mock the other 200+ fields GitHub sends.
 */
export interface IssuesWebhookEnvelope {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    labels?: ({ name?: string } | string)[] | null;
    /**
     * GitHub's sub-issue surface. When present, the issue is a child
     * of `parent`; the parent's owner/repo/number identifies the
     * Grove iteration to attach to.
     *
     * The shape here mirrors GitHub's own response (the parent issue
     * embedded inline). We tolerate either the full URL inline or the
     * minimal `repository.full_name` + `number` form — different
     * webhook deliveries include different subsets.
     */
    parent?: {
      number: number;
      html_url?: string;
      repository?: { full_name?: string };
    } | null;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
  /**
   * Present on `issues.labeled` and `issues.unlabeled` — the label
   * that just changed. The handler keys on this for the "iteration
   * label was just added/removed" branches.
   */
  label?: { name?: string };
}

/**
 * Extract `ParentIssueMetadata` from the parsed webhook envelope. Pure;
 * no DB writes. Returns null when the payload is structurally wrong
 * (caller surfaces 400 / no-op).
 */
export function parentMetadataFromWebhook(
  envelope: unknown
): ParentIssueMetadata | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Partial<IssuesWebhookEnvelope>;
  if (
    !env.issue ||
    typeof env.issue !== "object" ||
    !env.repository ||
    typeof env.repository !== "object"
  ) {
    return null;
  }
  const repo = env.repository as { full_name?: string; name?: string; owner?: { login?: string } };
  const issue = env.issue;
  const owner = repo.owner?.login;
  const name = repo.name;
  if (typeof owner !== "string" || typeof name !== "string") return null;
  if (typeof issue.number !== "number" || !Number.isInteger(issue.number)) {
    return null;
  }
  if (typeof issue.title !== "string" || typeof issue.html_url !== "string") {
    return null;
  }

  const labels: string[] = Array.isArray(issue.labels)
    ? (issue.labels as ({ name?: string } | string)[])
        .map((l) =>
          typeof l === "string"
            ? l
            : typeof l.name === "string"
              ? l.name
              : null
        )
        .filter((s): s is string => s !== null)
    : [];

  return {
    owner,
    repo: name,
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === "string" ? issue.body : null,
    htmlUrl: issue.html_url,
    labels,
  };
}

/**
 * Extract sub-issue metadata + parent ref from the parsed webhook
 * envelope. Returns null when the payload doesn't carry a parent
 * (i.e., the issue isn't a sub-issue) or is structurally malformed.
 *
 * Per the design's note in F-17 acceptance criterion 1:
 *   "Sub-issue detection is via GitHub's `parent` field on the issue,
 *    OR the `iteration` label's parent-issue relationship — confirm
 *    which is in the existing `issues` table schema."
 *
 * We rely on the inline `issue.parent` field (the modern GitHub
 * sub-issue surface). Older checklist-style children — `- [ ]` lines
 * in the parent body — are explicitly out of scope for v1; the
 * design's "checklist sub-issues, normalized to issue refs" line in
 * Decision 2 names them as a future-friendly extension, not a v1
 * dependency.
 */
export function subIssueRefsFromWebhook(envelope: unknown): {
  parent: { owner: string; repo: string; number: number };
  child: SubIssueMetadata;
} | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Partial<IssuesWebhookEnvelope>;
  if (
    !env.issue ||
    typeof env.issue !== "object" ||
    !env.repository ||
    typeof env.repository !== "object"
  ) {
    return null;
  }
  const issue = env.issue;
  const parent = issue.parent;
  if (!parent || typeof parent !== "object") return null;
  if (typeof parent.number !== "number" || !Number.isInteger(parent.number)) {
    return null;
  }

  // Resolve parent owner/repo. Prefer the embedded `repository.full_name`
  // over the `html_url` parse — full_name is structured and unambiguous;
  // the URL only kicks in when GitHub's payload omits the full_name (rare).
  let parentOwner: string | undefined;
  let parentName: string | undefined;
  if (parent.repository?.full_name && typeof parent.repository.full_name === "string") {
    const parts = parent.repository.full_name.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      parentOwner = parts[0];
      parentName = parts[1];
    }
  }
  if ((!parentOwner || !parentName) && typeof parent.html_url === "string") {
    // Format: https://github.com/<owner>/<repo>/issues/<number>
    try {
      const u = new URL(parent.html_url);
      const parts = u.pathname.split("/").filter(Boolean);
      // ['owner', 'repo', 'issues', 'N'] OR ['owner', 'repo', 'pull', 'N']
      if (parts.length >= 4 && parts[0] && parts[1]) {
        parentOwner = parts[0];
        parentName = parts[1];
      }
    } catch (_err) {
      // Malformed URL — fall through to the null-return below.
    }
  }
  if (!parentOwner || !parentName) {
    // GitHub didn't tell us the parent's repo. Sub-issues can live in
    // a different repo than their parent in principle (cross-repo
    // sub-issues are a recent GitHub feature) but for v1 we require
    // the payload to carry the parent repo explicitly so we don't
    // guess.
    return null;
  }

  const repo = env.repository as { name?: string; owner?: { login?: string } };
  const childOwner = repo.owner?.login;
  const childName = repo.name;
  if (typeof childOwner !== "string" || typeof childName !== "string") return null;
  if (typeof issue.number !== "number" || typeof issue.title !== "string") {
    return null;
  }
  if (typeof issue.html_url !== "string" || typeof issue.state !== "string") {
    return null;
  }

  return {
    parent: { owner: parentOwner, repo: parentName, number: parent.number },
    child: {
      owner: childOwner,
      repo: childName,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      htmlUrl: issue.html_url,
    },
  };
}

/**
 * Build a `ParentIssueMetadata` from a `gh api` response shape (the
 * same structure `fetchIssueOrPr` produces, but with owner/repo/number
 * threaded through from the original parsed `GitHubRef` because the
 * `gh` response itself doesn't echo them in the convenient form).
 */
export function parentMetadataFromGhResponse(
  ref: GitHubRef,
  fetched: {
    title: string;
    body: string | null;
    labels: string[];
    html_url: string;
  }
): ParentIssueMetadata {
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: fetched.title,
    body: fetched.body,
    htmlUrl: fetched.html_url,
    labels: fetched.labels,
  };
}
