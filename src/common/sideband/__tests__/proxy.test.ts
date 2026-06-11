/**
 * P-14 U0.1 — sideband server-side proxy: routing, error mapping, timeout,
 * body cap, header hygiene (signal cortex-sideband.md §2/§3/§4/§8).
 */

import { describe, expect, test } from "bun:test";
import { proxySideband, type SidebandProxyConfig } from "../proxy";

const BASE = "http://127.0.0.1:9092";

/** Build a fetch stub that records the call and returns a canned Response. */
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
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function cfg(over: Partial<SidebandProxyConfig> & { fetchImpl: typeof fetch }): SidebandProxyConfig {
  return { baseUrl: BASE, ...over };
}

describe("proxySideband — path allowlist (§2 endpoint surface)", () => {
  test("forwards /traces with query", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ correlation_id: "abc", backend: "victoria", spans: [] }),
    );
    const res = await proxySideband("GET", "/traces", "correlation_id=abcd", cfg({ fetchImpl }));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/traces?correlation_id=abcd");
  });

  test("forwards /logs with query", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ correlation_id: "abc", backend: "victoria", logs: [] }),
    );
    await proxySideband("GET", "/logs", "correlation_id=abcd", cfg({ fetchImpl }));
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/logs?correlation_id=abcd");
  });

  test("forwards /traces/{id}/timeline", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { fetchImpl, calls } = stubFetch(() =>
      Response.json({ correlation_id: id, backend: "victoria", entries: [] }),
    );
    const res = await proxySideband("GET", `/traces/${id}/timeline`, "", cfg({ fetchImpl }));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9092/traces/${id}/timeline`);
  });

  test("forwards /healthz", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ status: "ok", backend: "victoria" }));
    await proxySideband("GET", "/healthz", "", cfg({ fetchImpl }));
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/healthz");
  });

  test("refuses an unknown endpoint with structured 404", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("GET", "/admin/secrets", "", cfg({ fetchImpl }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("internal_error");
    expect(calls.length).toBe(0); // never reached upstream
  });

  test("refuses a path-traversal timeline id", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("GET", "/traces/..%2f..%2fadmin/timeline", "", cfg({ fetchImpl }));
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  test("refuses non-GET (read-only sideband, §9)", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband("POST", "/traces", "", cfg({ fetchImpl }));
    expect(res.status).toBe(405);
    expect(calls.length).toBe(0);
  });
});

describe("proxySideband — header hygiene (§3 tokenless)", () => {
  test("sends a bare GET with accept only; no auth headers", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ spans: [] }));
    await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl }));
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers).toEqual({ accept: "application/json" });
  });
});

describe("proxySideband — error mapping (§4 failure semantics)", () => {
  test("relays the sideband's own SidebandError + deep_link verbatim on 503", async () => {
    const { fetchImpl } = stubFetch(() =>
      Response.json(
        { code: "backend_unavailable", message: "backend down", deep_link: "https://grafana/x" },
        { status: 503 },
      ),
    );
    const res = await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(body.deep_link).toBe("https://grafana/x");
  });

  test("maps connection refusal to structured 503 (not a 500 splat)", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9092");
    }) as unknown as typeof fetch;
    const res = await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(body.message).toContain("interior capture not available");
  });

  test("maps timeout/abort to 504 with retry_after", async () => {
    const fetchImpl = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const res = await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl }));
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("backend_timeout");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("proxySideband — loopback re-enforcement at request boundary", () => {
  test("refuses a non-loopback base URL without ever fetching", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({}));
    const res = await proxySideband(
      "GET",
      "/traces",
      "correlation_id=x",
      cfg({ fetchImpl, baseUrl: "http://192.168.1.5:9092" }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(calls.length).toBe(0);
  });
});

describe("proxySideband — body cap", () => {
  test("refuses an oversized body (Content-Length) with structured 503", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response("x".repeat(100), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "100" },
        }),
    );
    const res = await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl, maxBodyBytes: 10 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
  });

  test("refuses an oversized streamed body without Content-Length", async () => {
    const big = "y".repeat(1000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const { fetchImpl } = stubFetch(
      () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await proxySideband("GET", "/logs", "correlation_id=x", cfg({ fetchImpl, maxBodyBytes: 10 }));
    expect(res.status).toBe(503);
  });

  test("passes a small body through unchanged", async () => {
    const payload = { correlation_id: "x", backend: "victoria", spans: [{ name: "tool.read" }] };
    const { fetchImpl } = stubFetch(() => Response.json(payload));
    const res = await proxySideband("GET", "/traces", "correlation_id=x", cfg({ fetchImpl, maxBodyBytes: 1024 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });
});

describe("proxySideband — reverse-proxy base path (§8)", () => {
  test("preserves a base URL path prefix", async () => {
    const { fetchImpl, calls } = stubFetch(() => Response.json({ spans: [] }));
    await proxySideband(
      "GET",
      "/traces",
      "correlation_id=x",
      cfg({ fetchImpl, baseUrl: "http://127.0.0.1:9092/sideband" }),
    );
    expect(calls[0]!.url).toBe("http://127.0.0.1:9092/sideband/traces?correlation_id=x");
  });
});
