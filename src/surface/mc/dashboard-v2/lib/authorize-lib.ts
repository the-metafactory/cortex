/**
 * FLG-2 (docs/plan-mc-future-state.md Track FLG, decision D-11, cortex#1706) —
 * pure logic for the **authorize-from-glass** GOVERN verb: POST the target
 * request-id to `/api/networks/authorize`, carrying the current TOTP step-up
 * code, and map the registry verdict to something renderable.
 *
 * Mirrors `pier-decide-lib.ts` (POST + map + injectable `FetchLike`): the
 * load-bearing behaviour — the typed-confirm gate, the step-up header, and the
 * verdict → readable-message mapping — is unit-testable without a DOM harness
 * (the dashboard tests render statically; there is no testing-library).
 *
 * Authorize is a trust-GRANTING, high-blast control verb: the daemon route
 * ({@link AUTHORIZE_PATH}) sits behind the FND-3 step-up MFA gate, so a POST
 * MUST carry a valid current 6-digit TOTP code in the {@link STEP_UP_HEADER}
 * header. The daemon signs the hub-admin authorize claim locally + POSTs the
 * registry; this client only POSTs and renders the verdict.
 */

/** The step-up MFA header the daemon's control gate reads (mirror of the server const). */
export const STEP_UP_HEADER = "X-Cortex-Step-Up-Otp";

/** `POST /api/networks/authorize`. */
export const AUTHORIZE_PATH = "/api/networks/authorize";

/** The POST body the endpoint expects (`confirm` must equal `request_id`). */
export interface AuthorizeBody {
  request_id: string;
  confirm: string;
}

/** The outcome of an authorize POST, already mapped to something renderable. */
export type AuthorizeOutcome =
  | { kind: "ok"; requestId: string; hubAuthorizedAt: string }
  | { kind: "error"; message: string; httpStatus: number };

/** Minimal fetch shape (injectable for tests). Identical to pier-decide-lib. */
export type FetchLike = (
  path: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The typed-confirm gate: an authorize may be submitted only when a non-empty
 * request-id has been entered AND the confirm box exactly echoes it AND a
 * non-empty step-up code has been supplied AND no request is already in flight.
 * Pure — the single source of truth the button's disabled state and any
 * programmatic caller share.
 */
export function canAuthorize(input: {
  requestId: string;
  confirm: string;
  stepUpCode: string;
  busy: boolean;
}): boolean {
  const id = input.requestId.trim();
  if (id.length === 0) return false;
  if (input.busy) return false;
  // A control verb is step-up-gated: no code ⇒ the daemon will 403, so the
  // button stays disabled rather than firing a request that cannot succeed.
  if (input.stepUpCode.trim().length === 0) return false;
  // Exact echo — NOT trimmed on the confirm side: the principal must reproduce
  // the id verbatim (a stray space is a real mismatch, surfaced honestly).
  return input.confirm === input.requestId;
}

/**
 * POST an authorize and map the response to an {@link AuthorizeOutcome}. Sends
 * the TOTP code in the {@link STEP_UP_HEADER} header (the control gate reads it
 * BEFORE the body). Reads the server's `{ error, detail }` on failure so the
 * principal sees the readable `detail` (e.g. the not-admitted / not-authorized
 * explanation) rather than a bare status code. Never throws — a transport
 * failure becomes `{ kind: "error", httpStatus: 0 }`.
 */
export async function submitAuthorize(
  body: AuthorizeBody,
  stepUpCode: string,
  fetchImpl: FetchLike,
): Promise<AuthorizeOutcome> {
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(AUTHORIZE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [STEP_UP_HEADER]: stepUpCode.trim(),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      httpStatus: 0,
    };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  const obj = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  if (resp.ok) {
    const hubAuthorizedAt = typeof obj.hub_authorized_at === "string" ? obj.hub_authorized_at : undefined;
    if (hubAuthorizedAt !== undefined) {
      const requestId = typeof obj.request_id === "string" ? obj.request_id : body.request_id;
      return { kind: "ok", requestId, hubAuthorizedAt };
    }
    return { kind: "error", message: "the authorize succeeded but the response was malformed", httpStatus: resp.status };
  }

  // Failure — prefer the human `detail`, fall back to the `error` code, then HTTP.
  const detail = typeof obj.detail === "string" ? obj.detail : undefined;
  const error = typeof obj.error === "string" ? obj.error : undefined;
  const message = detail ?? error ?? `HTTP ${resp.status.toString()}`;
  return { kind: "error", message, httpStatus: resp.status };
}

/** A short, tone-tagged summary of an outcome for the result line. */
export function describeAuthorizeOutcome(outcome: AuthorizeOutcome): { tone: "ok" | "error"; text: string } {
  if (outcome.kind === "ok") {
    return { tone: "ok", text: `Request ${outcome.requestId} authorized (hub_authorized_at stamped).` };
  }
  return { tone: "error", text: outcome.message };
}
