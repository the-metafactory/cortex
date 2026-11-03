import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphRepositoryBody, LISTING_FAILED_LINE } from "../components/desk-graph-repositories";
import { SettingsBody } from "../components/desk-settings";
import { loadGraphRepositories, saveGraphRepository } from "../lib/desk-graph-repositories";

const noop = (): void => {};
const repo = (name: string, enabled: boolean, extra: { listed?: false } = {}) => ({ ref: `github:github.com/${name}`, label: name, forge: "github", enabled, ...extra });
const body = (rows: ReturnType<typeof repo>[] | null, listing: { ok: true } | { ok: false; reason: string } = { ok: true }, error: string | null = null) =>
  renderToStaticMarkup(<GraphRepositoryBody rows={rows} listing={listing} error={error} busy={false} onChange={noop} />);

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

describe("the repository requests", () => {
  it("reads the listing", async () => {
    const reply = { repositories: [repo("acme/api", true), { nonsense: true }], listing: { ok: false, reason: "no gh" } };
    const seen: string[] = [];
    const fake = async (path: string, init: RequestInit) => { seen.push(`${init.method} ${path}`); return Response.json(reply); };
    expect(await loadGraphRepositories(fake)).toEqual({ ok: true, repositories: [repo("acme/api", true)], listing: { ok: false, reason: "no gh" } });
    expect(seen).toEqual(["GET /api/desk/graph-repositories"]);
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
