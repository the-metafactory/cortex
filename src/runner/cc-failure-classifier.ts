/**
 * cortex#360 — Shared CC failure classifier.
 *
 * Lifts the four-way nak taxonomy mapping previously inlined in
 * `review-pipeline.ts:244-298` into a single shared helper. Two call
 * sites consume it:
 *
 *   1. `review-pipeline.ts` — the JetStream-pull `tasks.code-review.*`
 *      consumer path (review-consumer path).
 *   2. `dispatch-handler.ts` — the chat dispatch path that adapters
 *      (Discord, Mattermost) drive on inbound `@mention` / DM. This
 *      path now retries `not_now` failures up to 3 attempts before
 *      surfacing the apology to the principal (cortex#360 acceptance
 *      criteria).
 *
 * **What this module IS:**
 *   - A pure function. No I/O, no state, no side effects.
 *   - The canonical mapping from `CCSessionResult` shape to
 *     `DispatchTaskFailedReason` for the substrate-side error modes
 *     (`aborted`, `exit non-zero with no output`, factory-throw on spawn).
 *
 * **What this module is NOT:**
 *   - NOT a verdict-block parser. That stays in `review-pipeline.ts`
 *     where the `cant_do` cases (skill didn't emit a block, JSON parse
 *     failed, schema violations) are decided.
 *   - NOT a policy gate. `wont_do` decisions come from the optional
 *     `policyCheck` hook in `review-pipeline.ts`, not from the result
 *     shape.
 *   - NOT a retry executor. The chat-path retry loop lives in
 *     `dispatch-handler.ts`; this module just answers "is this failure
 *     retryable?" via `reason.kind === 'not_now'`.
 *
 * **Anchors:**
 *   - `docs/architecture.md` §7.3 — canonical nak vocabulary.
 *   - `docs/design-pilot-restructure.md` §4.4 — pilot-side nak consumption.
 *   - `review-pipeline.ts` file header — original mapping table.
 *
 * **Spec preservation:** The body of this module is the verbatim logic
 * from `review-pipeline.ts:244-298`. The review-consumer path's
 * behaviour MUST NOT change as a result of this lift (cortex#360
 * critical rule: migration moves preserve behaviour). The corresponding
 * review-consumer / review-pipeline tests assert exactly this.
 */

import type { CCSessionResult } from "./cc-session";
import type { DispatchTaskFailedReason } from "../bus/dispatch-events";

/**
 * Classify a `CCSessionResult` into a `DispatchTaskFailedReason`, or
 * return `null` when the result represents a clean outcome that the
 * downstream caller should continue processing (verdict-block parsing,
 * direct response forwarding, etc.).
 *
 * **Mapping table** (verbatim from `review-pipeline.ts:244-298`):
 *
 * | CCSessionResult shape                              | Returned reason  |
 * |----------------------------------------------------|------------------|
 * | `aborted === true` (inactivity timeout / kill)     | `not_now`        |
 * | `!success` AND `response.trim() === ""`            | `not_now`        |
 * | any other shape (success, or failure WITH output)  | `null`           |
 *
 * The "failure with output" case is intentionally null — the
 * review-pipeline path treats a non-zero exit with captured output as a
 * candidate for verdict-block parsing (the skill emitted a block then
 * crashed late). The dispatch-handler path treats it as success-like:
 * the user sees the response text, not the apology message.
 *
 * `retry_after_ms: 0` per architecture §7.3 — the producer signals
 * "no specific backpressure hint, retry whenever you like." Pilot
 * translates this to exit 4 (transient, retry safe).
 */
export function classifyCcFailure(
  result: CCSessionResult,
): DispatchTaskFailedReason | null {
  // §7.6 — substrate-side abort / crash paths. `aborted` covers the
  // inactivity-timeout case (the canonical signature from cc-session.ts
  // is `exitCode: 1 + aborted: true`, not `exitCode: 143`).
  if (result.aborted) {
    const reason = result.abortReason ?? "aborted";
    return {
      kind: "not_now",
      detail: `cc session aborted: ${reason}`,
      retry_after_ms: 0,
    };
  }
  // A non-zero exit with no captured response is the "CC crashed mid-
  // stream" case. Note: review-pipeline.ts pre-#360 also checked
  // `!result.success` here — kept for behaviour parity.
  if (!result.success && !result.response.trim()) {
    return {
      kind: "not_now",
      detail: `cc session exited ${result.exitCode} with no output`,
      retry_after_ms: 0,
    };
  }
  // Clean exit, or failure that produced output — downstream caller's
  // problem (verdict-block parse / direct user response).
  return null;
}

/**
 * Classify a synchronous-throw or async-rejection from the CC session
 * factory (e.g. spawn failed, binary missing, immediate API rejection).
 * Always maps to `not_now` per §7.3 — these are transient infrastructure
 * failures, principal-recoverable.
 *
 * Separate entry point because `classifyCcFailure` operates on a
 * `CCSessionResult` shape; this one operates on an unknown thrown value
 * (caller's `try`/`catch`).
 *
 * **No null return** — every spawn-error is by definition a failure
 * classification. The caller must always handle the reason.
 */
export function classifyCcSpawnError(err: unknown): DispatchTaskFailedReason {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    kind: "not_now",
    detail: `cc session error: ${detail}`,
    retry_after_ms: 0,
  };
}

/**
 * Convenience predicate: is this failure reason retry-eligible per the
 * `not_now` semantics? Used by the chat-path retry loop in
 * `dispatch-handler.ts` to decide whether to spawn another attempt or
 * surface the apology immediately.
 *
 * `not_now` is the ONLY retryable kind — `cant_do`, `wont_do`,
 * `policy_denied`, and `compliance_block` are all terminal (principal
 * action needed; retry would just re-fail).
 */
export function isTransientFailure(
  reason: DispatchTaskFailedReason,
): boolean {
  return reason.kind === "not_now";
}

/**
 * cortex#2055 — Signatures of a Claude Code **authentication** failure. When
 * the host's `claude` login has expired, the CLI exits non-zero with the auth
 * error on stderr (and no stdout response), so the generic classifier buckets
 * it as `not_now` → the chat path retries 3× (all futile — auth won't self-heal)
 * and then surfaces the opaque "couldn't process that (exit code: 1)". These
 * patterns let the chat path detect it, skip the retries, and tell the
 * principal what to actually do.
 *
 * Matched case-insensitively against `response + stderr`. Kept broad because
 * the exact wording varies by CLI version (OAuth vs API-key, login-expired vs
 * invalid-key), but every variant is principal-recoverable the same way.
 */
const CC_AUTH_FAILURE_SIGNATURES: readonly RegExp[] = [
  /authentication_failed/i,
  /invalid api key/i,
  /oauth token (?:has )?expired/i,
  /(?:please|run) .*\bclaude\b.*\b(?:login|log ?in)\b/i,
  /\/login\b/i,
  /not (?:logged|signed) in/i,
  /session (?:has )?expired/i,
];

/**
 * cortex#2055 — Actionable message shown to the principal (in place of the
 * generic apology) when a dispatch fails because Claude Code auth expired on
 * the host. Names the fix so they don't have to dig through session JSONL.
 */
export const CC_AUTH_FAILURE_MESSAGE =
  "⚠️ I couldn't reach Claude Code — the host's authentication has expired. " +
  "On the host, run `claude` in a terminal and complete the login, then try again.";

/**
 * cortex#2055 — True when a `CCSessionResult` bears the fingerprint of an auth
 * failure (checks the captured stderr and any partial response). The chat path
 * uses this to classify the failure as terminal (no retry) and to swap the
 * opaque apology for `CC_AUTH_FAILURE_MESSAGE`.
 */
export function isCcAuthFailure(result: CCSessionResult): boolean {
  if (result.success) return false;
  const haystack = `${result.response}\n${result.stderr ?? ""}`;
  if (!haystack.trim()) return false;
  return CC_AUTH_FAILURE_SIGNATURES.some((re) => re.test(haystack));
}
