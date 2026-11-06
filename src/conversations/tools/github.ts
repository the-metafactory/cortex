import { z } from "zod/v4";
import type { ToolProject } from "../../common/types/desk-conversations";
import { runCommand, type CommandResult } from "../../surface/mc/desk/spawn";
import type { ToolContext, ToolDefinition } from "./capabilities";

export type GithubRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>;
export interface GithubToolOptions {
  run?: GithubRunner;
  now?: () => Date;
  requestTimeoutMs?: number;
  loginCacheMs?: number;
}

export type GithubFailure = "login-required" | "permission-denied" | "not-found" | "rate-limited" | "provider-failure";
type ReadStatus = GithubFailure | "identity-mismatch" | "head-changed" | "invalid-source";
interface Target { host: string; owner: string; name: string; repo: string }
type Fetched = { ok: true; json: unknown; text: string } | { ok: false; status: GithubFailure; message: string };

const DEFAULT_HOST = "github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_CACHE_MS = 15_000;
const BODY_LIMIT = 3_000;
const COMMENT_LIMIT = 1_200;
const DIFF_PAGE = 12_000;
const MAX_NUMBER = 10_000_000;
const FOREIGN_SCOPE = /(?:^|[\s(])-?(?:repo|org|user|owner|enterprise|team|team-review-requested):/i;
const NAME_PART = /^[\w.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const ACCEPT_JSON = "application/vnd.github+json";
const ACCEPT_DIFF = "application/vnd.github.diff";
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const DISCUSSION_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner discussion(number:$number){number title url body createdAt updatedAt closed locked category{name} author{login} answer{url} comments(first:10){totalCount nodes{url body createdAt author{login}}}}}}";

const Project = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const Number_ = z.number().int().min(1).max(MAX_NUMBER);
const Page = z.number().int().min(1).max(20).default(1);

const RepositoryInput = z.object({ project: Project }).strict();
const SearchInput = z.object({
  project: Project,
  query: z.string().max(256).refine(query => !/[\r\n\0]/.test(query), "query must be one line").refine(query => !FOREIGN_SCOPE.test(query), "query cannot name another repository, owner or scope").default(""),
  kind: z.enum(["issue", "pr", "any"]).default("any"),
  state: z.enum(["open", "closed", "any"]).default("any"),
  page: Page,
  perPage: z.number().int().min(1).max(20).default(10),
}).strict();
const ItemInput = z.object({ project: Project, number: Number_, page: Page }).strict();
const DiscussionInput = z.object({ project: Project, number: Number_ }).strict();
const DiffInput = z.object({ project: Project, number: Number_, offset: z.number().int().min(0).max(50_000_000).default(0), limit: z.number().int().min(1).max(DIFF_PAGE).default(DIFF_PAGE) }).strict();
const ChecksInput = z.object({ project: Project, pr: Number_.optional(), sha: z.string().regex(SHA).optional(), page: Page }).strict().refine(input => (input.pr === undefined) !== (input.sha === undefined), "give exactly one of pr or sha");

const clip = (text: unknown, limit: number): string => {
  const value = typeof text === "string" ? text : "";
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} characters]` : value;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rec = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null => typeof value === "number" ? value : null;
const login = (value: unknown): string | null => str(rec(value).login);
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function githubTarget(project: ToolProject): Target | string {
  const forge = project.forge;
  if (!forge || forge.kind !== "github") return "this source has no configured GitHub repository";
  const host = (forge.host ?? DEFAULT_HOST).toLowerCase();
  const parts = forge.repo.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !NAME_PART.test(owner) || !NAME_PART.test(name) || owner === "." || owner === ".." || name === "." || name === "..") return "the configured repository must be exactly owner/name";
  return { host, owner, name, repo: `${owner}/${name}` };
}

export function classifyGithubFailure(result: CommandResult): { status: GithubFailure; message: string } {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/HTTP 401|gh auth login|not logged in|Bad credentials|authentication required/i.test(text)) return { status: "login-required", message: "The host's GitHub login is missing or expired. Ask the principal to run gh auth login." };
  if (/rate limit|HTTP 429|abuse detection/i.test(text)) return { status: "rate-limited", message: "GitHub rate limit reached. Retry later; no result was read." };
  if (/HTTP 403|Resource not accessible|SAML|forbidden/i.test(text)) return { status: "permission-denied", message: "The host's GitHub login may not read this repository or item." };
  if (/HTTP 404|HTTP 410|Not Found|Could not resolve to/i.test(text)) return { status: "not-found", message: "Not found, or not visible to the host's GitHub login." };
  return { status: "provider-failure", message: "GitHub did not answer usefully. Nothing was read." };
}

const segment = encodeURIComponent;
const repoPath = (target: Target, rest: string): string => `repos/${segment(target.owner)}/${segment(target.name)}${rest}`;
const canonical = (target: Target, path: string): string => `https://${target.host}/${target.repo}${path}`;
const belongs = (target: Target, url: unknown): boolean => typeof url === "string" && url.toLowerCase().startsWith(`https://${target.host}/${target.repo}/`.toLowerCase());

export function createGithubTools(options: GithubToolOptions = {}): ToolDefinition[] {
  const run: GithubRunner = options.run ?? ((argv, timeoutMs) => runCommand(argv, timeoutMs));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const loginCacheMs = options.loginCacheMs ?? LOGIN_CACHE_MS;
  const logins = new Map<string, { at: number; reason: string | null }>();

  const attempt = async (argv: string[]): Promise<CommandResult | null> => {
    try { return await run(argv, timeoutMs); }
    catch (_err) { return null; }
  };

  const get = async (target: Target, path: string, params: Record<string, string | number> = {}, accept = ACCEPT_JSON): Promise<Fetched> => {
    const fields = Object.entries(params).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
    const result = await attempt(["gh", "api", "--hostname", target.host, "--method", "GET", "-H", `Accept: ${accept}`, ...fields, path]);
    if (!result) return { ok: false, status: "provider-failure", message: "GitHub did not answer in time. Nothing was read." };
    if (result.code !== 0) return { ok: false, ...classifyGithubFailure(result) };
    if (accept === ACCEPT_DIFF) return { ok: true, json: null, text: result.stdout };
    try { return { ok: true, json: JSON.parse(result.stdout) as unknown, text: result.stdout }; }
    catch (_err) { return { ok: false, status: "provider-failure", message: "GitHub returned an unreadable response. Nothing was read." }; }
  };

  const outcome = (target: Target | null, status: "ok" | ReadStatus, body: Record<string, unknown>): string => JSON.stringify({ status, ...(target ? { source: { host: target.host, repository: target.repo, url: canonical(target, "") } } : {}), fetchedAt: now().toISOString(), ...body });
  const failed = (target: Target, failure: Extract<Fetched, { ok: false }>): string => outcome(target, failure.status, { message: failure.message });
  const mismatch = (target: Target, what: string): string => outcome(target, "identity-mismatch", { message: `${what} does not belong to the configured repository ${target.repo}. Nothing was returned.` });

  const withTarget = async (context: ToolContext, body: (target: Target) => Promise<string>): Promise<string> => {
    const project = context.project;
    const target = project ? githubTarget(project) : "no source";
    if (typeof target === "string") return outcome(null, "invalid-source", { message: target });
    const confirmed = await get(target, repoPath(target, ""));
    if (!confirmed.ok) return failed(target, confirmed);
    const full = str(rec(confirmed.json).full_name);
    if (!full || !sameRepo(full, target.repo)) return outcome(target, "identity-mismatch", { message: `The configured repository resolves to a different repository now (${full ?? "unknown"}). Nothing was read.` });
    return body(target);
  };

  const pullHead = async (target: Target, number: number): Promise<{ ok: true; sha: string; pull: Record<string, unknown> } | { ok: false; failure: string }> => {
    const pull = await get(target, repoPath(target, `/pulls/${number}`));
    if (!pull.ok) return { ok: false, failure: failed(target, pull) };
    const data = rec(pull.json);
    const sha = str(rec(data.head).sha);
    if (!belongs(target, data.html_url) || !sha || !SHA.test(sha)) return { ok: false, failure: mismatch(target, "The pull request") };
    return { ok: true, sha, pull: data };
  };

  const loginReason = async (target: Target): Promise<string | null> => {
    const cached = logins.get(target.host);
    if (cached && now().getTime() - cached.at < loginCacheMs) return cached.reason;
    const result = await attempt(["gh", "auth", "status", "--hostname", target.host]);
    const reason = result === null ? "The GitHub CLI could not be run on the host." : result.code === 0 ? null : `The host has no GitHub login for ${target.host}. Ask the principal to run gh auth login.`;
    logins.set(target.host, { at: now().getTime(), reason });
    return reason;
  };

  const dependency = (project: ToolProject): string | null => {
    const target = githubTarget(project);
    return typeof target === "string" ? target : null;
  };
  const provider = async (project: ToolProject): Promise<string | null> => {
    const target = githubTarget(project);
    return typeof target === "string" ? target : loginReason(target);
  };
  const define = (name: string, description: string, input: z.ZodType<object>, body: (input: never, target: Target) => Promise<string>): ToolDefinition => ({
    name, description, operation: "forge.read", input, dependency, provider,
    run: (parsed, context) => withTarget(context, target => body(parsed as never, target)),
  });

  const summary = (target: Target, item: Record<string, unknown>): Record<string, unknown> => ({
    number: num(item.number), kind: item.pull_request ? "pull_request" : "issue", title: clip(item.title, 300), state: str(item.state), author: login(item.user),
    labels: list(item.labels).map(label => str(label.name)).filter(Boolean), comments: num(item.comments), createdAt: str(item.created_at), updatedAt: str(item.updated_at),
    url: belongs(target, item.html_url) ? str(item.html_url) : null,
  });

  const repository = define("github_repository", "Read metadata of the configured GitHub repository: description, default branch, visibility and canonical URL.", RepositoryInput, async (_input, target) => {
    const data = await get(target, repoPath(target, ""));
    if (!data.ok) return failed(target, data);
    const repo = rec(data.json);
    return outcome(target, "ok", { repository: { fullName: str(repo.full_name), url: str(repo.html_url), description: clip(repo.description, 500), private: repo.private === true, archived: repo.archived === true, defaultBranch: str(repo.default_branch), pushedAt: str(repo.pushed_at), openIssuesAndPulls: num(repo.open_issues_count), hasDiscussions: repo.has_discussions === true } });
  });

  const search = define("github_search", "Search issues and pull requests inside the configured repository only. Returns a page; use nextPage for more.", SearchInput, async (input: z.infer<typeof SearchInput>, target) => {
    const qualifiers = [`repo:${target.repo}`, input.kind === "issue" ? "is:issue" : input.kind === "pr" ? "is:pr" : "", input.state === "any" ? "" : `is:${input.state}`, input.query].filter(Boolean).join(" ");
    const data = await get(target, "search/issues", { q: qualifiers, per_page: input.perPage, page: input.page, sort: "updated", order: "desc" });
    if (!data.ok) return failed(target, data);
    const body = rec(data.json);
    const all = list(body.items);
    const inside = all.filter(item => belongs(target, item.html_url) && typeof item.repository_url === "string" && item.repository_url.toLowerCase().endsWith(`/repos/${target.repo}`.toLowerCase()));
    return outcome(target, "ok", { query: input.query, page: input.page, totalCount: num(body.total_count), incompleteResults: body.incomplete_results === true, omittedOutsideRepository: all.length - inside.length, items: inside.map(item => summary(target, item)), nextPage: all.length === input.perPage && input.page < 20 ? input.page + 1 : null });
  });

  const item = define("github_item", "Read one issue or pull request by number from the configured repository with a page of comments and, for pull requests, reviews, head SHA and merge state.", ItemInput, async (input: z.infer<typeof ItemInput>, target) => {
    const issue = await get(target, repoPath(target, `/issues/${input.number}`));
    if (!issue.ok) return failed(target, issue);
    const data = rec(issue.json);
    if (!belongs(target, data.html_url)) return mismatch(target, "The item");
    const isPull = data.pull_request !== undefined;
    const paging = { per_page: 10, page: input.page };
    const [comments, head, reviews] = await Promise.all([
      get(target, repoPath(target, `/issues/${input.number}/comments`), paging),
      isPull ? pullHead(target, input.number) : Promise.resolve(null),
      isPull ? get(target, repoPath(target, `/pulls/${input.number}/reviews`), paging) : Promise.resolve(null),
    ]);
    if (!comments.ok) return failed(target, comments);
    if (head && !head.ok) return head.failure;
    if (reviews && !reviews.ok) return failed(target, reviews);
    const commentList = list(comments.json).filter(comment => belongs(target, comment.html_url));
    const pull = head?.ok ? head.pull : null;
    return outcome(target, "ok", {
      item: { ...summary(target, data), body: clip(data.body, BODY_LIMIT), assignees: list(data.assignees).map(who => login(who)), milestone: str(rec(data.milestone).title) },
      ...(pull ? { pullRequest: { headSha: head?.ok ? head.sha : null, headRef: str(rec(pull.head).ref), baseRef: str(rec(pull.base).ref), draft: pull.draft === true, merged: pull.merged === true, mergeable: pull.mergeable ?? null, changedFiles: num(pull.changed_files), additions: num(pull.additions), deletions: num(pull.deletions) } } : {}),
      comments: { page: input.page, entries: commentList.map(comment => ({ author: login(comment.user), createdAt: str(comment.created_at), url: str(comment.html_url), body: clip(comment.body, COMMENT_LIMIT) })), nextPage: commentList.length === 10 && input.page < 20 ? input.page + 1 : null },
      ...(reviews?.ok ? { reviews: { page: input.page, entries: list(reviews.json).filter(review => belongs(target, review.html_url)).map(review => ({ author: login(review.user), state: str(review.state), submittedAt: str(review.submitted_at), commitSha: str(review.commit_id), url: str(review.html_url), body: clip(review.body, COMMENT_LIMIT) })), nextPage: list(reviews.json).length === 10 && input.page < 20 ? input.page + 1 : null } } : {}),
    });
  });

  const discussion = define("github_discussion", "Read one discussion by number from the configured repository with its first comments.", DiscussionInput, async (input: z.infer<typeof DiscussionInput>, target) => {
    const result = await attempt(["gh", "api", "graphql", "--hostname", target.host, "-f", `query=${DISCUSSION_QUERY}`, "-f", `owner=${target.owner}`, "-f", `name=${target.name}`, "-F", `number=${input.number}`]);
    if (!result) return outcome(target, "provider-failure", { message: "GitHub did not answer in time. Nothing was read." });
    if (result.code !== 0) return failed(target, { ok: false, ...classifyGithubFailure(result) });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch (_err) { return outcome(target, "provider-failure", { message: "GitHub returned an unreadable response. Nothing was read." }); }
    const repo = rec(rec(rec(parsed).data).repository);
    const name = str(repo.nameWithOwner);
    if (name && !sameRepo(name, target.repo)) return mismatch(target, "The discussion");
    const found = rec(repo.discussion);
    if (!str(found.url)) return outcome(target, "not-found", { message: "No such discussion, or it is not visible to the host's GitHub login." });
    if (!belongs(target, found.url)) return mismatch(target, "The discussion");
    const comments = rec(found.comments);
    return outcome(target, "ok", { discussion: { number: num(found.number), title: clip(found.title, 300), url: str(found.url), category: str(rec(found.category).name), author: login(found.author), closed: found.closed === true, locked: found.locked === true, createdAt: str(found.createdAt), updatedAt: str(found.updatedAt), answerUrl: str(rec(found.answer).url), body: clip(found.body, BODY_LIMIT), commentCount: num(comments.totalCount), comments: list(comments.nodes).filter(comment => belongs(target, comment.url)).map(comment => ({ author: login(comment.author), createdAt: str(comment.createdAt), url: str(comment.url), body: clip(comment.body, COMMENT_LIMIT) })) } });
  });

  const diff = define("github_pr_diff", "Read a window of a pull request's unified diff, with its head SHA. offset and limit select characters; nextOffset continues. If the head moved during the read nothing is returned.", DiffInput, async (input: z.infer<typeof DiffInput>, target) => {
    const before = await pullHead(target, input.number);
    if (!before.ok) return before.failure;
    const text = await get(target, repoPath(target, `/pulls/${input.number}`), {}, ACCEPT_DIFF);
    if (!text.ok) return failed(target, text);
    const after = await pullHead(target, input.number);
    if (!after.ok) return after.failure;
    if (after.sha !== before.sha) return outcome(target, "head-changed", { url: canonical(target, `/pull/${input.number}`), headShaBefore: before.sha, headShaAfter: after.sha, message: "The pull request head moved while the diff was read. Read it again; this diff was withheld." });
    const end = input.offset + input.limit;
    return outcome(target, "ok", { url: canonical(target, `/pull/${input.number}`), headSha: after.sha, totalCharacters: text.text.length, offset: input.offset, nextOffset: end < text.text.length ? end : null, diff: text.text.slice(input.offset, end) });
  });

  const checks = define("github_checks", "Read check runs and commit statuses for a pull request head or a commit SHA in the configured repository. The rollup is passing only when every check was read and finished successfully.", ChecksInput, async (input: z.infer<typeof ChecksInput>, target) => {
    let sha: string;
    let url: string;
    if (input.pr !== undefined) {
      const head = await pullHead(target, input.pr);
      if (!head.ok) return head.failure;
      sha = head.sha;
      url = canonical(target, `/pull/${input.pr}`);
    } else {
      const commit = await get(target, repoPath(target, `/commits/${segment(input.sha ?? "")}`));
      if (!commit.ok) return failed(target, commit);
      const resolved = str(rec(commit.json).sha);
      if (!belongs(target, rec(commit.json).html_url) || !resolved || !SHA.test(resolved)) return mismatch(target, "The commit");
      sha = resolved;
      url = canonical(target, `/commit/${sha}`);
    }
    const [runs, statuses] = await Promise.all([
      get(target, repoPath(target, `/commits/${sha}/check-runs`), { per_page: 30, page: input.page }),
      get(target, repoPath(target, `/commits/${sha}/status`), { per_page: 30 }),
    ]);
    if (!runs.ok) return failed(target, runs);
    if (!statuses.ok) return failed(target, statuses);
    if (input.pr !== undefined) {
      const after = await pullHead(target, input.pr);
      if (!after.ok) return after.failure;
      if (after.sha !== sha) return outcome(target, "head-changed", { url, headShaBefore: sha, headShaAfter: after.sha, message: "The pull request head moved while checks were read. These results describe an older commit and were withheld." });
    }
    const runData = rec(runs.json);
    const runEntries = list(runData.check_runs);
    const statusData = rec(statuses.json);
    const statusEntries = list(statusData.statuses);
    const foreign = runEntries.filter(run => str(run.head_sha) !== sha).length;
    const totalRuns = num(runData.total_count) ?? runEntries.length;
    const totalStatuses = num(statusData.total_count) ?? statusEntries.length;
    const readAllRuns = input.page === 1 && runEntries.length >= totalRuns;
    const readAllStatuses = statusEntries.length >= totalStatuses;
    const failing = runEntries.some(run => FAILING_CONCLUSIONS.has(str(run.conclusion) ?? "")) || ["failure", "error"].includes(str(statusData.state) ?? "") && totalStatuses > 0;
    const pending = runEntries.some(run => str(run.status) !== "completed") || str(statusData.state) === "pending" && totalStatuses > 0;
    const allPassing = runEntries.every(run => str(run.status) === "completed" && PASSING_CONCLUSIONS.has(str(run.conclusion) ?? ""));
    const rollup = foreign > 0 ? "stale" : !readAllRuns || !readAllStatuses ? "incomplete" : failing ? "failing" : pending || !allPassing ? "pending" : totalRuns + totalStatuses === 0 ? "none" : "passing";
    return outcome(target, "ok", {
      url, headSha: sha, rollup, readAll: readAllRuns && readAllStatuses,
      checkRuns: { total: totalRuns, page: input.page, nextPage: runEntries.length === 30 && input.page < 20 ? input.page + 1 : null, entries: runEntries.map(run => ({ name: clip(run.name, 200), status: str(run.status), conclusion: str(run.conclusion), startedAt: str(run.started_at), completedAt: str(run.completed_at), url: belongs(target, run.html_url) ? str(run.html_url) : null, headSha: str(run.head_sha) })) },
      commitStatuses: { total: totalStatuses, state: totalStatuses > 0 ? str(statusData.state) : null, entries: statusEntries.map(entry => ({ context: clip(entry.context, 200), state: str(entry.state), updatedAt: str(entry.updated_at), targetUrl: str(entry.target_url) })) },
    });
  });

  return [repository, search, item, discussion, diff, checks];
}
