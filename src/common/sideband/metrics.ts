/**
 * Cortex-side response types + request helpers for the sideband v2 reads
 * (P-14 U4.2, cortex#938) — `/metrics/summary` and `/search`.
 *
 * These types are PINNED to signal's contract. Signal's authoritative wire
 * shapes live in `signal/src/lib/sideband/types.ts`:
 *   - `SidebandMetricSample`        → {@link SidebandMetricSample}
 *   - `SidebandLatencyPercentiles`  → {@link SidebandLatencyPercentiles}
 *   - `SidebandMetricsSummary`      → {@link SidebandMetricsSummary}
 *   - `MetricsSummaryResponse`      → {@link MetricsSummaryResponse}
 *   - `SidebandSearchFilter`        → {@link SidebandSearchFilter}
 *   - `SearchResponse`              → {@link SearchResponse}
 *   - `SidebandLogRecord`           → {@link SidebandLogRecord}
 *
 * Signal's `docs/contract/cortex-sideband.md` documents both v2 reads since
 * signal#152 (merged 2026-06-16): §2.5 `GET /metrics/summary` and §2.6
 * `GET /search`. That doc + signal's `src/lib/sideband/types.ts` are the
 * contract source-of-truth for these two endpoints; this module mirrors the
 * `types.ts` shapes (the type-pin source) and is enforced at compile time
 * against captured signal fixtures. The `SidebandError` envelope is shared
 * verbatim with the P-9 reads
 * (see `proxy.ts`), so a v2 failure renders through the SAME honest
 * "interior capture not available" + `deep_link` affordance.
 *
 * Pure module: no fetch, no DOM. The fetch path lives in the
 * `use-obs-metrics` hook so this stays unit-testable in isolation and the
 * type-pin is enforced at compile time against captured signal fixtures.
 */

// =============================================================================
// /metrics/summary — aggregate panels (pinned to signal SidebandMetricsSummary)
// =============================================================================

/**
 * One evaluated PromQL series point. `value` is `null` when the underlying
 * series produced a non-finite result (NaN / +Inf — VictoriaMetrics emits
 * these for empty histograms); cortex renders `null` as an em-dash.
 *
 * Mirrors signal `SidebandMetricSample`.
 */
export interface SidebandMetricSample {
  /** Label set the series carried (e.g. `{ tool: "read" }`). */
  labels: Record<string, string>;
  /** Evaluated PromQL value; `null` for NaN / Inf. */
  value: number | null;
}

/**
 * Hook-latency p50 / p95 / p99 of `pai_duration_ms`, in milliseconds. A field
 * is `null` when the histogram had no samples in the window.
 *
 * Mirrors signal `SidebandLatencyPercentiles`.
 */
export interface SidebandLatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/**
 * The signal-overview panels as JSON. Rates are per-second over `window`.
 *
 * Mirrors signal `SidebandMetricsSummary`. Metric provenance (signal
 * `architecture.md` §3.2): `pai_tool_calls_total`, `pai_agent_spawns_total`,
 * `pai_events_total` (counters → rates), `pai_duration_ms` (histogram → p50/95/99).
 */
export interface SidebandMetricsSummary {
  /** The rate window the panels were evaluated over (e.g. `5m`). */
  window: string;
  /** Per-second tool-call rate, broken out by `tool` label. */
  toolCallRate: SidebandMetricSample[];
  /** Per-second agent-spawn rate (typically a single point). */
  agentSpawnRate: SidebandMetricSample[];
  /** Per-second overall event rate. */
  eventRate: SidebandMetricSample[];
  /** Hook-latency p50 / p95 / p99 over the window, milliseconds. */
  hookLatencyMs: SidebandLatencyPercentiles;
}

/**
 * Response body for `GET /metrics/summary`. Mirrors signal `MetricsSummaryResponse`.
 */
export interface MetricsSummaryResponse {
  /** Adapter name (`victoria` only — PromQL is victoria-specific today). */
  backend: string;
  /** The rate window applied (echo of the request `window`). */
  window: string;
  /** The signal-overview panels. */
  summary: SidebandMetricsSummary;
}

// =============================================================================
// /search — generalized LogsQL filter (pinned to signal SidebandSearchFilter)
// =============================================================================

/**
 * A log record subset. Mirrors signal `SidebandLogRecord` (`cortex-sideband.md`
 * §2.2 / signal `types.ts`). Cortex already mirrors this shape in
 * `dashboard-v2/lib/sideband-timeline.ts`; re-declared here for the v2 search
 * surface so `common/sideband` is self-contained (no surface→surface import).
 */
export interface SidebandLogRecord {
  /** Unix-nanos timestamp the record was observed. */
  timeUnixNano: string;
  /** Body text — for envelope-tail records, the verbatim envelope JSON. */
  body: string;
  /** OTel severity: TRACE / DEBUG / INFO / WARN / ERROR / FATAL / "". */
  severityText: string;
  /** Flat attribute bag (underscored keys per envelope-tail §3.1). */
  attributes: Record<string, string | number | boolean | null>;
}

/**
 * Filter set for `GET /search`. Mirrors signal `SidebandSearchFilter`.
 *
 * SAFETY: every populated field is interpolated into LogsQL on the SERVER side.
 * The cortex client validates the same gates BEFORE building the query string
 * (see {@link buildSearchQuery}) so a malformed value is rejected at the cortex
 * boundary rather than round-tripping to a server 400 — but the server is the
 * load-bearing gate regardless (defense in depth).
 */
export interface SidebandSearchFilter {
  /** LogsQL relative time range, e.g. `30m` / `1h` / `30d`. */
  since?: string;
  /** Envelope class (segment-4 myelin domain: `dispatch` / `review` / …). */
  class?: string;
  /** Free-text substring matched across the record body. */
  query?: string;
  /** Max records to return. */
  limit?: number;
}

/** Response body for `GET /search`. Mirrors signal `SearchResponse`. */
export interface SearchResponse {
  /** Adapter name. */
  backend: string;
  /** Echo of the applied filter (post-validation). */
  filter: SidebandSearchFilter;
  /** Matching log records, sorted ascending by `timeUnixNano`. */
  results: SidebandLogRecord[];
}

// =============================================================================
// Client-side request helpers (pure — mirror signal's server-side gates)
// =============================================================================

/**
 * PromQL / LogsQL duration grammar — one or more `<number><unit>`, units
 * s/m/h/d/w. IDENTICAL to signal's `DURATION_RE` (server.ts) and
 * `isValidPromWindow` (victoria.ts). The value is interpolated into a PromQL
 * range selector / LogsQL `_time:` filter on the server, so this gate is
 * load-bearing; we apply it client-side so a bad window/since is refused before
 * the round-trip rather than surfacing as a server 400.
 */
const DURATION_RE = /^(\d+[smhdw])+$/;

/** Bare lowercase envelope-class token — mirrors signal's `CLASS_RE`. */
const CLASS_RE = /^[a-z][a-z0-9_-]*$/;

/** Free-text cap — mirrors signal's `SEARCH_QUERY_MAX`. */
const SEARCH_QUERY_MAX = 1024;

/** Default aggregate window for the live panels (mirrors signal `DEFAULT_METRICS_WINDOW`). */
export const DEFAULT_METRICS_WINDOW = "5m";

/**
 * Window options the aggregate panels offer. `5m` / `1h` / `24h` are the
 * "live" windows; `30d` is the >14d history window — wider than MC's
 * 14-day local `observability_events` retention, so it is necessarily sourced
 * from signal's VictoriaMetrics (which retains far longer), NOT the local
 * projection. See {@link HISTORY_WINDOW}.
 */
export const METRICS_WINDOWS = ["5m", "1h", "24h", "30d"] as const;
export type MetricsWindow = (typeof METRICS_WINDOWS)[number];

/**
 * The >14d history window. MC's `observability_events` projection prunes at
 * 14 days (`OBSERVABILITY_RETENTION_MS = 14 * DAY_MS`, db/retention.ts), so any
 * "history past 14d" view CANNOT be served from the local projection. This
 * window is honoured against signal's backend instead: VictoriaMetrics
 * (aggregate panels) + VictoriaLogs (event rows via `/search`), which retain
 * 30/90d (cortex#938). Sourcing history here is the honest path the issue calls
 * for — "history past MC's 7/14d retention (VictoriaLogs holds 30/90d)".
 */
export const HISTORY_WINDOW: MetricsWindow = "30d";

/** True iff `window` is a valid PromQL/LogsQL duration. */
export function isValidDuration(window: string): boolean {
  return DURATION_RE.test(window);
}

/**
 * Build the proxied `/api/observability/metrics/summary` request path for a
 * given window. Throws on an invalid window (caller pre-validated, but this is
 * the load-bearing client gate before the interpolated value leaves cortex).
 */
export function buildMetricsSummaryPath(window: string): string {
  if (!isValidDuration(window)) {
    throw new Error(
      `invalid metrics window "${window}" — must be a PromQL duration like 5m, 1h, 30d`,
    );
  }
  const qs = new URLSearchParams({ window });
  return `/api/observability/metrics/summary?${qs.toString()}`;
}

/**
 * Build the proxied `/api/observability/search` request path from a filter.
 * Validates every populated field with the same gates signal's server applies
 * (DURATION_RE / CLASS_RE / SEARCH_QUERY_MAX / positive-int limit) so a bad
 * value is refused at the cortex boundary. Throws on any invalid field.
 */
export function buildSearchPath(filter: SidebandSearchFilter): string {
  const qs = new URLSearchParams();
  if (filter.since !== undefined) {
    if (!DURATION_RE.test(filter.since)) {
      throw new Error(
        `invalid search "since" "${filter.since}" — must be a LogsQL duration like 30m, 1h, 30d`,
      );
    }
    qs.set("since", filter.since);
  }
  if (filter.class !== undefined) {
    if (!CLASS_RE.test(filter.class)) {
      throw new Error(
        `invalid search "class" "${filter.class}" — must be a bare lowercase token like dispatch`,
      );
    }
    qs.set("class", filter.class);
  }
  if (filter.query !== undefined && filter.query.length > 0) {
    if (filter.query.length > SEARCH_QUERY_MAX) {
      throw new Error(`search "query" exceeds ${SEARCH_QUERY_MAX} chars`);
    }
    qs.set("query", filter.query);
  }
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit < 1) {
      throw new Error(`invalid search "limit" — must be a positive integer`);
    }
    qs.set("limit", String(filter.limit));
  }
  const query = qs.toString();
  return query === ""
    ? "/api/observability/search"
    : `/api/observability/search?${query}`;
}

// Re-export the shared `buildSearchQuery` alias used in docs/tests.
export { buildSearchPath as buildSearchQuery };
