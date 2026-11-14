import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GITLAB_LISTING_FAILED_LINE, GraphRepositoryBody, LISTING_FAILED_LINE, gitlabHostFailedLine, repositoryGroups } from "../components/desk-graph-repositories";
import type { GitlabListing } from "../../desk/graph-repositories";
import { SettingsBody } from "../components/desk-settings";
import { loadGraphRepositories, saveGraphRepository, saveGraphRepositories } from "../lib/desk-graph-repositories";

const noop = (): void => undefined;
const repo = (name: string, enabled: boolean, extra: { listed?: false } = {}) => ({ ref: `github:github.com/${name}`, label: name, forge: "github", enabled, ...extra });
const project = (path: string, enabled: boolean, extra: { listed?: false } = {}, host = "gitlab.example.org") => ({ ref: `gitlab:${host}/${path}`, label: path, forge: "gitlab", enabled, ...extra });
const GITLAB_OK: GitlabListing = { ok: true, hosts: [{ host: "gitlab.example.org", ok: true }] };
const body = (rows: ReturnType<typeof repo>[] | null, listing: { ok: true } | { ok: false; reason: string } = { ok: true }, error: string | null = null, gitlab: GitlabListing = GITLAB_OK) =>
  renderToStaticMarkup(<GraphRepositoryBody rows={rows} listing={listing} gitlab={gitlab} error={error} busy={false} onChange={noop} />);
const section = (html: string, label: string): string => {
  const start = html.indexOf(`<section aria-label="${label}"`);
  if (start < 0) return "";
  const tags = /<section[\s>]|<\/section>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    depth += m[0] === "</section>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
};
const hostSection = (html: string, host: string): string => section(html, `GitLab projects on ${host}`);

describe("the repositories panel", () => {
  it("is a Settings page of its own with the panel title", () => {
    const none = { rows: [], note: null, onAdd: () => Promise.resolve(true), onRemove: noop };
    const html = renderToStaticMarkup(<SettingsBody group="graph-repositories" vips={none} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain('aria-selected="true" aria-controls="settings-panel-graph-repositories" tabindex="0"');
    expect(html).toContain("<h2>Repositories Assistant may file to</h2>");
  });

  it("shows one checkbox per repository, ticked as stored", () => {
    const html = body([repo("acme/api", false), repo("jcfischer/desk", true)]);
    expect(html).toMatch(/aria-label="Allow Assistant to file to acme\/api"(?![^>]*checked)/);
    expect(html).toMatch(/aria-label="Allow Assistant to file to jcfischer\/desk"[^>]*checked/);
    expect(html).not.toContain("not listed");
    expect(html).not.toContain(LISTING_FAILED_LINE);
  });

  it("marks a ticked repository the listing no longer returns, and keeps its checkbox", () => {
    const html = body([repo("gone/repo", true, { listed: false })]);
    expect(html).toContain("gone/repo<small>not listed</small>");
    expect(html).toMatch(/aria-label="Allow Assistant to file to gone\/repo"[^>]*checked/);
  });

  it("says in one sentence that the repositories could not be listed, and still shows the ticked ones", () => {
    const html = body([repo("jcfischer/desk", true)], { ok: false, reason: "gh: not logged in" });
    expect(html).toContain(LISTING_FAILED_LINE);
    expect(LISTING_FAILED_LINE.match(/\./g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Allow Assistant to file to jcfischer\/desk"[^>]*checked/);
    expect(html).not.toContain("No repositories found");
  });

  it("says so when nothing is listed and nothing is ticked, and shows a save error", () => {
    expect(body([])).toContain("No repositories found");
    expect(body([repo("acme/api", false)], { ok: true }, "Mission Control answered HTTP 500.")).toContain('role="alert">Mission Control answered HTTP 500.</p>');
    expect(body(null, { ok: true }, "Mission Control did not answer: offline")).toContain("Mission Control did not answer: offline");
    expect(body(null)).toContain("Loading…");
  });
});

describe("the GitLab section", () => {
  it("lists the GitLab projects in their own section below the GitHub section", () => {
    const html = body([project("claw/crisis-simulator", true), repo("jcfischer/desk", false)]);
    expect(html.indexOf('aria-label="GitHub repositories"')).toBeLessThan(html.indexOf('aria-label="GitLab projects"'));
    expect(section(html, "GitHub repositories")).toContain("Allow Assistant to file to jcfischer/desk");
    expect(section(html, "GitHub repositories")).not.toContain("claw/crisis-simulator");
    expect(section(html, "GitLab projects")).toMatch(/aria-label="Allow Assistant to file to claw\/crisis-simulator"[^>]*checked/);
  });

  it("says in one sentence that the projects could not be listed, and leaves the GitHub section unaffected", () => {
    const html = body([repo("jcfischer/desk", true)], { ok: true }, null, { ok: false, reason: "glab missing" });
    expect(section(html, "GitLab projects")).toContain(GITLAB_LISTING_FAILED_LINE);
    expect(GITLAB_LISTING_FAILED_LINE.match(/\./g)).toHaveLength(1);
    expect(section(html, "GitHub repositories")).not.toContain(GITLAB_LISTING_FAILED_LINE);
    expect(section(html, "GitHub repositories")).not.toContain(LISTING_FAILED_LINE);
    expect(section(html, "GitHub repositories")).toMatch(/aria-label="Allow Assistant to file to jcfischer\/desk"[^>]*checked/);
  });

  it("shows one group per logged-in host, headed by the host name, and says in one sentence that a failing host could not be listed", () => {
    const gitlab: GitlabListing = { ok: true, hosts: [{ host: "a.example.org", ok: true }, { host: "b.example.org", ok: true }, { host: "c.example.org", ok: false, reason: "502" }] };
    const html = body([project("g/p", true, {}, "a.example.org"), project("team/tool", false, {}, "b.example.org"), project("g/ticked", true, {}, "c.example.org"), repo("jcfischer/desk", true)], { ok: true }, null, gitlab);
    expect(hostSection(html, "a.example.org")).toContain("<h4>a.example.org</h4>");
    expect(hostSection(html, "a.example.org")).toMatch(/aria-label="Allow Assistant to file to g\/p"[^>]*checked/);
    expect(hostSection(html, "a.example.org")).not.toContain("team/tool");
    expect(hostSection(html, "b.example.org")).toMatch(/aria-label="Allow Assistant to file to team\/tool"(?![^>]*checked)/);
    expect(hostSection(html, "c.example.org")).toContain(gitlabHostFailedLine("c.example.org"));
    expect(gitlabHostFailedLine("c.example.org").replaceAll("c.example.org", "").match(/\./g)).toHaveLength(1);
    expect(hostSection(html, "c.example.org")).toMatch(/aria-label="Allow Assistant to file to g\/ticked"[^>]*checked/);
    for (const host of ["a.example.org", "b.example.org"]) expect(hostSection(html, host)).not.toContain("could not be listed");
    expect(html).not.toContain(GITLAB_LISTING_FAILED_LINE);
    expect(section(html, "GitHub repositories")).toMatch(/aria-label="Allow Assistant to file to jcfischer\/desk"[^>]*checked/);
    expect(section(html, "GitHub repositories")).not.toContain("could not be listed");
  });

  it("keeps a ticked project on a host that is not logged in, in a group of its own, so it can be unticked", () => {
    const html = body([project("g/p", true, { listed: false }, "gitlab.com")]);
    expect(hostSection(html, "gitlab.com")).toContain("g/p<small>not listed</small>");
    expect(hostSection(html, "gitlab.example.org")).toContain("No projects found for your GitLab account on gitlab.example.org.");
  });

  it("says so when the host has no projects", () => {
    expect(hostSection(body([repo("jcfischer/desk", false)]), "gitlab.example.org")).toContain("No projects found for your GitLab account on gitlab.example.org.");
  });
});

describe("the repository requests", () => {
  it("reads the listing", async () => {
    const reply = { repositories: [repo("acme/api", true), { nonsense: true }], listing: { ok: false, reason: "no gh" } };
    const seen: string[] = [];
    const fake = (path: string, init: RequestInit) => { seen.push(`${init.method} ${path}`); return Promise.resolve(Response.json(reply)); };
    expect(await loadGraphRepositories(fake)).toEqual({ ok: true, repositories: [repo("acme/api", true)], listing: { ok: false, reason: "no gh" }, gitlab: { ok: false, reason: "" } });
    expect(seen).toEqual(["GET /api/desk/graph-repositories"]);
  });

  it("reads the GitLab listing", async () => {
    const read = async (gitlab: unknown) => {
      const r = await loadGraphRepositories(() => Promise.resolve(Response.json({ repositories: [], listing: { ok: true }, gitlab })));
      return r.ok ? r.gitlab : null;
    };
    const listed: GitlabListing = { ok: true, hosts: [{ host: "a.example.org", ok: true }, { host: "b.example.org", ok: false, reason: "502" }] };
    expect(await read(listed)).toEqual(listed);
    expect(await read({ ok: true, hosts: [{ host: "a.example.org", ok: "yes" }, { ok: true }, null, { host: "" }] })).toEqual({ ok: true, hosts: [{ host: "a.example.org", ok: false, reason: "" }] });
    expect(await read({ ok: false, reason: "glab missing" })).toEqual({ ok: false, reason: "glab missing" });
    expect(await read({ ok: true, host: "gitlab.example.org" })).toEqual({ ok: false, reason: "" });
    expect(await read(undefined)).toEqual({ ok: false, reason: "" });
  });

  it("returns the server's reason, or one line, when the listing cannot be read", async () => {
    expect(await loadGraphRepositories(() => Promise.resolve(Response.json({ error: "denied" }, { status: 403 })))).toEqual({ ok: false, text: "denied" });
    expect(await loadGraphRepositories(() => Promise.resolve(new Response("{}", { status: 500 })))).toEqual({ ok: false, text: "Mission Control answered HTTP 500." });
    expect(await loadGraphRepositories(() => Promise.reject(new Error("offline")))).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });

  it("saves a tick with the reference encoded into the path", async () => {
    const seen: { path: string; method: string | undefined; body: unknown }[] = [];
    const fake = (path: string, init: RequestInit) => { seen.push({ path, method: init.method, body: JSON.parse(typeof init.body === "string" ? init.body : "") }); return Promise.resolve(Response.json({})); };
    expect(await saveGraphRepository("github:github.com/jcfischer/desk", true, fake)).toEqual({ ok: true });
    expect(seen).toEqual([{ path: "/api/desk/graph-repositories/github%3Agithub.com%2Fjcfischer%2Fdesk", method: "PUT", body: { enabled: true } }]);
    expect(await saveGraphRepository("x", false, () => Promise.resolve(Response.json({ error: "no" }, { status: 400 })))).toEqual({ ok: false, text: "no" });
    expect(await saveGraphRepository("x", false, () => Promise.reject(new Error("offline")))).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });
});


describe("repository organisation selection", () => {
  it("offers search and groups canonical owners while keeping each forge and host separate", () => {
    const html = body([repo("alpha/api", true), repo("alpha/web", false), repo("beta/tool", false), project("alpha/api", false, {}, "a.example.org"), project("alpha/sub/tool", true, {}, "b.example.org")]);
    expect(html).toContain('type="search"');
    const github = section(html, "GitHub organisation alpha");
    expect(github).toContain('aria-label="Select all repositories in alpha on GitHub"');
    expect(github).toContain('aria-checked="mixed"');
    expect(github).toContain("Select all 2 repositories");
    expect(github).not.toContain("beta/tool");
    expect(section(html, "GitLab a.example.org organisation alpha")).toContain("alpha/api");
    expect(section(html, "GitLab b.example.org organisation alpha")).toContain("alpha/sub/tool");
    expect(html).toContain("including those hidden by search");
  });
  it("filters live by name, owner or reference without shrinking the organisation selection scope", () => {
    const api = repo("alpha/api", true);
    const tool = repo("beta/tool", true);
    const rows = [api, repo("alpha/web", false), tool];
    const found = repositoryGroups(rows, " API ");
    expect(found.map(group => [group.owner, group.visible.map(row => row.ref)])).toEqual([["alpha", [api.ref]]]);
    expect(found[0]?.rows).toEqual(rows.slice(0, 2));
    expect(repositoryGroups(rows, "ALPHA")[0]?.visible).toEqual(rows.slice(0, 2));
    expect(repositoryGroups(rows, "github.com/beta")[0]?.visible).toEqual([tool]);
    expect(repositoryGroups(rows, "missing")).toEqual([]);
    expect(repositoryGroups(rows, "").flatMap(group => group.visible)).toEqual(rows);
    expect(rows.map(row => row.enabled)).toEqual([true, false, true]);
  });
  it("uses the canonical namespace for nested GitLab projects and keeps unlisted saved repositories", () => {
    const gone = repo("gone/tool", true, { listed: false });
    const rows = [project("alpha/sub/tool", true), project("alpha/api", false), gone];
    expect(repositoryGroups(rows, "alpha")[0]).toMatchObject({ owner: "alpha", rows: rows.slice(0, 2) });
    expect(repositoryGroups(rows, "gone")[0]?.visible).toEqual([gone]);
  });
  it("serializes group saves, reports only persisted rows and keeps going after a partial failure", async () => {
    const refs = ["github:github.com/alpha/api", "github:github.com/alpha/web", "github:github.com/alpha/tool"] as const;
    const saved: string[] = [];
    const calls: string[] = [];
    let pending = 0;
    let maxPending = 0;
    const result = await saveGraphRepositories([...refs, refs[0]], true, ref => { saved.push(ref); }, async path => {
      pending++;
      maxPending = Math.max(pending, maxPending);
      const ref = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      calls.push(ref);
      if (ref === refs[1]) expect(saved).toEqual([refs[0]]);
      await Promise.resolve();
      pending--;
      return ref === refs[1] ? Response.json({ error: "Save refused" }, { status: 503 }) : Response.json({});
    });
    expect(calls).toEqual([...refs]);
    expect(maxPending).toBe(1);
    expect(saved).toEqual([refs[0], refs[2]]);
    expect(result).toEqual({ ok: false, text: `1 of 3 repository changes could not be saved. ${refs[1]}: Save refused` });
  });
  it("persists deselection and leaves transport failures unconfirmed", async () => {
    const changed: string[] = [];
    expect(await saveGraphRepositories(["github:github.com/alpha/api"], false, ref => { changed.push(ref); }, (_path, init) => {
      expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual({ enabled: false });
      return Promise.resolve(Response.json({}));
    })).toEqual({ ok: true });
    expect(changed).toEqual(["github:github.com/alpha/api"]);
    const result = await saveGraphRepositories(["github:github.com/alpha/web"], true, ref => { changed.push(ref); }, () => Promise.reject(new Error("Offline")));
    expect(result.ok).toBe(false);
    expect(changed).toEqual(["github:github.com/alpha/api"]);
  });
});
