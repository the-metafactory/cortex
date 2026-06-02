/**
 * G-1113.D.4 — phase-detail surface (design §7.2). Shows a phase's parent plan,
 * its work items, and each work item's linked pull requests.
 *
 * Honest-data scope: §7.2 also lists sessions / branches / checks / reviews /
 * attention items; only PR linkage is queryable today (see api/phase-detail.ts),
 * so those sections aren't shown — they deepen as the linkage lands. Work items
 * are empty until WorkItem ingestion (a filed follow-up); the surface shows an
 * honest empty state meanwhile.
 */
import type { PhaseDetail } from "../../api/phase-detail";

export interface PhaseDetailViewProps {
  detail: PhaseDetail | null;
  loaded: boolean;
  onClose: () => void;
  /** Open the work-item detail surface (D.5). */
  onOpenWorkItem?: (workItemId: string) => void;
}

export function PhaseDetailView({ detail, loaded, onClose, onOpenWorkItem }: PhaseDetailViewProps) {
  return (
    <section className="scaffold-section phase-detail" aria-label="Phase detail">
      <div className="phase-detail-head">
        <button type="button" className="tab" onClick={onClose}>
          ← Plans
        </button>
      </div>

      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : !detail ? (
        <p className="dim">Phase not found.</p>
      ) : (
        <>
          <h2>{detail.phase.title}</h2>
          <p className="plan-meta">
            {detail.plan ? <span className="dim">{detail.plan.title}</span> : null}
            <span className={`badge status-${detail.phase.status}`}>{detail.phase.status}</span>
          </p>

          <h3 className="phase-section-label">
            Work items <span className="dim">({detail.workItems.length})</span>
          </h3>
          {detail.workItems.length === 0 ? (
            <p className="dim faint">
              No work items linked to this phase yet — work-item ingestion lands in a later slice.
            </p>
          ) : (
            <ul className="work-items">
              {detail.workItems.map(({ workItem: w, pullRequests }) => (
                <li key={w.id} className="work-item">
                  <div className="work-item-head">
                    {onOpenWorkItem ? (
                      <button
                        type="button"
                        className="work-item-open"
                        onClick={() => onOpenWorkItem(w.id)}
                        aria-label={`Open work item ${w.title}`}
                      >
                        {w.title}
                      </button>
                    ) : (
                      <span>{w.title}</span>
                    )}
                    {w.url ? (
                      <a
                        className="dim mono wid-ext"
                        href={w.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open on provider"
                      >
                        ↗
                      </a>
                    ) : null}
                    {w.status ? <span className="badge">{w.status}</span> : null}
                  </div>
                  {pullRequests.length > 0 ? (
                    <ul className="work-item-prs">
                      {pullRequests.map((pr) => (
                        <li key={pr.id}>
                          {pr.url ? (
                            <a href={pr.url} target="_blank" rel="noopener noreferrer">
                              #{pr.numberOrKey}
                            </a>
                          ) : (
                            <span>#{pr.numberOrKey}</span>
                          )}{" "}
                          <span className={`phase-status status-${pr.state}`}>{pr.state}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
