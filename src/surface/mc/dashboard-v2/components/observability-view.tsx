/**
 * P-14 U2.1 (#934) — Observability tab.
 *
 * Read-only surface over the projection of signal's four canonical myelin
 * `system.*` envelope families, grouped into three sections:
 *
 *   1. **Signal health** — `system.signal.*` + `system.signal.collector.*`.
 *   2. **Federation**    — `system.federation.*`.
 *   3. **Transport**     — `system.transport.*`.
 *
 * ## Hub-scope caveat (stated honestly, not faked)
 * Federation and transport envelopes are HUB-emitted: a non-hub stack legitimately
 * never sees them, so those sections render zero rows on a leaf. We do NOT
 * synthesize placeholder data — an empty federation/transport section shows an
 * EXPLANATORY empty state ("hub-emitted; this stack is not a hub / the roster
 * arrives via U3.3"), distinct from the signal-health empty state ("no signal
 * activity yet"). Absence of rows is the truth, surfaced as such.
 */

import type { ObservabilityState } from "../hooks/use-observability";
import type { ObsMetricsState } from "../hooks/use-obs-metrics";
import { ObsMetricsPanels } from "./obs-metrics-panels";
import type { ObservabilityEventRow } from "../../db/observability";
import type { TransportRosterEventRow } from "../../api/observability-tab";
import { foldHubVitals, humanizeBytes, scrapeAge } from "../lib/hub-vitals";

function when(ts: string): string {
  // ISO-8601 (or SQLite 'YYYY-MM-DD HH:MM:SS') → compact 'YYYY-MM-DD HH:MM'.
  return ts.replace("T", " ").slice(0, 16);
}

function EventTable({ rows }: { rows: ObservabilityEventRow[] }) {
  return (
    <table className="observability-events">
      <thead>
        <tr>
          <th>When</th>
          <th>Type</th>
          <th>Origin</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="mono dim">{when(r.timestamp)}</td>
            <td className="mono">{r.type}</td>
            <td className="mono dim">{r.stackId ?? "—"}</td>
            <td>{r.summary ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SectionProps {
  title: string;
  rows: ObservabilityEventRow[];
  count: number;
  /** Copy shown when the section has zero rows. */
  emptyNote: string;
}

function Section({ title, rows, count, emptyNote }: SectionProps) {
  return (
    <div className="observability-section">
      <h3>
        {title}{" "}
        {count > 0 ? <span className="dim">({count})</span> : null}
      </h3>
      {rows.length === 0 ? <p className="dim">{emptyNote}</p> : <EventTable rows={rows} />}
    </div>
  );
}

/**
 * The exact honest empty-state copy for the hub-vitals strip (cortex#1469).
 * Named signal#118 (hub provisioning) so the absence points at the real cause —
 * the transport collector isn't running against the hub yet — not a cortex bug.
 * Exported so the test can assert it verbatim without re-typing the string.
 */
export const HUB_VITALS_EMPTY_NOTE =
  "no hub vitals — transport collector not running (signal#118)";

/**
 * cortex#1469 — the compact hub VITALS strip. Folds signal's
 * `system.transport.server-vitals` rows (payload-bearing on `transportRoster`)
 * into the latest vitals PER NETWORK and renders CPU / mem / connections /
 * leafnodes / slow-consumers + scrape age. A strip, not a panel: no charts, no
 * history, no synthesized numbers. Zero vitals rows → the honest empty state.
 *
 * Numbers use tabular numerals (`.tnum`) so columns align across rows.
 */
function HubVitalsStrip({ rows }: { rows: readonly TransportRosterEventRow[] }) {
  const vitals = foldHubVitals(rows);
  const now = Date.now();
  return (
    <div className="observability-section">
      <h3>
        Hub vitals{" "}
        {vitals.length > 0 ? <span className="dim">({vitals.length})</span> : null}
      </h3>
      {vitals.length === 0 ? (
        <p className="dim">{HUB_VITALS_EMPTY_NOTE}</p>
      ) : (
        <table className="observability-events hub-vitals-strip">
          <thead>
            <tr>
              <th>Network</th>
              <th>CPU</th>
              <th>Mem</th>
              <th>Conns</th>
              <th>Leafs</th>
              <th>Slow</th>
              <th>Scraped</th>
            </tr>
          </thead>
          <tbody>
            {vitals.map((v) => (
              <tr key={v.network}>
                <td className="mono" title={v.serverName ?? undefined}>
                  {v.network}
                </td>
                <td className="mono tnum">{v.cpu.toFixed(1)}%</td>
                <td className="mono tnum">{humanizeBytes(v.mem)}</td>
                <td className="mono tnum">{v.connections}</td>
                <td className="mono tnum">{v.leafnodes}</td>
                <td className="mono tnum">{v.slowConsumers}</td>
                <td className="mono dim tnum">{scrapeAge(v, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export interface ObservabilityViewProps {
  state: ObservabilityState;
  /**
   * Aggregate-metrics + >14d-history state (P-14 U4.2, #938). Optional so the
   * tab still renders its U2.1 event sections if the panels aren't wired (e.g.
   * a test that only exercises the event projection).
   */
  metrics?: ObsMetricsState;
}

export function ObservabilityView({ state, metrics }: ObservabilityViewProps) {
  const { data, loaded, error } = state;

  // Aggregate panels + >14d history are sourced INDEPENDENTLY of the event
  // projection (sideband /metrics/summary + /search vs the local
  // observability_events table). Render them whenever wired, even if the event
  // sections below are still loading or errored — the two have distinct
  // sources and distinct failure modes (P-14 U4.2, #938).
  const panels = metrics ? <ObsMetricsPanels state={metrics} /> : null;

  if (!loaded) {
    return (
      <section className="scaffold-section observability-view" aria-label="Observability">
        <h2>Observability</h2>
        {panels}
        <p className="dim">Loading…</p>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="scaffold-section observability-view" aria-label="Observability">
        <h2>Observability</h2>
        {panels}
        <p className="dim">Could not load observability events: {error ?? "no data"}.</p>
      </section>
    );
  }

  // Signal health groups the signal + collector families.
  const signalRows = [...data.byFamily.signal, ...data.byFamily.collector].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
  const signalCount = data.counts.signal + data.counts.collector;

  return (
    <section className="scaffold-section observability-view" aria-label="Observability">
      <h2>Observability</h2>

      {panels}

      <Section
        title="Signal health"
        rows={signalRows}
        count={signalCount}
        emptyNote="No signal or collector activity recorded yet. Once signal is emitting on this stack, its health envelopes appear here."
      />

      <Section
        title="Federation"
        rows={data.byFamily.federation}
        count={data.counts.federation}
        emptyNote="No federation events. These are hub-emitted — a non-hub stack does not see federation envelopes until it joins a network and a roster arrives (U3.3). This empty state is expected on a leaf, not a fault."
      />

      <HubVitalsStrip rows={data.transportRoster} />

      <Section
        title="Transport"
        rows={data.byFamily.transport}
        count={data.counts.transport}
        emptyNote="No transport events. Transport envelopes (leaf connect/disconnect, backend reachability) are hub-emitted — a non-hub stack does not observe them until the roster arrives via U3.3. Empty here is honest, not synthetic."
      />
    </section>
  );
}
