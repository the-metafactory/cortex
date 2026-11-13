import { parseGraphRepoRef } from "../../../../common/graph-ref";
import { CommandTimeout, runCommand } from "../../desk/spawn";

export interface GitLabIssueRef {
  host: string;
  path: string;
  number: number;
}

export type GitLabFetchErrorKind = "invalid_ref" | "not_found" | "unauthorized" | "rate_limited" | "timeout" | "spawn_failed" | "upstream" | "parse_error";

export interface GitLabFetchError {
  kind: GitLabFetchErrorKind;
  message: string;
}

export interface GitLabIssue {
  body: string | null;
}

export function gitlabIssueRef(repo: string, nodeId: string): GitLabIssueRef | null {
  const parsed = parseGraphRepoRef(repo);
  const number = Number(nodeId);
  if (repo !== repo.trim() || parsed?.forge !== "gitlab" || parsed.path.split("/").length < 2 || !/^[1-9]\d*$/.test(nodeId) || !Number.isSafeInteger(number)) return null;
  return { host: parsed.host, path: parsed.path, number };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const defaultRun = (argv: string[], timeoutMs: number) => runCommand(argv, timeoutMs, undefined, undefined, true, { maxOutputBytes: MAX_OUTPUT_BYTES });

function upstreamError(stderr: string): GitLabFetchError {
  const text = stderr.toLowerCase();
  if (/rate limit|http 429/.test(text)) return { kind: "rate_limited", message: "GitLab rate limit reached." };
  if (/http 401|http 403|unauthorized|forbidden|glab auth|authentication|token/.test(text)) return { kind: "unauthorized", message: "GitLab authentication failed." };
  if (/http 404|not found/.test(text)) return { kind: "not_found", message: "The GitLab issue could not be found." };
  return { kind: "upstream", message: "The GitLab issue could not be read." };
}

export async function fetchGitlabIssue(ref: GitLabIssueRef, opts: { run?: typeof defaultRun; timeoutMs?: number } = {}): Promise<GitLabIssue | GitLabFetchError> {
  const validated = gitlabIssueRef(`gitlab:${ref.host}/${ref.path}`, String(ref.number));
  if (!validated) return { kind: "invalid_ref", message: "The GitLab issue reference is invalid." };
  const argv = ["glab", "api", "--hostname", validated.host, "--method", "GET", `projects/${encodeURIComponent(validated.path)}/issues/${validated.number}`];
  let stdout: string;
  try {
    const result = await (opts.run ?? defaultRun)(argv, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (result.code !== 0) return upstreamError(result.stderr);
    stdout = result.stdout;
  } catch (err) {
    return err instanceof CommandTimeout
      ? { kind: "timeout", message: "GitLab took too long to respond." }
      : { kind: "spawn_failed", message: "The glab CLI could not read the issue." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { kind: "parse_error", message: "The GitLab response was not JSON." };
  }
  if (raw === null || typeof raw !== "object" || !("iid" in raw) || raw.iid !== validated.number || !("description" in raw) || (typeof raw.description !== "string" && raw.description !== null)) {
    return { kind: "parse_error", message: "The GitLab response did not contain the requested issue body." };
  }
  return { body: raw.description };
}
