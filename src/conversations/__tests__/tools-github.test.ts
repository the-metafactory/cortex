import { describe, expect, test } from "bun:test";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import type { CommandResult } from "../../surface/mc/desk/spawn";
import type { ToolSession } from "../tools/capabilities";
import { createGithubTools, type GithubRunner } from "../tools/github";
import { toolBody, toolRig } from "./fixtures/tool-host";

const REPO = "example/alpha";
const URL_BASE = `https://github.com/${REPO}`;
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const ok = (value: unknown): CommandResult => ({ code: 0, signal: null, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, signal: null, stdout: "", stderr });

const config = (): ToolsConfig => ({
  projects: [
    { id: "alpha", root: "/tmp/alpha", policy: "cloud", operations: ["forge.read"], forge: { kind: "github", repo: REPO } },
    { id: "closed", root: "/tmp/closed", policy: "cloud", operations: ["repo.read"], forge: { kind: "github", repo: "example/closed" } },
    { id: "gl", root: "/tmp/gl", policy: "cloud", operations: ["forge.read"], forge: { kind: "gitlab", repo: "group/project" } },
  ],
});

type Answer = CommandResult | ((argv: string[]) => CommandResult);
interface Rig { call: (name: string, input: unknown) => Promise<{ outcome: string; text: string }>; argvs: string[][]; routes: Map<string, Answer> }
function rig(routes: Record<string, Answer> = {}): Rig {
  const table = new Map<string, Answer>(Object.entries({ auth: ok("Logged in"), ...routes }));
  const argvs: string[][] = [];
  const run: GithubRunner = (argv) => {
    argvs.push(argv);
    const path = argv[argv.length - 1] ?? "";
    const key = argv[2] === "graphql" ? "graphql" : argv[1] === "auth" ? "auth" : path;
    const answer = table.get(key) ?? table.get(`${key}?${argv.filter(a => a.startsWith("page=") || a.startsWith("q=")).join("&")}`);
    if (!answer) return Promise.resolve(fail("gh: Not Found (HTTP 404)"));
    return Promise.resolve(typeof answer === "function" ? answer(argv) : answer);
  };
  const session = (): Promise<ToolSession | null> => Promise.resolve({ principal: "p", conversationId: "c", transport: "web", route: "cloud", policy: "cloud", scope: ["alpha", "closed", "gl"] });
  const { call } = toolRig({ route: "cloud", config, session, tools: createGithubTools({ run, now: () => new Date("2026-11-06T10:00:00Z"), loginCacheMs: 0 }) });
  return { call, argvs, routes: table };
}
const repoRoute = { "repos/example/alpha": ok({ full_name: "Example/Alpha", html_url: URL_BASE, description: "d", private: false, default_branch: "main" }) };
const pull = (head: string) => ok({ html_url: `${URL_BASE}/pull/7`, head: { sha: head, ref: "feat" }, base: { ref: "main" }, draft: false, merged: false, changed_files: 2 });

describe("github read tools through the conversation boundary", () => {
  test("repository metadata carries the canonical URL and fetch time", async () => {
    const r = rig(repoRoute);
    const result = await r.call("github_repository", { project: "alpha" });
    expect(result.outcome).toBe("done");
    expect(toolBody(result.text)).toMatchObject({ status: "ok", fetchedAt: "2026-11-06T10:00:00.000Z", source: { host: "github.com", repository: REPO, url: URL_BASE }, repository: { url: URL_BASE } });
  });

  test("requests are fixed GET reads with the host pinned and no token input", async () => {
    const r = rig(repoRoute);
    await r.call("github_repository", { project: "alpha" });
    expect(r.argvs.at(-1)).toEqual(["gh", "api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", "repos/example/alpha"]);
    expect((await r.call("github_repository", { project: "alpha", token: "x" })).outcome).toBe("refused");
    expect((await r.call("github_repository", { project: "alpha", path: "user" })).outcome).toBe("refused");
  });

  test("a repository that resolves to another identity is refused before any content", async () => {
    const r = rig({ "repos/example/alpha": ok({ full_name: "other/renamed", html_url: "https://github.com/other/renamed" }) });
    const result = toolBody((await r.call("github_item", { project: "alpha", number: 1 })).text);
    expect(result.status).toBe("identity-mismatch");
    expect(r.argvs.some(argv => argv.at(-1)?.includes("/issues/1"))).toBe(false);
  });

  test("denied and unconfigured repositories are refused without a request", async () => {
    const r = rig(repoRoute);
    expect((await r.call("github_repository", { project: "closed" })).outcome).toBe("refused");
    expect((await r.call("github_repository", { project: "unknown" })).outcome).toBe("refused");
    expect(r.argvs.length).toBe(0);
    const gitlab = await r.call("github_repository", { project: "gl" });
    expect(gitlab.outcome).toBe("error");
    expect(r.argvs.length).toBe(0);
  });

  test("malformed identifiers and foreign search scopes are refused", async () => {
    const r = rig(repoRoute);
    for (const input of [{ project: "alpha", number: 0 }, { project: "alpha", number: -1 }, { project: "alpha", number: 1.5 }, { project: "alpha", number: "7/../../user" }, { project: "alpha", number: 1, page: 99 }]) expect((await r.call("github_item", input)).outcome).toBe("refused");
    expect((await r.call("github_checks", { project: "alpha", sha: "../../x" })).outcome).toBe("refused");
    expect((await r.call("github_checks", { project: "alpha" })).outcome).toBe("refused");
    expect((await r.call("github_checks", { project: "alpha", pr: 1, sha: HEAD })).outcome).toBe("refused");
    for (const query of ["repo:other/private bug", "org:other bug", "bug -repo:x/y", "bug\nrepo:x/y"]) expect((await r.call("github_search", { project: "alpha", query })).outcome).toBe("refused");
    expect(r.argvs.length).toBe(0);
  });

  test("search is pinned to the configured repository, paginates and drops foreign hits", async () => {
    const hit = (n: number, repo = REPO) => ({ number: n, title: `Issue ${n}`, state: "open", user: { login: "u" }, labels: [{ name: "bug" }], comments: 2, html_url: `https://github.com/${repo}/issues/${n}`, repository_url: `https://api.github.com/repos/${repo}` });
    const r = rig({
      ...repoRoute,
      "search/issues": (argv) => {
        const q = argv.find(a => a.startsWith("q=")) ?? "";
        expect(q).toBe("q=repo:example/alpha is:issue is:open crash");
        return ok({ total_count: 31, incomplete_results: false, items: [hit(1), hit(2, "other/secret"), hit(3)] });
      },
    });
    const result = toolBody((await r.call("github_search", { project: "alpha", query: "crash", kind: "issue", state: "open", perPage: 3, page: 2 })).text);
    expect(result).toMatchObject({ status: "ok", totalCount: 31, page: 2, omittedOutsideRepository: 1, nextPage: 3 });
    expect((result.items as { url: string }[]).map(item => item.url)).toEqual([`${URL_BASE}/issues/1`, `${URL_BASE}/issues/3`]);
  });

  test("a pull request read returns head SHA, a comment page and reviews", async () => {
    const comment = (n: number) => ({ user: { login: "c" }, created_at: "2026-11-05T00:00:00Z", html_url: `${URL_BASE}/pull/7#issuecomment-${n}`, body: `comment ${n}` });
    const r = rig({
      ...repoRoute,
      "repos/example/alpha/issues/7": ok({ number: 7, title: "PR", state: "open", user: { login: "a" }, pull_request: {}, html_url: `${URL_BASE}/pull/7`, body: "x".repeat(5000), labels: [], assignees: [] }),
      "repos/example/alpha/pulls/7": pull(HEAD),
      "repos/example/alpha/issues/7/comments": ok(Array.from({ length: 10 }, (_, i) => comment(i))),
      "repos/example/alpha/pulls/7/reviews": ok([{ user: { login: "r" }, state: "CHANGES_REQUESTED", commit_id: HEAD, html_url: `${URL_BASE}/pull/7#pullrequestreview-1`, body: "fix" }]),
    });
    const result = toolBody((await r.call("github_item", { project: "alpha", number: 7 })).text);
    expect(result).toMatchObject({ status: "ok", pullRequest: { headSha: HEAD, baseRef: "main" }, comments: { page: 1, nextPage: 2 }, reviews: { entries: [{ state: "CHANGES_REQUESTED", commitSha: HEAD }] } });
    expect(((result.item as { body: string }).body).length).toBeLessThan(3100);
    expect((result.comments as { entries: unknown[] }).entries).toHaveLength(10);
  });

  test("an item whose canonical URL leaves the repository is not returned", async () => {
    const r = rig({ ...repoRoute, "repos/example/alpha/issues/3": ok({ number: 3, title: "moved", html_url: "https://github.com/other/place/issues/3" }) });
    expect(toolBody((await r.call("github_item", { project: "alpha", number: 3 })).text).status).toBe("identity-mismatch");
  });

  test("a discussion is read with one fixed query and repository variables", async () => {
    const r = rig({ ...repoRoute, graphql: ok({ data: { repository: { nameWithOwner: REPO, discussion: { number: 4, title: "Q", url: `${URL_BASE}/discussions/4`, body: "b", category: { name: "Ideas" }, author: { login: "d" }, comments: { totalCount: 1, nodes: [{ url: `${URL_BASE}/discussions/4#discussioncomment-1`, body: "c", author: { login: "e" } }] } } } } }) });
    const result = toolBody((await r.call("github_discussion", { project: "alpha", number: 4 })).text);
    expect(result).toMatchObject({ status: "ok", discussion: { url: `${URL_BASE}/discussions/4`, commentCount: 1 } });
    const argv = r.argvs.find(a => a[2] === "graphql") ?? [];
    expect(argv).toContain("owner=example");
    expect(argv).toContain("number=4");
    expect(argv.filter(a => a.startsWith("query=")).length).toBe(1);
  });

  test("a diff is windowed and withheld when the head changed during the read", async () => {
    let reads = 0;
    const diffText = "diff --git a/f b/f\n".repeat(1000);
    const r = rig({ ...repoRoute, "repos/example/alpha/pulls/7": (argv) => argv.some(a => a.includes("diff")) ? ok(diffText) : pull(HEAD) });
    const window = toolBody((await r.call("github_pr_diff", { project: "alpha", number: 7, offset: 18, limit: 36 })).text);
    expect(window).toMatchObject({ status: "ok", headSha: HEAD, offset: 18, nextOffset: 54, totalCharacters: diffText.length });
    expect((window.diff as string).length).toBe(36);
    const moving = rig({ ...repoRoute, "repos/example/alpha/pulls/7": (argv) => argv.some(a => a.includes("diff")) ? ok("diff") : pull(reads++ === 0 ? HEAD : MOVED) });
    const changed = toolBody((await moving.call("github_pr_diff", { project: "alpha", number: 7 })).text);
    expect(changed).toMatchObject({ status: "head-changed", headShaBefore: HEAD, headShaAfter: MOVED });
    expect(changed.diff).toBeUndefined();
  });

  const run = (name: string, conclusion: string | null, sha = HEAD) => ({ name, status: conclusion ? "completed" : "in_progress", conclusion, head_sha: sha, html_url: `${URL_BASE}/runs/1` });
  const checkRoutes = (runs: unknown[], total = runs.length, statuses = { total_count: 0, state: "pending", statuses: [] as unknown[] }): Record<string, Answer> => ({
    ...repoRoute, "repos/example/alpha/pulls/7": pull(HEAD),
    [`repos/example/alpha/commits/${HEAD}/check-runs`]: ok({ total_count: total, check_runs: runs }),
    [`repos/example/alpha/commits/${HEAD}/status`]: ok(statuses),
  });

  test("check rollups keep passing, failing, pending, unread and none distinct", async () => {
    const rollup = async (routes: Record<string, Answer>) => toolBody((await rig(routes).call("github_checks", { project: "alpha", pr: 7 })).text).rollup;
    expect(await rollup(checkRoutes([run("a", "success"), run("b", "skipped")]))).toBe("passing");
    expect(await rollup(checkRoutes([run("a", "success"), run("b", "failure")]))).toBe("failing");
    expect(await rollup(checkRoutes([run("a", "success"), run("b", null)]))).toBe("pending");
    expect(await rollup(checkRoutes([run("a", "success")], 45))).toBe("incomplete");
    expect(await rollup(checkRoutes([]))).toBe("none");
    expect(await rollup(checkRoutes([run("a", "success", MOVED)]))).toBe("stale");
    expect(await rollup(checkRoutes([run("a", "success")], 1, { total_count: 1, state: "failure", statuses: [{ context: "ci", state: "failure" }] }))).toBe("failing");
  });

  test("commit statuses paginate and drop off-repository target URLs", async () => {
    const entries = Array.from({ length: 30 }, (_, n) => ({ context: `ci-${n}`, state: "success", target_url: n === 0 ? "https://evil.example/x" : `${URL_BASE}/runs/${n}` }));
    const routes = checkRoutes([run("a", "success")], 1, { total_count: 45, state: "success", statuses: entries });
    const first = toolBody((await rig(routes).call("github_checks", { project: "alpha", pr: 7 })).text) as { rollup: string; readAll: boolean; commitStatuses: { nextPage: number | null; entries: { targetUrl: string | null }[] } };
    expect(first.rollup).toBe("incomplete");
    expect(first.readAll).toBe(false);
    expect(first.commitStatuses.nextPage).toBe(2);
    expect(first.commitStatuses.entries[0]?.targetUrl).toBeNull();
    const second = toolBody((await rig(routes).call("github_checks", { project: "alpha", pr: 7, statusPage: 2 })).text) as { commitStatuses: { page: number } };
    expect(second.commitStatuses.page).toBe(2);
  });

  test("checks for a pull request whose head moved are withheld, not reported as current", async () => {
    let heads = 0;
    const routes = checkRoutes([run("a", "success")]);
    routes["repos/example/alpha/pulls/7"] = () => pull(heads++ === 0 ? HEAD : MOVED);
    const result = toolBody((await rig(routes).call("github_checks", { project: "alpha", pr: 7 })).text);
    expect(result).toMatchObject({ status: "head-changed", headShaBefore: HEAD, headShaAfter: MOVED });
    expect(result.rollup).toBeUndefined();
  });

  test("failure modes stay distinct", async () => {
    const status = async (stderr: string) => toolBody((await rig({ "repos/example/alpha": fail(stderr) }).call("github_repository", { project: "alpha" })).text).status;
    expect(await status("To get started with GitHub CLI, please run:  gh auth login")).toBe("login-required");
    expect(await status("gh: Bad credentials (HTTP 401)")).toBe("login-required");
    expect(await status("gh: Resource not accessible by integration (HTTP 403)")).toBe("permission-denied");
    expect(await status("gh: API rate limit exceeded (HTTP 403)")).toBe("rate-limited");
    expect(await status("gh: Not Found (HTTP 404)")).toBe("not-found");
    expect(await status("gh: Bad Gateway (HTTP 502)")).toBe("provider-failure");
  });

  test("an unparseable response is a provider failure, not an empty success", async () => {
    const result = toolBody((await rig({ "repos/example/alpha": ok("<html>") }).call("github_repository", { project: "alpha" })).text);
    expect(result.status).toBe("provider-failure");
  });

  test("capabilities reports a missing login as provider-unavailable", async () => {
    const r = rig({ ...repoRoute, auth: fail("You are not logged into any GitHub hosts") });
    const caps = JSON.parse((await r.call("capabilities", {})).text.split("\n").slice(1, -2).join("\n")) as { sources: { project: string; tools: { tool: string; availability: string }[] }[] };
    const alpha = caps.sources.find(source => source.project === "alpha");
    expect(alpha?.tools.find(tool => tool.tool === "github_checks")?.availability).toBe("provider-unavailable");
    expect(caps.sources.find(source => source.project === "closed")?.tools.find(tool => tool.tool === "github_checks")?.availability).toBe("denied");
  });
});
