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
 *   POST /admission-requests/{request_id}/authorize (cortex#1498)
 *     HUB-ADMIN-signed: stamps `hub_authorized_at` onto an ADMITTED row.
 *     Same authority + gate order as sealed-secret (below). 409 not_admitted
 *     if the row is not ADMITTED. This is the real signal the guided-join
 *     handoff's hub-authorize leg reads.
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
import { parseAdminPubkeys, parseHubAdminPubkeys, parseNetworkAdminPubkeys, type Env } from "../index";
import { getNonceCache, getIssuanceStore, getStore, AlreadyDecidedError } from "../store";
import {
  validateSignedAdmissionDecision,
  validateAdmissionDecisionClaim,
  validateSignedAdmissionRead,
  validateSignedAdmissionMineRead,
  validateSignedSealedSecretWrite,
  validateSealedSecretClaim,
  validateSignedAdmissionRevoke,
  validateAdmissionRevokeClaim,
  validateSignedHubAuthorize,
  validateHubAuthorizeClaim,
  validateSignedAdmissionDepart,
  validateAdmissionDepartClaim,
  isValidRequestId,
} from "../validate";
import { canonicalJSON, verifyEd25519 } from "../signing";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "../rate-limit";
import type { AdmissionMineRow, AdmissionStatus } from "../types";

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
    // #1414 — verify over the claim AS RECEIVED (canonicalJSON(signed.claim)),
    // NOT the whitelist reconstruction, converging on the #832 register pattern:
    // a future signed field the reconstruction doesn't echo can no longer
    // silently 401 a legitimate decision. The reconstruction (`claim`) stays for
    // structural validation + the pubkey/allowlist/storage — validation already
    // proved claim.admin_pubkey === signed.claim.admin_pubkey, so the key we
    // verify + allowlist against is unchanged; only the signed BYTES converge.
    // Fail closed (401) if the shared guarded canonicaliser throws on an
    // over-deep/over-wide hostile body (#832 depth + #1418 width) — it can never
    // match a real signature anyway.
    let message: Uint8Array<ArrayBuffer>;
    try {
      message = new TextEncoder().encode(canonicalJSON(signed.claim)) as Uint8Array<ArrayBuffer>;
    } catch (_err) {
      return c.json({ error: "signature_invalid" }, 401);
    }
    const sigValid = await verifyEd25519(claim.admin_pubkey, signed.signature, message);
    if (!sigValid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // 4b. Authorisation (#1321 per-network admin). The proven key must be
    // authorised to admit onto THIS request's network — either a GLOBAL admin
    // (REGISTRY_ADMIN_PUBKEYS, the metafactory bootstrap) OR a PER-NETWORK admin
    // listed in the target network's `admin_pubkeys` (the **Network posture**
    // authority — each network sovereign over its own roster, CONTEXT.md). A
    // network-less request (network_id null) is global-admin-only. Authorization
    // is keyed off the request's stored network_id, NEVER off anything on the
    // wire — control-plane only.
    const issuanceStore = getIssuanceStore(c.env);
    const reqForAuth = await issuanceStore.getIssuanceRequest(requestId);
    let authorized = adminPubkeys.has(claim.admin_pubkey);
    if (!authorized && reqForAuth?.network_id) {
      const net = await getStore(c.env).getNetwork(reqForAuth.network_id);
      authorized = parseNetworkAdminPubkeys(net?.admin_pubkeys).has(claim.admin_pubkey);
    }
    if (!authorized) {
      return c.json({ error: "admin_not_authorized" }, 403);
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
  //
  // FND-5 (ADR-0020 §4 read-scoping) — reads are no longer global-admin-only.
  // The gate resolves the caller to a READ SCOPE (fail-closed):
  //   - scope === null      → GLOBAL admin, read ALL networks (incl. network-less
  //                            rows). The caller MAY narrow with claim.network_id.
  //   - scope === <id>      → read is FORCED to that one network's rows.
  //
  // Authorization is keyed off the network the caller NAMES in the signed claim
  // (bound into the signature, so a token minted for network A cannot read B),
  // checked against THAT network's stored `admin_pubkeys` — NEVER off anything a
  // caller could forge past the signature. The security-critical property: a
  // per-network admin is authorised for — and scoped to — exactly the network
  // they administer, and nothing else (unauthorised ⇒ 403).
  // ---------------------------------------------------------------------------

  async function resolveAdminReadScope(
    c: Context<{ Bindings: Env }>,
  ): Promise<{ ok: true; scope: string | null } | { ok: false; error: string; status: number }> {
    // 1. FAIL-CLOSED: admin allowlist must be configured.
    const adminPubkeys = parseAdminPubkeys(c.env);
    if (adminPubkeys.size === 0) {
      return { ok: false, error: "admin_not_configured", status: 503 };
    }

    // M1 — rate-limit BEFORE the Ed25519 verify.
    const allowed = await checkRateLimit(c.env, "read", clientKey(c.req.raw));
    if (!allowed) {
      return { ok: false, error: "rate_limited", status: 429 };
    }

    // 2. Parse + validate x-admin-signed header.
    const headerVal = c.req.header("x-admin-signed");
    if (!headerVal) {
      return { ok: false, error: "x-admin-signed header required", status: 400 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerVal);
    } catch (_err) {
      return { ok: false, error: "x-admin-signed must be valid JSON", status: 400 };
    }

    const readCheck = validateSignedAdmissionRead(parsed);
    if (!readCheck.ok) {
      return { ok: false, error: "x-admin-signed validation_failed", status: 400 };
    }
    const { signed } = readCheck;

    // 3. Clock-skew check.
    const issued = Date.parse(signed.claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return { ok: false, error: "issued_at out of skew window", status: 400 };
    }

    // 4. Signature check FIRST (no nonce for reads — idempotent). Verify over the
    // reconstructed claim (validate echoes network_id only when the caller sent
    // it) so the bytes match what the caller signed either way.
    const message = new TextEncoder().encode(canonicalJSON(signed.claim));
    const valid = await verifyEd25519(signed.claim.admin_pubkey, signed.signature, message as Uint8Array<ArrayBuffer>);
    if (!valid) return { ok: false, error: "signature_invalid", status: 401 };

    // 5. Authorisation + scoping (FND-5). A GLOBAL admin reads all networks (and
    // MAY narrow to a named one). Otherwise the caller MUST name a network they
    // administer — authorised ONLY as a per-network admin of THAT network, and
    // the read is FORCED to it. Anything else is 403 (a per-network admin cannot
    // read all networks, nor a network they do not administer).
    const isGlobal = adminPubkeys.has(signed.claim.admin_pubkey);
    const claimedNetworkId = signed.claim.network_id;

    if (isGlobal) {
      // Global admin: honour an optional narrowing, else read everything.
      return { ok: true, scope: claimedNetworkId ?? null };
    }

    // Per-network path: a network MUST be named (no network ⇒ nothing to scope
    // to, and a non-global admin may not read all → 403).
    if (!claimedNetworkId) {
      return { ok: false, error: "admin_not_authorized", status: 403 };
    }
    const net = await getStore(c.env).getNetwork(claimedNetworkId);
    if (!parseNetworkAdminPubkeys(net?.admin_pubkeys).has(signed.claim.admin_pubkey)) {
      return { ok: false, error: "admin_not_authorized", status: 403 };
    }
    return { ok: true, scope: claimedNetworkId };
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
  // Helper: HUB-ADMIN-signed write gate (ADR-0018 Q5, PR5b).
  //
  // Distinct authority from the registry-admin admit gate: the HUB-admin mints
  // the per-member secret + writes/clears the opaque sealed blob. Gated on
  // `REGISTRY_HUB_ADMIN_PUBKEYS` (falling back to `REGISTRY_ADMIN_PUBKEYS` when
  // the two authorities collapse into one principal — parseHubAdminPubkeys).
  //
  // Mirrors handleDecision's gate ORDER verbatim:
  //   M2 request_id grammar → 503 fail-closed (FIRST) → M1 rate-limit →
  //   JSON parse → envelope+claim validate → clock-skew → sig verify (FIRST) →
  //   allowlist → nonce replay. Returns the verified claim or a Response to
  //   short-circuit.
  // ---------------------------------------------------------------------------

  async function verifyHubAdminWrite<C extends { hub_admin_pubkey: string; issued_at: string; nonce: string }>(
    c: Context<{ Bindings: Env }>,
    requestId: string,
    validateEnvelope: (body: unknown) => { ok: true; signed: { claim: unknown; signature: string } } | { ok: false; errors: unknown },
    validateClaim: (claim: unknown, expectedRequestId: string) => { ok: true; claim: C } | { ok: false; errors: unknown },
  ): Promise<{ ok: true; claim: C } | { ok: false; response: Response }> {
    // M2 — validate request_id path param BEFORE body parse or crypto.
    if (!isValidRequestId(requestId)) {
      return { ok: false, response: c.json({ error: "invalid_request_id" }, 400) };
    }

    // 1. FAIL-CLOSED, FIRST: hub-admin allowlist must be configured.
    const hubAdminPubkeys = parseHubAdminPubkeys(c.env);
    if (hubAdminPubkeys.size === 0) {
      return {
        ok: false,
        response: c.json(
          {
            error: "admin_not_configured",
            details:
              "neither REGISTRY_HUB_ADMIN_PUBKEYS nor REGISTRY_ADMIN_PUBKEYS provisioned; " +
              "secret delivery is disabled (fail-closed). Set the hub-admin allowlist via " +
              "`wrangler secret put` to enable signed hub-admin writes.",
          },
          503,
        ),
      };
    }

    // M1 — rate-limit BEFORE the expensive Ed25519 verify (register bucket).
    const allowed = await checkRateLimit(c.env, "register", clientKey(c.req.raw, requestId));
    if (!allowed) {
      return {
        ok: false,
        response: c.json(TOO_MANY_REQUESTS_BODY, 429, {
          "Retry-After": String(retryAfterSeconds("register")),
        }),
      };
    }

    // 2. Parse + validate envelope.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err) {
      return { ok: false, response: c.json({ error: "body must be valid JSON" }, 400) };
    }
    const envelopeCheck = validateEnvelope(body);
    if (!envelopeCheck.ok) {
      return { ok: false, response: c.json({ error: "validation_failed", details: envelopeCheck.errors }, 400) };
    }
    const claimResult = validateClaim(envelopeCheck.signed.claim, requestId);
    if (!claimResult.ok) {
      return { ok: false, response: c.json({ error: "validation_failed", details: claimResult.errors }, 400) };
    }
    const claim = claimResult.claim;

    // 3. Clock-skew check.
    const issued = Date.parse(claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return {
        ok: false,
        response: c.json(
          { error: "issued_at out of skew window", details: { skew_ms: now - issued, max_ms: CLOCK_SKEW_MS } },
          400,
        ),
      };
    }

    // 4. Signature verification FIRST (before recording nonce), then allowlist.
    // #1414 — verify over the wire claim (canonicalJSON(signed.claim)), not the
    // reconstruction (#832 pattern), so sealed-secret + revoke can't be broken by
    // a future signed field. Validation already proved claim.hub_admin_pubkey ===
    // signed.claim.hub_admin_pubkey, so the key we gate on is unchanged. Fail
    // closed (401) if the guarded canonicaliser throws (over-deep/over-wide,
    // #832/#1418).
    let message: Uint8Array<ArrayBuffer>;
    try {
      message = new TextEncoder().encode(canonicalJSON(envelopeCheck.signed.claim)) as Uint8Array<ArrayBuffer>;
    } catch (_err) {
      return { ok: false, response: c.json({ error: "signature_invalid" }, 401) };
    }
    const gateResult = await applyAdminGate(
      hubAdminPubkeys,
      claim.hub_admin_pubkey,
      envelopeCheck.signed.signature,
      message,
    );
    if (gateResult) {
      return { ok: false, response: c.json({ error: gateResult.error }, gateResult.status as 401 | 403) };
    }

    // 5. Replay check — only on the authentic + authorised path.
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return { ok: false, response: c.json({ error: "nonce_replayed" }, 409) };
    }

    return { ok: true, claim };
  }

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/sealed-secret — ADR-0018 Q1 b′ / Q5
  //
  // The HUB-ADMIN delivers the opaque per-member sealed blob onto the ADMITTED
  // row (add-member sealed mode; rotate REPLACES it). The registry persists the
  // ciphertext it is handed and NEVER reads it. Gated on the hub-admin
  // authority — the admit route mints nothing, this route is the only mint/seal
  // sink. 409 not_admitted if the row is not ADMITTED (a secret can only be
  // delivered to an admitted member).
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/sealed-secret", async (c) => {
    const requestId = c.req.param("request_id") ?? "";
    const gate = await verifyHubAdminWrite(
      c,
      requestId,
      validateSignedSealedSecretWrite,
      validateSealedSecretClaim,
    );
    if (!gate.ok) return gate.response;

    const store = getIssuanceStore(c.env);
    const updated = await store.setSealedSecret(requestId, gate.claim.sealed_secret);
    if (!updated) {
      // Row missing OR not ADMITTED — distinguish for the caller.
      const existing = await store.getIssuanceRequest(requestId);
      if (!existing) return c.json({ error: "not_found" }, 404);
      return c.json(
        { error: "not_admitted", details: `request ${requestId} is ${existing.status}, not ADMITTED — cannot deliver a sealed secret` },
        409,
      );
    }
    return c.json(updated, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/authorize — cortex#1498
  //
  // The HUB-ADMIN stamps `hub_authorized_at` onto the ADMITTED row once they
  // have applied the member's leaf `authorization` entry on their OWN hub
  // nats-server config (the #1481 hub-owner artifact). SAME authority as the
  // sealed-secret write (hub-admin, ADR-0018 Q5) — mints nothing, just records
  // that the hub owner did their part of the 3-leg guided-join handoff (seal →
  // hub-authorize → leaf-up). This is the real signal `cortex network handoff
  // status` / `join --guided` read in place of the honor-system
  // `--hub-authorized-confirmed` attestation. 409 not_admitted if the row is
  // not ADMITTED (mirrors sealed-secret's guard — nothing to authorize until
  // the roster admission has landed).
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/authorize", async (c) => {
    const requestId = c.req.param("request_id") ?? "";
    const gate = await verifyHubAdminWrite(
      c,
      requestId,
      validateSignedHubAuthorize,
      validateHubAuthorizeClaim,
    );
    if (!gate.ok) return gate.response;

    const store = getIssuanceStore(c.env);
    const updated = await store.markHubAuthorized(requestId, gate.claim.issued_at);
    if (!updated) {
      // Row missing OR not ADMITTED — distinguish for the caller. This is the
      // SAME re-read the sealed-secret route uses (Sage #1501 nit: an extra
      // SELECT on the cold error path only, to map 404 vs 409 — kept verbatim
      // for parity with sealed-secret rather than optimised away).
      const existing = await store.getIssuanceRequest(requestId);
      if (!existing) return c.json({ error: "not_found" }, 404);
      return c.json(
        { error: "not_admitted", details: `request ${requestId} is ${existing.status}, not ADMITTED — cannot authorize` },
        409,
      );
    }
    return c.json(updated, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/revoke — ADR-0018 Q6
  //
  // The HUB-ADMIN marks an ADMITTED row REVOKED and CLEARS its sealed blob. The
  // CLI cuts transport at the hub (drops the `authorization` user + reloads)
  // BEFORE calling this — this is the registry-side half (roster + member
  // PoP-read both stop serving the member). Idempotent: a second revoke of an
  // already-REVOKED row returns 200. 409 if the row was never ADMITTED.
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/revoke", async (c) => {
    const requestId = c.req.param("request_id") ?? "";
    const gate = await verifyHubAdminWrite(
      c,
      requestId,
      validateSignedAdmissionRevoke,
      validateAdmissionRevokeClaim,
    );
    if (!gate.ok) return gate.response;

    const store = getIssuanceStore(c.env);
    let updated;
    try {
      updated = await store.revokeAdmission(requestId);
    } catch (err) {
      if (err instanceof AlreadyDecidedError) {
        return c.json(
          {
            error: "not_admitted",
            details: `request ${requestId} is ${err.request.status}, not ADMITTED — nothing to revoke`,
            current: err.request,
          },
          409,
        );
      }
      throw err;
    }
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json(updated, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /admission-requests/:request_id/depart — C-1350 Slice 1 (#1350)
  //
  // The MEMBER leaves a network of their OWN accord (voluntary), transitioning
  // their own ADMITTED row → DEPARTED and clearing its sealed blob. This is the
  // member-side counterpart to the hub-admin `/revoke` (involuntary kick):
  // `DEPARTED` keeps "left" separable from "kicked" for the audit + admin queue.
  //
  // Authority = MEMBER PROOF-OF-POSSESSION, promoted from the `/mine` read to a
  // write. There is NO admin allowlist on this route — the signature over
  // canonicalJSON(claim) against `claim.peer_pubkey` proves the caller holds the
  // member key, and the OWN-ROW check (`peer_pubkey === row.peer_pubkey`) is the
  // authz: a member can only depart their own row, never someone else's (403).
  //
  // Gate order (fail-closed, mirrors handleDecision): M2 request_id grammar →
  // M1 rate-limit → JSON parse → envelope+claim validate → clock-skew → sig
  // verify FIRST (over the wire claim; guarded canonicaliser throw → 401, never
  // 500) → OWN-ROW ownership (403) → nonce burn (#695: only after the authentic
  // + authorised path) → transition. Idempotent: re-departing a DEPARTED row →
  // 200; a non-ADMITTED (PENDING/REJECTED/REVOKED) row → 409.
  // ---------------------------------------------------------------------------

  app.post("/admission-requests/:request_id/depart", async (c) => {
    const requestId = c.req.param("request_id") ?? "";

    // M2 — validate request_id path param BEFORE body parse or crypto.
    if (!isValidRequestId(requestId)) {
      return c.json({ error: "invalid_request_id" }, 400);
    }

    // M1 — rate-limit BEFORE the expensive Ed25519 verify (register/write bucket).
    const allowed = await checkRateLimit(c.env, "register", clientKey(c.req.raw, requestId));
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("register")),
      });
    }

    // Parse + validate envelope, then the claim (binds request_id to the path).
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err) {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const envelopeCheck = validateSignedAdmissionDepart(body);
    if (!envelopeCheck.ok) {
      return c.json({ error: "validation_failed", details: envelopeCheck.errors }, 400);
    }
    const claimResult = validateAdmissionDepartClaim(envelopeCheck.signed.claim, requestId);
    if (!claimResult.ok) {
      return c.json({ error: "validation_failed", details: claimResult.errors }, 400);
    }
    const { claim } = claimResult;

    // Clock-skew — bound a captured token's lifetime.
    const issued = Date.parse(claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return c.json(
        { error: "issued_at out of skew window", details: { skew_ms: now - issued, max_ms: CLOCK_SKEW_MS } },
        400,
      );
    }

    // Signature verification FIRST (before recording the nonce). Verify over the
    // WIRE claim (canonicalJSON(signed.claim), #1414) — the signature IS the
    // proof of possession of `claim.peer_pubkey`. Fail closed (401) if the shared
    // guarded canonicaliser throws on an over-deep/over-wide hostile body
    // (#832/#1418) — it can never match a real signature anyway.
    let message: Uint8Array<ArrayBuffer>;
    try {
      message = new TextEncoder().encode(canonicalJSON(envelopeCheck.signed.claim)) as Uint8Array<ArrayBuffer>;
    } catch (_err) {
      return c.json({ error: "signature_invalid" }, 401);
    }
    const sigValid = await verifyEd25519(claim.peer_pubkey, envelopeCheck.signed.signature, message);
    if (!sigValid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // OWN-ROW authorisation — the proven member key MUST equal the target row's
    // stored `peer_pubkey`. This ownership check IS the authz (no admin
    // allowlist). Load the row to compare; a missing row is a 404, a wrong-owner
    // row is a 403 and is left UNTOUCHED (a member can never depart another's
    // row). Done BEFORE the nonce burn so a wrong-member probe cannot grief a
    // legitimate member's nonce or leak beyond existence.
    const store = getIssuanceStore(c.env);
    const row = await store.getIssuanceRequest(requestId);
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    if (row.peer_pubkey !== claim.peer_pubkey) {
      return c.json({ error: "not_row_owner" }, 403);
    }

    // Replay check — only on the authentic + authorised path (#695 posture).
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    // State transition: ADMITTED → DEPARTED (+ clear sealed blob). Idempotent on
    // an already-DEPARTED row (200); a non-ADMITTED row is a 409 "already
    // <STATUS>". `rosterFromAdmissions` filters ADMITTED, so the member drops out
    // of `members[]` automatically.
    let updated;
    try {
      updated = await store.departAdmission(requestId);
    } catch (err) {
      if (err instanceof AlreadyDecidedError) {
        return c.json(
          {
            error: "not_admitted",
            details: `request ${requestId} is already ${err.request.status}, not ADMITTED — nothing to depart`,
            current: err.request,
          },
          409,
        );
      }
      throw err;
    }
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json(updated, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /admission-requests?status=<status>
  // ---------------------------------------------------------------------------

  app.get("/admission-requests", async (c) => {
    const auth = await resolveAdminReadScope(c);
    if (!auth.ok) {
      return c.json({ error: auth.error }, auth.status as 400 | 401 | 403 | 429 | 503);
    }

    const status = c.req.query("status") as AdmissionStatus | undefined;
    // C-1350 — REVOKED + DEPARTED admitted here too so the admin listing
    // (`admit --list-pending --status DEPARTED|REVOKED`) surfaces
    // departed-/kicked-but-not-yet-hub-revoked rows. The CLI's LIST_STATUSES
    // (network.ts) and this server-side gate must stay in lockstep — a status
    // accepted by one but rejected by the other 400s the list round-trip.
    const validStatuses: AdmissionStatus[] = ["PENDING", "ADMITTED", "REJECTED", "REVOKED", "DEPARTED"];
    if (!status || !validStatuses.includes(status)) {
      return c.json(
        { error: "status query param required", details: "must be one of PENDING, ADMITTED, REJECTED, REVOKED, DEPARTED" },
        400,
      );
    }

    const store = getIssuanceStore(c.env);
    const requests = await store.listIssuanceRequests(status);
    // FND-5 — scope the result to the authorised network. A GLOBAL admin's scope
    // is null → all rows (incl. network-less). A per-network admin's scope is
    // their network id → ONLY that network's rows (a network-less row, network_id
    // null, never matches a concrete scope, so it stays global-admin-only per
    // ADR-0020 §3). Filtering here (not in SQL) keeps the store interface intact;
    // the admission queue is small and the filtered set never leaves the worker.
    const scoped = auth.scope === null ? requests : requests.filter((r) => r.network_id === auth.scope);
    return c.json(scoped, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /admission-requests/mine — ADR-0018 Q4 (Gap-C) member PoP-read
  //
  // Released to a caller who signs a proof-of-possession claim with their OWN
  // registered key. The signature IS the authorization (no admin key, no
  // allowlist): the route verifies the signature against `claim.peer_pubkey`
  // and returns ONLY the admission rows for that key, across all networks.
  // Each row carries a `sealed_secret` slot (null in PR5a; PR5b populates the
  // sealed-to-pubkey leaf-secret blob — ADR-0018 Q1 b′).
  //
  // Signed-read so an unauthenticated caller leaks NO metadata about the
  // onboarding queue. MUST be registered before `/:request_id` so "mine" is
  // not swallowed by the param route (where it would 400 as invalid_request_id).
  // ---------------------------------------------------------------------------

  app.get("/admission-requests/mine", async (c) => {
    // M1 — rate-limit BEFORE the Ed25519 verify (read bucket).
    const allowed = await checkRateLimit(c.env, "read", clientKey(c.req.raw));
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("read")),
      });
    }

    // Parse + validate the x-pop-signed header.
    const headerVal = c.req.header("x-pop-signed");
    if (!headerVal) {
      return c.json({ error: "x-pop-signed header required" }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerVal);
    } catch (_err) {
      return c.json({ error: "x-pop-signed must be valid JSON" }, 400);
    }
    const readCheck = validateSignedAdmissionMineRead(parsed);
    if (!readCheck.ok) {
      return c.json({ error: "x-pop-signed validation_failed", details: readCheck.errors }, 400);
    }
    const { signed } = readCheck;

    // Clock-skew — stop a captured read token being replayed indefinitely.
    const issued = Date.parse(signed.claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return c.json({ error: "issued_at out of skew window" }, 400);
    }

    // Proof-of-possession — the signature over canonicalJSON(claim) MUST verify
    // against the claimed peer_pubkey. This signature IS the authorization: a
    // caller who cannot sign for the key gets nothing (401), so the rows for a
    // key are released only to a holder of that key.
    const message = new TextEncoder().encode(canonicalJSON(signed.claim)) as Uint8Array<ArrayBuffer>;
    const valid = await verifyEd25519(signed.claim.peer_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // Return the caller's OWN admission rows (by the proven pubkey), each
    // carrying its sealed_secret slot — POPULATED (PR5b) once the hub-admin has
    // delivered the opaque blob (sealed to THIS member's pubkey, useless to
    // anyone else), NULL before delivery and after revoke. Never another
    // member's queue. The blob needs no extra auth: it is opaque to everyone but
    // the holder of the matching seed (ADR-0018 Q4 b′).
    const store = getIssuanceStore(c.env);
    const rows = await store.listIssuanceRequestsByPeer(signed.claim.peer_pubkey);
    const mine: AdmissionMineRow[] = rows;
    return c.json(mine, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /admission-requests/:request_id
  // ---------------------------------------------------------------------------

  app.get("/admission-requests/:request_id", async (c) => {
    const auth = await resolveAdminReadScope(c);
    if (!auth.ok) {
      return c.json({ error: auth.error }, auth.status as 400 | 401 | 403 | 429 | 503);
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
    // FND-5 — a per-network admin (scope = their network id) must not read a row
    // outside their network. Return 404, NOT 403, so a non-owning admin cannot
    // even confirm the row EXISTS (no existence oracle across networks). A global
    // admin (scope null) is unaffected; a global admin who narrowed to a network
    // likewise only sees that network's rows.
    if (auth.scope !== null && request.network_id !== auth.scope) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(request, 200);
  });

  return app;
}
