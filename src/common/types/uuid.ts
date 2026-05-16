/**
 * UUID validators — shared module for the two UUID-shaped checks
 * cortex uses on inbound payloads.
 *
 * Why centralised: pre-cortex#196 the same regex pair appeared in
 * 5+ callsites across `src/runner/`, `src/taps/cc-events/`,
 * `src/bus/`, `src/substrates/`, and `src/surface/mc/api/`. Drift
 * between independent copies was a real risk — particularly the
 * STRICT-vs-LOOSE choice (whether to admit non-v1-v5 variants like
 * v6/v7) which had no single source of truth.
 *
 * Cross-references:
 *   - `src/runner/dispatch-listener.ts` — task_id strict check
 *   - `src/taps/cc-events/cc-events.ts` — session_id strict check
 *   - `src/bus/github-events.ts` — deliveryId strict check
 *   - `src/substrates/claude-code/harness.ts` — requestId loose check
 *   - `src/surface/mc/api/handlers.ts` — API param loose check
 *
 * Closes cortex#196.
 */

/**
 * Strict UUID v1-v5 (RFC 4122) regex.
 *
 * Validates: 8-4-4-4-12 lowercase hex (case-insensitive via `i`
 * flag), with the version nibble constrained to 1-5 and the
 * variant nibble constrained to 8/9/a/b. Rejects v6/v7 and other
 * non-RFC-4122 shapes.
 *
 * Use this for inputs that come from cortex-controlled producers
 * — `runner/dispatch-listener.ts` task ids, `cc-events/cc-events.ts`
 * session ids, `bus/github-events.ts` delivery ids. These are all
 * minted via `crypto.randomUUID()` (which produces v4) and a
 * non-v4 value indicates a bad payload, not a future variant.
 */
const STRICT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Loose hex-only UUID regex.
 *
 * Validates: 8-4-4-4-12 lowercase/uppercase hex. No version or
 * variant nibble constraints — accepts v6, v7, and any other
 * 36-char hex with the canonical dash positions.
 *
 * Use this for inputs from external/uncontrolled producers —
 * `substrates/claude-code/harness.ts` request ids (Claude Code
 * session ids aren't guaranteed v4), `surface/mc/api/handlers.ts`
 * URL params (the API client may not be cortex). Trades stricter
 * validation for cross-version compatibility.
 */
const LOOSE_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Strict UUID v1-v5 check. See {@link STRICT_UUID_REGEX} for the
 * grammar + use-site guidance.
 */
export function isUuid(value: string): boolean {
  return STRICT_UUID_REGEX.test(value);
}

/**
 * Loose UUID check (any RFC-4122 dash layout, hex-only).
 * See {@link LOOSE_UUID_REGEX} for the grammar + use-site guidance.
 */
export function isUuidLoose(value: string): boolean {
  return LOOSE_UUID_REGEX.test(value);
}
