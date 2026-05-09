/**
 * F-12b "Add task" — client-side GitHub URL/shorthand validation.
 *
 * The server-side parser (`src/mission-control/api/github-ref.ts`) is the
 * authoritative validator: this client-side helper is a fast pre-flight
 * so the modal doesn't waste a round-trip on an obviously-malformed
 * input. The accepted-formats table is the same as the server's
 * (`docs/design-mc-f12b-add-to-queue.md` Decision 4).
 *
 * Pure function, no I/O. Returns either a parsed shape (for diagnostic
 * display in tests / dev tools) or a tagged error so the modal can
 * render "Paste a GitHub URL or owner/repo#N." instead of letting an
 * empty-Preview-click drift to the server.
 */

export type GitHubRefKind = "issue" | "pr" | "auto";

export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
  kind: GitHubRefKind;
}

export type GitHubRefError =
  | "empty"
  | "bad-format"
  | "not-github-host"
  | "bad-owner"
  | "bad-repo"
  | "bad-number"
  | "needs-default-repo";

export type GitHubRefParseResult =
  | { ok: true; ref: GitHubRef }
  | { ok: false; error: GitHubRefError; message: string };

export interface ParseDefaults {
  /** Optional default `owner` for `repo#N` shorthand. */
  owner?: string;
  /** Optional default `owner/repo` for `#N` shorthand. */
  repo?: string;
}

/**
 * GitHub identifier rule — alnum, dash, underscore, dot. Length cap of
 * 100 mirrors the server-side validation; longer values are almost
 * certainly a paste error.
 */
const ID_RE = /^[A-Za-z0-9._-]+$/;
const ID_MAX = 100;
/** SQLite `INTEGER` is 64-bit but we cap at 2^31-1 for cross-tooling sanity. */
const NUMBER_MAX = 2 ** 31 - 1;

/**
 * Parse `input` against the F-12b Decision 4 format table:
 *   - https://github.com/owner/repo/issues/N
 *   - https://github.com/owner/repo/pull/N
 *   - owner/repo#N
 *   - repo#N (uses defaults.owner)
 *   - #N    (uses defaults.owner + defaults.repo)
 *
 * Returns the parsed shape or a typed error. The `kind` field is `issue`
 * / `pr` for URL inputs (the path discriminator is preserved); `auto`
 * for shorthand inputs (the server resolves issue-vs-PR via the API).
 */
export function parseGitHubRef(
  input: string,
  defaults: ParseDefaults = {}
): GitHubRefParseResult {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "empty", message: "Paste a GitHub URL or owner/repo#N." };
  }

  // 1) Full HTTPS URL form.
  if (/^https?:\/\//i.test(trimmed)) {
    return parseUrl(trimmed);
  }

  // 2) Bare `#N` shorthand — needs defaults.
  const hashOnly = trimmed.match(/^#(\d+)$/);
  if (hashOnly) {
    if (!defaults.owner || !defaults.repo) {
      return {
        ok: false,
        error: "needs-default-repo",
        message: "No default repo configured — use owner/repo#N or a full URL.",
      };
    }
    return finalize(defaults.owner, defaults.repo, hashOnly[1]!, "auto");
  }

  // 3) `owner/repo#N` and `repo#N` shorthand.
  const shorthand = trimmed.match(/^([^#]+)#(\d+)$/);
  if (shorthand) {
    const lhs = shorthand[1]!;
    const num = shorthand[2]!;
    if (lhs.includes("/")) {
      const [owner, repo, ...rest] = lhs.split("/");
      if (rest.length > 0 || !owner || !repo) {
        return {
          ok: false,
          error: "bad-format",
          message: "Use owner/repo#N — too many slashes.",
        };
      }
      return finalize(owner, repo, num, "auto");
    }
    if (!defaults.owner) {
      return {
        ok: false,
        error: "needs-default-repo",
        message: "No default owner configured — use owner/repo#N.",
      };
    }
    return finalize(defaults.owner, lhs, num, "auto");
  }

  return {
    ok: false,
    error: "bad-format",
    message: "Use https://github.com/owner/repo/issues/N or owner/repo#N.",
  };
}

function parseUrl(input: string): GitHubRefParseResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "bad-format", message: "Not a valid URL." };
  }
  if (url.protocol !== "https:") {
    // Per Decision 4 we reject http (and any other scheme); the server
    // also rejects, but catching it here saves a round-trip.
    return {
      ok: false,
      error: "bad-format",
      message: "Only HTTPS URLs are accepted.",
    };
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    return {
      ok: false,
      error: "not-github-host",
      message: "Only github.com URLs are supported (gist/api/etc not in F-12b scope).",
    };
  }
  // Path: /owner/repo/(issues|pull)/N — reject anything else (orgs/projects/etc).
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) {
    return { ok: false, error: "bad-format", message: "URL is missing the issue/PR number." };
  }
  const [owner, repo, kindRaw, numberRaw] = parts;
  if (!owner || !repo || !kindRaw || !numberRaw) {
    return { ok: false, error: "bad-format", message: "URL must point at an issue or PR." };
  }
  let kind: GitHubRefKind;
  if (kindRaw === "issues") kind = "issue";
  else if (kindRaw === "pull") kind = "pr";
  else return {
    ok: false,
    error: "bad-format",
    message: "URL must point at /issues/N or /pull/N.",
  };
  return finalize(owner, repo, numberRaw, kind);
}

function finalize(owner: string, repo: string, numberRaw: string, kind: GitHubRefKind): GitHubRefParseResult {
  if (!ID_RE.test(owner) || owner.length > ID_MAX) {
    return { ok: false, error: "bad-owner", message: `Invalid owner: ${owner}` };
  }
  if (!ID_RE.test(repo) || repo.length > ID_MAX) {
    return { ok: false, error: "bad-repo", message: `Invalid repo: ${repo}` };
  }
  const n = Number.parseInt(numberRaw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > NUMBER_MAX) {
    return { ok: false, error: "bad-number", message: `Invalid issue/PR number: ${numberRaw}` };
  }
  return { ok: true, ref: { owner, repo, number: n, kind } };
}

/** Canonical `owner/repo#N` string — useful for display + dedup keys. */
export function canonicalRef(ref: GitHubRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
