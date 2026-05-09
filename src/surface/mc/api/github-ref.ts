/**
 * Grove Mission Control v2 — F-12b URL parser for GitHub issue/PR refs.
 *
 * Pure function, no I/O. Accepts the five input formats from
 * `docs/design-mc-f12b-add-to-queue.md` Decision 4 and canonicalises to
 * `{owner, repo, number, kind}`. Also exposes `canonicalRef({owner, repo, number})`
 * which produces the `"owner/repo#number"` string used as the dedup key in
 * `tasks.source_external_id` and as the wire `ref` field in the preview/create
 * request bodies.
 *
 * Security posture (Decision 4, SSRF discussion): the parser only ever
 * produces a validated `{owner, repo, number}` triple. Downstream code
 * reissues a structured `gh api /repos/${owner}/${repo}/issues/${number}`
 * call — it never dereferences the input URL. The parser therefore only has
 * to normalise to the triple; it does not have to sanitise the URL for
 * direct fetch use.
 */

export type GitHubRefKind = "issue" | "pr" | "auto";

export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
  /**
   * `"issue"` / `"pr"` when the input URL explicitly named the path
   * (`/issues/` or `/pull/`), `"auto"` for shorthand inputs where the
   * server will disambiguate via the GitHub API response.
   */
  kind: GitHubRefKind;
}

export interface ParseError {
  error: string;
}

export interface ParseDefaults {
  owner?: string;
  repo?: string;
}

// GitHub identifier rules: alphanumerics, dots, dashes, underscores. The
// first character must be alphanumeric or underscore — GitHub itself
// rejects accounts/repos starting with `.` or `-` (and would also 404 on
// `.` / `..`), so refusing them at the parser tightens defence-in-depth
// before the value reaches the `gh api /repos/${owner}/${repo}/...` URL
// path. `gh` URL-encodes path segments, so shell injection is closed
// regardless, but a tighter regex narrows the surface.
const IDENTIFIER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const IDENTIFIER_MAX_LEN = 100;

// A positive 32-bit integer covers every plausible issue/PR number while
// keeping the value safe to index as INTEGER in SQLite if ever needed.
const NUMBER_RE = /^[1-9][0-9]*$/;
const NUMBER_MAX = 2 ** 31 - 1;

function validateOwnerRepo(owner: string, repo: string): ParseError | null {
  if (owner.length === 0 || owner.length > IDENTIFIER_MAX_LEN) {
    return { error: "Owner must be 1–100 characters." };
  }
  if (!IDENTIFIER_RE.test(owner)) {
    return {
      error:
        "Owner contains characters outside [A-Za-z0-9._-]. GitHub usernames and orgs only.",
    };
  }
  if (repo.length === 0 || repo.length > IDENTIFIER_MAX_LEN) {
    return { error: "Repo must be 1–100 characters." };
  }
  if (!IDENTIFIER_RE.test(repo)) {
    return {
      error:
        "Repo contains characters outside [A-Za-z0-9._-].",
    };
  }
  return null;
}

function validateNumber(raw: string): number | ParseError {
  if (!NUMBER_RE.test(raw)) {
    return { error: "Issue/PR number must be a positive integer." };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > NUMBER_MAX) {
    return {
      error: `Issue/PR number must be between 1 and ${NUMBER_MAX}.`,
    };
  }
  return n;
}

/**
 * Parse a user-supplied GitHub reference. Returns either a `GitHubRef` on
 * success or a `ParseError` on failure. Never throws.
 *
 * Accepted inputs:
 *   - `https://github.com/owner/repo/issues/42`
 *   - `https://github.com/owner/repo/pull/45`
 *   - `owner/repo#42` (kind=auto — server disambiguates issue vs PR)
 *   - `repo#42`      (kind=auto — with defaults.owner)
 *   - `#42`          (kind=auto — with defaults.owner + defaults.repo)
 *
 * Rejected:
 *   - http:// URLs (HTTPS only)
 *   - gist.github.com, github.com/orgs/... — non-issue/PR paths
 *   - anything malformed
 */
export function parseGitHubRef(
  input: string,
  defaults: ParseDefaults = {}
): GitHubRef | ParseError {
  if (typeof input !== "string") {
    return { error: "Input must be a string." };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { error: "Input is empty." };
  }

  // --- URL form ---
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    if (!trimmed.startsWith("https://")) {
      return { error: "Only HTTPS github.com URLs are supported." };
    }
    // We intentionally parse by string split rather than `new URL()` so the
    // error messages remain pinned to the format rather than URL-class
    // idiosyncrasies.
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (_err) {
      return { error: "Could not parse URL." };
    }
    if (url.hostname !== "github.com") {
      return {
        error:
          "Only github.com URLs are supported. Linear/Jira/other sources are not supported in v2.",
      };
    }
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    // Expected shape: [owner, repo, 'issues'|'pull', number]
    if (parts.length < 4) {
      return {
        error:
          "URL does not point at a GitHub issue or PR. Expected /owner/repo/issues/N or /owner/repo/pull/N.",
      };
    }
    const [owner, repo, segment, rawNumber] = parts as [
      string,
      string,
      string,
      string
    ];
    if (segment !== "issues" && segment !== "pull") {
      return {
        error:
          "URL path segment must be 'issues' or 'pull'. Discussions and project boards are not supported in v2.",
      };
    }
    const vErr = validateOwnerRepo(owner, repo);
    if (vErr) return vErr;
    const n = validateNumber(rawNumber);
    if (typeof n !== "number") return n;
    return {
      owner,
      repo,
      number: n,
      kind: segment === "pull" ? "pr" : "issue",
    };
  }

  // --- Shorthand forms ---
  // `#N` (bare) — must have defaults.owner + defaults.repo
  if (trimmed.startsWith("#")) {
    if (!defaults.owner || !defaults.repo) {
      return {
        error:
          "#N shorthand requires a default repo. Configure mission_control.default_github_repo in bot.yaml or paste the full owner/repo#N form.",
      };
    }
    const rawNumber = trimmed.slice(1);
    const vErr = validateOwnerRepo(defaults.owner, defaults.repo);
    if (vErr) return vErr;
    const n = validateNumber(rawNumber);
    if (typeof n !== "number") return n;
    return {
      owner: defaults.owner,
      repo: defaults.repo,
      number: n,
      kind: "auto",
    };
  }

  // `owner/repo#N` or `repo#N` (with defaults.owner)
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx < 0) {
    return {
      error:
        "Input must be a https://github.com URL, owner/repo#N, or #N (with default repo).",
    };
  }
  const lhs = trimmed.slice(0, hashIdx);
  const rawNumber = trimmed.slice(hashIdx + 1);
  const slashIdx = lhs.indexOf("/");
  let owner: string;
  let repo: string;
  if (slashIdx < 0) {
    // `repo#N` — needs defaults.owner
    if (!defaults.owner) {
      return {
        error:
          "Shorthand 'repo#N' requires a default owner. Use 'owner/repo#N' or configure mission_control.default_github_repo in bot.yaml.",
      };
    }
    owner = defaults.owner;
    repo = lhs;
  } else {
    owner = lhs.slice(0, slashIdx);
    repo = lhs.slice(slashIdx + 1);
    // Reject owner/repo/extra — more than one slash means malformed.
    if (repo.includes("/")) {
      return {
        error:
          "Shorthand format is 'owner/repo#N' — extra path segments are not allowed.",
      };
    }
  }
  const vErr = validateOwnerRepo(owner, repo);
  if (vErr) return vErr;
  const n = validateNumber(rawNumber);
  if (typeof n !== "number") return n;
  return { owner, repo, number: n, kind: "auto" };
}

/**
 * Canonical string form used as the dedup key in `tasks.source_external_id`
 * and as the wire `ref` value in preview/create responses.
 *
 * Paste-the-URL and paste-the-shorthand for the same issue both canonicalise
 * to the same string (Decision 5 — "The dedup query is keyed off the
 * canonical string").
 */
export function canonicalRef(ref: {
  owner: string;
  repo: string;
  number: number;
}): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Canonical web URL for a ref. Used for the `source_url` column and for
 * `Open existing task` deeplinks. `auto` kind falls back to /issues/N since
 * GitHub auto-redirects to /pull/N when the number resolves to a PR.
 */
export function canonicalUrl(ref: GitHubRef): string {
  const segment = ref.kind === "pr" ? "pull" : "issues";
  return `https://github.com/${ref.owner}/${ref.repo}/${segment}/${ref.number}`;
}

/**
 * Type guard: distinguish `ParseError` from `GitHubRef`.
 */
export function isParseError(x: GitHubRef | ParseError): x is ParseError {
  return (x as ParseError).error !== undefined;
}
