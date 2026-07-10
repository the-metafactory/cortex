/**
 * MIG-7.2d — PagerDutyRenderer tests.
 *
 * Pins the events-v2 mapping rules in `pagerduty.ts`:
 *   - POST URL + payload shape (routing_key, event_action: trigger,
 *     dedup_key, severity, summary, custom_details)
 *   - severity classification (crashed → critical, degraded → error,
 *     fallback → warning, payload.severity override)
 *   - summary truncation at PagerDuty's 1024-char hard limit
 *   - HTTP failures + thrown errors log + drop (never throw out of
 *     `render()`)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PagerDutyRenderer } from "../pagerduty";
import type { Envelope } from "../../bus/myelin/envelope-validator";

let originalWarn: typeof console.warn;
let warnings: string[];

beforeEach(() => {
  originalWarn = console.warn;
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = originalWarn;
});

interface FetchCall {
  url: string;
  body: unknown;
  headers?: HeadersInit;
}

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call: FetchCall = { url, body, headers: init?.headers };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    source: "metafactory.discord-luna.guild-1",
    type: "system.adapter.degraded",
    timestamp: "2026-05-11T18:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: {},
    ...overrides,
  };
}

describe("PagerDutyRenderer", () => {
  // cortex#1788 (S3, ADR-0024 OQ10) — id defaults to kind; two `kind:
  // pagerduty` entries (different routing keys) need distinct configured
  // ids to avoid colliding in router metrics / a future `unload` verb.
  test("id defaults to \"pagerduty\" when config.id is unset", () => {
    const renderer = new PagerDutyRenderer({ kind: "pagerduty", routingKey: "rk", subscribe: [] });
    expect(renderer.id).toBe("pagerduty");
  });

  test("id honors config.id when set (OQ10)", () => {
    const renderer = new PagerDutyRenderer({ kind: "pagerduty", id: "pagerduty-secondary", routingKey: "rk-2", subscribe: [] });
    expect(renderer.id).toBe("pagerduty-secondary");
  });

  test("POSTs to the events-v2 endpoint with the routing key in the body", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk-test-123", subscribe: ["local.{principal}.system.>"] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope());
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect((calls[0]!.body as { routing_key: string }).routing_key).toBe("rk-test-123");
  });

  test("sets event_action=trigger and a deterministic dedup_key", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope({ source: "src-A", type: "system.process.crashed" }));
    expect(calls[0]!.body).toMatchObject({
      event_action: "trigger",
      dedup_key: "src-A:system.process.crashed",
    });
  });

  test("classifies severity: crashed → critical", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope({ type: "system.process.crashed" }));
    expect((calls[0]!.body as { payload: { severity: string } }).payload.severity).toBe("critical");
  });

  test("classifies severity: degraded → error", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope({ type: "system.adapter.degraded" }));
    expect((calls[0]!.body as { payload: { severity: string } }).payload.severity).toBe("error");
  });

  test("classifies severity: fallback → warning", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope({ type: "review.cycle.completed" }));
    expect((calls[0]!.body as { payload: { severity: string } }).payload.severity).toBe("warning");
  });

  test("payload.severity overrides the classifier", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await renderer.render(makeEnvelope({
      type: "review.cycle.completed",
      payload: { severity: "critical" },
    }));
    expect((calls[0]!.body as { payload: { severity: string } }).payload.severity).toBe("critical");
  });

  test("truncates summary at 1024 chars (PagerDuty hard limit)", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    const longSource = "a".repeat(2000);
    await renderer.render(makeEnvelope({ source: longSource }));
    const summary = (calls[0]!.body as { payload: { summary: string } }).payload.summary;
    expect(summary.length).toBeLessThanOrEqual(1024);
  });

  test("includes the full envelope as custom_details", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    const env = makeEnvelope({ id: "env-xyz" });
    await renderer.render(env);
    expect((calls[0]!.body as { payload: { custom_details: Envelope } }).payload.custom_details.id).toBe("env-xyz");
  });

  test("logs + drops on non-2xx HTTP response (never throws)", async () => {
    const { fetchImpl } = makeFetch(() => new Response("rate limit", { status: 429, statusText: "Too Many Requests" }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await expect(renderer.render(makeEnvelope())).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("HTTP 429"))).toBe(true);
  });

  test("logs + drops on fetch throwing (never throws)", async () => {
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl },
    );
    await expect(renderer.render(makeEnvelope())).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("network down"))).toBe(true);
  });

  test("surfaceConfig exposes the configured subjects and renderer id", () => {
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: ["local.{principal}.system.>"] },
    );
    expect(renderer.surfaceConfig.id).toBe("pagerduty");
    expect(renderer.surfaceConfig.subjects).toEqual(["local.{principal}.system.>"]);
  });

  test("custom endpoint override is honoured (for staging / tests)", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("", { status: 202 }));
    const renderer = new PagerDutyRenderer(
      { kind: "pagerduty", routingKey: "rk", subscribe: [] },
      { fetchImpl, endpoint: "https://staging.pagerduty.example/v2/enqueue" },
    );
    await renderer.render(makeEnvelope());
    expect(calls[0]!.url).toBe("https://staging.pagerduty.example/v2/enqueue");
  });
});
