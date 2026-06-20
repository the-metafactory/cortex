/**
 * ADR-0015 — Network-admission gate endpoints.
 *
 * Repurposes the O-4a issuance-request state machine as the admission gate:
 * it gates ROSTER MEMBERSHIP, mints NOTHING.
 *
 *   POST /admission-requests/{request_id}/admit
 *     Admin-signed transition: PENDING → ADMITTED.
 *     Reuses the admin-pubkey gate from #747 (network-create) verbatim:
 *       503 admin_not_configured  — no allowlist set
 *       401 signature_invalid     — sig doesn't verify
 *       403 admin_not_authorized  — key not allowlisted
 *     On success: returns the updated AdmissionRequest. 409 already_decided
 *     if the request is not PENDING.
 *
 *   POST /admission-requests/{request_id}/reject
 *     Admin-signed transition: PENDING → REJECTED. Same gate as admit.
 *
 *   GET /admission-requests?status=<PENDING|ADMITTED|REJECTED>
 *     Admin-gated list of requests by status. The admin proves allowlisted
 *     possession via the `x-admin-signed` request header (a signed read
 *     claim — no nonce, clock-skew applies). 400 if the header is missing
 *     or malformed.
 *
 *   GET /admission-requests/{request_id}
 *     Admin-gated single-request fetch. Same auth as the list surface.
 *     404 when the request_id is not found.
 *
 * Trust model
 * ───────────
 * All write operations reuse the network-create admin gate EXACTLY:
 *   1. parseAdminPubkeys → empty set → 503 fail-closed (FIRST, no body parse)
 *   2. JSON parse → schema validate → clock-skew
 *   3. verifyEd25519(claim.admin_pubkey, sig, canonicalJSON(claim)) → 401
 *   4. adminPubkeys.has(claim.admin_pubkey) → 403
 *   5. nonceCache.recordIfFresh → 409
 *   6. store.transitionIssuanceRequest → 409 already_decided / 404 / 200
 *
 * Read operations use the same gate for the admin_pubkey check but carry
 * the signed token in a header rather than the request body (reads must
 * remain GETs for HTTP semantics and cache compatibility). No nonce is
 * required for reads — they are idempotent and don't mutate state. Clock
 * skew still applies to prevent stale read-tokens lingering.
 */

import { Hono, type Context } from "hono";
import { parseAdminPubkeys, type Env } from "../index";
import { getNonceCache, getIssuanceStore, AlreadyDecidedError } from "../store";
import {
  validateSignedAdmissionDecision,
  validateAdmissionDecisionClaim,
  validateSignedAdmissionRead,
  isValidRequestId,
} from "../validate";
import { canonicalJSON, verifyEd25519 } from "../signing";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "../rate-limit";
import type { AdmissionStatus } from "../types";

/** Maximum clock skew for admin decision claims — mirrors the network-create route. */
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Shared admin gate used by both write (admit/reject) and read endpoints.
 * Mirrors the network-create gate order verbatim:
 *   503 admin_not_configured → 401 signature_invalid → 403 admin_not_authorized
 *
 * Returns null on success (caller continues); returns an error descriptor on
 * failure (caller short-circuits immediately).
 */
async function applyAdminGate(
  adminPubkeys: Set<string>,
  adminPubkey: string,
  signature: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<{ error: string; status: number } | null> {
  // adminPubkeys already checked for empty before calling this helper.
  const valid = await verifyEd25519(adminPubkey, signature, message);
  if (!valid) return { error: "signature_invalid", status: 401 };
  if (!adminPubkeys.has(adminPubkey)) return { error: "admin_not_authorized", status: 403 };
  return null; // pass
}

export function admissionRequestRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ---------------------------------------------------------------------------
  // Helper: shared decision handler for admit and reject
  // ---------------------------------------------------------------------------

  async function handleDecision(
    c: Context<{ Bindings: Env }>,
    decision: "admit" | "reject",
  ): Promise<Response> {
    const requestId = c.req.param("request_id") ?? "";

    // M2 — validate request_id path param BEFORE body parse or crypto.
    if (!isValidRequestId(requestId)) {
      return c.json({ error: "invalid_request_id" }, 400);
    }

    // 1. FAIL-CLOSED, FIRST: admin allowlist must be configured.
    const adminPubkeys = parseAdminPubkeys(c.env);
    if (adminPubkeys.size === 0) {
      return c.json(
        {
          error: "admin_not_configured",
          details:
            "REGISTRY_ADMIN_PUBKEYS not provisioned; admission decisions are disabled (fail-closed). " +
            "Set the admin pubkey allowlist via `wrangler secret put` to enable signed-admin writes.",
        },
        503,
      );
    }

    // M1 — rate-limit BEFORE the expensive Ed25519 verify.
    const allowed = await checkRateLimit(c.env, "register", clientKey(c.req.raw, requestId));
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("register")),
      });
    }

    // 2. Parse + validate envelope.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err) {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const envelopeCheck = validateSignedAdmissionDecision(body);
    if (!envelopeCheck.ok) {
      return c.json({ error: "validation_failed", details: envelopeCheck.errors }, 400);
    }
    const { signed } = envelopeCheck;

    const claimResult = validateAdmissionDecisionClaim(signed.claim, requestId, decision);
    if (!claimResult.ok) {
      return c.json({ error: "validation_failed", details: claimResult.errors }, 400);
    }
    const { claim } = claimResult;

    // 3. Clock-skew check.
    const issued = Date.parse(claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return c.json(
        {
          error: "issued_at out of skew window",
          details: { skew_ms: now - issued, max_ms: CLOCK_SKEW_MS },
        },
        400,
      );
    }

    // 4. Signature verification FIRST (before recording nonce).
    const message = new TextEncoder().encode(canonicalJSON(claim)) as Uint8Array<ArrayBuffer>;
    const gateResult = await applyAdminGate(
      adminPubkeys,
      claim.admin_pubkey,
      signed.signature,
      message,
    );
    if (gateResult) {
      return c.json({ error: gateResult.error }, gateResult.status as 401 | 403);
    }

    // 5. Replay check — only on authentic + authorised path.
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    // 6. State transition.
    const store = getIssuanceStore(c.env);
    let updated;
    try {
      updated = await store.transitionIssuanceRequest(
        requestId,
        decision === "admit" ? "ADMITTED" : "REJECTED",
        claim.admin_pubkey,
      );
    } catch (err) {
      if (err instanceof AlreadyDecidedError) {
        return c.json(
          {
            error: "already_decided",
            details: `request ${requestId} is already ${err.request.status}`,
            current: err.request,
          },
          409,
        );
      }
      throw err;
    }

    if (!updated) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json(updated, 200);
  }

  // ---------------------------------------------------------------------------
  // Helper: verify admin signature for read endpoints (x-admin-signed header)
  // ---------------------------------------------------------------------------

  async function verifyAdminReadHeader(
    c: Context<{ Bindings: Env }>,
  ): Promise<{ error: string; status: number } | null> {
    // 1. FAIL-CLOSED: admin allowlist must be configured.
    const adminPubkeys = parseAdminPubkeys(c.env);
    if (adminPubkeys.size === 0) {
      return { error: "admin_not_configured", status: 503 };
    }

    // M1 — rate-limit BEFORE the Ed25519 verify.
    const allowed = await checkRateLimit(c.env, "read", clientKey(c.req.raw));
    if (!allowed) {
      return { error: "rate_limited", status: 429 };
    }

    // 2. Parse + validate x-admin-signed header.
    const headerVal = c.req.header("x-admin-signed");
    if (!headerVal) {
      return { error: "x-admin-signed header required", status: 400 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerVal);
    } catch (_err) {
      return { error: "x-admin-signed must be valid JSON", status: 400 };
    }

    const readCheck = validateSignedAdmissionRead(parsed);
    if (!readCheck.ok) {
      return { error: "x-admin-signed validation_failed", status: 400 };
    }
    const { signed } = readCheck;

    // 3. Clock-skew check.
    const issued = Date.parse(signed.claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return { error: "issued_at out of skew window", status: 400 };
    }

    // 4. Signature + allowlist check (no nonce for reads — idempotent).
    const message = new TextEncoder().encode(canonicalJSON(signed.claim));
    const valid = await verifyEd25519(signed.claim.admin_pubkey, signed.signature, message as Uint8Array<ArrayBuffer>);
    if (!valid) return { error: "signature_invalid", status: 401 };
    if (!adminPubkeys.has(signed.claim.admin_pubkey)) return { error: "admin_not_authorized", status: 403 };

    return null; // pass
  }

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/admit
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/admit", (c) => handleDecision(c, "admit"));

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/reject
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/reject", (c) => handleDecision(c, "reject"));

  // ---------------------------------------------------------------------------
  // GET /admission-requests?status=<status>
  // ---------------------------------------------------------------------------

  app.get("/admission-requests", async (c) => {
    const authError = await verifyAdminReadHeader(c);
    if (authError) {
      return c.json({ error: authError.error }, authError.status as 400 | 401 | 403 | 429 | 503);
    }

    const status = c.req.query("status") as AdmissionStatus | undefined;
    const validStatuses: AdmissionStatus[] = ["PENDING", "ADMITTED", "REJECTED"];
    if (!status || !validStatuses.includes(status)) {
      return c.json(
        { error: "status query param required", details: "must be one of PENDING, ADMITTED, REJECTED" },
        400,
      );
    }

    const store = getIssuanceStore(c.env);
    const requests = await store.listIssuanceRequests(status);
    return c.json(requests, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /admission-requests/:request_id
  // ---------------------------------------------------------------------------

  app.get("/admission-requests/:request_id", async (c) => {
    const authError = await verifyAdminReadHeader(c);
    if (authError) {
      return c.json({ error: authError.error }, authError.status as 400 | 401 | 403 | 429 | 503);
    }

    const requestId = c.req.param("request_id") ?? "";
    // M2 — validate request_id path param before any query.
    if (!isValidRequestId(requestId)) {
      return c.json({ error: "invalid_request_id" }, 400);
    }
    const store = getIssuanceStore(c.env);
    const request = await store.getIssuanceRequest(requestId);
    if (!request) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(request, 200);
  });

  return app;
}
