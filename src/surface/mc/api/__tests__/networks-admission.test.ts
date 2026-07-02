/**
 * MC-B2 (cortex#1279) — tests for `handleAdmissionDecision`: the two gates
 * (CF-Access principal identity + typed-confirm) and the decider-verdict → HTTP
 * mapping. Pure — the decider is a stub; no bus, no network.
 */

import { describe, it, expect } from "bun:test";
import {
  handleAdmissionDecision,
  type AdmissionDecider,
  type AdmissionDecisionResult,
} from "../networks-admission";

function decider(result: AdmissionDecisionResult): AdmissionDecider {
  return { decide: () => Promise.resolve(result) };
}

/** A decider that must NOT be called (asserts the gate fired first). */
const throwingDecider: AdmissionDecider = {
  decide: () => {
    throw new Error("decider should not be reached");
  },
};

const OK_BODY = {
  network_id: "alpha",
  request_id: "req-abc-123",
  decision: "admit",
  confirm: "req-abc-123",
};

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("handleAdmissionDecision — gate 1: CF-Access principal identity", () => {
  it("401 when the principal identity is absent", async () => {
    const res = await handleAdmissionDecision(throwingDecider, undefined, OK_BODY);
    expect(res.status).toBe(401);
    expect((await body(res)).error).toBe("unauthenticated");
  });

  it("401 when the principal identity is blank/whitespace", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "   ", OK_BODY);
    expect(res.status).toBe(401);
  });
});

describe("handleAdmissionDecision — gate 2: body + typed-confirm", () => {
  it("400 when the body is not an object", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", null);
    expect(res.status).toBe(400);
  });

  it("400 when request_id is invalid", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", { ...OK_BODY, request_id: "!", confirm: "!" });
    expect(res.status).toBe(400);
  });

  it("400 when network_id is invalid", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", { ...OK_BODY, network_id: "Bad Net" });
    expect(res.status).toBe(400);
  });

  it("400 when decision is neither admit nor reject", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", { ...OK_BODY, decision: "revoke" });
    expect(res.status).toBe(400);
  });

  it("400 when confirm does not exactly echo request_id (typed-confirm gate)", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", { ...OK_BODY, confirm: "req-abc-124" });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("confirm must exactly match request_id");
  });

  it("400 when confirm has stray whitespace (exact echo, not trimmed)", async () => {
    const res = await handleAdmissionDecision(throwingDecider, "op@x.io", { ...OK_BODY, confirm: "req-abc-123 " });
    expect(res.status).toBe(400);
  });
});

describe("handleAdmissionDecision — decider wiring", () => {
  it("503 when the decider is not wired (null)", async () => {
    const res = await handleAdmissionDecision(null, "op@x.io", OK_BODY);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("not_configured");
  });

  it("200 + status when the decider admits", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: true, status: "ADMITTED", requestId: "req-abc-123" }),
      "op@x.io",
      OK_BODY,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.status).toBe("ADMITTED");
    expect(b.request_id).toBe("req-abc-123");
  });

  it("200 + REJECTED when rejecting", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: true, status: "REJECTED", requestId: "req-abc-123" }),
      "op@x.io",
      { ...OK_BODY, decision: "reject" },
    );
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe("REJECTED");
  });

  it("403 when the registry says not_authorized", async () => {
    const res = await handleAdmissionDecision(
      decider({ ok: false, reason: "not_authorized", detail: "not an admin" }),
      "op@x.io",
      OK_BODY,
    );
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error).toBe("not_authorized");
    expect(b.detail).toBe("not an admin");
  });

  it("409 already_decided, 429 rate_limited, 404 not_found, 502 unreachable map through", async () => {
    const cases: [AdmissionDecisionResult, number][] = [
      [{ ok: false, reason: "already_decided", detail: "x" }, 409],
      [{ ok: false, reason: "replayed", detail: "x" }, 409],
      [{ ok: false, reason: "rate_limited", detail: "x" }, 429],
      [{ ok: false, reason: "not_found", detail: "x" }, 404],
      [{ ok: false, reason: "invalid", detail: "x" }, 400],
      [{ ok: false, reason: "unreachable", detail: "x" }, 502],
    ];
    for (const [result, status] of cases) {
      const res = await handleAdmissionDecision(decider(result), "op@x.io", OK_BODY);
      expect(res.status).toBe(status);
    }
  });
});
