import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskGraphRepositories, type DeskGraphRepositoryDeps } from "../api/desk-graph-repositories";
import { githubRef, isGraphRepositoryAllowed, listGraphRepositories, type GraphRepositoryRunner } from "../desk/graph-repositories";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";
import { TABLE_NAMES } from "../db/schema";

const NOW = Date.parse("2026-11-03T09:00:00.000Z");
const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "" });
const gh = (stdout: string): GraphRepositoryRunner & { calls: { argv: string[]; timeoutMs: number }[] } => {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  const run = Object.assign(async (argv: string[], timeoutMs: number) => { calls.push({ argv, timeoutMs }); return ok(stdout); }, { calls });
  return run;
};

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
    });
    expect(run.calls).toEqual([{ argv: ["gh", "api", "--paginate", "user/repos?affiliation=owner,organization_member", "--jq", ".[].full_name"], timeoutMs: 30_000 }]);
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

  it("unticks a stored row of any shape, but ticks only a GitHub repository reference", async () => {
    db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run("gitlab:gitlab.com/g/p", NOW);
    expect((await put("gitlab:gitlab.com/g/p", false)).status).toBe(200);
    expect(rows()).toEqual([]);
    for (const bad of ["jcfischer/desk", "github:github.com/jcfischer", "github:github.com/a/b/c", "github:github.com/a/b c", "gitlab:gitlab.com/g/p"]) {
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
