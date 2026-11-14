// glossary-ignore: host
import { useEffect, useRef, useState } from "react";
import type { GitlabListing, GraphRepository, GraphRepositoryListing } from "../../desk/graph-repositories";
import { parseGitlabRef } from "../../desk/graph-repository-schema";
import { loadGraphRepositories, saveGraphRepositories } from "../lib/desk-graph-repositories";
import { useAssistantName } from "../lib/assistant-name";

export const LISTING_FAILED_LINE = "The GitHub repositories could not be listed; check that gh is installed and signed in.";
export const GITLAB_LISTING_FAILED_LINE = "The GitLab projects could not be listed; check that glab is installed and signed in.";
export const gitlabHostFailedLine = (host: string): string => `The projects on ${host} could not be listed; check that glab is still signed in to it.`;

const GITLAB_PENDING: GitlabListing = { ok: false, reason: "" };

export function GraphRepositorySettings({ active }: { active: boolean }) {
  const [rows, setRows] = useState<GraphRepository[] | null>(null);
  const [listing, setListing] = useState<GraphRepositoryListing>({ ok: true });
  const [gitlab, setGitlab] = useState<GitlabListing>(GITLAB_PENDING);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    if (!active || asked) return;
    setAsked(true);
    void loadGraphRepositories().then((r) => {
      if (r.ok) { setRows(r.repositories); setListing(r.listing); setGitlab(r.gitlab); }
      else setError(r.text);
    });
  }, [active, asked]);
  const change = async (refs: readonly string[], enabled: boolean): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    const result = await saveGraphRepositories(refs, enabled, ref => {
      setRows(all => (all ?? []).flatMap(row => row.ref !== ref ? [row] : !enabled && row.listed === false ? [] : [{ ...row, enabled }]));
    });
    saving.current = false;
    setBusy(false);
    if (!result.ok) setError(result.text);
  };
  return <GraphRepositoryBody rows={rows} listing={listing} gitlab={gitlab} error={error} busy={busy} onChange={(refs, enabled) => { void change(refs, enabled); }} />;
}

function RepositoryList({ rows, busy, onChange }: { rows: GraphRepository[]; busy: boolean; onChange: (refs: readonly string[], enabled: boolean) => void }) {
  const name = useAssistantName();
  return (
    <ul className="desk-set-list">
      {rows.map((r) => (
        <li key={r.ref}>
          <label className="desk-calendar-toggle">
            <input type="checkbox" aria-label={`Allow ${name} to file to ${r.label}`} checked={r.enabled} disabled={busy} onChange={(e) => { onChange([r.ref], e.target.checked); }} />
            <span>{r.label}{r.listed === false && <small>not listed</small>}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

const repositoryMatches = (row: GraphRepository, needle: string): boolean => `${row.label} ${row.ref}`.toLocaleLowerCase().includes(needle);

export function repositoryGroups(rows: GraphRepository[], query: string) {
  const groups = new Map<string, GraphRepository[]>();
  for (const row of rows) {
    const path = parseGitlabRef(row.ref)?.path ?? row.ref.slice(row.ref.indexOf("/") + 1);
    const owner = path.split("/").find(segment => segment.length > 0) ?? row.label;
    const group = groups.get(owner);
    if (group) group.push(row);
    else groups.set(owner, [row]);
  }
  const needle = query.trim().toLocaleLowerCase();
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([owner, all]) => ({ owner, rows: all, visible: all.filter(row => repositoryMatches(row, needle)) })).filter(group => group.visible.length > 0);
}

function RepositoryGroups({ rows, scope, query, busy, onChange }: { rows: GraphRepository[]; scope: string; query: string; busy: boolean; onChange: (refs: readonly string[], enabled: boolean) => void }) {
  const Heading = scope === "GitHub" ? "h4" : "h5";
  return repositoryGroups(rows, query).map(group => {
    const selected = group.rows.filter(row => row.enabled).length;
    const checked = selected === group.rows.length;
    const partial = selected > 0 && !checked;
    return <section key={group.owner} aria-label={`${scope} organisation ${group.owner}`} className="desk-repository-group">
      <Heading>{group.owner}</Heading>
      <label className="desk-calendar-toggle">
        <input type="checkbox" aria-label={`Select all repositories in ${group.owner} on ${scope}`} checked={checked} aria-checked={partial ? "mixed" : checked} ref={input => { if (input) input.indeterminate = partial; }} disabled={busy} onChange={event => { onChange(group.rows.filter(row => row.enabled !== event.target.checked).map(row => row.ref), event.target.checked); }} />
        <span>Select all {group.rows.length} {group.rows.length === 1 ? "repository" : "repositories"}<small>{selected} selected{group.visible.length < group.rows.length ? ` · ${group.visible.length} matching search` : ""}</small></span>
      </label>
      <RepositoryList rows={group.visible} busy={busy} onChange={onChange} />
    </section>;
  });
}

// glossary-ignore: host
interface GitlabGroup { host: string; notice: string | null; failed: boolean; rows: GraphRepository[] }

function gitlabGroups(gitlab: GitlabListing, rows: GraphRepository[]): GitlabGroup[] {
  const groups = new Map<string, GitlabGroup>();
  for (const h of gitlab.ok ? gitlab.hosts : []) groups.set(h.host, { host: h.host, notice: h.ok ? null : gitlabHostFailedLine(h.host), failed: !h.ok, rows: [] });
  for (const row of rows) {
    const host = parseGitlabRef(row.ref)?.host ?? row.ref;
    const group = groups.get(host) ?? { host, notice: null, failed: false, rows: [] };
    group.rows.push(row);
    groups.set(host, group);
  }
  return [...groups.values()].map((g) => (g.notice === null && g.rows.length === 0 ? { ...g, notice: `No projects found for your GitLab account on ${g.host}.` } : g));
}

export function GraphRepositoryBody({ rows, listing, gitlab, error, busy, onChange }: {
  rows: GraphRepository[] | null;
  listing: GraphRepositoryListing;
  gitlab: GitlabListing;
  error: string | null;
  busy: boolean;
  onChange: (refs: readonly string[], enabled: boolean) => void;
}) {
  const name = useAssistantName();
  const [query, setQuery] = useState("");
  const githubRows = (rows ?? []).filter((r) => r.forge !== "gitlab");
  const gitlabRows = (rows ?? []).filter((r) => r.forge === "gitlab");
  const groups = gitlabGroups(gitlab, gitlabRows);
  return (
    <section className="desk-set-card" aria-label={`Repositories ${name} may file to`}>
      <h2>Repositories {name} may file to</h2>
      <p className="desk-set-sub">Tick the repositories where {name} may file graph nodes and maps from a conversation. A ticked repository allows both.</p>
      {rows === null ? (
        <p className="desk-set-empty">{error ?? "Loading…"}</p>
      ) : (
        <>
          <label className="desk-repository-search">Search repositories<input type="search" value={query} onChange={event => { setQuery(event.target.value); }} placeholder="Repository or organisation" /></label>
          <p className="desk-set-sub">Selecting an organisation applies to all its repositories, including those hidden by search.</p>
          {rows.length > 0 && !rows.some(row => repositoryMatches(row, query.trim().toLocaleLowerCase())) && <p role="status">No repositories match your search.</p>}
          <section aria-label="GitHub repositories">
            <h3>GitHub</h3>
            {!listing.ok && <p className="desk-set-empty" role="status">{LISTING_FAILED_LINE}</p>}
            {githubRows.length === 0 ? (
              listing.ok && <p className="desk-set-empty">No repositories found for your GitHub account.</p>
            ) : (
              <RepositoryGroups rows={githubRows} scope="GitHub" query={query} busy={busy} onChange={onChange} />
            )}
          </section>
          <section aria-label="GitLab projects">
            <h3>GitLab</h3>
            {!gitlab.ok && <p className="desk-set-empty" role="status">{GITLAB_LISTING_FAILED_LINE}</p>}
            {groups.map((g) => (
              <section key={g.host} aria-label={`GitLab projects on ${g.host}`}>
                <h4>{g.host}</h4>
                {g.notice !== null && <p className="desk-set-empty" role={g.failed ? "status" : undefined}>{g.notice}</p>}
                {g.rows.length > 0 && <RepositoryGroups rows={g.rows} scope={`GitLab ${g.host}`} query={query} busy={busy} onChange={onChange} />}
              </section>
            ))}
          </section>
          {error && <p className="desk-set-err" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
