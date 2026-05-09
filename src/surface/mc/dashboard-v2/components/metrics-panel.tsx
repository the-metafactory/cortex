/**
 * F-18 — Metrics panel.
 *
 * Three sections per `docs/design-mc-f18-metrics.md` Decision 5:
 *   1. Cycle time card     (window selector + count / p50 / p90 / p95)
 *   2. Wait-time stacked bar (queued / running / blocked-{permission,tool_error,review})
 *   3. Per-agent table     (sortable by Agent / Completed / p50 / Top blocker)
 *
 * No chart library. Stack bar is flexbox; per-agent table is plain HTML.
 * Loading / error semantics mirror `iteration-board.tsx`.
 */

import { useMemo, useState } from "react";
import "./metrics-panel.css";
import { formatDurationCompact } from "../../../../shared/format-utils";
import type { FleetMetrics } from "../../db/metrics";
import type { FleetWindow, UseMetricsState } from "../hooks/use-metrics";

const WINDOWS: FleetWindow[] = ["24h", "7d", "30d"];

type SegKey =
  | "queued"
  | "dispatched"
  | "running"
  | "permission"
  | "tool_error"
  | "review";

// Pretty labels for the wait-time legend.
const SEG_LABELS: Record<SegKey, string> = {
  queued: "Queued",
  dispatched: "Dispatched",
  running: "Running",
  permission: "Blocked · permission",
  tool_error: "Blocked · tool error",
  review: "Blocked · review",
};

function segments(metrics: FleetMetrics): Array<{
  key: SegKey;
  ms: number;
}> {
  return [
    { key: "queued", ms: metrics.meanByState.queued },
    { key: "dispatched", ms: metrics.meanByState.dispatched },
    { key: "running", ms: metrics.meanByState.running },
    {
      key: "permission",
      ms: metrics.meanByBlockReason["permission.request"],
    },
    { key: "tool_error", ms: metrics.meanByBlockReason["tool.error"] },
    { key: "review", ms: metrics.meanByBlockReason["review.checkpoint"] },
  ];
}

type SortKey = "agent" | "completed" | "p50" | "blocker";
type SortDir = "asc" | "desc";

interface MetricsPanelProps {
  state: UseMetricsState;
}

export function MetricsPanel({ state }: MetricsPanelProps) {
  const { metrics, loaded, error, window: w, setWindow } = state;
  const [sortKey, setSortKey] = useState<SortKey>("completed");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sortedAgents = useMemo(() => {
    if (!metrics) return [];
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = metrics.perAgent.slice();
    arr.sort((a, b) => {
      switch (sortKey) {
        case "agent":
          return dir * a.agentName.localeCompare(b.agentName);
        case "completed":
          return dir * (a.completed - b.completed);
        case "p50": {
          // Nulls sort last regardless of dir (consistent with the
          // `perAgent` server-side sort which puts unknowns at the bottom).
          if (a.p50CycleMs === null && b.p50CycleMs === null) return 0;
          if (a.p50CycleMs === null) return 1;
          if (b.p50CycleMs === null) return -1;
          return dir * (a.p50CycleMs - b.p50CycleMs);
        }
        case "blocker": {
          const ax = a.topBlocker ?? "";
          const bx = b.topBlocker ?? "";
          return dir * ax.localeCompare(bx);
        }
        default:
          return 0;
      }
    });
    return arr;
  }, [metrics, sortKey, sortDir]);

  function onHeader(k: SortKey) {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir(k === "agent" ? "asc" : "desc");
    }
  }

  function sortIndicator(k: SortKey) {
    if (sortKey !== k) return null;
    return <span className="sort-indicator">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  // Boot states — mirror iteration-board.tsx.
  if (!loaded && !metrics) {
    return (
      <div className="metrics-panel">
        <div className="metrics-loading">Loading metrics…</div>
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="metrics-panel">
        <div className="metrics-error">Failed to load metrics: {error}</div>
      </div>
    );
  }

  // metrics is non-null here (loaded || metrics is set from a previous fetch
  // that didn't error this round-trip).
  const m = metrics!;
  const segs = segments(m);
  const totalMs = segs.reduce((acc, s) => acc + s.ms, 0);

  return (
    <div className="metrics-panel">
      {/* ---- Cycle time card ---- */}
      <div className="metrics-section">
        <h2>
          Cycle time
          <span className="metrics-window" role="tablist" aria-label="Window">
            {WINDOWS.map((opt) => (
              <button
                key={opt}
                type="button"
                role="tab"
                aria-selected={w === opt}
                className={w === opt ? "active" : ""}
                onClick={() => setWindow(opt)}
              >
                {opt}
              </button>
            ))}
          </span>
        </h2>
        <div className="metrics-bignums">
          <div className="metrics-bignum">
            <div className="label">Assignments</div>
            <div className="value">{m.count}</div>
          </div>
          <div className="metrics-bignum">
            <div className="label">p50 cycle</div>
            <div className="value">{formatDurationCompact(m.p50CycleMs)}</div>
          </div>
          <div className="metrics-bignum">
            <div className="label">p90 cycle</div>
            <div className="value">{formatDurationCompact(m.p90CycleMs)}</div>
          </div>
          <div className="metrics-bignum">
            <div className="label">p95 cycle</div>
            <div className="value">{formatDurationCompact(m.p95CycleMs)}</div>
          </div>
        </div>
      </div>

      {/* ---- Wait-time breakdown ---- */}
      <div className="metrics-section">
        <h2>Wait-time breakdown (mean per assignment)</h2>
        {totalMs === 0 ? (
          <div className="metrics-empty">No measurable activity in this window.</div>
        ) : (
          <>
            <div className="metrics-stack">
              {segs.map((s) =>
                s.ms > 0 ? (
                  <div
                    key={s.key}
                    className={`seg ${s.key}`}
                    style={{ flex: s.ms }}
                    title={`${SEG_LABELS[s.key]}: ${formatDurationCompact(s.ms)}`}
                  />
                ) : null
              )}
            </div>
            <div className="metrics-legend">
              {segs.map((s) =>
                s.ms > 0 ? (
                  <span className="item" key={s.key}>
                    <span className={`swatch ${s.key}`} style={{ backgroundColor: cssColor(s.key) }} />
                    {SEG_LABELS[s.key]} ({formatDurationCompact(s.ms)})
                  </span>
                ) : null
              )}
            </div>
          </>
        )}
      </div>

      {/* ---- Per-agent table ---- */}
      <div className="metrics-section">
        <h2>Per-agent</h2>
        {sortedAgents.length === 0 ? (
          <div className="metrics-empty">No agent activity in this window.</div>
        ) : (
          <table className="metrics-agents">
            <thead>
              <tr>
                <th onClick={() => onHeader("agent")}>Agent{sortIndicator("agent")}</th>
                <th className="num" onClick={() => onHeader("completed")}>
                  Completed{sortIndicator("completed")}
                </th>
                <th className="num" onClick={() => onHeader("p50")}>
                  p50 cycle{sortIndicator("p50")}
                </th>
                <th onClick={() => onHeader("blocker")}>
                  Top blocker{sortIndicator("blocker")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.map((a) => (
                <tr key={a.agentId}>
                  <td>{a.agentName}</td>
                  <td className="num">{a.completed}</td>
                  <td className="num">{formatDurationCompact(a.p50CycleMs)}</td>
                  <td>{a.topBlocker ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Inline swatch colour fallback so the legend swatches render even when the
// CSS file's `.seg.<class>` rules haven't loaded yet (tests, SSR-skeleton).
// Source-of-truth is metrics-panel.css; this map mirrors the same hexes.
function cssColor(seg: SegKey): string {
  switch (seg) {
    case "queued":
      return "#6b7280";
    case "dispatched":
      return "#94a3b8";
    case "running":
      return "#22c55e";
    case "permission":
      return "#f59e0b";
    case "tool_error":
      return "#ef4444";
    case "review":
      return "#8b5cf6";
  }
}
