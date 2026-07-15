// API-P0.3 (epic #2055, Phase 0, decisions D1/D2) — normalized provider error
// contract. Design §"Error normalization": provider failures collapse to a
// small closed set of stable kinds while retaining a SAFE native diagnostic.
// Dispatch lifecycle publishing (→ API-P1.4) maps these kinds onto existing
// `failed`/`aborted` semantics and back-pressure hints.
//
// Types only — no runtime code, no provider implementations.

/**
 * The stable, provider-neutral classification of a model-provider failure.
 * Deliberately small: every provider's native error taxonomy normalizes onto
 * exactly one of these kinds so the harness reasons about failures without
 * vendor branches.
 */
export type ProviderErrorKind =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "unsupported_capability"
  | "content_filter"
  | "timeout"
  | "unavailable"
  | "malformed_response";

/**
 * A normalized provider failure. Carries retryability, an optional
 * `retryAfterMs` back-pressure hint when the provider supplied one, the
 * provider's own request id for correlation, and a redacted diagnostic summary.
 */
export interface ProviderError {
  /** Stable, provider-neutral failure classification. */
  kind: ProviderErrorKind;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** Provider-advised delay before retrying, in milliseconds, when known. */
  retryAfterMs?: number;
  /** The provider's own request identifier, for cross-system correlation. */
  providerRequestId?: string;
  /**
   * REDACTED — a safe, human-readable diagnostic only. MUST NEVER carry
   * secrets, API keys, authorization headers, or raw request/response bodies.
   * Anything placed here may be logged, published onto the bus, and surfaced
   * on the dashboard.
   */
  summary: string;
}
