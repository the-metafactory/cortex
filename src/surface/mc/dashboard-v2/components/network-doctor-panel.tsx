/**
 * FLG-3 (docs/plan-mc-future-state.md §4.D) — the network doctor DRILL.
 *
 * The "why is this link red" affordance surfaced per joined network on the
 * roster panel (R1 render home; CK-7 rehomes it into the cockpit GOVERN bar +
 * wires it to red-edge/node drilling in R2). It runs the 8-leg `DoctorCheck`
 * matrix (epic #1479, cortex#1484/#1482) FROM this member's machine and renders,
 * PER LEG: a status glyph, the leg id/title, the detail, an owner-actionable
 * fix, and WHOSE job the fix is (member / hub owner / admin / peer) — plus the
 * aggregate verdict. Includes the two plan-named legs
 * (`sealed-secret-hub-authorized`, `peer-reachable:<p>`).
 *
 * ## On-demand, not a live banner (truth-not-theater)
 *
 * Unlike the FLG-1 handoff banner (a cheap read that self-fetches on mount),
 * the doctor runs a LIVE echo round-trip per configured peer (a real probe with
 * a multi-second per-peer timeout). Auto-running it on every roster-panel mount
 * would fire probes across the fleet on every render. So {@link DoctorDrill}
 * renders a collapsed "Diagnose" button and fetches ONLY when the principal
 * clicks — matching the plan's "drill from a red edge/node". It is SSR-inert
 * (no effect fires until the click), so the roster panel stays effectively pure.
 *
 * {@link DoctorReport} is PURE (props-only, SSR-renderable — the shape the tests
 * assert). {@link DoctorDrill} is the thin self-fetching wrapper the roster
 * panel mounts.
 */

import type {
  NetworkDoctorDTO,
  DoctorCheckDTO,
  DoctorCheckStatus,
  DoctorCheckOwner,
  DoctorVerdict,
} from "../hooks/use-doctor";
import { useDoctor } from "../hooks/use-doctor";

/** Tone token per leg status — reused by the `.tone-*` styles in global.css. */
function statusTone(
  status: DoctorCheckStatus,
): "ok" | "danger" | "warn" | "muted" {
  switch (status) {
    case "pass":
      return "ok";
    case "fail":
      return "danger";
    case "warn":
      return "warn";
    case "skip":
      return "muted";
  }
}

/** Status glyph per leg — pass / fail / warn / skip. */
function statusGlyph(status: DoctorCheckStatus): string {
  switch (status) {
    case "pass":
      return "✓";
    case "fail":
      return "✗";
    case "warn":
      return "⚠";
    case "skip":
      return "·";
  }
}

/** Tone for the aggregate verdict chip. */
function verdictTone(verdict: DoctorVerdict): "ok" | "warn" | "danger" {
  switch (verdict) {
    case "healthy":
      return "ok";
    case "degraded":
      return "warn";
    case "broken":
      return "danger";
  }
}

/** Human label for who owns a leg's fix ("whose job"). The member is the local you. */
function ownerLabel(owner: DoctorCheckOwner): string {
  switch (owner) {
    case "member":
      return "you (member)";
    case "hub-owner":
      return "hub owner";
    case "admin":
      return "admin";
    case "peer":
      return "peer";
  }
}

export interface DoctorReportProps {
  report: NetworkDoctorDTO;
}

/**
 * PURE presentational report — props only, no fetching. The drill mounts
 * {@link DoctorDrill} (which feeds this); tests render THIS directly.
 *
 * Verdicts are shown VERBATIM: the status, detail, fix, and owner come straight
 * from the DTO (sourced from `runDoctorChecks`, never re-derived here).
 */
export function DoctorReport({ report }: DoctorReportProps) {
  return (
    <div
      className="doctor-report"
      data-network={report.network_id}
      data-verdict={report.verdict}
      aria-label={`Network doctor for ${report.network_id}`}
    >
      <div className="doctor-report-head">
        <span className="doctor-report-title">Doctor</span>
        <span className="dim doctor-report-network">{report.network_id}</span>
        <span
          className={`doctor-report-verdict tone-${verdictTone(report.verdict)}`}
          data-verdict={report.verdict}
        >
          {report.verdict}
        </span>
      </div>

      <ul className="doctor-legs">
        {report.checks.map((leg: DoctorCheckDTO) => (
          <li
            key={leg.id}
            className={`doctor-leg tone-${statusTone(leg.status)}`}
            data-leg={leg.id}
            data-status={leg.status}
            data-owner={leg.owner}
          >
            <span className="doctor-leg-status">
              <span className="doctor-leg-glyph" aria-hidden="true">
                {statusGlyph(leg.status)}
              </span>{" "}
              <span className="doctor-leg-id">{leg.id}</span>
            </span>
            <span className="dim doctor-leg-detail">{leg.detail}</span>
            {leg.fix !== null ? (
              <span className="doctor-leg-fix">
                <span className="dim doctor-leg-fix-owner">
                  fix ({ownerLabel(leg.owner)}):
                </span>{" "}
                {leg.fix}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DoctorDrillProps {
  networkId: string;
}

/**
 * Self-fetching wrapper the roster panel mounts. Renders a collapsed "Diagnose"
 * button; on click it runs the doctor (a live per-peer probe) and renders the
 * {@link DoctorReport}. SSR-inert — no effect fires until the click, so the
 * roster panel stays effectively pure and a non-federated stack is unchanged.
 */
export function DoctorDrill({ networkId }: DoctorDrillProps) {
  const { report, loading, error, hasRun, run } = useDoctor(networkId);

  return (
    <div className="doctor-drill" data-network={networkId}>
      <button
        type="button"
        className="doctor-drill-run"
        onClick={run}
        disabled={loading}
        data-testid="doctor-run"
      >
        {loading
          ? "Diagnosing…"
          : hasRun
            ? "Re-run doctor"
            : "Diagnose — why is this red?"}
      </button>
      {error !== null ? (
        <div className="dim doctor-drill-error" role="status">
          {error}
        </div>
      ) : null}
      {report !== null ? <DoctorReport report={report} /> : null}
    </div>
  );
}
