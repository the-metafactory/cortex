/**
 * P-14 U4.2 (#938) — cortex-side sideband metrics client (request builders +
 * validation gates). Pins the cortex types to signal's contract via a
 * captured `SidebandMetricsSummary` fixture (verbatim from signal's
 * query-v2.test.ts SUMMARY) and verifies the load-bearing window/since/class
 * gates mirror signal's server-side gates (DURATION_RE / CLASS_RE / cap).
 */

import { describe, expect, test } from "bun:test";
import {
  buildMetricsSummaryPath,
  buildSearchPath,
  buildSearchQuery,
  DEFAULT_METRICS_WINDOW,
  HISTORY_WINDOW,
  isValidDuration,
  METRICS_WINDOWS,
  type MetricsSummaryResponse,
  type SidebandMetricsSummary,
} from "../metrics";

// Captured verbatim from signal/src/cli/query-v2.test.ts `SUMMARY` — pins the
// cortex type to signal's wire shape at compile time (this object must satisfy
// the cortex SidebandMetricsSummary).
const SUMMARY_FIXTURE: SidebandMetricsSummary = {
  window: "5m",
  toolCallRate: [
    { labels: { tool: "read" }, value: 0.5 },
    { labels: { tool: "bash" }, value: 0.25 },
  ],
  agentSpawnRate: [{ labels: {}, value: 0.1 }],
  eventRate: [{ labels: {}, value: 1.0 }],
  hookLatencyMs: { p50: 30, p95: 100, p99: 100 },
};

// Captured verbatim from signal's MetricsSummaryResponse wrapper shape.
const RESPONSE_FIXTURE: MetricsSummaryResponse = {
  backend: "victoria",
  window: "5m",
  summary: SUMMARY_FIXTURE,
};

describe("metrics client — type pin to signal contract", () => {
  test("the captured signal fixture satisfies the cortex types", () => {
    // Compile-time assertion realized at runtime: the objects exist + carry the
    // contract fields. A drift in signal's shape would fail tsc on this file.
    expect(RESPONSE_FIXTURE.summary.hookLatencyMs.p95).toBe(100);
    expect(RESPONSE_FIXTURE.summary.toolCallRate[0]!.labels.tool).toBe("read");
    expect(RESPONSE_FIXTURE.backend).toBe("victoria");
  });

  test("nullable percentile / sample shapes are honoured", () => {
    const empty: SidebandMetricsSummary = {
      window: "5m",
      toolCallRate: [],
      agentSpawnRate: [],
      eventRate: [{ labels: {}, value: null }],
      hookLatencyMs: { p50: null, p95: null, p99: null },
    };
    expect(empty.hookLatencyMs.p50).toBeNull();
    expect(empty.eventRate[0]!.value).toBeNull();
  });
});

describe("isValidDuration — mirrors signal DURATION_RE", () => {
  test.each(["5m", "1h", "24h", "30d", "2w", "1h30m", "90d"])(
    "accepts %s",
    (w) => {
      expect(isValidDuration(w)).toBe(true);
    },
  );
  test.each(["", "5", "m", "5x", "5 m", "-5m", "5min", "abc"])(
    "rejects %s",
    (w) => {
      expect(isValidDuration(w)).toBe(false);
    },
  );
});

describe("buildMetricsSummaryPath", () => {
  test("builds the proxied path with the window query", () => {
    expect(buildMetricsSummaryPath("5m")).toBe(
      "/api/observability/metrics/summary?window=5m",
    );
  });
  test("builds the >14d history window path", () => {
    expect(buildMetricsSummaryPath(HISTORY_WINDOW)).toBe(
      "/api/observability/metrics/summary?window=30d",
    );
  });
  test("throws on an invalid window (load-bearing client gate)", () => {
    expect(() => buildMetricsSummaryPath("5 minutes")).toThrow(/invalid metrics window/);
    expect(() => buildMetricsSummaryPath("")).toThrow();
  });
  test("DEFAULT_METRICS_WINDOW + METRICS_WINDOWS are coherent", () => {
    expect(METRICS_WINDOWS).toContain(DEFAULT_METRICS_WINDOW as never);
    expect(METRICS_WINDOWS).toContain(HISTORY_WINDOW);
  });
});

describe("buildSearchPath — mirrors signal's /search gates", () => {
  test("builds the default >14d history filter path", () => {
    expect(buildSearchPath({ since: "30d", limit: 200 })).toBe(
      "/api/observability/search?since=30d&limit=200",
    );
  });
  test("omits empty query and builds bare path with no fields", () => {
    expect(buildSearchPath({})).toBe("/api/observability/search");
    expect(buildSearchPath({ query: "" })).toBe("/api/observability/search");
  });
  test("includes class + free-text query when present", () => {
    const path = buildSearchPath({ since: "1h", class: "dispatch", query: "task" });
    expect(path).toContain("since=1h");
    expect(path).toContain("class=dispatch");
    expect(path).toContain("query=task");
  });
  test("rejects a bad since duration", () => {
    expect(() => buildSearchPath({ since: "yesterday" })).toThrow(/since/);
  });
  test("rejects a bad class token (CLASS_RE)", () => {
    expect(() => buildSearchPath({ class: "Dispatch" })).toThrow(/class/);
    expect(() => buildSearchPath({ class: "dis patch" })).toThrow(/class/);
  });
  test("rejects an over-long query (SEARCH_QUERY_MAX = 1024)", () => {
    expect(() => buildSearchPath({ query: "x".repeat(1025) })).toThrow(/exceeds/);
    // exactly 1024 is allowed.
    expect(buildSearchPath({ query: "x".repeat(1024) })).toContain("query=");
  });
  test("rejects a non-positive / non-integer limit", () => {
    expect(() => buildSearchPath({ limit: 0 })).toThrow(/limit/);
    expect(() => buildSearchPath({ limit: -5 })).toThrow(/limit/);
    expect(() => buildSearchPath({ limit: 1.5 })).toThrow(/limit/);
  });
  test("buildSearchQuery is an alias of buildSearchPath", () => {
    expect(buildSearchQuery({ since: "30d" })).toBe(buildSearchPath({ since: "30d" }));
  });
});
