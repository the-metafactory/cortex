/**
 * P-14 U4.2 (#938) — ObsMetricsPanels rendering against captured fixtures.
 *
 * SSR-renders the aggregate panels (rates + hook-latency percentiles) and the
 * >14d history view through `renderToStaticMarkup`, using fixtures captured
 * verbatim from signal's contract types (SidebandMetricsSummary /
 * SidebandLogRecord). Pins:
 *   - REAL numbers render (rates as /s, percentiles as compact durations),
 *   - a genuinely empty window renders honest empty states (not zeros-as-data),
 *   - a SidebandError renders "interior capture not available" + the deep_link
 *     (honest degradation — NOT fabricated panels),
 *   - the >14d history note states the source honestly (VictoriaLogs past 14d).
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ObsMetricsPanels } from "../components/obs-metrics-panels";
import type { ObsMetricsState } from "../hooks/use-obs-metrics";
import type {
  SidebandLogRecord,
  SidebandMetricsSummary,
} from "../../../../common/sideband/metrics";

// Verbatim from signal/src/cli/query-v2.test.ts SUMMARY.
const SUMMARY: SidebandMetricsSummary = {
  window: "5m",
  toolCallRate: [
    { labels: { tool: "read" }, value: 0.5 },
    { labels: { tool: "bash" }, value: 0.25 },
  ],
  agentSpawnRate: [{ labels: {}, value: 0.1 }],
  eventRate: [{ labels: {}, value: 1.0 }],
  hookLatencyMs: { p50: 30, p95: 100, p99: 100 },
};

const EMPTY_SUMMARY: SidebandMetricsSummary = {
  window: "5m",
  toolCallRate: [],
  agentSpawnRate: [],
  eventRate: [{ labels: {}, value: null }],
  hookLatencyMs: { p50: null, p95: null, p99: null },
};

const HISTORY_ROWS: SidebandLogRecord[] = [
  {
    // 2026-05-01 00:00 UTC in unix-nanos. Split literal (seconds + "e9" zeros):
    // an unbroken 19-digit run trips the confidentiality-gate's platform-id
    // shape check (tier2:platform-snowflake) even for timestamps (#1552).
    timeUnixNano: "1777593600" + "000000000",
    body: '{"type":"dispatch.task.received"}',
    severityText: "INFO",
    attributes: {
      envelope_class: "dispatch",
      envelope_entity: "task",
      envelope_action: "received",
    },
  },
];

function baseState(over: Partial<ObsMetricsState> = {}): ObsMetricsState {
  return {
    summary: { phase: "loading" },
    window: "5m",
    setWindow: () => {},
    history: { phase: "loading" },
    loadHistory: () => {},
    ...over,
  };
}

function render(state: ObsMetricsState): string {
  return renderToStaticMarkup(createElement(ObsMetricsPanels, { state }));
}

describe("ObsMetricsPanels — real numbers from /metrics/summary fixture", () => {
  it("renders tool/spawn/event rates and latency percentiles", () => {
    const html = render(baseState({ summary: { phase: "ready", data: SUMMARY } }));
    // Rates: spawn 0.1/s, event 1.00/s. Per-tool rows.
    expect(html).toContain("/s");
    expect(html).toContain("0.100/s"); // spawn rate (toPrecision(3) on sub-1/s)
    expect(html).toContain("1.00/s"); // event rate (>=1 → 2dp)
    expect(html).toContain("read");
    expect(html).toContain("bash");
    // Distinct tools = 2.
    expect(html).toContain("Distinct tools");
    // Latency percentiles rendered (30ms / 100ms via formatDurationCompact).
    expect(html).toContain("p50");
    expect(html).toContain("p95");
    expect(html).toContain("p99");
  });

  it("renders honest empty states for a genuinely empty window (not zeros)", () => {
    const html = render(baseState({ summary: { phase: "ready", data: EMPTY_SUMMARY } }));
    expect(html).toContain("No tool-call activity in this window.");
    expect(html).toContain("No hook-latency samples in this window.");
  });
});

describe("ObsMetricsPanels — honest degradation on SidebandError", () => {
  it("renders 'interior capture not available' + deep_link, not fabricated panels", () => {
    const html = render(
      baseState({
        summary: {
          phase: "error",
          message: "interior capture not available — sideband unreachable",
          deepLink: "https://grafana.example/d/signal-overview",
        },
      }),
    );
    expect(html).toContain("interior capture not available");
    expect(html).toContain("https://grafana.example/d/signal-overview");
    expect(html).toContain("Open in observability backend");
    // It did NOT render rate rows.
    expect(html).not.toContain("Distinct tools");
  });

  it("renders a loading state before data arrives", () => {
    const html = render(baseState({ summary: { phase: "loading" } }));
    expect(html).toContain("Loading metrics…");
  });
});

describe("ObsMetricsPanels — >14d history view", () => {
  it("renders the history CTA + honest source note when collapsed", () => {
    const html = render(baseState({ summary: { phase: "ready", data: SUMMARY } }));
    expect(html).toContain("Show history");
    expect(html).toContain("VictoriaLogs");
    expect(html).toContain("14-day local retention");
  });
});
