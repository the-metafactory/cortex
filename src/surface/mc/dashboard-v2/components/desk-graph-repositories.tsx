import { useEffect, useState } from "react";
import type { GraphRepository, GraphRepositoryListing } from "../../desk/graph-repositories";
import { loadGraphRepositories, saveGraphRepository } from "../lib/desk-graph-repositories";

export const LISTING_FAILED_LINE = "The GitHub repositories could not be listed; check that gh is installed and signed in.";

export function GraphRepositorySettings({ active }: { active: boolean }) {
  const [rows, setRows] = useState<GraphRepository[] | null>(null);
  const [listing, setListing] = useState<GraphRepositoryListing>({ ok: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!active || asked) return;
    setAsked(true);
    void loadGraphRepositories().then((r) => {
      if (r.ok) { setRows(r.repositories); setListing(r.listing); }
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
  return <GraphRepositoryBody rows={rows} listing={listing} error={error} busy={busy} onChange={(ref, enabled) => void change(ref, enabled)} />;
}

export function GraphRepositoryBody({ rows, listing, error, busy, onChange }: {
  rows: GraphRepository[] | null;
  listing: GraphRepositoryListing;
  error: string | null;
  busy: boolean;
  onChange: (ref: string, enabled: boolean) => void;
}) {
  return (
    <section className="desk-set-card" aria-label="Repositories Ivy may file to">
      <h2>Repositories Ivy may file to</h2>
      <p className="desk-set-sub">Tick the repositories where Ivy may file graph nodes and maps from a conversation. A ticked repository allows both. Ivy files nowhere that is not ticked.</p>
      {rows === null ? (
        <p className="desk-set-empty">{error ?? "Loading…"}</p>
      ) : (
        <>
          {!listing.ok && <p className="desk-set-empty" role="status">{LISTING_FAILED_LINE}</p>}
          {rows.length === 0 ? (
            listing.ok && <p className="desk-set-empty">No repositories found for your GitHub account.</p>
          ) : (
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
          )}
          {error && <p className="desk-set-err" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
