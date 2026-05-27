/**
 * MIG-7 — Shared envelope skeleton helper.
 *
 * Three event domains now construct G-1100.B envelopes from the same
 * `id / source / type / timestamp / correlation_id / sovereignty / payload`
 * skeleton:
 *
 *   - `bus/system-events.ts`     — `system.*`     (principal-only system signals)
 *   - `bus/dispatch-events.ts`   — `dispatch.task.*` (task lifecycle)
 *   - `taps/cc-events/cc-events.ts` — `cc.*` (relay-lifted CC hooks)
 *
 * Rule of three is satisfied: each domain re-implements the same envelope
 * skeleton, just with different default sovereignty + payload extras. Lift
 * the common skeleton here so an envelope-shape change (e.g. a new schema
 * field) lives in one place rather than three. The defaults stay in their
 * respective domain files because each domain has slightly different
 * sovereignty postures and source-default conventions; this helper takes
 * the already-resolved sovereignty and source as inputs.
 *
 * Per the deferred TODO in `dispatch-events.ts`: this is the right time to
 * extract — earlier extraction would have orphaned a one-call-site
 * abstraction, but with three domains in play the duplication cost has
 * crossed the maintenance break-even.
 *
 * **What this file is NOT:**
 *   - NOT a sovereignty defaulter — each domain owns its own posture.
 *   - NOT a source-string builder — domains have different segment defaults
 *     (e.g. `cc-events` defaults agent="cortex" instance="relay"; `system-events`
 *     requires all three explicitly). This helper takes the already-built
 *     dotted source string.
 *   - NOT a validator — call `validateEnvelope` from the schema validator if
 *     you need pre-publish validation; this builder produces a literal that
 *     conforms to the type but doesn't run the JSON Schema.
 *   - NOT a generator of `id`/`timestamp` defaults outside its scope — both
 *     are produced fresh per call (UUID + new Date.toISOString()) so
 *     downstream consumers can't share envelope identity by mistake.
 */

import type { Envelope } from "./myelin/envelope-validator";

export interface BaseEnvelopeOpts {
  /** Envelope `type` — `domain.entity.action` per G-1100.B. */
  type: string;
  /** Pre-built source string — `{principal}.{assistant}.{instance}` (exactly 3 dotted segments, per myelin#185). */
  source: string;
  /** Payload — domain-specific contents. */
  payload: Record<string, unknown>;
  /**
   * Optional UUID-shaped `correlation_id`. Set on the envelope only when
   * provided; omitted entirely otherwise (the schema makes it optional).
   * Callers MUST pass UUID-shaped values here — the schema rejects
   * non-UUID `correlation_id`. For non-UUID workflow keys (e.g. the
   * `adapter:{id}:{iso}` convention from system-events), keep them in
   * the payload instead.
   */
  correlationId?: string;
  /**
   * Pre-built sovereignty object. Domain helpers compute defaults using
   * their own posture (typically local-only / NZ / max_hop=0), then pass
   * the result here. This helper does NOT default-fill sovereignty — that
   * decision lives in the domain layer.
   */
  sovereignty: Envelope["sovereignty"];
}

/**
 * Build a fresh envelope literal from the common skeleton.
 *
 * Each call produces:
 *   - a fresh `crypto.randomUUID()` for `id` (envelope idempotency key)
 *   - a fresh `new Date().toISOString()` for `timestamp`
 *
 * This means callers MUST NOT cache a returned envelope and re-emit it as a
 * different signal — the `id` and `timestamp` are baked in at construction
 * time. To produce a sibling envelope, call `buildBaseEnvelope` again with
 * fresh inputs.
 *
 * `correlation_id` is set on the envelope only when `opts.correlationId` is
 * truthy; this matches the existing per-domain behaviour where the field
 * is omitted (not `undefined`) when no correlation is intended.
 */
export function buildBaseEnvelope(opts: BaseEnvelopeOpts): Envelope {
  const envelope: Envelope = {
    id: crypto.randomUUID(),
    source: opts.source,
    type: opts.type,
    timestamp: new Date().toISOString(),
    sovereignty: opts.sovereignty,
    payload: opts.payload,
  };
  if (opts.correlationId) {
    envelope.correlation_id = opts.correlationId;
  }
  return envelope;
}
