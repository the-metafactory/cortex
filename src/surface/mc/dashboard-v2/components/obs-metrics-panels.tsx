/**
 * P-14 U4.2 (#938) — Observability aggregate-metrics panels + >14d history view.
 *
 * Renders REAL aggregate numbers sourced via the sideband `/metrics/summary`
 * (PromQL over VictoriaMetrics), proxied per U0.1:
 *   1. **Rates** — per-second tool-call rate (by tool), agent-spawn rate, and
 *      overall event rate, evaluated over the selected window.
 *   2. **Hook latency** — p50 / p95 / p99 of `pai_duration_ms`, in ms.
 *   3. **>14d history** — events past MC's 14-day local projection prune, sourced
 *      from VictoriaLogs via `/search?since=30d`. This is the HONEST source: the
 *      local `observability_events` table prunes at 14 days
 *      (`OBSERVABILITY_RETENTION_MS`), so anything older necessarily comes from
 *      signal's backend (VictoriaLogs holds 30/90d — cortex#938).
 *
 * No chart library — flexbox + plain tables, mirroring the F-18 `metrics-panel`
 * design language (reuses `metrics-panel.css` tokens; this file adds only the
 * obs-specific rate-table + history-table rules).
 *
 * Honest degradation: a `SidebandError` (no running stack, backend down) renders
 * an "interior capture not available" line + the `deep_link` exit, NOT fabricated
 * zeros. A genuinely empty window renders real empty panels.
 */

import { useState } from "react";
import "./metrics-panel.css";
import "./obs-metrics-panels.css";
import { formatDurationCompact } from "../../../../shared/format-utils";
import {
  HISTORY_WINDOW,
  METRICS_WINDOWS,
  type SidebandLogRecord,
  type SidebandMetricSample,
  type SidebandMetricsSummary,
} from "../../../../common/sideband/metrics";
import type { ObsMetricsState, ObsMetricsLoad } from "../hooks/use-obs-metrics";

/** Per-second rate → a compact human string. `null` → em-dash. */
function rate(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0/s";
  // Sub-1/s rates: show 3 sig-figs; ≥1/s: 2 decimals.
  return value < 1 ? `${value.toPrecision(3)}/s` : `${value.toFixed(2)}/s`;
}

/** p50/95/99 ms → compact duration (reuses the F-18 formatter). `null` → em-dash. */
function ms(value: number | null): string {
  return value === null ? "—" : formatDurationCompact(value);
}

/** A single labelled metric series → a display label (`tool=read` → `read`). */
function sampleLabel(s: SidebandMetricSample): string {
  const keys = Object.keys(s.labels);
  if (keys.length === 0) return "(all)";
  return keys.map((k) => s.labels[k]).join(" · ");
}

function ErrorLine({ message, deepLink }: { message: string; deepLink?: string }) {
  return (
    <div className="obs-metrics-unavailable">
      <span>{message}</span>
      {deepLink ? (
        <a href={deepLink} target="_blank" rel="noreferrer noopener">
          Open in observability backend ↗
        </a>
      ) : null}
    </div>
  );
}

function WindowSelector({
  window,
  setWindow,
}: {
  window: string;
  setWindow: (w: string) => void;
}) {
  return (
    <span className="metrics-window" role="tablist" aria-label="Metrics window">
      {METRICS_WINDOWS.map((opt) => (
        <button
          key={opt}
          type="button"
          role="tab"
          aria-selected={window === opt}
          className={window === opt ? "active" : ""}
          onClick={() => setWindow(opt)}
        >
          {opt}
        </button>
      ))}
    </span>
  );
}

function RatesSection({ summary }: { summary: SidebandMetricsSummary }) {
  const spawn = summary.agentSpawnRate[0]?.value ?? null;
  const event = summary.eventRate[0]?.value ?? null;
  return (
    <div className="metrics-section">
      <h2>Rates (per second, over {summary.window})</h2>
      <div className="metrics-bignums">
        <div className="metrics-bignum">
          <div className="label">Agent spawns</div>
          <div className="value">{rate(spawn)}</div>
        </div>
        <div className="metrics-bignum">
          <div className="label">Events</div>
          <div className="value">{rate(event)}</div>
        </div>
        <div className="metrics-bignum">
          <div className="label">Tools (total)</div>
          <div className="value">
            {rate(
              summary.toolCallRate.length === 0
                ? 0
                : summary.toolCallRate.reduce((acc, s) => acc + (s.value ?? 0), 0),
            )}
          </div>
        </div>
        <div className="metrics-bignum">
          <div className="label">Distinct tools</div>
          <div className="value">{summary.toolCallRate.length}</div>
        </div>
      </div>

      {summary.toolCallRate.length === 0 ? (
        <div className="metrics-empty">No tool-call activity in this window.</div>
      ) : (
        <table className="obs-metrics-rates">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="num">Rate</th>
            </tr>
          </thead>
          <tbody>
            {summary.toolCallRate
              .slice()
              .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
              .map((s) => (
                <tr key={sampleLabel(s)}>
                  <td className="mono">{sampleLabel(s)}</td>
                  <td className="num">{rate(s.value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LatencySection({ summary }: { summary: SidebandMetricsSummary }) {
  const { p50, p95, p99 } = summary.hookLatencyMs;
  const allNull = p50 === null && p95 === null && p99 === null;
  return (
    <div className="metrics-section">
      <h2>Hook latency (over {summary.window})</h2>
      {allNull ? (
        <div className="metrics-empty">No hook-latency samples in this window.</div>
      ) : (
        <div className="metrics-bignums metrics-bignums-3">
          <div className="metrics-bignum">
            <div className="label">p50</div>
            <div className="value">{ms(p50)}</div>
          </div>
          <div className="metrics-bignum">
            <div className="label">p95</div>
            <div className="value">{ms(p95)}</div>
          </div>
          <div className="metrics-bignum">
            <div className="label">p99</div>
            <div className="value">{ms(p99)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function nanoToWhen(timeUnixNano: string): string {
  // Unix-nanos → 'YYYY-MM-DD HH:MM'. BigInt-safe for the ms division.
  const ms = Number(BigInt(timeUnixNano) / 1_000_000n);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function envelopeType(r: SidebandLogRecord): string {
  const cls = r.attributes["envelope_class"];
  const entity = r.attributes["envelope_entity"];
  const action = r.attributes["envelope_action"];
  const parts = [cls, entity, action].filter((p) => typeof p === "string" && p !== "");
  return parts.length > 0 ? parts.join(".") : (r.severityText || "log");
}

function HistorySection({
  history,
  onLoad,
}: {
  history: ObsMetricsLoad<SidebandLogRecord[]>;
  onLoad: () => void;
}) {
  return (
    <div className="metrics-section">
      <h2>
        History (&gt;14d)
        <button type="button" className="obs-metrics-refresh" onClick={onLoad}>
          Load {HISTORY_WINDOW}
        </button>
      </h2>
      <p className="obs-metrics-note">
        MC&rsquo;s local projection retains 14 days; this view sources older
        events from signal&rsquo;s VictoriaLogs (30/90d) via the sideband
        <code> /search</code>.
      </p>
      {history.phase === "loading" ? (
        <div className="metrics-loading">Loading history…</div>
      ) : history.phase === "error" ? (
        <ErrorLine message={history.message} deepLink={history.deepLink} />
      ) : history.data.length === 0 ? (
        <div className="metrics-empty">
          No events in the history window (nothing retained past 14d, or the
          window is genuinely empty).
        </div>
      ) : (
        <table className="obs-metrics-history">
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((r, i) => (
              <tr key={`${r.timeUnixNano}-${i}`}>
                <td className="mono dim">{nanoToWhen(r.timeUnixNano)}</td>
                <td className="mono">{envelopeType(r)}</td>
                <td className="dim">{r.severityText || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export interface ObsMetricsPanelsProps {
  state: ObsMetricsState;
}

export function ObsMetricsPanels({ state }: ObsMetricsPanelsProps) {
  const { summary, window, setWindow, history, loadHistory } = state;
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="metrics-panel obs-metrics-panels">
      <div className="obs-metrics-header">
        <h3>Aggregate metrics</h3>
        <WindowSelector window={window} setWindow={setWindow} />
      </div>

      {summary.phase === "loading" ? (
        <div className="metrics-loading">Loading metrics…</div>
      ) : summary.phase === "error" ? (
        <ErrorLine message={summary.message} deepLink={summary.deepLink} />
      ) : (
        <>
          <RatesSection summary={summary.data} />
          <LatencySection summary={summary.data} />
        </>
      )}

      {historyOpen ? (
        <HistorySection
          history={history}
          onLoad={() => loadHistory()}
        />
      ) : (
        <div className="metrics-section obs-metrics-history-cta">
          <button
            type="button"
            className="obs-metrics-open-history"
            onClick={() => {
              setHistoryOpen(true);
              loadHistory();
            }}
          >
            Show history &gt;14d
          </button>
          <span className="obs-metrics-note">
            Sourced from signal&rsquo;s backend (VictoriaLogs/VictoriaMetrics),
            beyond MC&rsquo;s 14-day local retention.
          </span>
        </div>
      )}
    </div>
  );
}
