/**
 * FND-3 (docs/plan-mc-future-state.md §4.0, decision D-2) — **step-up MFA at
 * the daemon decider seam**. The single shared gate for ALL high-blast
 * (`GrantScope 'control'`) govern verbs: seal / rotate-K / revoke / escalation-
 * approve (FLG-6/8/9, SPX-8). Those verbs CONSUME this gate; this module does
 * NOT implement them.
 *
 * ## Why the daemon, not the worker (verified)
 *
 * The named `worker/src/user-auth/authorize.ts` is the **CF Worker's** — the
 * loopback daemon path never traverses it, so worker-side MFA is bypassed
 * entirely. And on the dominant loopback bind CF Access is **not in the request
 * path at all**, so "ride CF Access" is architecturally impossible there.
 * Enforcement therefore lives HERE, at the daemon's `handleApi` decider seam,
 * right after the FND-6 identity gate.
 *
 * ## Mechanism (D-2 ratified: LOCAL TOTP)
 *
 * RFC 6238 TOTP (see `src/common/step-up/totp.ts`). A secret is enrolled
 * out-of-band via `cortex step-up enroll` and stored `0600` under
 * `~/.config/cortex/` (see `src/common/step-up/enrollment.ts`). A high-blast
 * request must carry a valid current 6-digit code in the {@link STEP_UP_HEADER}
 * header; the daemon verifies it constant-time against the enrolled secret with
 * a ±1-step window.
 *
 * ## Invariants (each fail-closed)
 *
 *  1. **Loopback is challenged too.** Terminal possession ≠ step-up. This gate
 *     does NOT branch on the bind — a loopback request is challenged exactly
 *     like a non-loopback one. CF-Access re-auth on a non-loopback bind is
 *     ADDITIONAL hardening handled by the FND-6 identity gate that runs first;
 *     it is never the step-up mechanism.
 *  2. **Absent enrollment ⇒ 403**, with an honest body ("enroll or use the
 *     CLI") — NEVER a silent downgrade to typed-confirm. The CLI (`cortex
 *     network …`) remains the unbroken fallback, so fail-closed ≠ unusable.
 *  3. **No valid code ⇒ 403.** Missing code and wrong code are both refused.
 *  4. **The secret is never logged, printed, or returned.** It lives only in
 *     the `0600` file and in memory for the length of a verify. The submitted
 *     code is likewise never echoed. Nothing in this module writes to a log or
 *     the event pipeline.
 */

import { verifyTotp, TOTP_DEFAULTS } from "../../../common/step-up/totp";
import type { StepUpEnrollment } from "../../../common/step-up/enrollment";

/**
 * Request header carrying the current TOTP code for a high-blast verb. A header
 * (not a body field) is deliberate: the gate runs BEFORE any route body is
 * read, so it must not consume/observe the JSON body — that stays owned by the
 * verb handler downstream.
 */
export const STEP_UP_HEADER = "X-Cortex-Step-Up-Otp";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Extract the submitted TOTP code from the request header (trimmed). */
export function readStepUpCode(req: Request): string {
  return (req.headers.get(STEP_UP_HEADER) ?? "").trim();
}

/**
 * The `'control'` (high-blast) route registry — the SINGLE source of truth for
 * which glass mutations require step-up MFA. The govern verbs (FLG-6/8/9,
 * SPX-8) are NOT built here; when they mount their handlers they align to these
 * paths so the gate is enforced centrally in `handleApi` and a verb can never
 * forget to call it. Route names follow the established
 * `/api/networks/admission-decision` convention.
 *
 * Deliberately EXCLUDES the low-blast verbs (admit/reject via
 * `/api/networks/admission-decision`, the attention lifecycle) — those stay at
 * the FND-6 identity + typed-confirm tier.
 */
export const STEP_UP_CONTROL_ROUTES: ReadonlySet<string> = new Set([
  "/api/networks/authorize", // FLG-2 — authorize-from-glass (stamp hub_authorized_at)
  "/api/networks/seal", // FLG-6 — admit-and-seal from glass
  "/api/networks/rotate-key", // FLG-8 — rotate-K from glass
  "/api/networks/revoke", // FLG-9 — revoke from glass
  "/api/networks/escalation-decision", // SPX-8 — escalation approve
]);

/** Only POST mutates a control verb; a GET to the same path is not gated here. */
export function requiresStepUp(method: string, pathname: string): boolean {
  return method === "POST" && STEP_UP_CONTROL_ROUTES.has(pathname);
}

/** Per-request inputs for {@link enforceStepUp}. */
export interface StepUpContext {
  /**
   * The loaded enrollment, or `null` when not enrolled. Resolved lazily by the
   * server per control request (re-enrollment must not require a daemon
   * restart). A THROW from the loader (malformed / bad-perm file) is handled by
   * the server BEFORE calling this — mapped to a 500 rather than a silent
   * downgrade.
   */
  enrollment: StepUpEnrollment | null;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * The step-up gate. Returns a `Response` (403) to send verbatim when the
 * challenge is not satisfied, or `null` when the request may proceed to the
 * verb handler.
 *
 * Fail-closed, bind-agnostic (loopback is challenged too):
 *  - not enrolled          → 403 `step_up_not_configured` (enroll / use the CLI)
 *  - no code on the request → 403 `step_up_required`
 *  - wrong code             → 403 `step_up_invalid`
 *
 * The secret and the submitted code are never included in any response body or
 * log line.
 */
export function enforceStepUp(req: Request, ctx: StepUpContext): Response | null {
  if (ctx.enrollment === null) {
    return json(
      {
        error: "step_up_not_configured",
        detail:
          "step-up MFA is not configured on this daemon — this high-blast control " +
          "verb is refused (fail-closed). Enroll a TOTP secret with `cortex step-up " +
          "enroll`, or run the equivalent `cortex network …` CLI command, which " +
          "remains the fallback. There is no typed-confirm downgrade for control verbs.",
      },
      403,
    );
  }

  const code = readStepUpCode(req);
  if (code === "") {
    return json(
      {
        error: "step_up_required",
        detail:
          `a current TOTP step-up code is required for this control verb — send it in the ` +
          `${STEP_UP_HEADER} header. Terminal/loopback possession alone is not step-up.`,
      },
      403,
    );
  }

  const ok = verifyTotp(ctx.enrollment.secret, code, {
    digits: ctx.enrollment.digits,
    period: ctx.enrollment.period,
    window: TOTP_DEFAULTS.window,
    ...(ctx.nowMs !== undefined ? { nowMs: ctx.nowMs } : {}),
  });
  if (!ok) {
    return json(
      {
        error: "step_up_invalid",
        detail:
          "the step-up TOTP code was not valid for the current time window. Re-read " +
          "the current code from your authenticator and retry.",
      },
      403,
    );
  }
  return null;
}
