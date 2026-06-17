/**
 * P-14 U4.2 (#938) — Observability aggregate-metrics hook.
 *
 * Fetches the sideband v2 reads through U0.1's server-side proxy:
 *   - `GET /api/observability/metrics/summary?window=…`  → aggregate panels
 *     (tool/spawn/event rates + hook-latency p50/p95/p99) from VictoriaMetrics.
 *   - `GET /api/observability/search?since=30d&…`        → >14d event history
 *     from VictoriaLogs (past MC's 14-day local projection prune).
 *
 * Both paths degrade HONESTLY on a `SidebandError`: the same envelope (with its
 * optional `deep_link`) the P-9 reads carry, surfaced as "interior capture not
 * available" rather than fabricated zeros — distinct from a genuinely empty
 * window, which renders real empty panels. The browser only ever talks to MC
 * (same origin); MC proxies to the loopback sideband (`127.0.0.1:9092`).
 *
 * Only fetches when `enabled` (the Observability tab is visible). Changing the
 * `window` refetches the aggregate panels; the history view refetches on its
 * own toggle. Mirrors the boot/gen/alive discipline of `use-observability`.
 *
 * Live-oracle note: the real values come from a running signal stack
 * (VictoriaMetrics + VictoriaLogs reached via the sideband). Without the live
 * stack the proxy returns a `backend_unavailable` SidebandError, which this
 * hook renders honestly. The client→proxy wiring + panel rendering are unit-
 * tested against captured fixtures; the live path is wired end-to-end.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMetricsSummaryPath,
  buildSearchPath,
  DEFAULT_METRICS_WINDOW,
  type MetricsSummaryResponse,
  type SearchResponse,
  type SidebandLogRecord,
  type SidebandMetricsSummary,
  type SidebandSearchFilter,
} from "../../../../common/sideband/metrics";
import type { SidebandError } from "../../../../common/sideband/proxy";

/** A loaded-or-failed result, preserving the SidebandError for honest rendering. */
export type ObsMetricsLoad<T> =
  | { phase: "loading" }
  | { phase: "ready"; data: T }
  | { phase: "error"; message: string; deepLink?: string };

export interface ObsMetricsState {
  /** Aggregate panels for the currently-selected `window`. */
  summary: ObsMetricsLoad<SidebandMetricsSummary>;
  /** The selected aggregate window. */
  window: string;
  setWindow: (w: string) => void;
  /** >14d event history (lazy — only loaded once the history view is opened). */
  history: ObsMetricsLoad<SidebandLogRecord[]>;
  /** Open/refresh the >14d history view (sourced from VictoriaLogs via /search). */
  loadHistory: (filter?: SidebandSearchFilter) => void;
}

/** Default history filter — events past the 14-day local prune, capped. */
const DEFAULT_HISTORY_FILTER: SidebandSearchFilter = { since: "30d", limit: 200 };

/**
 * Parse a non-2xx proxy response into a `SidebandError`. The proxy always
 * returns the contract error shape (never a 500 splat), but a transport-level
 * failure reaching MC itself can still happen — fall back to a generic honest
 * label in that case.
 */
async function readSidebandError(resp: Response): Promise<SidebandError> {
  try {
    const body = (await resp.json()) as Partial<SidebandError>;
    if (body && typeof body.code === "string" && typeof body.message === "string") {
      return body as SidebandError;
    }
  } catch {
    // fall through
  }
  return {
    code: "backend_unavailable",
    message: "interior capture not available — sideband returned an unexpected response",
  };
}

function errorLoad<T>(err: SidebandError): ObsMetricsLoad<T> {
  const next: ObsMetricsLoad<T> = { phase: "error", message: err.message };
  if (err.deep_link) (next as { deepLink?: string }).deepLink = err.deep_link;
  return next;
}

export function useObsMetrics(enabled: boolean): ObsMetricsState {
  const [summary, setSummary] = useState<ObsMetricsLoad<SidebandMetricsSummary>>({
    phase: "loading",
  });
  const [window, setWindowState] = useState<string>(DEFAULT_METRICS_WINDOW);
  const [history, setHistory] = useState<ObsMetricsLoad<SidebandLogRecord[]>>({
    phase: "loading",
  });

  const aliveRef = useRef(true);
  const summaryGenRef = useRef(0);
  const historyGenRef = useRef(0);
  const historyRequestedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const fetchSummary = useCallback(async (w: string) => {
    const gen = ++summaryGenRef.current;
    setSummary({ phase: "loading" });
    let path: string;
    try {
      path = buildMetricsSummaryPath(w);
    } catch (e) {
      if (!aliveRef.current || gen !== summaryGenRef.current) return;
      setSummary({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      const resp = await fetch(path, { headers: { accept: "application/json" } });
      if (!aliveRef.current || gen !== summaryGenRef.current) return;
      if (!resp.ok) {
        setSummary(errorLoad(await readSidebandError(resp)));
        return;
      }
      const body = (await resp.json()) as MetricsSummaryResponse;
      if (!aliveRef.current || gen !== summaryGenRef.current) return;
      setSummary({ phase: "ready", data: body.summary });
    } catch {
      if (!aliveRef.current || gen !== summaryGenRef.current) return;
      setSummary(
        errorLoad({
          code: "backend_unavailable",
          message:
            "interior capture not available — could not reach Mission Control for metrics",
        }),
      );
    }
  }, []);

  const fetchHistory = useCallback(async (filter: SidebandSearchFilter) => {
    const gen = ++historyGenRef.current;
    setHistory({ phase: "loading" });
    let path: string;
    try {
      path = buildSearchPath(filter);
    } catch (e) {
      if (!aliveRef.current || gen !== historyGenRef.current) return;
      setHistory({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      const resp = await fetch(path, { headers: { accept: "application/json" } });
      if (!aliveRef.current || gen !== historyGenRef.current) return;
      if (!resp.ok) {
        setHistory(errorLoad(await readSidebandError(resp)));
        return;
      }
      const body = (await resp.json()) as SearchResponse;
      if (!aliveRef.current || gen !== historyGenRef.current) return;
      setHistory({ phase: "ready", data: body.results });
    } catch {
      if (!aliveRef.current || gen !== historyGenRef.current) return;
      setHistory(
        errorLoad({
          code: "backend_unavailable",
          message:
            "interior capture not available — could not reach Mission Control for history",
        }),
      );
    }
  }, []);

  // Aggregate panels: fetch on enable + whenever the window changes.
  useEffect(() => {
    if (!enabled) return;
    void fetchSummary(window);
  }, [enabled, window, fetchSummary]);

  // History is lazy: only fetch once the >14d view is opened, and
  // refetch on enable thereafter (so reopening the tab re-reads it).
  useEffect(() => {
    if (!enabled || !historyRequestedRef.current) return;
    void fetchHistory(DEFAULT_HISTORY_FILTER);
  }, [enabled, fetchHistory]);

  const setWindow = useCallback((w: string) => setWindowState(w), []);

  const loadHistory = useCallback(
    (filter?: SidebandSearchFilter) => {
      historyRequestedRef.current = true;
      void fetchHistory(filter ?? DEFAULT_HISTORY_FILTER);
    },
    [fetchHistory],
  );

  return { summary, window, setWindow, history, loadHistory };
}
