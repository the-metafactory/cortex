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
 *  1. **CF-Access principal identity — bind-conditioned (#1410).** On a
 *     **loopback** bind (every current deployment; server.ts SEV-2) the
 *     `Cf-Access-Authenticated-User-Email` header is trusted as-is — the
 *     request can only reach the local signer over the principal's own
 *     loopback interface (the invariant the #1279 http test locks). On a
 *     **non-loopback** bind that header is forgeable, so the route instead
 *     REQUIRES a `Cf-Access-Jwt-Assertion` verified against the CF Access team
 *     JWKS (`aud`/`iss`/`exp`/`nbf` + RS256 signature) and takes the principal
 *     from the verified `email` claim. Fail-closed off loopback: no
 *     `cfAccess.aud` configured ⇒ 503; missing/invalid JWT ⇒ 401. This turns
 *     the loopback bind into defense-in-depth rather than the sole gate.
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

/** The signed `Cf-Access-Jwt-Assertion` header (the JWT CF Access injects at the edge). */
export const CF_ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Hostnames that denote a loopback bind. Single source of "is this loopback". */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * cortex#1410 — whether an MC bind hostname is a loopback interface.
 *
 * On a **loopback** bind the admission route trusts the CF-Access email header
 * directly: the request can only originate from the principal's own machine
 * (the boundary the #1279 http test locks). On **any other** bind that header
 * is trivially forgeable, so the route instead requires a CF-Access JWT
 * verified against the team JWKS. An empty/unknown hostname is treated as
 * NON-loopback (fail-safe → demands the JWT).
 */
export function isLoopbackBind(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * Gate-1 auth inputs, resolved by the server per request. The bind decides
 * which identity proof is required (see {@link isLoopbackBind}).
 */
export interface AdmissionAuthContext {
  /** True when MC is bound to a loopback interface. */
  isLoopback: boolean;
  /** Raw `Cf-Access-Authenticated-User-Email` — trusted ONLY on a loopback bind. */
  emailHeader: string | undefined;
  /** Raw `Cf-Access-Jwt-Assertion` — verified on a non-loopback bind. */
  jwtAssertion: string | undefined;
  /**
   * CF-Access JWT verifier, pre-bound to the configured `aud` + `teamDomain`.
   * Present iff `cfAccess.aud` is configured. On a non-loopback bind its
   * ABSENCE fails the route closed (503). Returns the verified claims, or
   * `null` to reject (fail closed).
   */
  verifyJwt?: (token: string) => Promise<Record<string, unknown> | null>;
}

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
 * Resolve the CF-Access principal for Gate 1 — bind-conditioned (#1410):
 *
 *  - **Loopback bind:** trust the `Cf-Access-Authenticated-User-Email` header
 *    as-is (unchanged pre-#1410 behavior; the loopback boundary is the gate,
 *    locked by the #1279 http test). Empty ⇒ 401.
 *  - **Non-loopback bind:** the raw email header is forgeable, so REQUIRE a
 *    CF-Access JWT verified against the team JWKS; the principal comes from the
 *    verified `email` claim. Fails closed on every branch:
 *      · `cfAccess.aud` not configured (no verifier) ⇒ 503
 *      · missing JWT header ⇒ 401
 *      · JWT fails verification (sig/aud/iss/exp/nbf) ⇒ 401
 *      · verified JWT carries no `email` claim ⇒ 401
 *
 * Returns the resolved principal email, or a `Response` to return verbatim.
 */
async function resolveAdmissionPrincipal(
  auth: AdmissionAuthContext,
): Promise<string | Response> {
  if (auth.isLoopback) {
    const who = (auth.emailHeader ?? "").trim();
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
    return who;
  }

  // Non-loopback: do NOT trust the raw email header — verify the JWT.
  if (!auth.verifyJwt) {
    return json(
      {
        error: "not_configured",
        detail:
          "cf-access is not configured for a non-loopback Mission Control bind — set " +
          "`cfAccess.aud` (the Access application audience) so admit/reject can verify " +
          `the ${CF_ACCESS_JWT_HEADER}. Refusing to trust the raw email header off loopback.`,
      },
      503,
    );
  }

  const token = (auth.jwtAssertion ?? "").trim();
  if (token.length === 0) {
    return json(
      {
        error: "unauthenticated",
        detail:
          "a verified CF-Access JWT is required to admit/reject on a non-loopback bind " +
          `(missing/empty ${CF_ACCESS_JWT_HEADER}).`,
      },
      401,
    );
  }

  const claims = await auth.verifyJwt(token);
  if (claims === null) {
    return json(
      {
        error: "unauthenticated",
        detail:
          "the CF-Access JWT failed verification (bad signature, wrong audience/issuer, " +
          "expired, or not yet valid). Refusing to admit/reject.",
      },
      401,
    );
  }

  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (email.length === 0) {
    return json(
      {
        error: "unauthenticated",
        detail: "the verified CF-Access JWT carries no `email` claim to attribute the decision to.",
      },
      401,
    );
  }
  return email;
}

/**
 * Handle `POST /api/networks/admission-decision`.
 *
 * @param decider The injected signer seam. `null` ⇒ 503 (no
 *                federation/registry/signing identity configured).
 * @param auth    Gate-1 auth inputs (bind-conditioned; see
 *                {@link resolveAdmissionPrincipal}).
 * @param rawBody The parsed JSON body (server already enforced the size cap).
 */
export async function handleAdmissionDecision(
  decider: AdmissionDecider | null,
  auth: AdmissionAuthContext,
  rawBody: unknown,
): Promise<Response> {
  // Gate 1 — a CF-Access principal identity is required for a mutation.
  const who = await resolveAdmissionPrincipal(auth);
  if (who instanceof Response) return who;

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
