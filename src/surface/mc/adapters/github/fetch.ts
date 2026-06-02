/**
 * Grove Mission Control v2 — F-12b GitHub metadata fetch via `gh` CLI.
 *
 * Reuses Grove's existing `gh` CLI path (see `src/bot/lib/github-sync.ts`'s
 * `ghJsonArgs`) rather than introducing `@octokit/rest`. No new dependency,
 * principal's existing `gh auth login` is the trust root.
 *
 * Design addendum `docs/design-mc-f12b-add-to-queue.md`:
 *   - Decision 3 — `gh` CLI via `Bun.spawn`, principal-frequency only.
 *   - Decision 6 — maps 401/403/404/5xx / timeout / parse errors into
 *     discriminated error kinds the handler translates to HTTP status.
 *   - Decision 9 — 30-second spawn timeout; spinner clears and the form
 *     shows "GitHub took too long…"
 *
 * SSRF posture: argv is statically constructed from a caller-validated
 * `{owner, repo, number}` triple — no shell interpolation, no
 * principal-controlled hostname. The `gh` CLI resolves `api.github.com`
 * from `gh auth` config.
 */

export type GitHubFetchErrorKind =
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "spawn_failed"
  | "upstream"
  | "parse_error";

export interface GitHubFetchError {
  kind: GitHubFetchErrorKind;
  message: string;
  /** Raw stderr from `gh`, when we have it. Optional — tests check shape only. */
  stderr?: string;
}

/**
 * Subset of GitHub's REST /repos/:owner/:repo/issues/:number response that
 * F-12b cares about. Everything else in the GitHub payload is discarded.
 *
 * `pull_request` is the discriminator the API uses to mark a PR: it is
 * present (as an object) on PR rows and absent on issue rows. See
 * https://docs.github.com/en/rest/issues/issues#get-an-issue.
 */
export interface GitHubIssueOrPr {
  /** "issue" | "pr" — derived from the `pull_request` field on the response. */
  type: "issue" | "pr";
  /** "open" | "closed" — verbatim from GitHub. */
  state: string;
  /** The issue/PR title. */
  title: string;
  /** Label names only; we don't need colors or descriptions. */
  labels: string[];
  /** Issue body, raw. May be `null` for no-body issues. */
  body: string | null;
  /** Canonical HTML URL from the response. Used for `source_url`. */
  html_url: string;
}

/**
 * Surface of `Bun.spawn` we use — narrowed for the test fake.
 * Exposed so `task-create-endpoints.test.ts` can inject a fake `gh`.
 */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: string | number) => void;
}
export type GhSpawnFn = (args: string[]) => SpawnResult;

const DEFAULT_TIMEOUT_MS = 30_000;

interface RawGithubIssue {
  title?: string;
  state?: string;
  body?: string | null;
  html_url?: string;
  labels?: ({ name?: string } | string)[] | null;
  pull_request?: unknown;
}

function defaultSpawn(args: string[]): SpawnResult {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc as unknown as SpawnResult;
}

/**
 * Fetch issue/PR metadata via `gh api /repos/:owner/:repo/issues/:number`.
 *
 * GitHub's REST API treats PRs and issues as a shared number space (Decision
 * 4 — "GitHub's REST API treats PRs as issues; the response's `pull_request`
 * field disambiguates"). The `/repos/.../issues/N` endpoint therefore
 * succeeds for both kinds.
 */
export async function fetchIssueOrPr(
  ref: { owner: string; repo: string; number: number },
  opts: { spawn?: GhSpawnFn; timeoutMs?: number } = {}
): Promise<GitHubIssueOrPr | GitHubFetchError> {
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [
    "gh",
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
  ];

  let proc: SpawnResult;
  try {
    proc = spawn(args);
  } catch (err) {
    return {
      kind: "spawn_failed",
      message: `Could not spawn gh CLI: ${(err as Error).message}. Is 'gh' installed and in PATH?`,
    };
  }

  let timedOut = false;
  // Hard-escalation grace period: if the process is still alive 2s after
  // SIGTERM we send SIGKILL. Standard subprocess-cleanup pattern — covers
  // the case where `gh` (or one of its child processes) ignores SIGTERM
  // and would otherwise linger as a zombie holding network sockets.
  const SIGKILL_GRACE_MS = 2_000;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch (_err) {
      // Best-effort — the timeout branch returns regardless.
    }
    sigkillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_err) {
        // Best-effort — process may already have exited.
      }
    }, SIGKILL_GRACE_MS);
  }, timeoutMs);

  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    // Drain stdout + stderr in parallel with the exited promise so a large
    // response can't deadlock on the pipe buffer.
    const [so, se, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = so;
    stderr = se;
    exitCode = code;
  } catch (err) {
    clearTimeout(timer);
    // sigkillTimer + timedOut are nullable/false at the start; the rule
    // sees them as always-falsy because the only assignments happen
    // inside callbacks the executor scheduled. Real runtime updates fire
    // post-timeout — these guards are load-bearing.
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (timedOut) {
      return {
        kind: "timeout",
        message: "GitHub took too long to respond. Try again.",
      };
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    return {
      kind: "spawn_failed",
      message: `gh CLI failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearTimeout(timer);
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (sigkillTimer) clearTimeout(sigkillTimer);

  if (timedOut) {
    return {
      kind: "timeout",
      message: "GitHub took too long to respond. Try again.",
    };
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  if (exitCode !== 0) {
    // Map gh's common stderr shapes to kinds.
    // `gh` emits messages like "HTTP 404: Not Found (...)", "HTTP 401: ...",
    // "API rate limit exceeded ...". The checks are order-sensitive — the
    // rate-limit signal can appear alongside a 403 status, so it goes first.
    const normalized = stderr.toLowerCase();
    if (
      normalized.includes("rate limit") ||
      normalized.includes("api rate limit exceeded")
    ) {
      return {
        kind: "rate_limited",
        message:
          "GitHub rate limit reached. Try again in a few minutes.",
        stderr,
      };
    }
    if (
      normalized.includes("http 404") ||
      normalized.includes("not found")
    ) {
      return {
        kind: "not_found",
        message: "That issue or PR could not be found on GitHub.",
        stderr,
      };
    }
    if (
      normalized.includes("http 401") ||
      normalized.includes("unauthorized") ||
      normalized.includes("gh auth") ||
      normalized.includes("authentication required")
    ) {
      return {
        kind: "unauthorized",
        message:
          "GitHub auth failed. Run 'gh auth login' to authenticate, then try again.",
        stderr,
      };
    }
    return {
      kind: "upstream",
      message: `gh CLI exited ${exitCode}: ${stderr.trim() || "(empty stderr)"}`,
      stderr,
    };
  }

  let raw: RawGithubIssue;
  try {
    raw = JSON.parse(stdout) as RawGithubIssue;
  } catch (err) {
    return {
      kind: "parse_error",
      message: `Could not parse GitHub response: ${(err as Error).message}`,
    };
  }

  if (
    typeof raw.title !== "string" ||
    typeof raw.state !== "string" ||
    typeof raw.html_url !== "string"
  ) {
    return {
      kind: "parse_error",
      message: "GitHub response missing required fields (title/state/html_url).",
    };
  }

  const labels: string[] = Array.isArray(raw.labels)
    ? raw.labels
        .map((l) =>
          typeof l === "string" ? l : typeof l.name === "string" ? l.name : null
        )
        .filter((s): s is string => s !== null)
    : [];

  return {
    type:
      raw.pull_request && typeof raw.pull_request === "object"
        ? "pr"
        : "issue",
    state: raw.state,
    title: raw.title,
    labels,
    body: raw.body ?? null,
    html_url: raw.html_url,
  };
}

/**
 * Rich pull-request detail from `gh api /repos/:owner/:repo/pulls/:number`.
 *
 * The issues endpoint {@link fetchIssueOrPr} uses does NOT carry branch/sha, so
 * G-1113.C.5 fetches the pulls endpoint to populate the GitBranch + GitCommit +
 * PullRequest model. PR-only (issues have no head/base).
 */
export interface GitHubPullRequestDetail {
  state: string; // "open" | "closed"
  merged: boolean;
  draft: boolean;
  title: string;
  html_url: string;
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  /** Head repo `owner/name` — differs from the base repo for fork PRs; null when absent. */
  headRepoFullName: string | null;
}

interface RawGithubPull {
  state?: string;
  merged?: boolean;
  draft?: boolean;
  title?: string;
  html_url?: string;
  number?: number;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null;
  base?: { ref?: string } | null;
}

/**
 * Run a `gh api <path>` call and return stdout, mapping gh's stderr shapes to
 * the same {@link GitHubFetchError} kinds as {@link fetchIssueOrPr}. Self-
 * contained (does not disturb the existing fetcher); used by
 * {@link fetchPullRequest}. (fetchIssueOrPr predates this and could migrate to
 * it in a later cleanup.)
 */
async function runGhApi(
  path: string,
  opts: { spawn?: GhSpawnFn; timeoutMs?: number } = {}
): Promise<{ ok: true; stdout: string } | GitHubFetchError> {
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["gh", "api", "-H", "Accept: application/vnd.github+json", path];

  let proc: SpawnResult;
  try {
    proc = spawn(args);
  } catch (err) {
    return {
      kind: "spawn_failed",
      message: `Could not spawn gh CLI: ${(err as Error).message}. Is 'gh' installed and in PATH?`,
    };
  }

  let timedOut = false;
  const SIGKILL_GRACE_MS = 2_000;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch (_err) {
      // best-effort
    }
    sigkillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_err) {
        // best-effort
      }
    }, SIGKILL_GRACE_MS);
  }, timeoutMs);

  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    const [so, se, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = so;
    stderr = se;
    exitCode = code;
  } catch (err) {
    clearTimeout(timer);
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (timedOut) return { kind: "timeout", message: "GitHub took too long to respond. Try again." };
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    return {
      kind: "spawn_failed",
      message: `gh CLI failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearTimeout(timer);
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (sigkillTimer) clearTimeout(sigkillTimer);
  if (timedOut) return { kind: "timeout", message: "GitHub took too long to respond. Try again." };
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  if (exitCode !== 0) {
    const n = stderr.toLowerCase();
    if (n.includes("rate limit")) return { kind: "rate_limited", message: "GitHub rate limit reached. Try again in a few minutes.", stderr };
    if (n.includes("http 404") || n.includes("not found")) return { kind: "not_found", message: "That GitHub resource could not be found.", stderr };
    if (n.includes("http 401") || n.includes("unauthorized") || n.includes("gh auth") || n.includes("authentication required"))
      return { kind: "unauthorized", message: "GitHub auth failed. Run 'gh auth login' to authenticate, then try again.", stderr };
    return { kind: "upstream", message: `gh CLI exited ${exitCode}: ${stderr.trim() || "(empty stderr)"}`, stderr };
  }
  return { ok: true, stdout };
}

/**
 * Fetch rich PR detail (head/base branch + head sha + merged/draft) via the
 * `/pulls/:number` endpoint. Returns {@link GitHubPullRequestDetail} or a
 * {@link GitHubFetchError}.
 */
export async function fetchPullRequest(
  ref: { owner: string; repo: string; number: number },
  opts: { spawn?: GhSpawnFn; timeoutMs?: number } = {}
): Promise<GitHubPullRequestDetail | GitHubFetchError> {
  const res = await runGhApi(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, opts);
  if ("kind" in res) return res; // GitHubFetchError carries `kind`; success carries `ok`/`stdout`

  let raw: RawGithubPull;
  try {
    raw = JSON.parse(res.stdout) as RawGithubPull;
  } catch (err) {
    return { kind: "parse_error", message: `Could not parse GitHub PR response: ${(err as Error).message}` };
  }

  if (
    typeof raw.state !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.html_url !== "string" ||
    !raw.head ||
    typeof raw.head.ref !== "string" ||
    typeof raw.head.sha !== "string" ||
    !raw.base ||
    typeof raw.base.ref !== "string"
  ) {
    return { kind: "parse_error", message: "GitHub PR response missing required fields (state/title/html_url/head.ref/head.sha/base.ref)." };
  }

  return {
    state: raw.state,
    merged: raw.merged === true,
    draft: raw.draft === true,
    title: raw.title,
    html_url: raw.html_url,
    number: typeof raw.number === "number" ? raw.number : ref.number,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    headSha: raw.head.sha,
    headRepoFullName:
      raw.head.repo && typeof raw.head.repo.full_name === "string"
        ? raw.head.repo.full_name
        : null,
  };
}

/**
 * G-1113.D.5b — a sub-issue of an umbrella issue, as the WorkItem ingester
 * needs it. Subset of GitHub's `/issues/:n/sub_issues` array element.
 */
export interface GitHubSubIssue {
  number: number;
  title: string;
  /** "open" | "closed" — verbatim from GitHub. */
  state: string;
  html_url: string;
  /** Label names only. */
  labels: string[];
}

interface RawGithubSubIssue {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  labels?: ({ name?: string } | string)[];
}

/**
 * G-1113.D.5b — fetch the sub-issues of an umbrella issue via
 * `/repos/:owner/:repo/issues/:number/sub_issues`. Returns the normalized
 * array or a {@link GitHubFetchError}. Used by the GitHub WorkItemSource to
 * enumerate a plan's work items. Same `gh` CLI trust root + error mapping as
 * {@link fetchPullRequest}.
 */
export async function fetchSubIssues(
  ref: { owner: string; repo: string; number: number },
  opts: { spawn?: GhSpawnFn; timeoutMs?: number } = {}
): Promise<GitHubSubIssue[] | GitHubFetchError> {
  const res = await runGhApi(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/sub_issues`, opts);
  if ("kind" in res) return res;

  let raw: RawGithubSubIssue[];
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return { kind: "parse_error", message: "GitHub sub_issues response was not an array." };
    }
    raw = parsed as RawGithubSubIssue[];
  } catch (err) {
    return { kind: "parse_error", message: `Could not parse GitHub sub_issues response: ${(err as Error).message}` };
  }

  const out: GitHubSubIssue[] = [];
  for (const r of raw) {
    if (typeof r.number !== "number" || typeof r.title !== "string" || typeof r.state !== "string" || typeof r.html_url !== "string") {
      // Skip malformed rows rather than failing the whole ingest — a single
      // odd sub-issue shouldn't sink the batch. (Logged by the caller's count.)
      continue;
    }
    const labels = Array.isArray(r.labels)
      ? r.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter((n): n is string => typeof n === "string")
      : [];
    out.push({ number: r.number, title: r.title, state: r.state, html_url: r.html_url, labels });
  }
  return out;
}

/**
 * Type guard: distinguish error from successful metadata.
 */
export function isGitHubFetchError(
  x: GitHubIssueOrPr | GitHubFetchError
): x is GitHubFetchError {
  // TS sees `kind` as non-undefined on the GitHubFetchError branch (literal
  // union) — but isGitHubFetchError is the runtime narrower for unions
  // where TS can't yet prove the discriminant. Suppress the dead-condition
  // warning since the check IS the type guard.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (x as GitHubFetchError).kind !== undefined;
}

/**
 * First 240 chars of a body with newlines collapsed to spaces. Decision 6 —
 * "body_excerpt". Returns empty string for a null/empty body.
 */
export function excerpt(body: string | null, maxChars = 240): string {
  if (body === null || body.length === 0) return "";
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars - 1) + "…";
}
