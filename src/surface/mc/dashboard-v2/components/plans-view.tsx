/**
 * G-1113.D.3 — Plan overview surface (design §7.1, software mode). Each plan
 * card shows title + source-doc link, kind/status badges, a phase-status
 * progress line, and the ordered phase list with per-phase status.
 *
 * Honest-data scope: WI/PR/release/attention counts (design §7.1) are not
 * shown yet — that data lands with work-item linkage (D.5+). The card surfaces
 * only the real skeleton (phases + status); a phase is marked "current" only
 * when the data explicitly flags it active.
 */
import type { PlanOverview } from "../../api/plans";
import type { PlanPhaseStatus } from "../../types";

const PHASE_STATUS_LABEL: Record<PlanPhaseStatus, string> = {
  not_started: "not started",
  active: "active",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

function progressLine(ov: PlanOverview): string {
  const { phaseCounts, phases } = ov;
  const parts = [`${phaseCounts.done}/${phases.length} phases done`];
  if (phaseCounts.active) parts.push(`${phaseCounts.active} active`);
  if (phaseCounts.blocked) parts.push(`${phaseCounts.blocked} blocked`);
  return parts.join(" · ");
}

export interface PlansViewProps {
  plans: PlanOverview[];
  loaded: boolean;
}

export function PlansView({ plans, loaded }: PlansViewProps) {
  return (
    <section className="scaffold-section plans-view" aria-label="Plans">
      <h2>Plans</h2>
      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : plans.length === 0 ? (
        <p className="dim">
          No plans ingested yet — plan docs (<span className="mono">docs/plan-*.md</span>,{" "}
          <span className="mono">docs/iteration-*.md</span>) populate this surface.
        </p>
      ) : (
        plans.map((ov) => (
          <div key={ov.plan.id} className="plan-card">
            <h3>
              {ov.plan.title}
              {ov.plan.sourceDocumentUrl ? (
                <a
                  className="dim mono plan-link"
                  href={ov.plan.sourceDocumentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Source document"
                >
                  ↗
                </a>
              ) : null}
            </h3>
            <p className="plan-meta">
              <span className={`badge kind-${ov.plan.kind}`}>{ov.plan.kind}</span>
              <span className={`badge status-${ov.plan.status}`}>{ov.plan.status}</span>
              {ov.phases.length > 0 ? <span className="dim">{progressLine(ov)}</span> : null}
            </p>
            {ov.phases.length === 0 ? (
              <p className="dim faint">No phases parsed from the source doc.</p>
            ) : (
              <ol className="plan-phases">
                {ov.phases.map((ph) => (
                  <li
                    key={ph.id}
                    className={`plan-phase${ph.id === ov.currentPhaseId ? " current" : ""}`}
                  >
                    <span className="phase-title">{ph.title}</span>
                    <span className={`phase-status status-${ph.status}`}>
                      {PHASE_STATUS_LABEL[ph.status]}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))
      )}
    </section>
  );
}
