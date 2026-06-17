/**
 * P-14 U4.2 (#938) — sideband proxy v2 reads: `/metrics/summary` + `/search`.
 *
 * The proxy's path allowlist (`mapAllowedPath`) gains the two v2 endpoints
 * (signal#127/#147). These tests pin:
 *   - both v2 paths forward verbatim (query string preserved),
 *   - the GET-only + loopback-re-enforcement + structured-error guarantees still
 *     hold for them (they are reads on the same tokenless local daemon),
 *   - a non-v2 path under the same prefix is still refused.
 *
 * Mirrors the U0.1 proxy.test.ts harness.
 */

import { describe, expect, test } from "bun:test";
import { proxySideband, type SidebandProxyConfig } from "../proxy";

const BASE = "http://127.0.0.1:9092";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function cfg(
  over: Partial<SidebandProxyConfig> & { fetchImpl: typeof fetch },
): SidebandProxyConfig {
  return { baseUrl: BASE, ...over };
}

describe("proxySideband — v2 metrics/summary (#938)", () => {
  test("forwards /metrics/summary with the window query", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ backend: "victoria", window: "5m", summary: {} }),
    );
    const res = await proxySideband(
      "GET",
      "/metrics/summary",
      "window=5m",
      cfg({ fetchImpl }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/metrics/summary?window=5m");
  });

  test("forwards a wide >14d window verbatim (history aggregate path)", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ backend: "victoria", window: "30d", summary: {} }),
    );
    await proxySideband("GET", "/metrics/summary", "window=30d", cfg({ fetchImpl }));
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/metrics/summary?window=30d");
  });

  test("sends a bare GET with accept only (tokenless §3)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ summary: {} }));
    await proxySideband("GET", "/metrics/summary", "window=1h", cfg({ fetchImpl }));
    expect(calls[0]!.init?.headers).toEqual({ accept: "application/json" });
  });

  test("refuses non-GET on the v2 path (read-only §9)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("POST", "/metrics/summary", "window=5m", cfg({ fetchImpl }));
    expect(res.status).toBe(405);
    expect(calls.length).toBe(0);
  });

  test("re-enforces loopback on the v2 path without fetching", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband(
      "GET",
      "/metrics/summary",
      "window=5m",
      cfg({ fetchImpl, baseUrl: "http://10.0.0.4:9092" }),
    );
    expect(res.status).toBe(503);
    expect(calls.length).toBe(0);
  });

  test("relays a backend SidebandError (e.g. 501 unsupported backend) verbatim", async () => {
    const { fetchImpl } = stubFetch(() =>
      Response.json(
        {
          code: "internal_error",
          message: 'backend "honeycomb" does not support /metrics/summary (PromQL)',
        },
        { status: 501 },
      ),
    );
    const res = await proxySideband("GET", "/metrics/summary", "window=5m", cfg({ fetchImpl }));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("internal_error");
    expect(body.message).toContain("does not support /metrics/summary");
  });
});

describe("proxySideband — v2 search (#938)", () => {
  test("forwards /search with the filter query verbatim", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ backend: "victoria", filter: {}, results: [] }),
    );
    const res = await proxySideband(
      "GET",
      "/search",
      "since=30d&class=dispatch&limit=200",
      cfg({ fetchImpl }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:9092/search?since=30d&class=dispatch&limit=200",
    );
  });

  test("forwards /search with no query (bare path)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ results: [] }));
    await proxySideband("GET", "/search", "", cfg({ fetchImpl }));
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/search");
  });

  test("preserves a reverse-proxy base path prefix on the v2 reads (§8)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ summary: {} }));
    await proxySideband(
      "GET",
      "/metrics/summary",
      "window=5m",
      cfg({ fetchImpl, baseUrl: "http://127.0.0.1:9092/sideband" }),
    );
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:9092/sideband/metrics/summary?window=5m",
    );
  });
});

describe("proxySideband — v2 allowlist is exact", () => {
  test("refuses /metrics (without /summary)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("GET", "/metrics", "", cfg({ fetchImpl }));
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  test("refuses /search/anything (no sub-paths)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("GET", "/search/all", "", cfg({ fetchImpl }));
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });
});
