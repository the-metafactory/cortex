/**
 * G-1115 / P-14 U3.1 (#936) — Governance tab (governance upgrade Stage 5).
 *
 * Read-only audit surface with TWO dimensions over a 30-day window:
 *   1. VERDICTS — the governed-action stack's bus verdicts
 *      (`governance.verdict.{l0,tribunal,gate,resolved}` — pulse P-702).
 *   2. DENIALS / REFUSALS (#936) — U0.2's access-gate decisions
 *      (`system.access.{denied,filtered}`). A REFUSAL is the sovereignty subset
 *      (`sovereignty_model_class` / residency / model-class / classification);
 *      everything else (authz, chain-verify, originator) is a generic denial.
 * Plus a deterministic alarm banner (tier on combined 24h denials) + window
 * summaries. RavenClaude's Heimdall/Víðarr concept, reading the bus.
 *
 * Honest empty states: "no verdicts recorded" / "no access denials recorded"
 * mean nothing reached this stack's projection in the window — NOT an all-clear,
 * and the copy says so.
 */

import type { GovernanceState } from "../hooks/use-governance";
import type {
  GovernanceVerdictRow,
  GovernanceDenialRow,
} from "../../db/governance";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
// MC-B1/B2 (cortex#1278/#1279) — the Pier queue (pending admission requests +
// Tier-2 grant/reject) lives here in Governance rather than cluttering the
// Network topology view. Self-effacing under its own admin-posture gate: renders
// nothing for a principal who admins no networks (§Posture in pier-queue.tsx).
import { PierQueue } from "./pier-queue";
import { selectPierQueue } from "../lib/pier-queue-adapter";

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
  /**
   * Joined networks (admitted roster ⋈ presence). Feeds the "Admissions"
   * subsection (the relocated Pier queue). Optional: the scoped cockpit mount
   * omits it, so the admissions affordance appears only on the full Governance
   * tab. `PierQueue` self-effaces when the principal admins no networks.
   */
  networks?: readonly NetworkMembershipDTO[];
}

export function GovernanceView({ state, networks }: GovernanceViewProps) {
  const { data, loaded, error } = state;

  const hasAnyData =
    data !== null && (data.summary.total > 0 || data.denialSummary.total > 0);

  return (
    <section className="scaffold-section governance-view" aria-label="Governance">
      <h2>
        Governance{" "}
        {loaded && hasAnyData && data ? (
          <span className="dim">
            ({data.summary.total} verdicts · {data.denialSummary.total} denials / {data.windowDays}d)
          </span>
        ) : null}
      </h2>

      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : error ? (
        <p className="dim">Could not load governance data: {error}</p>
      ) : !data ? (
        <p className="dim">No governance data available.</p>
      ) : (
        <>
          {hasAnyData ? (
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
          ) : null}

          <VerdictsSection data={data} />
          <DenialsSection data={data} />
        </>
      )}

      {/* MC-B1/B2 — Admissions: the Pier queue (pending admission requests +
          Tier-2 grant/reject), relocated here from the Network view. Rendered
          independent of the verdict/denial window above; self-effaces (renders
          nothing) when the principal admins no networks or no networks were
          passed (the scoped cockpit mount). */}
      {networks && selectPierQueue(networks).adminNetworkCount > 0 ? (
        <div className="governance-subsection governance-admissions" aria-label="Admissions">
          <h3>Admissions</h3>
          <PierQueue networks={networks} />
        </div>
      ) : null}
    </section>
  );
}

/** Governed-action verdicts (governance.verdict.*) — 30d window. */
function VerdictsSection({ data }: { data: NonNullable<GovernanceState["data"]> }) {
  return (
    <div className="governance-subsection governance-verdicts" aria-label="Verdicts">
      <h3>Verdicts</h3>
      {data.summary.total === 0 ? (
        <p className="dim">
          No governance verdicts recorded in the last {data.windowDays} days. Either no governed
          pipelines ran, or their verdicts never reached this stack&apos;s projection (bus,
          validation, or retention). Absence of records is not an all-clear.
        </p>
      ) : (
        <>
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
    </div>
  );
}

/**
 * P-14 U3.1 (#936) — access denials / refusals (U0.2's system.access.*), 30d.
 * Refusals (sovereignty subset) are badged distinctly from generic denials.
 */
function DenialsSection({ data }: { data: NonNullable<GovernanceState["data"]> }) {
  const s = data.denialSummary;
  return (
    <div className="governance-subsection governance-denials" aria-label="Denials and refusals">
      <h3>Denials &amp; refusals</h3>
      {s.total === 0 ? (
        <p className="dim">
          No access denials recorded in the last {data.windowDays} days. Either nothing was denied
          or refused, or U0.2&apos;s <code>system.access.*</code> envelopes never reached this
          stack&apos;s projection (bus, validation, or retention). Absence of records is not an
          all-clear.
        </p>
      ) : (
        <>
          <p className="governance-summary dim">
            {s.refusals} sovereignty refusal{s.refusals === 1 ? "" : "s"} · {s.otherDenials} other
            denial{s.otherDenials === 1 ? "" : "s"}
            {data.denials.length < s.total
              ? ` | showing newest ${data.denials.length} of ${s.total}`
              : ""}
          </p>

          <table className="governance-table">
            <thead>
              <tr>
                <th>when (UTC)</th>
                <th>type</th>
                <th>reason</th>
                <th>principal</th>
                <th>capability</th>
                <th>origin</th>
                <th>detail</th>
              </tr>
            </thead>
            <tbody>
              {data.denials.map((d: GovernanceDenialRow) => (
                <tr key={d.id} className={d.isRefusal ? "verdict-defer" : "verdict-deny"}>
                  <td className="dim">{when(d.createdAt)}</td>
                  <td>
                    <span className={`badge ${d.isRefusal ? "decision-defer" : "decision-deny"}`}>
                      {d.isRefusal ? "refusal" : "denial"}
                      {d.kind === "filtered" ? <span className="dim"> (filtered)</span> : null}
                    </span>
                  </td>
                  <td className="governance-reason">{d.reasonKind}</td>
                  <td className="dim">{d.principalId ?? "—"}</td>
                  <td className="dim">{d.capability ?? "—"}</td>
                  <td className="dim">
                    {d.principal ?? "?"}
                    {d.stack ? `/${d.stack}` : ""}
                  </td>
                  <td className="dim governance-reason">{d.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
