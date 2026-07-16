// API-P1.4 (issue #2064) — unit coverage for the `ProviderErrorKind` → dispatch
// outcome table. Proves EVERY kind maps to a defined outcome, that the transient
// kinds are back-pressure (carry `retryAfterMs` when known) and the rest are not,
// and that the `not_now` reason detail is built from the kind alone (secret-free).

import { describe, expect, test } from "bun:test";

import type { ProviderErrorKind } from "../../../common/inference/errors";
import {
  PROVIDER_ERROR_KIND_OUTCOME,
  shapeProviderFailure,
} from "../error-mapping";

// The full closed set, spelled out independently of the table so a kind added to
// the type (and the table) without updating this list fails the exhaustiveness
// assertion below.
const ALL_KINDS: ProviderErrorKind[] = [
  "authentication",
  "authorization",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "unsupported_capability",
  "content_filter",
  "timeout",
  "unavailable",
  "malformed_response",
];

const BACK_PRESSURE_KINDS: ProviderErrorKind[] = [
  "rate_limit",
  "overloaded",
  "unavailable",
  "timeout",
];
const NON_RETRYABLE_KINDS: ProviderErrorKind[] = ALL_KINDS.filter(
  (k) => !BACK_PRESSURE_KINDS.includes(k),
);

describe("api-agent error-mapping · ProviderErrorKind → dispatch outcome (#2064)", () => {
  test("the table is exhaustive over every ProviderErrorKind", () => {
    const tableKinds = Object.keys(PROVIDER_ERROR_KIND_OUTCOME).sort();
    expect(tableKinds).toEqual([...ALL_KINDS].sort());
  });

  test("every kind maps to a defined `failed` outcome (never undefined)", () => {
    for (const kind of ALL_KINDS) {
      const shape = shapeProviderFailure({ errorKind: kind, retryable: true });
      // No provider-error kind maps to `aborted` — that is the cancellation
      // path's outcome, not a provider error's.
      expect(shape.outcome).toBe("failed");
    }
  });

  test("back-pressure kinds are retryable and surface `retryAfterMs` when known", () => {
    for (const kind of BACK_PRESSURE_KINDS) {
      const shape = shapeProviderFailure({
        errorKind: kind,
        retryable: true,
        retryAfterMs: 2500,
      });
      expect(shape.retryable).toBe(true);
      expect(shape.retryAfterMs).toBe(2500);
      expect(shape.reason).toEqual({
        kind: "not_now",
        detail: `provider back-pressure (${kind})`,
        retry_after_ms: 2500,
      });
    }
  });

  test("a back-pressure kind WITHOUT a hint still emits `not_now`, no retry_after_ms", () => {
    for (const kind of BACK_PRESSURE_KINDS) {
      const shape = shapeProviderFailure({ errorKind: kind, retryable: true });
      expect(shape.retryable).toBe(true);
      expect(shape.retryAfterMs).toBeUndefined();
      expect(shape.reason).toEqual({
        kind: "not_now",
        detail: `provider back-pressure (${kind})`,
      });
    }
  });

  test("non-retryable kinds carry NO retryAfterMs and NO back-pressure reason", () => {
    for (const kind of NON_RETRYABLE_KINDS) {
      // Even if a provider mis-set `retryable: true` / supplied a hint, the
      // table's classification is authoritative and refuses the hint.
      const shape = shapeProviderFailure({
        errorKind: kind,
        retryable: true,
        retryAfterMs: 9999,
      });
      expect(shape.retryable).toBe(false);
      expect(shape.retryAfterMs).toBeUndefined();
      expect(shape.reason).toBeUndefined();
    }
  });

  test("the `not_now` detail is derived from the kind alone (no injected text)", () => {
    const shape = shapeProviderFailure({
      errorKind: "rate_limit",
      retryable: true,
      retryAfterMs: 1000,
    });
    // Deterministic, kind-only string — nothing provider-authored can reach it.
    expect(shape.reason?.kind).toBe("not_now");
    if (shape.reason?.kind === "not_now") {
      expect(shape.reason.detail).toBe("provider back-pressure (rate_limit)");
    }
  });
});
