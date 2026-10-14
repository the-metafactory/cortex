// glossary-ignore: run
import type { Database } from "bun:sqlite";
import { validateExecutionRunFinished, type ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import type { Envelope } from "../bus/myelin/envelope-validator";
import { getVigilSubject } from "./db";

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
 * A5b ledger-field check, as `field: message` of the first error, or `null`
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

/**
 * Caller validates A5b first. Subject and transition are committed atomically.
 * `replay` (rebuild from LEDGER, node #2561) updates the subject row the same
 * way and writes no Vigil event.
 */
export function ingestLedgerEnvelope(db: Database, envelope: Envelope, now: number, opts: { replay?: boolean } = {}): void {
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  const key = runHealthKey(payload);
  const stack = stackOfEnvelope(envelope);
  const endedAt = Date.parse(payload.ended_at);
  db.transaction(() => {
    const prior = getVigilSubject(db, key);
    if (prior && (endedAt < prior.last_ended_at || payload.run_id === prior.last_run_id)) return;
    const healthy = payload.outcome === "succeeded";
    const changed = prior ? prior.value !== payload.outcome : !healthy;
    db.query(`INSERT INTO vigil_subjects
      (subject_key, subject_kind, vocab, ref, value, healthy, goal_id, producer, stack,
       run_kind, last_run_id, last_ended_at, last_seen_at, updated_at)
      VALUES (?, 'run', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET
        value = excluded.value, healthy = excluded.healthy, goal_id = excluded.goal_id,
        producer = excluded.producer, stack = excluded.stack, run_kind = excluded.run_kind,
        last_run_id = excluded.last_run_id, last_ended_at = excluded.last_ended_at,
        last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`).run(
      key, payload.ran.ref, payload.outcome, healthy ? 1 : 0,
      payload.serves?.goal ?? null, payload.producer, stack, payload.ran.kind,
      payload.run_id, endedAt, now, now,
    );
    if (changed && !opts.replay) {
      db.query(`INSERT INTO vigil_events
        (id, subject_key, event_kind, from_value, to_value, direction, run_id, occurred_at, created_at)
        VALUES (?, ?, 'transition', ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), key, prior?.value ?? null, payload.outcome,
        healthy ? "better" : "worse", payload.run_id, endedAt, now,
      );
    }
  }).immediate();
}
