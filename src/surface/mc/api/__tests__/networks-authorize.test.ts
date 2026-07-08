/**
 * FLG-2 (cortex#1706) — tests for the authorize-from-glass daemon route:
 * `handleAuthorize` (typed-confirm intent gate + fail-closed hub-admin seam +
 * registry-verdict passthrough) AND the step-up MFA wiring that guards it.
 *
 * Pure — an injected `Authorizer` stub; no HTTP, no crypto.
 */

import { describe, it, expect } from "bun:test";
import {
  handleAuthorize,
  AUTHORIZE_PATH,
  type Authorizer,
  type AuthorizeResult,
} from "../networks-authorize";
import {
  STEP_UP_CONTROL_ROUTES,
  requiresStepUp,
  enforceStepUp,
  readStepUpCode,
  STEP_UP_HEADER,
} from "../step-up-mfa";

const REQ = "req-abc-123";
const OK_BODY = { request_id: REQ, confirm: REQ };

/** An authorizer that returns a fixed result. */
function authorizer(result: AuthorizeResult): Authorizer {
  return { authorize: () => Promise.resolve(result) };
}

/** An authorizer that records its calls (to assert the request_id passed through). */
function recordingAuthorizer(): { authorizer: Authorizer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorizer: {
      authorize: (requestId) => {
        calls.push(requestId);
        return Promise.resolve({ ok: true, requestId, hubAuthorizedAt: "2026-07-08T00:00:00.000Z" });
      },
    },
  };
}

/** An authorizer that must NOT be reached (asserts a gate fired first). */
const throwingAuthorizer: Authorizer = {
  authorize: () => {
    throw new Error("authorizer should not be reached");
  },
};

async function bodyOf(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json()) as Record<string, unknown>;
}

describe("handleAuthorize — typed-confirm intent gate", () => {
  it("rejects a non-object body with 400", async () => {
    const resp = await handleAuthorize(throwingAuthorizer, "nope");
    expect(resp.status).toBe(400);
  });

  it("rejects a missing/invalid request_id with 400", async () => {
    const resp = await handleAuthorize(throwingAuthorizer, { request_id: "", confirm: "" });
    expect(resp.status).toBe(400);
    expect((await bodyOf(resp)).error).toContain("request_id");
  });

  it("rejects a confirm that does not exactly match request_id with 400", async () => {
    const resp = await handleAuthorize(throwingAuthorizer, { request_id: REQ, confirm: "req-abc-124" });
    expect(resp.status).toBe(400);
    expect((await bodyOf(resp)).error).toContain("confirm must exactly match request_id");
  });

  it("rejects a trailing-space confirm mismatch (exact echo, not trimmed) with 400", async () => {
    const resp = await handleAuthorize(throwingAuthorizer, { request_id: REQ, confirm: `${REQ} ` });
    expect(resp.status).toBe(400);
  });
});

describe("handleAuthorize — fail-closed hub-admin seam", () => {
  it("returns a structured 503 hub_admin_not_configured when the authorizer is null", async () => {
    const resp = await handleAuthorize(null, OK_BODY);
    expect(resp.status).toBe(503);
    const body = await bodyOf(resp);
    expect(body.error).toBe("hub_admin_not_configured");
    expect(typeof body.detail).toBe("string");
  });

  it("does NOT reach the null-seam 503 until the intent gate passes (mismatch 400 first)", async () => {
    // A bad confirm on a null authorizer still 400s (the intent gate runs before
    // the seam check) — never a 503 that would leak "the seam is absent" past a
    // malformed request.
    const resp = await handleAuthorize(null, { request_id: REQ, confirm: "wrong" });
    expect(resp.status).toBe(400);
  });
});

describe("handleAuthorize — verdict passthrough", () => {
  it("surfaces hub_authorized_at ONLY on a positive (ok) result", async () => {
    const { authorizer: rec, calls } = recordingAuthorizer();
    const resp = await handleAuthorize(rec, OK_BODY);
    expect(resp.status).toBe(200);
    const body = await bodyOf(resp);
    expect(body.request_id).toBe(REQ);
    expect(body.hub_authorized_at).toBe("2026-07-08T00:00:00.000Z");
    expect(calls).toEqual([REQ]);
  });

  it("propagates a registry 409 not_admitted verbatim as structured JSON", async () => {
    const resp = await handleAuthorize(
      authorizer({ ok: false, reason: "not_admitted", detail: "request is PENDING, not ADMITTED" }),
      OK_BODY,
    );
    expect(resp.status).toBe(409);
    const body = await bodyOf(resp);
    expect(body.error).toBe("not_admitted");
    expect(body.detail).toContain("PENDING");
  });

  it("propagates a registry 401 signature_invalid as 401", async () => {
    const resp = await handleAuthorize(
      authorizer({ ok: false, reason: "signature_invalid", detail: "sig" }),
      OK_BODY,
    );
    expect(resp.status).toBe(401);
    expect((await bodyOf(resp)).error).toBe("signature_invalid");
  });

  it("propagates a registry 403 admin_not_authorized as 403", async () => {
    const resp = await handleAuthorize(
      authorizer({ ok: false, reason: "admin_not_authorized", detail: "not allowlisted" }),
      OK_BODY,
    );
    expect(resp.status).toBe(403);
    expect((await bodyOf(resp)).error).toBe("admin_not_authorized");
  });

  it("maps a hub_admin_not_configured registry failure to 503", async () => {
    const resp = await handleAuthorize(
      authorizer({ ok: false, reason: "hub_admin_not_configured", detail: "no allowlist" }),
      OK_BODY,
    );
    expect(resp.status).toBe(503);
  });
});

describe("FLG-2 route is step-up (MFA) gated", () => {
  it("/api/networks/authorize is in STEP_UP_CONTROL_ROUTES", () => {
    expect(STEP_UP_CONTROL_ROUTES.has(AUTHORIZE_PATH)).toBe(true);
    expect(AUTHORIZE_PATH).toBe("/api/networks/authorize");
  });

  it("requiresStepUp is true for a POST to the authorize route", () => {
    expect(requiresStepUp("POST", AUTHORIZE_PATH)).toBe(true);
    // A GET to the same path is not step-up-gated here (it is not a mutation).
    expect(requiresStepUp("GET", AUTHORIZE_PATH)).toBe(false);
  });

  it("a POST without a step-up code is refused 403 (proven at the gate)", () => {
    // No X-Cortex-Step-Up-Otp header ⇒ the gate returns a 403 step_up_required
    // BEFORE the handler runs. Enrolled secret present (so this proves the
    // MISSING-CODE branch, not the not-enrolled branch).
    const req = new Request(`http://127.0.0.1${AUTHORIZE_PATH}`, {
      method: "POST",
      body: JSON.stringify(OK_BODY),
    });
    expect(readStepUpCode(req)).toBe("");
    const denial = enforceStepUp(req, {
      enrollment: {
        version: 1,
        secret: "JBSWY3DPEHPK3PXP",
        digits: 6,
        period: 30,
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    });
    expect(denial).not.toBeNull();
    expect(denial?.status).toBe(403);
  });

  it("a POST WITH the step-up header carries a code the gate reads", () => {
    const req = new Request(`http://127.0.0.1${AUTHORIZE_PATH}`, {
      method: "POST",
      headers: { [STEP_UP_HEADER]: "123456" },
      body: JSON.stringify(OK_BODY),
    });
    expect(readStepUpCode(req)).toBe("123456");
  });
});
