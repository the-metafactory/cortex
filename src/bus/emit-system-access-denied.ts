/**
 * cortex#932 (P-14 U0.2) — structured `system.access.denied` telemetry for the
 * consumer-side fail-closed DROP sites.
 *
 * Several gates in the bus refuse / drop an envelope SILENTLY (stderr-only, or
 * no signal at all). Each such drop is a governance-relevant decision that the
 * audit→enforce flip (#906) and the U3.1 governance pane need to SEE. This
 * helper turns a silent drop into a queryable `system.access.denied` audit
 * envelope, reusing the EXISTING builder + emit pattern.
 *
 * It is the drop-site sibling of {@link emitFederationDenied} (surface-router,
 * the D.2 router-gate variant): SAME wire shape (`type:
 * "system.access.denied"`, local audit subject derived from `source`), SAME
 * best-effort contract (no-op when `source` is undefined, runtime errors
 * surfaced to stderr and swallowed so a broken audit path can never poison the
 * gate's own fail-closed decision). Living in its own module keeps
 * `system-events.ts` a pure builder (runtime-free) and avoids editing the
 * cross-session `surface-router.ts` hotspot.
 *
 * @jcfischer owns the `system.access.*` shape — the four reason kinds emitted
 * through here (`sovereignty_model_class` / `chain_verify_failed` /
 * `chain_verify_fault` / `originator_denied`) ride the OPEN
 * {@link SystemAccessDeniedReason} record (its `kind` is `string`), so they add
 * NO wire break and need no schema bump.
 */

import type { Envelope } from "./myelin/envelope-validator";
import { getSignedByChain } from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import {
  createSystemAccessDeniedEvent,
  type SystemAccessDeniedReason,
  type SystemAccessSignedBy,
  type SystemAccessSovereignty,
  type SystemEventSource,
} from "./system-events";

/**
 * Per-call inputs that the builder can't infer from the dropped envelope. The
 * `signedBy` / `sovereignty` / `correlationId` / `envelopeSubject` /
 * `envelopeId` fields {@link createSystemAccessDeniedEvent} needs are derived
 * here from `envelope` + `envelopeSubject`, so callers only supply the gate's
 * own decision vocabulary.
 */
export interface SystemAccessDeniedEmit {
  /** Subject the dropped envelope arrived on — rides `envelope_subject`. */
  envelopeSubject: string;
  /**
   * Principal the gate was evaluating. Bare (no `did:mf:` prefix). Falls back
   * to the dropped envelope's source principal when the caller has nothing
   * more specific (e.g. a presence drop, where the source IS the actor).
   */
  principalId: string;
  /** Capability claim / intent the gate evaluated (free-form per gate). */
  capability: string;
  /** Structured reason — `kind` plus any variant fields (open record). */
  reason: SystemAccessDeniedReason;
}

/** First segment of `envelope.source` — the bare source principal. */
function sourcePrincipalOf(envelope: Envelope): string {
  return envelope.source.split(".")[0] ?? envelope.source;
}

/**
 * Emit a `system.access.denied` audit envelope for a fail-closed drop.
 *
 * No-op (log + return) when `source` is undefined — the test-only path, mirror
 * of {@link emitFederationDenied}. Production callers MUST pass a
 * `SystemEventSource`; emitting a half-formed envelope from an undefined source
 * is worse than not emitting.
 *
 * Best-effort: a `runtime.publish` rejection (a regression of the "publish
 * never throws" contract) is surfaced to stderr, never propagated — the gate's
 * own drop decision has already been made and must not be unwound by an audit
 * failure.
 */
export function emitSystemAccessDenied(
  runtime: MyelinRuntime,
  source: SystemEventSource | undefined,
  envelope: Envelope,
  emit: SystemAccessDeniedEmit,
): void {
  if (!source) {
    // Test-only path: a production caller wiring the gate passes
    // `systemEventSource`. Log so a missing wiring is visible, but never emit
    // a half-formed envelope. Same contract as `emitFederationDenied`.
    console.info(
      `emitSystemAccessDenied: drop subject="${emit.envelopeSubject}" reason=${emit.reason.kind} ` +
        `(no systemEventSource configured — system.access.denied envelope NOT emitted)`,
    );
    return;
  }

  // Carry `signed_by[]` verbatim (C.4.3) — a denied envelope stays
  // cryptographically attributable; the rejection is part of the audit trail.
  const signedBy: SystemAccessSignedBy[] = getSignedByChain(envelope).map(
    (stamp) => ({ ...stamp }),
  );
  const sovereignty: SystemAccessSovereignty = {
    classification: envelope.sovereignty.classification,
    data_residency: envelope.sovereignty.data_residency,
    max_hop: envelope.sovereignty.max_hop,
    frontier_ok: envelope.sovereignty.frontier_ok,
    model_class: envelope.sovereignty.model_class,
  };

  try {
    const env = createSystemAccessDeniedEvent({
      source,
      principalId: emit.principalId || sourcePrincipalOf(envelope),
      capability: emit.capability,
      reason: emit.reason,
      sovereignty,
      // Fall back to envelopeId for joinability when the dropped envelope had
      // no correlation_id — audit consumers always get a non-empty join key.
      correlationId: envelope.correlation_id ?? envelope.id,
      envelopeId: envelope.id,
      envelopeSubject: emit.envelopeSubject,
      signedBy,
    });
    // Defensive `.catch()` — same pattern as `emitFederationDenied`: a
    // regression of the runtime.publish "never throws" contract surfaces a
    // principal-visible signal instead of silently dropping the audit
    // envelope. Direct stderr — a broken runtime can't swallow alerts about
    // itself.
    runtime.publish(env).catch((publishErr: unknown) => {
      process.stderr.write(
        `[emit-system-access-denied] failed to emit system.access.denied audit envelope ` +
          `(reason=${emit.reason.kind}): ${publishErr instanceof Error ? publishErr.message : String(publishErr)}\n`,
      );
    });
  } catch (err) {
    // Defensive — buildBaseEnvelope shouldn't throw on schema-valid inputs,
    // but a future refactor making it synchronous-throwing must not poison the
    // gate that called us.
    console.error(
      `emitSystemAccessDenied: failed to build system.access.denied for subject="${emit.envelopeSubject}":`,
      err instanceof Error ? err.message : err,
    );
  }
}
