/**
 * FLG-2 (cortex#1706) — tests for the authorize-from-glass pure lib: the
 * typed-confirm + step-up gate (`canAuthorize`), the POST + verdict mapping
 * (`submitAuthorize`, incl. the `X-Cortex-Step-Up-Otp` header), and the
 * outcome-describe. Injected `FetchLike`; no DOM, no network.
 */

import { describe, it, expect } from "bun:test";
import {
  canAuthorize,
  submitAuthorize,
  describeAuthorizeOutcome,
  AUTHORIZE_PATH,
  STEP_UP_HEADER,
  type FetchLike,
} from "../authorize-lib";

const REQ = "req-abc-123";

/** A FetchLike that records the call and returns a canned response. */
function fakeFetch(resp: {
  ok: boolean;
  status: number;
  body: unknown;
}): { fetchImpl: FetchLike; calls: { path: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { path: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    calls,
    fetchImpl: (path, init) => {
      calls.push({ path, init });
      return Promise.resolve({
        ok: resp.ok,
        status: resp.status,
        json: () => Promise.resolve(resp.body),
      });
    },
  };
}

describe("canAuthorize — typed-confirm + step-up gate", () => {
  it("is true only when id + exact confirm + a step-up code are present and not busy", () => {
    expect(canAuthorize({ requestId: REQ, confirm: REQ, stepUpCode: "123456", busy: false })).toBe(true);
  });

  it("is false with an empty request id", () => {
    expect(canAuthorize({ requestId: "  ", confirm: "  ", stepUpCode: "123456", busy: false })).toBe(false);
  });

  it("is false when the confirm does not exactly echo the id (not trimmed)", () => {
    expect(canAuthorize({ requestId: REQ, confirm: `${REQ} `, stepUpCode: "123456", busy: false })).toBe(false);
    expect(canAuthorize({ requestId: REQ, confirm: "req-abc-124", stepUpCode: "123456", busy: false })).toBe(false);
  });

  it("is false without a step-up code (control verb is MFA-gated)", () => {
    expect(canAuthorize({ requestId: REQ, confirm: REQ, stepUpCode: "  ", busy: false })).toBe(false);
  });

  it("is false while a request is in flight", () => {
    expect(canAuthorize({ requestId: REQ, confirm: REQ, stepUpCode: "123456", busy: true })).toBe(false);
  });
});

describe("submitAuthorize — POST + verdict mapping", () => {
  it("POSTs to the authorize path with the step-up code in the header", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ok: true,
      status: 200,
      body: { request_id: REQ, hub_authorized_at: "2026-07-08T00:00:00.000Z" },
    });
    await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(AUTHORIZE_PATH);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers[STEP_UP_HEADER]).toBe("123456");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
  });

  it("trims the step-up code before sending it in the header", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ok: true,
      status: 200,
      body: { request_id: REQ, hub_authorized_at: "t" },
    });
    await submitAuthorize({ request_id: REQ, confirm: REQ }, "  123456  ", fetchImpl);
    expect(calls[0]?.init.headers[STEP_UP_HEADER]).toBe("123456");
  });

  it("maps a 2xx with hub_authorized_at to an ok outcome", async () => {
    const { fetchImpl } = fakeFetch({
      ok: true,
      status: 200,
      body: { request_id: REQ, hub_authorized_at: "2026-07-08T00:00:00.000Z" },
    });
    const outcome = await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.requestId).toBe(REQ);
      expect(outcome.hubAuthorizedAt).toBe("2026-07-08T00:00:00.000Z");
    }
  });

  it("maps a 2xx WITHOUT hub_authorized_at to an error (never fabricates success)", async () => {
    const { fetchImpl } = fakeFetch({ ok: true, status: 200, body: { request_id: REQ } });
    const outcome = await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.httpStatus).toBe(200);
  });

  it("prefers the server detail on a failure and preserves the http status", async () => {
    const { fetchImpl } = fakeFetch({
      ok: false,
      status: 409,
      body: { error: "not_admitted", detail: "request is PENDING, not ADMITTED" },
    });
    const outcome = await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("PENDING");
      expect(outcome.httpStatus).toBe(409);
    }
  });

  it("surfaces the 503 hub_admin_not_configured detail on an absent-seed daemon", async () => {
    const { fetchImpl } = fakeFetch({
      ok: false,
      status: 503,
      body: { error: "hub_admin_not_configured", detail: "no hub-admin signing seed" },
    });
    const outcome = await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.httpStatus).toBe(503);
      expect(outcome.message).toContain("hub-admin");
    }
  });

  it("never throws on a transport failure — maps it to httpStatus 0", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("network down"));
    const outcome = await submitAuthorize({ request_id: REQ, confirm: REQ }, "123456", fetchImpl);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.httpStatus).toBe(0);
      expect(outcome.message).toContain("network down");
    }
  });
});

describe("describeAuthorizeOutcome", () => {
  it("tone ok on success, naming the stamped request", () => {
    const d = describeAuthorizeOutcome({ kind: "ok", requestId: REQ, hubAuthorizedAt: "t" });
    expect(d.tone).toBe("ok");
    expect(d.text).toContain(REQ);
  });

  it("tone error carries the failure message", () => {
    const d = describeAuthorizeOutcome({ kind: "error", message: "not authorized", httpStatus: 403 });
    expect(d.tone).toBe("error");
    expect(d.text).toBe("not authorized");
  });
});
