/**
 * G-1113.D.5 — work-item detail surface (design §7.3). Shows a work item's
 * plan/phase context and its linked pull requests (each with reviews).
 *
 * Honest-data scope: §7.3 also lists current session, event log, checks/builds,
 * a principal input box, and curation actions — none are linked to a work item
 * today (see api/work-item-detail.ts), so they aren't shown. This surface
 * renders only the genuinely-linked context: plan/phase + PRs + reviews.
 */
import type { WorkItemDetail } from "../../api/work-item-detail";
import { ProviderBadge } from "./provider-badge";

export interface WorkItemDetailViewProps {
  detail: WorkItemDetail | null;
  loaded: boolean;
  onClose: () => void;
}

export function WorkItemDetailView({ detail, loaded, onClose }: WorkItemDetailViewProps) {
  return (
    <section className="scaffold-section work-item-detail" aria-label="Work item detail">
      <div className="wid-head">
        <button type="button" className="tab" onClick={onClose}>
          ← Phase
        </button>
      </div>

      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : !detail ? (
        <p className="dim">Work item not found.</p>
      ) : (
        <>
          <h2>
            {detail.workItem.url ? (
              <a href={detail.workItem.url} target="_blank" rel="noopener noreferrer">
                {detail.workItem.title}
              </a>
            ) : (
              detail.workItem.title
            )}
          </h2>
          <p className="plan-meta">
            {/* plan / phase breadcrumb */}
            {detail.plan ? <span className="dim">{detail.plan.title}</span> : null}
            {detail.phase ? <span className="dim">› {detail.phase.title}</span> : null}
            <ProviderBadge provider={detail.workItem.provider} />
            {detail.workItem.status ? (
              <span className="badge">{detail.workItem.status}</span>
            ) : null}
          </p>

          <h3 className="wid-section-label">
            Pull requests <span className="dim">({detail.pullRequests.length})</span>
          </h3>
          {detail.pullRequests.length === 0 ? (
            <p className="dim faint">No linked pull requests.</p>
          ) : (
            <ul className="wid-prs">
              {detail.pullRequests.map(({ pullRequest: pr, reviews }) => (
                <li key={pr.id} className="wid-pr">
                  <div className="wid-pr-head">
                    {pr.url ? (
                      <a href={pr.url} target="_blank" rel="noopener noreferrer">
                        #{pr.numberOrKey}
                      </a>
                    ) : (
                      <span>#{pr.numberOrKey}</span>
                    )}
                    <span className="dim mono">
                      {pr.sourceBranch} → {pr.targetBranch}
                    </span>
                    <span className={`phase-status status-${pr.state}`}>{pr.state}</span>
                    <span className="dim">{pr.reviewState}</span>
                  </div>
                  {reviews.length > 0 ? (
                    <ul className="wid-reviews">
                      {reviews.map((r) => (
                        <li key={r.id}>
                          <span className="dim">{r.reviewer ?? "—"}</span>{" "}
                          <span className={`review-state state-${r.state}`}>{r.state}</span>
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
