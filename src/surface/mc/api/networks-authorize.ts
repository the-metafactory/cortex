/**
 * FLG-2 (docs/plan-mc-future-state.md Track FLG, decision D-11, cortex#1706) —
 * the **authorize-from-glass** daemon route: `POST /api/networks/authorize`.
 *
 * Wave-1 of the MC govern glass wires the GOVERN bar's `Authorize` slot LIVE.
 * The registry backend already exists (`POST
 * /admission-requests/{request_id}/authorize`, cortex#1498 — HUB-ADMIN-signed,
 * stamps `hub_authorized_at` onto an ADMITTED row); this route is the glass +
 * daemon wiring to it — no new crypto, no new registry route.
 *
 * ## Trust posture (this is a trust-GRANTING verb — high blast)
 *
 * `hub_authorized_at` is the real signal that replaces the honor-system
 * `--hub-authorized-confirmed` attestation in the guided-join handoff: stamping
 * it tells a joining member's leaf it is cleared to come up. It is therefore a
 * `'control'` (high-blast) verb and sits behind the FND-3 **step-up MFA** gate
 * exactly like its siblings (seal / rotate-K / revoke). The gate is enforced
 * CENTRALLY in `server.ts handleApi` — this path is added to
 * `STEP_UP_CONTROL_ROUTES` (`step-up-mfa.ts`), so a POST without a valid
 * current TOTP code is refused with a 403 BEFORE the request reaches this
 * handler, and the handler never has to re-check it. The FND-6 identity gate
 * runs first (step-up without knowing WHO is stepping up is meaningless).
 *
 * ## Fail-closed on an absent hub-admin seed
 *
 * The signing seam is injected by `cortex.ts` from the hub-admin seed (built via
 * `hubAdminMaterialFromSeedFile` — the SAME chmod-600-gated loader the CLI's
 * `cortex network authorize` uses; seed loading is NOT hand-rolled here). When
 * the seed is absent / unloadable the injected seam is `null` and this handler
 * returns a structured `503 hub_admin_not_configured` — NEVER a silent success.
 * The live demo needs the deployed key (task #3 / #1671); the CODE builds and
 * fails-closed cleanly without it.
 *
 * ## Verdict passthrough
 *
 * `hub_authorized_at` is surfaced ONLY on a positive (2xx) registry response.
 * The registry's own gate order (`503 admin_not_configured → 401
 * signature_invalid → 403 admin_not_authorized`, plus `409 not_admitted`) is
 * propagated verbatim as structured JSON so the glass shows the registry's
 * reason, not a flattened status.
 */

/** The typed-confirm gate: the client must echo the target `request_id`. */
interface AuthorizeBody {
  request_id: string;
  /** Typed-confirm: must exactly equal `request_id`. */
  confirm: string;
}

// A conservative request-id shape (the registry's `isValidRequestId` is the
// authority; this is a cheap client-side pre-check so we never sign an
// obviously-bad id). IDENTICAL to the admission route's guard.
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

/** Why an authorize attempt failed — surface-local so this module never imports the bus. */
export type AuthorizeFailure =
  | "hub_admin_not_configured"
  | "signature_invalid"
  | "admin_not_authorized"
  | "not_admitted"
  | "rate_limited"
  | "invalid"
  | "not_found"
  | "unreachable";

/** The outcome of a hub-admin-signed authorize — never thrown. */
export type AuthorizeResult =
  | { ok: true; requestId: string; hubAuthorizedAt: string }
  | { ok: false; reason: AuthorizeFailure; detail: string };

/**
 * The injected seam the surface depends on to sign + POST the authorize claim.
 * `cortex.ts` supplies a live implementation built from the hub-admin seed +
 * the federated registry config; tests supply a stub. The server's getter
 * returns `null` when the hub-admin seed is not configured/loadable → the
 * handler returns a structured 503 `hub_admin_not_configured` (fail-closed).
 */
export interface Authorizer {
  authorize(requestId: string): Promise<AuthorizeResult>;
}

/** `POST /api/networks/authorize`. */
export const AUTHORIZE_PATH = "/api/networks/authorize";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Map an authorize failure reason to the HTTP status the glass branches on. */
function failureStatus(reason: AuthorizeFailure): number {
  switch (reason) {
    case "hub_admin_not_configured":
      return 503;
    case "signature_invalid":
      return 401;
    case "admin_not_authorized":
      return 403;
    case "not_admitted":
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
): { ok: true; body: AuthorizeBody } | { ok: false; response: Response } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, response: json({ error: "body must be a JSON object" }, 400) };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.request_id !== "string" || !REQUEST_ID_RE.test(b.request_id)) {
    return { ok: false, response: json({ error: "request_id must be a valid admission request id" }, 400) };
  }
  // Typed-confirm: the principal must echo the request_id they mean to act on —
  // the deliberate intent gate for a control-plane mutation (mirrors the CLI's
  // `cortex network authorize` posture + the admission-decision route).
  if (typeof b.confirm !== "string" || b.confirm !== b.request_id) {
    return {
      ok: false,
      response: json(
        {
          error: "confirm must exactly match request_id",
          detail:
            "Type the request id to confirm this trust-granting authorize. " +
            "This is the deliberate intent gate for a control-plane mutation.",
        },
        400,
      ),
    };
  }

  return { ok: true, body: { request_id: b.request_id, confirm: b.confirm } };
}

/**
 * Handle `POST /api/networks/authorize`.
 *
 * Identity (FND-6) + step-up MFA (FND-3) are already enforced upstream in
 * `handleApi` (this path is in `STEP_UP_CONTROL_ROUTES`); by the time we get
 * here the request is authenticated and step-up-satisfied. This handler owns
 * the typed-confirm intent gate + the fail-closed seam + the verdict passthrough.
 *
 * @param authorizer The injected hub-admin signer seam. `null` ⇒ 503
 *                   `hub_admin_not_configured` (no hub-admin seed loadable).
 * @param rawBody    The parsed JSON body (server already enforced the size cap).
 */
export async function handleAuthorize(
  authorizer: Authorizer | null,
  rawBody: unknown,
): Promise<Response> {
  // Intent gate — body shape + typed-confirm.
  const parsed = parseBody(rawBody);
  if (!parsed.ok) return parsed.response;

  // Fail-closed: the hub-admin signing seam must be wired (hub-admin seed
  // present + loadable). NEVER a silent success when the key is absent.
  if (authorizer === null) {
    return json(
      {
        error: "hub_admin_not_configured",
        detail:
          "authorize-from-glass is unavailable — no hub-admin signing seed is configured/loadable " +
          "on this daemon (stamping hub_authorized_at requires the hub-admin authority, ADR-0018 Q5). " +
          "Deploy the hub-admin seed, or run `cortex network authorize` from the hub owner's stack.",
      },
      503,
    );
  }

  const result = await authorizer.authorize(parsed.body.request_id);

  if (result.ok) {
    // hub_authorized_at is surfaced ONLY on a positive registry response.
    return json({ request_id: result.requestId, hub_authorized_at: result.hubAuthorizedAt }, 200);
  }
  return json({ error: result.reason, detail: result.detail }, failureStatus(result.reason));
}
