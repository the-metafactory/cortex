import { useEffect, useState } from "react";
import type { GitlabListing, GraphRepository, GraphRepositoryListing } from "../../desk/graph-repositories";
import { loadGraphRepositories, saveGraphRepository } from "../lib/desk-graph-repositories";

export const LISTING_FAILED_LINE = "The GitHub repositories could not be listed; check that gh is installed and signed in.";
export const GITLAB_LISTING_FAILED_LINE = "The GitLab projects could not be listed; check that glab is installed and signed in.";
export const GITLAB_SEVERAL_HOSTS_LINE = "The GitLab projects are not listed, because glab is signed in to several GitLab hosts and only one is supported yet.";

const GITLAB_PENDING: GitlabListing = { ok: false, kind: "unavailable", reason: "" };

export function GraphRepositorySettings({ active }: { active: boolean }) {
  const [rows, setRows] = useState<GraphRepository[] | null>(null);
  const [listing, setListing] = useState<GraphRepositoryListing>({ ok: true });
  const [gitlab, setGitlab] = useState<GitlabListing>(GITLAB_PENDING);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!active || asked) return;
    setAsked(true);
    void loadGraphRepositories().then((r) => {
      if (r.ok) { setRows(r.repositories); setListing(r.listing); setGitlab(r.gitlab); }
      else setError(r.text);
    });
  }, [active, asked]);
  const change = async (ref: string, enabled: boolean): Promise<void> => {
    setBusy(true);
    const r = await saveGraphRepository(ref, enabled);
    setBusy(false);
    if (!r.ok) { setError(r.text); return; }
    setError(null);
    setRows((all) => (all ?? []).flatMap((row) => (row.ref !== ref ? [row] : !enabled && row.listed === false ? [] : [{ ...row, enabled }])));
  };
  return <GraphRepositoryBody rows={rows} listing={listing} gitlab={gitlab} error={error} busy={busy} onChange={(ref, enabled) => void change(ref, enabled)} />;
}

function RepositoryList({ rows, busy, onChange }: { rows: GraphRepository[]; busy: boolean; onChange: (ref: string, enabled: boolean) => void }) {
  return (
    <ul className="desk-set-list">
      {rows.map((r) => (
        <li key={r.ref}>
          <label className="desk-calendar-toggle">
            <input type="checkbox" aria-label={`Allow Ivy to file to ${r.label}`} checked={r.enabled} disabled={busy} onChange={(e) => { onChange(r.ref, e.target.checked); }} />
            <span>{r.label}{r.listed === false && <small>not listed</small>}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function gitlabNotice(gitlab: GitlabListing, empty: boolean): string | null {
  if (!gitlab.ok) return gitlab.kind === "several-hosts" ? GITLAB_SEVERAL_HOSTS_LINE : GITLAB_LISTING_FAILED_LINE;
  return empty ? `No projects found for your GitLab account on ${gitlab.host}.` : null;
}

export function GraphRepositoryBody({ rows, listing, gitlab, error, busy, onChange }: {
  rows: GraphRepository[] | null;
  listing: GraphRepositoryListing;
  gitlab: GitlabListing;
  error: string | null;
  busy: boolean;
  onChange: (ref: string, enabled: boolean) => void;
}) {
  const githubRows = (rows ?? []).filter((r) => r.forge !== "gitlab");
  const gitlabRows = (rows ?? []).filter((r) => r.forge === "gitlab");
  const gitlabLine = gitlabNotice(gitlab, gitlabRows.length === 0);
  return (
    <section className="desk-set-card" aria-label="Repositories Ivy may file to">
      <h2>Repositories Ivy may file to</h2>
      <p className="desk-set-sub">Tick the repositories where Ivy may file graph nodes and maps from a conversation. A ticked repository allows both.</p>
      {rows === null ? (
        <p className="desk-set-empty">{error ?? "Loading…"}</p>
      ) : (
        <>
          <section aria-label="GitHub repositories">
            <h3>GitHub</h3>
            {!listing.ok && <p className="desk-set-empty" role="status">{LISTING_FAILED_LINE}</p>}
            {githubRows.length === 0 ? (
              listing.ok && <p className="desk-set-empty">No repositories found for your GitHub account.</p>
            ) : (
              <RepositoryList rows={githubRows} busy={busy} onChange={onChange} />
            )}
          </section>
          <section aria-label="GitLab projects">
            <h3>GitLab</h3>
            {gitlabLine !== null && <p className="desk-set-empty" role={gitlab.ok ? undefined : "status"}>{gitlabLine}</p>}
            {gitlabRows.length > 0 && <RepositoryList rows={gitlabRows} busy={busy} onChange={onChange} />}
          </section>
          {error && <p className="desk-set-err" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
