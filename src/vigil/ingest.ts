// glossary-ignore: run, subscriber, message
import type { Database } from "bun:sqlite";
import { validateExecutionRunFinished, type ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import type { Envelope } from "../bus/myelin/envelope-validator";
import { getVigilSubject, isNewObservation, writeVigilSubject, writeVigilTransition, type VigilEventRow } from "./db";
import type { AttentionDelta } from "../surface/mc/attention-notify";
import { applyVigilTransitions } from "./attention";
import { updateStateSubject, type LedgerObservation } from "./state-subject";

/**
 * Ledger consumer timing (live and replay), set explicitly so the
 * review-consumer defaults (sized for a 20-minute review) never leak into
 * Vigil. Ingest is one SQLite transaction; a delivery still unacked after a
 * minute is redelivered.
 */
export const LEDGER_ACK_WAIT_NS = 60 * 1_000_000_000;
export const LEDGER_MAX_DELIVER = 5;

/**
 * Run-health subject key, `run:{kind}:{ref}` (soma#787 Amendment 1, Q30).
 * The key carries no stack: the contract identifies a run by what ran, not
 * where, and the ledger is one per principal. The stack of the latest
 * observation is kept in `vigil_subjects.stack` so a same-ref collision
 * across stacks is visible in the data. Keying by stack would change the
 * contract; that is settled on soma#781, not here.
 */
export function runHealthKey(payload: Pick<ExecutionRunFinishedPayload, "ran">): string {
  return `run:${payload.ran.kind}:${payload.ran.ref}`;
}

/** `envelope.source` is `{principal}.{stack}.{instance}` (rfc-0003, 3..5 segments). */
export function stackOfEnvelope(envelope: Pick<Envelope, "source">): string {
  return envelope.source.split(".")[1] ?? "";
}

/**
 * A5b ledger-field check, as `field: reason` of the first error, or `null`
 * when the envelope is a valid `execution.run.finished`. The wire subscriber
 * already checked the envelope; A5b's newer chain-only signature type differs
 * from our vendored type, so only the fields it reads are passed.
 */
export function ledgerEnvelopeError(envelope: Envelope): string | null {
  const { id, source, type, timestamp, sovereignty, payload, economics, correlation_id } = envelope;
  const validation = validateExecutionRunFinished({ id, source, type, timestamp, sovereignty, payload, economics, correlation_id });
  if (validation.valid) return null;
  const first = validation.errors[0];
  return `${first?.field}: ${first?.message}`;
}

// glossary-ignore: run
/**
 * Run-health is an Execution Run contract term, distinct from a Cortex Session.
 * Caller validates A5b first. Every envelope updates its run-health subject,
 * and its state subject when `state` is present (soma#787 Q6). Each subject
 * dedupes on its own; all writes commit atomically. `replay` (rebuild from
 * LEDGER, see `replay.ts`) updates both rows the same way and writes no Vigil event.
 */
export function ingestLedgerEnvelope(db: Database, envelope: Envelope, now: number, opts: { replay?: boolean; stackId?: string } = {}): AttentionDelta {
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  const observation: LedgerObservation = {
    goal_id: payload.serves?.goal ?? null, producer: payload.producer, stack: stackOfEnvelope(envelope),
    last_run_id: payload.run_id, last_ended_at: Date.parse(payload.ended_at), last_seen_at: now,
  };
  return db.transaction(() => {
    const events = [updateRunHealthSubject(db, payload, observation, now, opts)];
    if (payload.state) events.push(updateStateSubject(db, payload.state, observation, now, opts));
    return applyVigilTransitions(db, events.filter((event) => event !== null), opts.stackId ?? "default");
  }).immediate();
}

function updateRunHealthSubject(
  db: Database, payload: ExecutionRunFinishedPayload, observation: LedgerObservation, now: number,
  opts: { replay?: boolean },
): VigilEventRow | null {
  const key = runHealthKey(payload);
  const prior = getVigilSubject(db, key);
  if (!isNewObservation(prior, observation.last_run_id, observation.last_ended_at)) return null;
  const healthy = payload.outcome === "succeeded";
  const changed = prior ? prior.value !== payload.outcome : !healthy;
  // glossary-ignore: run
  writeVigilSubject(db, {
    ...observation,
    subject_key: key, subject_kind: "run", vocab: null, ref: payload.ran.ref, value: payload.outcome,
    healthy: healthy ? 1 : 0, run_kind: payload.ran.kind,
  }, now);
  if (changed && !opts.replay) {
    return writeVigilTransition(db, {
      subject_key: key, from_value: prior?.value ?? null, to_value: payload.outcome,
      direction: healthy ? "better" : "worse",
      run_id: observation.last_run_id, occurred_at: observation.last_ended_at,
    }, now);
  }
  return null;
}
