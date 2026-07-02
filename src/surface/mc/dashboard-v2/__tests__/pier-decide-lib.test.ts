/**
 * MC-B2 (cortex#1279) — pure-logic tests for the decide action: the
 * typed-confirm gate, the POST verdict→outcome mapping (with an injected fetch),
 * and the outcome→message summary.
 */

import { describe, it, expect } from "bun:test";
import {
  ADMISSION_DECISION_PATH,
  canDecide,
  describeOutcome,
  submitDecision,
  type FetchLike,
} from "../lib/pier-decide-lib";

function stubFetch(status: number, payload: unknown, capture?: (path: string, init: { body: string }) => void): FetchLike {
  return (path, init) => {
    capture?.(path, init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    });
  };
}

describe("canDecide (typed-confirm gate)", () => {
  it("false when the request id is empty", () => {
    expect(canDecide({ requestId: "", confirm: "", busy: false })).toBe(false);
    expect(canDecide({ requestId: "   ", confirm: "   ", busy: false })).toBe(false);
  });
  it("false when busy", () => {
    expect(canDecide({ requestId: "req-1", confirm: "req-1", busy: true })).toBe(false);
  });
  it("false when confirm does not exactly echo the request id", () => {
    expect(canDecide({ requestId: "req-1", confirm: "req-2", busy: false })).toBe(false);
    expect(canDecide({ requestId: "req-1", confirm: "req-1 ", busy: false })).toBe(false);
  });
  it("true only on an exact echo, not busy", () => {
    expect(canDecide({ requestId: "req-1", confirm: "req-1", busy: false })).toBe(true);
  });
});

describe("submitDecision", () => {
  it("POSTs to the endpoint and returns ok/ADMITTED on 200", async () => {
    let seenPath = "";
    let seenBody: unknown;
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-1", decision: "admit", confirm: "req-1" },
      stubFetch(200, { status: "ADMITTED", request_id: "req-1" }, (path, init) => {
        seenPath = path;
        seenBody = JSON.parse(init.body);
      }),
    );
    expect(seenPath).toBe(ADMISSION_DECISION_PATH);
    expect((seenBody as { decision: string }).decision).toBe("admit");
    expect(res).toEqual({ kind: "ok", status: "ADMITTED", requestId: "req-1" });
  });

  it("returns REJECTED on a reject 200", async () => {
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-2", decision: "reject", confirm: "req-2" },
      stubFetch(200, { status: "REJECTED", request_id: "req-2" }),
    );
    expect(res).toEqual({ kind: "ok", status: "REJECTED", requestId: "req-2" });
  });

  it("surfaces the readable detail on a 403", async () => {
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-3", decision: "admit", confirm: "req-3" },
      stubFetch(403, { error: "not_authorized", detail: "your key is not a network admin" }),
    );
    expect(res).toEqual({ kind: "error", message: "your key is not a network admin", httpStatus: 403 });
  });

  it("falls back to the error code when no detail is present", async () => {
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-4", decision: "admit", confirm: "req-4" },
      stubFetch(409, { error: "already_decided" }),
    );
    expect(res).toEqual({ kind: "error", message: "already_decided", httpStatus: 409 });
  });

  it("never throws on a transport failure (httpStatus 0)", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("network down"));
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-5", decision: "admit", confirm: "req-5" },
      fetchImpl,
    );
    expect(res).toEqual({ kind: "error", message: "network down", httpStatus: 0 });
  });

  it("treats a 200 with a bad status as an error", async () => {
    const res = await submitDecision(
      { network_id: "alpha", request_id: "req-6", decision: "admit", confirm: "req-6" },
      stubFetch(200, { status: "MAYBE" }),
    );
    expect(res.kind).toBe("error");
  });
});

describe("describeOutcome", () => {
  it("summarises an admit", () => {
    expect(describeOutcome({ kind: "ok", status: "ADMITTED", requestId: "req-1" })).toEqual({
      tone: "ok",
      text: "Request req-1 admitted.",
    });
  });
  it("summarises a reject", () => {
    expect(describeOutcome({ kind: "ok", status: "REJECTED", requestId: "req-2" }).text).toBe("Request req-2 rejected.");
  });
  it("passes an error message through", () => {
    expect(describeOutcome({ kind: "error", message: "nope", httpStatus: 403 })).toEqual({ tone: "error", text: "nope" });
  });
});
