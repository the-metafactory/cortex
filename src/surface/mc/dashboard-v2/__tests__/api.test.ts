/**
 * lib/api unit tests — fetch wrapper error envelope.
 *
 * Verifies:
 *  - 2xx JSON returns parsed body
 *  - non-2xx with JSON {error: string} body propagates the error message
 *  - non-2xx with non-JSON body falls back to "HTTP <status>"
 *  - network failure produces ApiFailure with status=0
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ApiFailure, getJson, postJson } from "../lib/api";

const realFetch = globalThis.fetch;

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

describe("lib/api — getJson / postJson", () => {
  beforeEach(() => { /* fresh stub per test */ });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("getJson returns parsed body on 2xx", async () => {
    stubFetch(async () => new Response(JSON.stringify({ hello: "world" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const result = await getJson<{ hello: string }>("/api/test");
    expect(result).toEqual({ hello: "world" });
  });

  it("getJson throws ApiFailure with server message on 4xx + JSON error body", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "bad request" }), {
      status: 400, headers: { "content-type": "application/json" },
    }));
    let caught: ApiFailure | null = null;
    try { await getJson("/api/test"); } catch (e) {
      caught = e as ApiFailure;
    }
    expect(caught).toBeTruthy();
    expect(caught!.info.status).toBe(400);
    expect(caught!.info.message).toBe("bad request");
  });

  it("getJson falls back to HTTP <status> when error body isn't JSON", async () => {
    stubFetch(async () => new Response("plain text not json", {
      status: 500, headers: { "content-type": "text/plain" },
    }));
    let caught: ApiFailure | null = null;
    try { await getJson("/api/test"); } catch (e) {
      caught = e as ApiFailure;
    }
    expect(caught!.info.status).toBe(500);
    expect(caught!.info.message).toBe("HTTP 500");
  });

  it("getJson throws ApiFailure status=0 on network failure", async () => {
    stubFetch(async () => { throw new Error("network down"); });
    let caught: ApiFailure | null = null;
    try { await getJson("/api/test"); } catch (e) {
      caught = e as ApiFailure;
    }
    expect(caught!.info.status).toBe(0);
    expect(caught!.info.message).toBe("network down");
  });

  it("postJson sends JSON body and returns parsed response", async () => {
    let captured: { method?: string; body?: string; contentType?: string } = {};
    stubFetch(async (_input, init) => {
      captured = {
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        contentType: (init?.headers as Record<string, string>)?.["content-type"],
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const r = await postJson<{ x: number }, { ok: boolean }>("/api/test", { x: 1 });
    expect(r).toEqual({ ok: true });
    expect(captured.method).toBe("POST");
    expect(captured.contentType).toBe("application/json");
    expect(JSON.parse(captured.body!)).toEqual({ x: 1 });
  });
});
