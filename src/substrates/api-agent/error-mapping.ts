// API-P1.4 (epic #2055, Phase 1) — normalized `ProviderError` → dispatch
// lifecycle mapping + back-pressure. Design §"Error normalization",
// §"Policy, sovereignty, and economics".
//
// This is the AUTHORITATIVE table: every `ProviderErrorKind` maps to a defined
// dispatch outcome, and the transient/back-pressure kinds additionally carry a
// `retryAfterMs` hint. It refines the BASIC P1.3 mapping (every provider error →
// a plain `failed`) into the full table the issue specifies.
//
// KEY DECISIONS (mirrors the established back-pressure shape in
// `runner/dispatch-listener.ts`, where admission rate-exhaustion emits a
// `dispatch.task.failed { reason: { kind: "not_now", retry_after_ms } }`):
//
//   - Every `ProviderErrorKind` is a `failed` terminal. There is NO provider-
//     error kind that maps to `aborted` — `aborted` is reserved for the
//     abort-signal (cancellation / shutdown) path, which the agent loop yields
//     directly. Rate exhaustion is TRANSIENT, not a `term`/abort; the
//     dispatch-listener precedent is explicit on this.
//   - The four transient kinds (`rate_limit` / `overloaded` / `unavailable` /
//     `timeout`) are BACK-PRESSURE: they carry a `not_now` reason and surface
//     `retryAfterMs` when the provider supplied one. The other six kinds are
//     non-retryable: no `retryAfterMs`, no back-pressure reason.
//
// SECRET-SAFE by construction. This module only ever reads the normalized kind +
// the numeric `retryAfterMs`; it never touches the raw provider body, headers,
// or key material. The human-readable `not_now.detail` is built from the kind
// alone, so nothing an attacker controls can reach the lifecycle envelope here.

import type { ProviderErrorKind } from "../../common/inference/errors";
import type { DispatchTaskFailedReason } from "../../bus/dispatch-events";

/** The dispatch outcome a normalized provider error maps to. */
export type ProviderErrorOutcome = "failed" | "aborted";

/**
 * The authoritative `ProviderErrorKind` → dispatch outcome table (issue #2064).
 * Exhaustive over every kind — a new kind added to `ProviderErrorKind` fails
 * compilation here until it is classified, so the mapping can never silently
 * fall through to an undefined outcome.
 *
 * `backPressure: true` ⇒ transient/retryable: emit a `not_now` reason and
 * surface `retryAfterMs` when known. `backPressure: false` ⇒ non-retryable:
 * a plain `failed` terminal, no retry hint.
 */
export const PROVIDER_ERROR_KIND_OUTCOME: Record<
  ProviderErrorKind,
  { readonly outcome: ProviderErrorOutcome; readonly backPressure: boolean }
> = {
  // Non-retryable — a plain `failed` terminal, no back-pressure.
  authentication: { outcome: "failed", backPressure: false },
  authorization: { outcome: "failed", backPressure: false },
  invalid_request: { outcome: "failed", backPressure: false },
  unsupported_capability: { outcome: "failed", backPressure: false },
  content_filter: { outcome: "failed", backPressure: false },
  malformed_response: { outcome: "failed", backPressure: false },
  // Transient / back-pressure — `failed` + `not_now` reason + `retryAfterMs`.
  rate_limit: { outcome: "failed", backPressure: true },
  overloaded: { outcome: "failed", backPressure: true },
  unavailable: { outcome: "failed", backPressure: true },
  timeout: { outcome: "failed", backPressure: true },
};

/**
 * The normalized-provider-error facts the agent loop forwards to the harness for
 * lifecycle shaping. A subset of {@link ProviderError} — deliberately NOT the
 * whole error, so the raw body / headers / summary-with-detail never travel this
 * seam. (The redacted `summary` rides its own outcome field.)
 */
export interface ProviderFailureInput {
  readonly errorKind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/**
 * The lifecycle-envelope shaping a normalized provider error resolves to. The
 * harness stamps these onto the `dispatch.task.failed` envelope's diagnostic
 * fields.
 */
export interface ProviderFailureShape {
  /** The dispatch outcome — always `failed` for a provider error (see header). */
  readonly outcome: ProviderErrorOutcome;
  /** The normalized kind, stamped as a `provider_error_kind` diagnostic. */
  readonly errorKind: ProviderErrorKind;
  /** Whether a retry could plausibly succeed — the table's classification. */
  readonly retryable: boolean;
  /** Provider-advised retry delay — present ONLY for back-pressure kinds with a known hint. */
  readonly retryAfterMs?: number;
  /** A `not_now` back-pressure reason for the transient kinds; omitted otherwise. */
  readonly reason?: DispatchTaskFailedReason;
}

/**
 * Map a normalized provider error onto its dispatch-lifecycle shape (issue
 * #2064). Table-driven: the kind alone decides retryability and back-pressure,
 * so a provider that mis-set `retryable` cannot flip the classification. The
 * `retryAfterMs` hint is carried through verbatim for back-pressure kinds only.
 */
export function shapeProviderFailure(
  input: ProviderFailureInput,
): ProviderFailureShape {
  const spec = PROVIDER_ERROR_KIND_OUTCOME[input.errorKind];
  if (spec.backPressure) {
    return {
      outcome: spec.outcome,
      errorKind: input.errorKind,
      retryable: true,
      ...(input.retryAfterMs !== undefined
        ? { retryAfterMs: input.retryAfterMs }
        : {}),
      reason: {
        kind: "not_now",
        // Built from the kind ALONE — no provider-authored text, so this string
        // is secret-free by construction.
        detail: `provider back-pressure (${input.errorKind})`,
        ...(input.retryAfterMs !== undefined
          ? { retry_after_ms: input.retryAfterMs }
          : {}),
      },
    };
  }
  return {
    outcome: spec.outcome,
    errorKind: input.errorKind,
    retryable: false,
    // Non-retryable: no `retryAfterMs`, no back-pressure reason.
  };
}
