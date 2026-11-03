import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GITLAB_LISTING_FAILED_LINE, GITLAB_SEVERAL_HOSTS_LINE, GraphRepositoryBody, LISTING_FAILED_LINE } from "../components/desk-graph-repositories";
import type { GitlabListing } from "../../desk/graph-repositories";
import { SettingsBody } from "../components/desk-settings";
import { loadGraphRepositories, saveGraphRepository } from "../lib/desk-graph-repositories";

const noop = (): void => {};
const repo = (name: string, enabled: boolean, extra: { listed?: false } = {}) => ({ ref: `github:github.com/${name}`, label: name, forge: "github", enabled, ...extra });
const project = (path: string, enabled: boolean, extra: { listed?: false } = {}) => ({ ref: `gitlab:gitlab.example.org/${path}`, label: path, forge: "gitlab", enabled, ...extra });
const GITLAB_OK: GitlabListing = { ok: true, host: "gitlab.example.org" };
const body = (rows: ReturnType<typeof repo>[] | null, listing: { ok: true } | { ok: false; reason: string } = { ok: true }, error: string | null = null, gitlab: GitlabListing = GITLAB_OK) =>
  renderToStaticMarkup(<GraphRepositoryBody rows={rows} listing={listing} gitlab={gitlab} error={error} busy={false} onChange={noop} />);
const section = (html: string, label: string): string => {
  const start = html.indexOf(`<section aria-label="${label}">`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};

describe("the repositories panel", () => {
  it("is a Settings page of its own with the panel title", () => {
    const none = { rows: [], note: null, onAdd: async () => true, onRemove: noop };
    const html = renderToStaticMarkup(<SettingsBody group="graph-repositories" vips={none} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain('aria-selected="true" aria-controls="settings-panel-graph-repositories" tabindex="0"');
    expect(html).toContain("<h2>Repositories Ivy may file to</h2>");
  });

  it("shows one checkbox per repository, ticked as stored", () => {
    const html = body([repo("acme/api", false), repo("jcfischer/desk", true)]);
    expect(html).toMatch(/aria-label="Allow Ivy to file to acme\/api"(?![^>]*checked)/);
    expect(html).toMatch(/aria-label="Allow Ivy to file to jcfischer\/desk"[^>]*checked/);
    expect(html).not.toContain("not listed");
    expect(html).not.toContain(LISTING_FAILED_LINE);
  });

  it("marks a ticked repository the listing no longer returns, and keeps its checkbox", () => {
    const html = body([repo("gone/repo", true, { listed: false })]);
    expect(html).toContain("gone/repo<small>not listed</small>");
    expect(html).toMatch(/aria-label="Allow Ivy to file to gone\/repo"[^>]*checked/);
  });

  it("says in one sentence that the repositories could not be listed, and still shows the ticked ones", () => {
    const html = body([repo("jcfischer/desk", true)], { ok: false, reason: "gh: not logged in" });
    expect(html).toContain(LISTING_FAILED_LINE);
    expect(LISTING_FAILED_LINE.match(/\./g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Allow Ivy to file to jcfischer\/desk"[^>]*checked/);
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
    expect(section(html, "GitHub repositories")).toContain("Allow Ivy to file to jcfischer/desk");
    expect(section(html, "GitHub repositories")).not.toContain("claw/crisis-simulator");
    expect(section(html, "GitLab projects")).toMatch(/aria-label="Allow Ivy to file to claw\/crisis-simulator"[^>]*checked/);
  });

  it("says in one sentence that the projects could not be listed, and leaves the GitHub section unaffected", () => {
    const html = body([repo("jcfischer/desk", true)], { ok: true }, null, { ok: false, kind: "unavailable", reason: "glab missing" });
    expect(section(html, "GitLab projects")).toContain(GITLAB_LISTING_FAILED_LINE);
    expect(GITLAB_LISTING_FAILED_LINE.match(/\./g)).toHaveLength(1);
    expect(section(html, "GitHub repositories")).not.toContain(GITLAB_LISTING_FAILED_LINE);
    expect(section(html, "GitHub repositories")).not.toContain(LISTING_FAILED_LINE);
    expect(section(html, "GitHub repositories")).toMatch(/aria-label="Allow Ivy to file to jcfischer\/desk"[^>]*checked/);
  });

  it("says several GitLab hosts are not supported yet, and keeps a ticked project so it can be unticked", () => {
    const html = body([project("g/p", true)], { ok: true }, null, { ok: false, kind: "several-hosts", reason: "a, b" });
    expect(section(html, "GitLab projects")).toContain(GITLAB_SEVERAL_HOSTS_LINE);
    expect(GITLAB_SEVERAL_HOSTS_LINE.match(/\./g)).toHaveLength(1);
    expect(section(html, "GitLab projects")).toMatch(/aria-label="Allow Ivy to file to g\/p"[^>]*checked/);
  });

  it("says so when the host has no projects", () => {
    expect(section(body([repo("jcfischer/desk", false)]), "GitLab projects")).toContain("No projects found for your GitLab account on gitlab.example.org.");
  });
});

describe("the repository requests", () => {
  it("reads the listing", async () => {
    const reply = { repositories: [repo("acme/api", true), { nonsense: true }], listing: { ok: false, reason: "no gh" } };
    const seen: string[] = [];
    const fake = async (path: string, init: RequestInit) => { seen.push(`${init.method} ${path}`); return Response.json(reply); };
    expect(await loadGraphRepositories(fake)).toEqual({ ok: true, repositories: [repo("acme/api", true)], listing: { ok: false, reason: "no gh" }, gitlab: { ok: false, kind: "unavailable", reason: "" } });
    expect(seen).toEqual(["GET /api/desk/graph-repositories"]);
  });

  it("reads the GitLab listing", async () => {
    const read = async (gitlab: unknown) => {
      const r = await loadGraphRepositories(async () => Response.json({ repositories: [], listing: { ok: true }, gitlab }));
      return r.ok ? r.gitlab : null;
    };
    expect(await read({ ok: true, host: "gitlab.example.org" })).toEqual({ ok: true, host: "gitlab.example.org" });
    expect(await read({ ok: false, kind: "several-hosts", reason: "a, b" })).toEqual({ ok: false, kind: "several-hosts", reason: "a, b" });
    expect(await read({ ok: false, kind: "bogus" })).toEqual({ ok: false, kind: "unavailable", reason: "" });
    expect(await read({ ok: true })).toEqual({ ok: false, kind: "unavailable", reason: "" });
  });

  it("returns the server's reason, or one line, when the listing cannot be read", async () => {
    expect(await loadGraphRepositories(async () => Response.json({ error: "denied" }, { status: 403 }))).toEqual({ ok: false, text: "denied" });
    expect(await loadGraphRepositories(async () => new Response("{}", { status: 500 }))).toEqual({ ok: false, text: "Mission Control answered HTTP 500." });
    expect(await loadGraphRepositories(async () => { throw new Error("offline"); })).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });

  it("saves a tick with the reference encoded into the path", async () => {
    const seen: { path: string; method: string | undefined; body: unknown }[] = [];
    const fake = async (path: string, init: RequestInit) => { seen.push({ path, method: init.method, body: JSON.parse(String(init.body)) }); return Response.json({}); };
    expect(await saveGraphRepository("github:github.com/jcfischer/desk", true, fake)).toEqual({ ok: true });
    expect(seen).toEqual([{ path: "/api/desk/graph-repositories/github%3Agithub.com%2Fjcfischer%2Fdesk", method: "PUT", body: { enabled: true } }]);
    expect(await saveGraphRepository("x", false, async () => Response.json({ error: "no" }, { status: 400 }))).toEqual({ ok: false, text: "no" });
    expect(await saveGraphRepository("x", false, async () => { throw new Error("offline"); })).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });
});
