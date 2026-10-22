// glossary-ignore: run, subscriber, message
import type { Database } from "bun:sqlite";
import { validateExecutionRunFinished, type ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import type { Envelope } from "../bus/myelin/envelope-validator";
import { getVigilSubject, isNewObservation, writeVigilSubject, writeVigilTransition, type VigilEventRow } from "./db";
import type { AttentionDelta } from "../surface/mc/attention-notify";
import { ingestResult } from "./results";
import { ingestRefAttention, type VigilIngestOpts } from "./ref-attention";
import { applyVigilAttention, applyVigilTransitions } from "./attention";
import { stateDirection, stateSubjectKey, updateStateSubject, vocabularyOf, type LedgerObservation } from "./state-subject";
import { getAttentionItem } from "../surface/mc/db/attention";

/**
 * Ledger consumer timing (live and replay), set explicitly so the
 * review-consumer defaults (sized for a 20-minute review) never leak into
 * Vigil. Ingest is one SQLite transaction; a delivery still unacked after a
 * minute is redelivered.
 */
export const LEDGER_ACK_WAIT_NS = 60 * 1_000_000_000;
export const LEDGER_MAX_DELIVER = 5;

export function runHealthKey(payload: { ran: { kind: string; ref: string } }, stack: string): string {
  return `run:${payload.ran.kind}:${stack}:${payload.ran.ref}`;
}

/** `envelope.source` is `{principal}.{stack}.{instance}` (rfc-0003, 3..5 segments). */
export function stackOfEnvelope(envelope: Pick<Envelope, "source">): string {
  const segments = envelope.source.split(".");
  const stack = segments[1];
  if (!stack || segments.length < 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error("Invalid source: principal, stack and instance are required");
  }
  return stack;
}

/**
 * A5b ledger-field check, as `field: reason` of the first error, or `null`
 * when the envelope is a valid `execution.run.finished`. The wire subscriber
 * already checked the envelope; A5b's newer chain-only signature type differs
 * from our vendored type, so only the fields it reads are passed.
 */
export function ledgerEnvelopeError(envelope: Envelope): string | null {
  try {
    stackOfEnvelope(envelope);
  } catch {
    return "source: principal, stack and instance are required";
  }
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
export function ingestLedgerEnvelope(db: Database, envelope: Envelope, now: number, opts: Omit<VigilIngestOpts, "sourceStack"> = {}): AttentionDelta {
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  const observation: LedgerObservation = {
    goal_id: payload.serves?.goal ?? null, producer: payload.producer, stack: stackOfEnvelope(envelope),
    last_run_id: payload.run_id, last_ended_at: Date.parse(payload.ended_at), last_seen_at: now,
  };
  return db.transaction(() => {
    const replayKeys = opts.replay ? [runHealthKey(payload, observation.stack), ...(payload.state
      ? [stateSubjectKey(vocabularyOf(payload.state.value), observation.stack, payload.state.subject)] : [])] : [];
    const previous = replayKeys.map((key) => getVigilSubject(db, key));
    const events = [updateRunHealthSubject(db, payload, observation, now, opts)];
    if (payload.state) events.push(updateStateSubject(db, payload.state, observation, now, opts));
    ingestResult(db, payload, { ...opts, sourceStack: observation.stack });
    if (payload.outcome === "succeeded") {
      for (const ref of payload.proposal_refs ?? []) ingestRefAttention(db, "proposal", ref, payload, { ...opts, sourceStack: observation.stack });
    }
    for (const [index, key] of replayKeys.entries()) {
      if (!getAttentionItem(db, `att:vigil:${key}`)) continue;
      const subject = getVigilSubject(db, key);
      const prior = previous[index];
      if (subject?.last_run_id !== payload.run_id || !isNewObservation(prior ?? null, payload.run_id, observation.last_ended_at)) continue;
      const direction = subject.subject_kind === "state"
        ? stateDirection(vocabularyOf(subject.value), prior?.value ?? null, subject.value)
        : prior?.value === subject.value ? null : subject.healthy ? "better" : "worse";
      if (direction) applyVigilAttention(db, {
        id: "", subject_key: key, to_value: subject.value, direction,
      }, opts.localStackId ?? "default", { replay: true, now: observation.last_ended_at });
    }
    return applyVigilTransitions(db, events.filter((event) => event !== null), opts.localStackId ?? "default");
  }).immediate();
}

function updateRunHealthSubject(
  db: Database, payload: ExecutionRunFinishedPayload, observation: LedgerObservation, now: number,
  opts: { replay?: boolean },
): VigilEventRow | null {
  const key = runHealthKey(payload, observation.stack);
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
