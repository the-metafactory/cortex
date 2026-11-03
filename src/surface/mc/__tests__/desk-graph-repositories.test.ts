import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskGraphRepositories, type DeskGraphRepositoryDeps } from "../api/desk-graph-repositories";
import { githubRef, gitlabRef, isGraphRepositoryAllowed, listGraphRepositories, type GitlabListing, type GraphRepositoryRunner } from "../desk/graph-repositories";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";
import { TABLE_NAMES } from "../db/schema";

const NOW = Date.parse("2026-11-03T09:00:00.000Z");
const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "" });
type Reply = { code: number; signal: null; stdout: string; stderr: string } | Error;
const GLAB_STATUS = ["glab", "auth", "status"];
const glabList = (host: string) => ["glab", "api", "--hostname", host, "--paginate", "projects?membership=true&simple=true"];
const loggedIn = (...hosts: string[]): Reply => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: ["gitlab.com", "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}", ...hosts.flatMap((h) => [h, `  ✓ Logged in to ${h} as jcfischer (/Users/x/config.yml)`, "  ✓ Token found: ****"])].join("\n"),
});
const projects = (...paths: string[]): Reply => ok(JSON.stringify(paths.map((p, i) => ({ id: i + 1, name: p.split("/").at(-1), path_with_namespace: p }))));
const NO_GLAB = new Error("Executable not found in $PATH: \"glab\"");
const forges = (replies: { gh?: Reply; glabStatus?: Reply; glab?: Reply; glabByHost?: Record<string, Reply> }): GraphRepositoryRunner & { calls: { argv: string[]; timeoutMs: number }[] } => {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  const glabFor = (host: string): Reply => replies.glabByHost?.[host] ?? replies.glab ?? NO_GLAB;
  const run = Object.assign(async (argv: string[], timeoutMs: number) => {
    calls.push({ argv, timeoutMs });
    const reply = argv[0] === "gh" ? replies.gh ?? ok("") : argv[1] === "auth" ? replies.glabStatus ?? NO_GLAB : glabFor(argv[3] ?? "");
    if (reply instanceof Error) throw reply;
    return reply;
  }, { calls });
  return run;
};
const gh = (stdout: string) => forges({ gh: ok(stdout) });

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const call = (path: string, method: string, deps: DeskGraphRepositoryDeps, body?: unknown): Promise<Response> =>
  handleDeskGraphRepositories(new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1${path}`), db, { now: () => NOW, ...deps });

const put = (ref: string, enabled: unknown, deps: DeskGraphRepositoryDeps = {}): Promise<Response> => call(`/api/desk/graph-repositories/${encodeURIComponent(ref)}`, "PUT", deps, { enabled });

describe("isGraphRepositoryAllowed", () => {
  it("allows nothing while the table is empty", () => {
    expect(isGraphRepositoryAllowed(db, githubRef("jcfischer/desk"))).toBe(false);
    expect(isGraphRepositoryAllowed(db, "")).toBe(false);
  });

  it("allows only a ref that matches a stored row exactly, with no normalisation", () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run("github:github.com/jcfischer/desk", NOW);
    expect(isGraphRepositoryAllowed(db, "github:github.com/jcfischer/desk")).toBe(true);
    for (const other of ["github:github.com/JCFischer/desk", "github:github.com/jcfischer/desk/", " github:github.com/jcfischer/desk", "github.com/jcfischer/desk", "github:github.com/jcfischer/desk2", "gitlab:gitlab.com/jcfischer/desk", "jcfischer/desk", "%"]) {
      expect(isGraphRepositoryAllowed(db, other)).toBe(false);
    }
  });

  it("is a table Mission Control creates", () => {
    expect(TABLE_NAMES).toContain("desk_graph_repositories");
  });
});

describe("GET /api/desk/graph-repositories", () => {
  it("lists every repository from gh, sorted by label, with the stored ticks", async () => {
    const run = gh("zeta/last\njcfischer/desk\nacme/api\n");
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(githubRef("jcfischer/desk"), NOW);
    const res = await call("/api/desk/graph-repositories", "GET", { run });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        { ref: "github:github.com/acme/api", label: "acme/api", forge: "github", enabled: false },
        { ref: "github:github.com/jcfischer/desk", label: "jcfischer/desk", forge: "github", enabled: true },
        { ref: "github:github.com/zeta/last", label: "zeta/last", forge: "github", enabled: false },
      ],
      listing: { ok: true },
      gitlab: { ok: false, reason: "Executable not found in $PATH: \"glab\"" },
    });
    expect(run.calls[0]).toEqual({ argv: ["gh", "api", "--paginate", "user/repos?affiliation=owner,organization_member", "--jq", ".[].full_name"], timeoutMs: 30_000 });
  });

  it("keeps a ticked repository the listing no longer returns, marked not listed", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(githubRef("gone/repo"), NOW);
    const view = await listGraphRepositories(db, gh("acme/api\n"));
    expect(view.repositories).toEqual([
      { ref: "github:github.com/acme/api", label: "acme/api", forge: "github", enabled: false },
      { ref: "github:github.com/gone/repo", label: "gone/repo", forge: "github", enabled: true, listed: false },
    ]);
  });

  it("still shows the ticked repositories, and says why nothing else is listed, when gh fails", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(githubRef("jcfischer/desk"), NOW);
    const failing: GraphRepositoryRunner = async () => ({ code: 4, signal: null, stdout: "", stderr: "gh: To use GitHub CLI, run: gh auth login\nmore" });
    const view = await listGraphRepositories(db, failing);
    expect(view.listing).toEqual({ ok: false, reason: "gh: To use GitHub CLI, run: gh auth login" });
    expect(view.repositories).toEqual([{ ref: "github:github.com/jcfischer/desk", label: "jcfischer/desk", forge: "github", enabled: true }]);
  });

  it("treats a missing gh binary as a listing failure, not a server error", async () => {
    const missing: GraphRepositoryRunner = async () => { throw new Error("Executable not found in $PATH: \"gh\""); };
    const res = await call("/api/desk/graph-repositories", "GET", { run: missing });
    expect(res.status).toBe(200);
    const body = await res.json() as { repositories: unknown[]; listing: { ok: boolean } };
    expect(body.listing.ok).toBe(false);
    expect(body.repositories).toEqual([]);
  });

  it("refuses other methods on the listing", async () => {
    expect((await call("/api/desk/graph-repositories", "POST", {}, {})).status).toBe(405);
  });
});

describe("the GitLab projects in the listing", () => {
  it("adds every project of the one logged-in host as a gitlab row, beside the GitHub rows", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(gitlabRef("gitlab.switch.ch", "claw/crisis-simulator"), NOW);
    const run = forges({ gh: ok("jcfischer/desk\n"), glabStatus: loggedIn("gitlab.switch.ch"), glab: projects("claw/crisis-simulator", "community-soc/detection-rules/sigma") });
    const res = await call("/api/desk/graph-repositories", "GET", { run });
    expect(await res.json()).toEqual({
      repositories: [
        { ref: "gitlab:gitlab.switch.ch/claw/crisis-simulator", label: "claw/crisis-simulator", forge: "gitlab", enabled: true },
        { ref: "gitlab:gitlab.switch.ch/community-soc/detection-rules/sigma", label: "community-soc/detection-rules/sigma", forge: "gitlab", enabled: false },
        { ref: "github:github.com/jcfischer/desk", label: "jcfischer/desk", forge: "github", enabled: false },
      ],
      listing: { ok: true },
      gitlab: { ok: true, hosts: [{ host: "gitlab.switch.ch", ok: true }] },
    });
    expect(run.calls.filter((c) => c.argv[0] === "glab")).toEqual([{ argv: GLAB_STATUS, timeoutMs: 30_000 }, { argv: glabList("gitlab.switch.ch"), timeoutMs: 30_000 }]);
  });

  it("lists the projects although glab auth status exits non-zero for another, failing host", async () => {
    const view = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.example.org"), glab: projects("g/p") }));
    expect(view.gitlab).toEqual({ ok: true, hosts: [{ host: "gitlab.example.org", ok: true }] });
    expect(view.repositories.map((r) => r.ref)).toEqual(["gitlab:gitlab.example.org/g/p"]);
  });

  it("lists the projects of every logged-in host, reports a failing host on its own, and never asks a host without a login", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(gitlabRef("a.example.org", "g/p"), NOW);
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(gitlabRef("c.example.org", "g/ticked"), NOW);
    const run = forges({
      gh: ok("jcfischer/desk\n"),
      glabStatus: loggedIn("c.example.org", "b.example.org", "a.example.org"),
      glabByHost: { "a.example.org": projects("g/p", "g/q"), "b.example.org": projects("team/tool"), "c.example.org": { code: 1, signal: null, stdout: "", stderr: "glab: 502 Bad Gateway\nmore" } },
    });
    const res = await call("/api/desk/graph-repositories", "GET", { run });
    expect(await res.json()).toEqual({
      repositories: [
        { ref: "gitlab:a.example.org/g/p", label: "g/p", forge: "gitlab", enabled: true },
        { ref: "gitlab:a.example.org/g/q", label: "g/q", forge: "gitlab", enabled: false },
        { ref: "gitlab:c.example.org/g/ticked", label: "g/ticked", forge: "gitlab", enabled: true },
        { ref: "github:github.com/jcfischer/desk", label: "jcfischer/desk", forge: "github", enabled: false },
        { ref: "gitlab:b.example.org/team/tool", label: "team/tool", forge: "gitlab", enabled: false },
      ],
      listing: { ok: true },
      gitlab: { ok: true, hosts: [{ host: "a.example.org", ok: true }, { host: "b.example.org", ok: true }, { host: "c.example.org", ok: false, reason: "glab: 502 Bad Gateway" }] },
    });
    expect(run.calls.filter((c) => c.argv[0] === "glab").map((c) => c.argv)).toEqual([GLAB_STATUS, glabList("a.example.org"), glabList("b.example.org"), glabList("c.example.org")]);
    expect(run.calls.some((c) => c.argv.includes("gitlab.com"))).toBe(false);
  });

  it("reads every page that glab --paginate prints back to back", async () => {
    const page = (...paths: string[]) => JSON.stringify(paths.map((p) => ({ path_with_namespace: p, description: "a ][ b \"q\" [c]" })));
    const view = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.example.org"), glab: ok(`${page("g/one", "g/two")}${page("g/three")}\n`) }));
    expect(view.repositories.map((r) => r.label)).toEqual(["g/one", "g/three", "g/two"]);
    expect(view.gitlab).toEqual({ ok: true, hosts: [{ host: "gitlab.example.org", ok: true }] });
  });

  it("allows a ticked project on any host by exact reference, and refuses a host that was never ticked", async () => {
    const ref = gitlabRef("b.example.org", "team/tool");
    expect((await put(ref, true)).status).toBe(200);
    expect(isGraphRepositoryAllowed(db, ref)).toBe(true);
    expect(isGraphRepositoryAllowed(db, gitlabRef("a.example.org", "team/tool"))).toBe(false);
    expect(isGraphRepositoryAllowed(db, gitlabRef("gitlab.com", "team/tool"))).toBe(false);
  });

  it("marks a ticked project on a host that is not logged in as not listed", async () => {
    const ref = gitlabRef("gitlab.com", "g/p");
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(ref, NOW);
    const view = await listGraphRepositories(db, forges({ glabStatus: loggedIn("a.example.org"), glab: projects() }));
    expect(view.repositories).toEqual([{ ref, label: "g/p", forge: "gitlab", enabled: true, listed: false }]);
  });

  it("reports GitLab as unavailable, and leaves the GitHub rows alone, when glab is missing, not logged in or fails", async () => {
    const notLoggedIn: Reply = { code: 1, signal: null, stdout: "", stderr: "gitlab.com\n  x gitlab.com: API call failed\n  ! No token found" };
    const failing: Reply = { code: 1, signal: null, stdout: "", stderr: "glab: 401 Unauthorized\nmore" };
    const host = (reason: string): GitlabListing => ({ ok: true, hosts: [{ host: "gitlab.example.org", ok: false, reason }] });
    const cases: [Parameters<typeof forges>[0], GitlabListing][] = [
      [{}, { ok: false, reason: "Executable not found in $PATH: \"glab\"" }],
      [{ glabStatus: notLoggedIn }, { ok: false, reason: "glab is not logged in to any GitLab host" }],
      [{ glabStatus: loggedIn("gitlab.example.org"), glab: failing }, host("glab: 401 Unauthorized")],
      [{ glabStatus: loggedIn("gitlab.example.org"), glab: ok("not json") }, host("glab did not return a project list")],
      [{ glabStatus: loggedIn("gitlab.example.org"), glab: ok("{}") }, host("glab did not return a project list")],
      [{ glabStatus: loggedIn("gitlab.example.org"), glab: ok("[{\"path_with_namespace\":\"g/p\"}") }, host("glab did not return a project list")],
      [{ glabStatus: loggedIn("gitlab.example.org"), glab: ok("") }, host("glab did not return a project list")],
    ];
    for (const [replies, gitlab] of cases) {
      const view = await listGraphRepositories(db, forges({ gh: ok("jcfischer/desk\n"), ...replies }));
      expect(view.gitlab).toEqual(gitlab);
      expect(view.listing).toEqual({ ok: true });
      expect(view.repositories).toEqual([{ ref: "github:github.com/jcfischer/desk", label: "jcfischer/desk", forge: "github", enabled: false }]);
    }
  });

  it("keeps a ticked project the listing no longer returns, marked not listed, and does not mark it while its host cannot be listed", async () => {
    const ref = gitlabRef("gitlab.example.org", "gone/project");
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(ref, NOW);
    const listed = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.example.org"), glab: projects() }));
    expect(listed.repositories).toEqual([{ ref, label: "gone/project", forge: "gitlab", enabled: true, listed: false }]);
    const unlisted = await listGraphRepositories(db, forges({}));
    expect(unlisted.repositories).toEqual([{ ref, label: "gone/project", forge: "gitlab", enabled: true }]);
    const hostFailed = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.example.org", "other.example.org"), glabByHost: { "other.example.org": projects() } }));
    expect(hostFailed.repositories).toEqual([{ ref, label: "gone/project", forge: "gitlab", enabled: true }]);
  });

  it("skips project entries without a usable path", async () => {
    const odd = ok(JSON.stringify([{ path_with_namespace: "g/ok" }, { path_with_namespace: "solo" }, { path_with_namespace: 7 }, null, { name: "x" }, { path_with_namespace: "g/has space" }]));
    const view = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.example.org"), glab: odd }));
    expect(view.repositories.map((r) => r.label)).toEqual(["g/ok"]);
  });

  it("ticks a listed GitLab project, and the exact reference is then allowed", async () => {
    const ref = gitlabRef("gitlab.switch.ch", "claw/crisis-simulator");
    expect((await put(ref, true)).status).toBe(200);
    expect(isGraphRepositoryAllowed(db, ref)).toBe(true);
    for (const other of ["gitlab:gitlab.switch.ch/claw/crisis-simulator/", "gitlab:GITLAB.switch.ch/claw/crisis-simulator", "gitlab:gitlab.com/claw/crisis-simulator", "github:github.com/claw/crisis-simulator", "gitlab:gitlab.switch.ch/claw"]) {
      expect(isGraphRepositoryAllowed(db, other)).toBe(false);
    }
    const view = await listGraphRepositories(db, forges({ glabStatus: loggedIn("gitlab.switch.ch"), glab: projects("claw/crisis-simulator") }));
    expect(view.repositories).toEqual([{ ref, label: "claw/crisis-simulator", forge: "gitlab", enabled: true }]);
  });
});

describe("PUT /api/desk/graph-repositories/<encoded ref>", () => {
  const rows = (): string[] => db.query<{ ref: string }, []>("SELECT ref FROM desk_graph_repositories ORDER BY ref").all().map((r) => r.ref);

  it("inserts a row on tick and deletes it on untick, and a later listing shows the same ticks", async () => {
    const ref = githubRef("jcfischer/desk");
    const ticked = await put(ref, true);
    expect(await ticked.json()).toEqual({ ref, enabled: true });
    expect(rows()).toEqual([ref]);
    expect(db.query<{ enabled_at: number }, []>("SELECT enabled_at FROM desk_graph_repositories").get()?.enabled_at).toBe(NOW);
    expect(isGraphRepositoryAllowed(db, ref)).toBe(true);
    const listed = await (await call("/api/desk/graph-repositories", "GET", { run: gh("jcfischer/desk\n") })).json() as { repositories: { enabled: boolean }[] };
    expect(listed.repositories.map((r) => r.enabled)).toEqual([true]);

    expect((await put(ref, false)).status).toBe(200);
    expect(rows()).toEqual([]);
    expect(isGraphRepositoryAllowed(db, ref)).toBe(false);
  });

  it("is idempotent in both directions and keeps the first tick time", async () => {
    const ref = githubRef("jcfischer/desk");
    await put(ref, true);
    await call(`/api/desk/graph-repositories/${encodeURIComponent(ref)}`, "PUT", { now: () => NOW + 1000 }, { enabled: true });
    expect(db.query<{ enabled_at: number }, []>("SELECT enabled_at FROM desk_graph_repositories").all()).toEqual([{ enabled_at: NOW }]);
    expect((await put(githubRef("never/ticked"), false)).status).toBe(200);
    expect(rows()).toEqual([ref]);
  });

  it("unticks a stored row of any shape, but ticks only a GitHub repository or GitLab project reference", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run("svn:example.org/x", NOW);
    expect((await put("svn:example.org/x", false)).status).toBe(200);
    expect(rows()).toEqual([]);
    for (const bad of ["jcfischer/desk", "github:github.com/jcfischer", "github:github.com/a/b/c", "github:github.com/a/b c", "gitlab:gitlab.com/p", "gitlab:/g/p", "gitlab:gitlab.com/g//p", "gitlab:gitlab.com/g/p/", "gitlab:git lab.com/g/p", "gitlab:gitlab.com/g/p q", "svn:example.org/x"]) {
      expect((await put(bad, true)).status).toBe(400);
    }
    expect(rows()).toEqual([]);
  });

  it("refuses a body without a boolean enabled, an undecodable reference and other methods", async () => {
    const ref = githubRef("jcfischer/desk");
    for (const enabled of [undefined, "true", 1, null]) expect((await put(ref, enabled)).status).toBe(400);
    expect((await call("/api/desk/graph-repositories/%E0%A4%A", "PUT", {}, { enabled: true })).status).toBe(400);
    expect((await call(`/api/desk/graph-repositories/${encodeURIComponent(ref)}`, "GET", {})).status).toBe(405);
    expect((await call(`/api/desk/graph-repositories/${encodeURIComponent(ref)}`, "PUT", {})).status).toBe(400);
    expect((await call("/api/desk/graph-repositories/", "PUT", {}, { enabled: true })).status).toBe(404);
    expect(rows()).toEqual([]);
  });
});

describe("the route through the real server", () => {
  const ref = githubRef("jcfischer/desk");
  const put = (port: number, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/desk/graph-repositories/${encodeURIComponent(ref)}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ enabled: true }) });

  it("refuses a cross-origin or unauthorized tick and writes nothing", async () => {
    const context = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["allowed@example.org"], localPrincipal: "other@example.org" } }, db);
    try {
      expect((await put(context.port, { Origin: "https://untrusted.example.org" })).status).toBe(403);
      expect((await put(context.port)).status).toBe(403);
      expect(isGraphRepositoryAllowed(db, ref)).toBe(false);
    } finally { context.stop(true); }
  });

  it("accepts the tick from the local principal and persists it", async () => {
    const context = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["allowed@example.org"], localPrincipal: "allowed@example.org" } }, db);
    try {
      expect((await put(context.port)).status).toBe(200);
      expect(isGraphRepositoryAllowed(db, ref)).toBe(true);
    } finally { context.stop(true); }
  });
});
