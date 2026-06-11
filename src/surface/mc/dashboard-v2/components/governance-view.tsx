/**
 * G-1115 — Governance tab (governance upgrade Stage 5).
 *
 * Read-only audit surface over the governed-action stack's bus verdicts
 * (`governance.verdict.{l0,tribunal,gate,resolved}` — pulse P-702): alarm
 * banner (deterministic tier on 24h denials), window summary, and the 30d
 * verdict list. RavenClaude's Heimdall/Víðarr concept, reading the bus.
 *
 * Honest empty state: "no verdicts recorded" means no governed pipelines have
 * run in the window — it is NOT an all-clear, and the copy says so.
 */

import type { GovernanceState } from "../hooks/use-governance";
import type { GovernanceVerdictRow } from "../../db/governance";

const LAYER_LABEL: Record<string, string> = {
  l0: "L0 policy",
  tribunal: "L1 tribunal",
  gate: "L2 gate",
  resolved: "resolved",
};

/** deny/fail rows surface visually; defer is the human-escalation tone. */
function decisionTone(decision: string): string {
  if (decision === "deny" || decision === "fail") return "deny";
  if (decision === "defer" || decision === "ask") return "defer";
  return "allow";
}

function when(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().replace("T", " ").slice(0, 16);
}

export interface GovernanceViewProps {
  state: GovernanceState;
}

export function GovernanceView({ state }: GovernanceViewProps) {
  const { data, loaded, error } = state;

  return (
    <section className="scaffold-section governance-view" aria-label="Governance">
      <h2>
        Governance{" "}
        {loaded && data && data.summary.total > 0 ? (
          <span className="dim">
            ({data.summary.total} verdicts / {data.windowDays}d)
          </span>
        ) : null}
      </h2>

      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : error ? (
        <p className="dim">Could not load governance verdicts: {error}</p>
      ) : !data || data.summary.total === 0 ? (
        <p className="dim">
          No governance verdicts recorded in the last {data?.windowDays ?? 30} days. Either no
          governed pipelines ran, or their verdicts never reached this stack&apos;s projection
          (bus, validation, or retention). Absence of records is not an all-clear.
        </p>
      ) : (
        <>
          <p
            className={`governance-alarm alarm-${data.alarm.tier}`}
            role={data.alarm.tier === "high" ? "alert" : undefined}
          >
            <strong>
              {data.alarm.tier === "none"
                ? "No active alarm"
                : data.alarm.tier === "elevated"
                  ? "Elevated"
                  : "High"}
            </strong>{" "}
            — {data.alarm.note}
          </p>

          <p className="governance-summary dim">
            outcomes: {data.summary.allows} allow · {data.summary.denials} deny ·{" "}
            {data.summary.defers} defer&ensp;|&ensp;layers: {data.summary.byLayer.l0} L0 ·{" "}
            {data.summary.byLayer.tribunal} tribunal · {data.summary.byLayer.gate} gate ·{" "}
            {data.summary.byLayer.resolved} resolved
            {data.verdicts.length < data.summary.total
              ? ` | showing newest ${data.verdicts.length} of ${data.summary.total}`
              : ""}
          </p>

          <table className="governance-table">
            <thead>
              <tr>
                <th>when (UTC)</th>
                <th>layer</th>
                <th>decision</th>
                <th>action</th>
                <th>origin</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {data.verdicts.map((v: GovernanceVerdictRow) => (
                <tr key={v.id} className={`verdict-${decisionTone(v.decision)}`}>
                  <td className="dim">{when(v.createdAt)}</td>
                  <td>
                    <span className={`badge layer-${v.layer}`}>{LAYER_LABEL[v.layer] ?? v.layer}</span>
                  </td>
                  <td>
                    <span className={`badge decision-${decisionTone(v.decision)}`}>
                      {v.decision}
                      {v.resolvedBy ? <span className="dim"> via {v.resolvedBy}</span> : null}
                    </span>
                  </td>
                  <td>{v.name}</td>
                  <td className="dim">
                    {v.principal ?? "?"}
                    {v.stack ? `/${v.stack}` : ""}
                  </td>
                  <td className="dim governance-reason">{v.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
