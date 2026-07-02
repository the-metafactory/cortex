/**
 * MC-B2 (cortex#1279) — the **mutating** Tier-2 admit/reject action from the
 * Mission Control glass: `POST /api/networks/admission-decision`.
 *
 * ## Scope (principal decision, 2026-07-02)
 *
 * Ship the grant/reject action behind **CF-Access session + typed-confirm**;
 * full step-up MFA (#1194) is a follow-up. The decision is **signed by the
 * LOCAL daemon** with the principal's own stack seed (the daemon already holds it
 * to PoP-sign roster reads) — the seed NEVER goes in the CF worker and the
 * browser NEVER signs. This handler is the surface seam; `cortex.ts` injects the
 * bus-layer signer as an {@link AdmissionDecider} (mirroring how it injects the
 * member-roster read provider). The surface never imports the bus.
 *
 * ## The two gates (both required — reject if either is absent)
 *
 *  1. **CF-Access principal identity.** The `Cf-Access-Authenticated-User-Email`
 *     header, injected by Cloudflare Access at the authenticated edge (the same
 *     identity the worker's `getCfAccessEmail` derives). Absent/empty ⇒ 401. The
 *     local MC server additionally binds loopback-only (server.ts SEV-2), so this
 *     identity gate composes on top of the loopback boundary that already
 *     protects the on-disk seed.
 *  2. **Typed-confirm.** The client must echo the target `request_id` in the
 *     `confirm` field — the deliberate, mirror of the CLI's
 *     `cortex network admit <request-id> --apply` posture (the principal types the
 *     id they mean to act on). Mismatch/absent ⇒ 400. This is the intent gate for
 *     a control-plane mutation.
 *
 * Request-id-driven (Option A): the principal supplies the `request_id`
 * (obtained from `cortex network admit --list-pending` or the registry). Auto-
 * populating a PENDING queue with request_ids on the pier-queue rows is a
 * documented follow-up (it needs the admin-list read path, which hits the
 * ADR-0020 global-admin-read scoping and is admit-lane-adjacent).
 */

/** admit | reject — selects the registry route + claim decision. */
export type AdmissionDecisionVerb = "admit" | "reject";

/** What the injected decider is asked to do (principal identity carried for audit). */
export interface AdmissionDecisionInput {
  networkId: string;
  requestId: string;
  decision: AdmissionDecisionVerb;
  /** The CF-Access-authenticated principal email (audit/correlation). */
  principal: string;
}

/**
 * Why the decision failed — a superset of the bus signer's failure reasons,
 * surface-local so this module never imports the bus. `cortex.ts` maps the
 * bus `PostAdmissionDecisionResult` onto this shape.
 */
export type AdmissionDecisionFailure =
  | "not_authorized"
  | "not_configured"
  | "already_decided"
  | "replayed"
  | "rate_limited"
  | "invalid"
  | "not_found"
  | "unreachable";

/** The outcome of a signed decision — never thrown. */
export type AdmissionDecisionResult =
  | { ok: true; status: "ADMITTED" | "REJECTED"; requestId: string }
  | { ok: false; reason: AdmissionDecisionFailure; detail: string };

/**
 * The injected seam the surface depends on to sign + POST a decision. `cortex.ts`
 * supplies a live implementation built from the stack's identity material + the
 * federated registry config; tests supply a stub. Returns `null` from the
 * server's getter when federation/registry/signing identity is not configured
 * (→ the handler 503s honestly).
 */
export interface AdmissionDecider {
  decide(input: AdmissionDecisionInput): Promise<AdmissionDecisionResult>;
}

/** The `Cf-Access-Authenticated-User-Email` header (CF Access injects it at the edge). */
export const CF_ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";

/** The POST body the dashboard sends. */
interface AdmissionDecisionBody {
  network_id: string;
  request_id: string;
  decision: AdmissionDecisionVerb;
  /** Typed-confirm: must exactly equal `request_id`. */
  confirm: string;
}

const NETWORK_ID_RE = /^[a-z][a-z0-9-]*$/;
// A conservative request-id shape (registry `isValidRequestId` is the authority;
// this is a cheap client-side pre-check so we never sign an obviously-bad id).
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Map a decider failure reason to the HTTP status the dashboard branches on. */
function failureStatus(reason: AdmissionDecisionFailure): number {
  switch (reason) {
    case "not_authorized":
      return 403;
    case "not_configured":
      return 503;
    case "already_decided":
    case "replayed":
      return 409;
    case "rate_limited":
      return 429;
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "unreachable":
      return 502;
  }
}

/**
 * Validate the body shape (typed-confirm included). Pure — no I/O. Returns the
 * normalised body or a `Response` (already the right status) to return verbatim.
 */
function parseBody(
  raw: unknown,
): { ok: true; body: AdmissionDecisionBody } | { ok: false; response: Response } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, response: json({ error: "body must be a JSON object" }, 400) };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.request_id !== "string" || !REQUEST_ID_RE.test(b.request_id)) {
    return { ok: false, response: json({ error: "request_id must be a valid admission request id" }, 400) };
  }
  if (typeof b.network_id !== "string" || !NETWORK_ID_RE.test(b.network_id)) {
    return { ok: false, response: json({ error: "network_id must be lowercase alphanumeric + hyphen, letter-prefixed" }, 400) };
  }
  if (b.decision !== "admit" && b.decision !== "reject") {
    return { ok: false, response: json({ error: 'decision must be "admit" or "reject"' }, 400) };
  }
  // Typed-confirm: the principal must echo the request_id they mean to act on.
  if (typeof b.confirm !== "string" || b.confirm !== b.request_id) {
    return {
      ok: false,
      response: json(
        {
          error: "confirm must exactly match request_id",
          detail:
            "Type the request id to confirm this Tier-2 decision (mirrors the CLI --apply posture). " +
            "This is the deliberate intent gate for a control-plane mutation.",
        },
        400,
      ),
    };
  }

  return {
    ok: true,
    body: {
      network_id: b.network_id,
      request_id: b.request_id,
      decision: b.decision,
      confirm: b.confirm,
    },
  };
}

/**
 * Handle `POST /api/networks/admission-decision`.
 *
 * @param decider   The injected signer seam. `null` ⇒ 503 (no
 *                  federation/registry/signing identity configured).
 * @param principal The CF-Access principal email, extracted by the server from
 *                  {@link CF_ACCESS_EMAIL_HEADER}. Empty/undefined ⇒ 401.
 * @param rawBody   The parsed JSON body (server already enforced the size cap).
 */
export async function handleAdmissionDecision(
  decider: AdmissionDecider | null,
  principal: string | undefined,
  rawBody: unknown,
): Promise<Response> {
  // Gate 1 — a CF-Access principal identity is required for a mutation.
  const who = (principal ?? "").trim();
  if (who.length === 0) {
    return json(
      {
        error: "unauthenticated",
        detail:
          "a CF-Access authenticated principal identity is required to admit/reject " +
          `(missing/empty ${CF_ACCESS_EMAIL_HEADER}). This mutation is not available on an unauthenticated request.`,
      },
      401,
    );
  }

  // Gate 2 — body shape + typed-confirm.
  const parsed = parseBody(rawBody);
  if (!parsed.ok) return parsed.response;

  // The signer seam must be wired (federation + registry + stack seed present).
  if (decider === null) {
    return json(
      {
        error: "not_configured",
        detail:
          "admission decisions are unavailable — no federated registry / stack signing identity is configured " +
          "on this daemon (the decision must be signed locally with the stack seed).",
      },
      503,
    );
  }

  const result = await decider.decide({
    networkId: parsed.body.network_id,
    requestId: parsed.body.request_id,
    decision: parsed.body.decision,
    principal: who,
  });

  if (result.ok) {
    return json({ status: result.status, request_id: result.requestId }, 200);
  }
  return json({ error: result.reason, detail: result.detail }, failureStatus(result.reason));
}
