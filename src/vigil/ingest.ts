// glossary-ignore: run
import type { Database } from "bun:sqlite";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import type { Envelope } from "../bus/myelin/envelope-validator";
import { getVigilSubject, isNewObservation, writeVigilSubject, writeVigilTransition } from "./db";
import { updateStateSubject, type LedgerObservation } from "./state-subject";

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
 * Caller validates A5b first. Every envelope updates its run-health subject,
 * and its state subject when `state` is present (soma#787 Q6). Each subject
 * dedupes on its own; all writes commit atomically.
 */
export function ingestLedgerEnvelope(db: Database, envelope: Envelope, now: number): void {
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  const observation: LedgerObservation = {
    goal_id: payload.serves?.goal ?? null, producer: payload.producer, stack: stackOfEnvelope(envelope),
    last_run_id: payload.run_id, last_ended_at: Date.parse(payload.ended_at), last_seen_at: now,
  };
  db.transaction(() => {
    updateRunHealthSubject(db, payload, observation, now);
    if (payload.state) updateStateSubject(db, payload.state, observation, now);
  }).immediate();
}

function updateRunHealthSubject(
  db: Database, payload: ExecutionRunFinishedPayload, observation: LedgerObservation, now: number,
): void {
  const key = runHealthKey(payload);
  const prior = getVigilSubject(db, key);
  if (!isNewObservation(prior, observation.last_run_id, observation.last_ended_at)) return;
  const healthy = payload.outcome === "succeeded";
  const changed = prior ? prior.value !== payload.outcome : !healthy;
  writeVigilSubject(db, {
    ...observation,
    subject_key: key, subject_kind: "run", vocab: null, ref: payload.ran.ref, value: payload.outcome,
    healthy: healthy ? 1 : 0, run_kind: payload.ran.kind,
  }, now);
  if (changed) {
    writeVigilTransition(db, {
      subject_key: key, from_value: prior?.value ?? null, to_value: payload.outcome,
      direction: healthy ? "better" : "worse",
      run_id: observation.last_run_id, occurred_at: observation.last_ended_at,
    }, now);
  }
}
