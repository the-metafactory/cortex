/**
 * API-2115 — read the usage + provider diagnostics an api-agent dispatch stamps
 * onto its terminal lifecycle envelope.
 *
 * ## What this module is (and is deliberately NOT)
 *
 * This is the READ half of the producer→MC usage seam. The api-agent harness
 * (`src/substrates/api-agent/harness.ts` `stampUsage` / `stampFailureDiagnostics`)
 * widens its terminal envelope's payload with Mission Control's existing token
 * field names plus normalized provider diagnostics; until this module existed,
 * NOTHING read them (issue #2115 — epic #2055 DoD step 4).
 *
 * It is a pure structural read: `(payload) → typed struct`. It does NOT write MC
 * rows — `dispatch-lifecycle.ts` owns the write (`persistDispatchUsage`), keeping
 * "what the wire said" separable from "which row it lands on".
 *
 * The KEYING that write uses is settled (#2115 acceptance criterion 2): the usage
 * lands on the ANCHOR SESSION the projection already creates per `correlation_id`
 * — Option A. The premise that an api-agent dispatch has no session to key into
 * was false: `ensureAnchor` has always created one (`cc_session_id` NULL). A
 * `cc_session_id` is the cc-events JOIN key, not the session's identity, so no
 * synthetic id is minted and no new table is introduced.
 *
 * ## Cost is provider-reported or ABSENT — never estimated (design Q7)
 *
 * The design's §"Policy, sovereignty, and economics" allows cost to be
 * provider-reported OR computed from a versioned price table, and REQUIRES an
 * estimate to be labelled an estimate. Open question Q7 ("where should versioned
 * price data live, and which component labels costs as provider-reported versus
 * estimated?") is UNANSWERED. Therefore this module reads a cost ONLY when the
 * producer reported one, and leaves it `null` otherwise. It NEVER derives,
 * infers, or estimates a price — there is no price table here on purpose. A null
 * cost is an honest "not reported" that the SES-1 ledger already renders as 0
 * (`db/cost-attribution.ts` `usageOf`), never a fabricated number.
 *
 * Today no api-agent provider reports a price (the providers report tokens), so
 * {@link DispatchUsage.costUsd} is structurally always null on that path. The
 * read exists so that a provider which DOES report cost needs no new seam, and
 * so the "no estimate" rule has one enforced home.
 *
 * ## Why `payload.*` and not `economics.actual`
 *
 * The myelin envelope schema carries a first-class F-15 `economics.actual` block
 * (`input_tokens` / `output_tokens` / `total_tokens` / `model` / `duration_ms` /
 * `cost_usd`) that is arguably the wire grammar's designated home for token
 * economics. It is, today, dormant: NOTHING in cortex populates or reads it.
 * This module reads `payload.*` because that is what the producer VERIFIABLY
 * stamps (harness.ts `stampUsage`). Migrating the seam onto `economics.actual`
 * is a producer-side wire change and is out of scope for #2115 — flagged, not
 * silently chosen.
 */

/**
 * The usage an api-agent dispatch reports on its `completed` envelope, in
 * Mission Control's existing token vocabulary (`sessions.input_tokens` /
 * `output_tokens` / `cache_read_tokens` / `cost_usd`).
 *
 * Every field is `null` when the producer did not report it — an honest
 * "unreported", NEVER a zero-filled or estimated stand-in. A claude-code
 * dispatch's envelopes carry none of these fields, so its extraction is
 * all-null and the (future) write path is naturally a no-op for it.
 */
export interface DispatchUsage {
  /** Input tokens the provider reported consuming. Null ⇒ unreported. */
  inputTokens: number | null;
  /** Output tokens the provider reported producing. Null ⇒ unreported. */
  outputTokens: number | null;
  /** Prompt-cache read tokens. Null ⇒ unreported (not "zero cache hits"). */
  cacheReadTokens: number | null;
  /**
   * PROVIDER-REPORTED cost in USD. Null ⇒ the provider reported no price.
   *
   * NEVER an estimate. See the module docblock: design Q7 (where versioned price
   * data lives) is unresolved, so computing a price here is out of scope. If a
   * future slice adds a price table, an estimated value MUST be labelled as an
   * estimate rather than smuggled into this field.
   */
  costUsd: number | null;
}

/**
 * The normalized, SECRET-SAFE provider diagnostics an api-agent dispatch stamps
 * on its terminal envelope. Every value originates from the harness's normalized
 * failure shape (a controlled-vocab kind + a numeric hint) or the redacted
 * request id — never a raw provider body, header, or key.
 */
export interface DispatchProviderDiagnostics {
  /** Opaque provider request id, for cross-system correlation. Null ⇒ none. */
  providerRequestId: string | null;
  /** Normalized provider error kind (failed path only). Null ⇒ none. */
  providerErrorKind: string | null;
  /** Provider back-pressure hint in ms (failed path only). Null ⇒ none. */
  retryAfterMs: number | null;
}

/** True when `n` is a real, finite number — guards against NaN/Infinity on the wire. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read a non-negative INTEGER token count. Rejects negatives, non-integers, and
 * non-numbers — a malformed publisher can never poison a token column with a
 * value the schema's INTEGER columns and the ledger's sums would misread.
 * Returns null for anything unreadable (same honest-absence rule as unreported).
 */
function asTokenCount(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Read a non-negative cost. Unlike a token count this is REAL-valued (a price is
 * fractional), but the same "malformed ⇒ null, never a guess" rule applies.
 */
function asCost(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < 0) return null;
  return value;
}

/** Read a non-empty string, else null. */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Defensive payload narrowing — mirrors `projectDispatchLifecycle`'s own read:
 * a non-object payload (malformed envelope that slipped the validator, or a
 * hand-built object) is treated as "no fields" rather than throwing.
 */
function asFields(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Extract the usage an api-agent dispatch reported on a terminal lifecycle
 * payload. Total function: never throws, returns all-null for a payload that
 * carries no usage (every claude-code dispatch, and any api-agent dispatch whose
 * provider reported none).
 */
export function readDispatchUsage(payload: unknown): DispatchUsage {
  const fields = asFields(payload);
  return {
    inputTokens: asTokenCount(fields.input_tokens),
    outputTokens: asTokenCount(fields.output_tokens),
    cacheReadTokens: asTokenCount(fields.cache_read_tokens),
    // Provider-reported ONLY. No price table, no derivation — see docblock.
    costUsd: asCost(fields.cost_usd),
  };
}

/**
 * Extract the normalized provider diagnostics from a terminal lifecycle payload.
 * Total function: all-null when the envelope carries none.
 */
export function readDispatchProviderDiagnostics(
  payload: unknown,
): DispatchProviderDiagnostics {
  const fields = asFields(payload);
  return {
    providerRequestId: asNonEmptyString(fields.provider_request_id),
    providerErrorKind: asNonEmptyString(fields.provider_error_kind),
    retryAfterMs: asTokenCount(fields.retry_after_ms),
  };
}

/**
 * The substrates a dispatch may DECLARE on its lifecycle envelope. Mirrors the
 * `HarnessId` closed enum (`common/substrates/types.ts`) — kept as a local
 * allow-list so the projection stays import-free of the substrate layer and, more
 * importantly, so a malformed/hostile publisher cannot write an arbitrary string
 * into `sessions.substrate` (which the ledger and session-tree read models group
 * by). An unrecognised value reads as null ⇒ the column default stands.
 */
const KNOWN_SUBSTRATES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "pi-dev",
  "cursor",
  "custom",
  "api-agent",
]);

/**
 * Read the substrate a dispatch DECLARED on its lifecycle payload.
 *
 * Null ⇒ the envelope declared none (every claude-code dispatch today), in which
 * case the caller must leave `sessions.substrate` to its column default rather
 * than guess. NEVER inferred from the presence of usage or provider diagnostics:
 * a cortex-side api-agent failure (timeout / unsupported capability / missing
 * profile) carries neither, so that inference would mislabel it.
 */
export function readDispatchSubstrate(payload: unknown): string | null {
  const value = asNonEmptyString(asFields(payload).substrate);
  if (value === null) return null;
  return KNOWN_SUBSTRATES.has(value) ? value : null;
}

/** True when the extraction found at least one reported usage figure. */
export function hasReportedUsage(usage: DispatchUsage): boolean {
  return (
    usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.cacheReadTokens !== null ||
    usage.costUsd !== null
  );
}
