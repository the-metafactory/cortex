import type { Database } from "bun:sqlite";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import type { Envelope } from "../bus/myelin/envelope-validator";
import { getVigilSubject } from "./db";

/** Caller validates A5b first. Subject and transition are committed atomically. */
export function ingestLedgerEnvelope(db: Database, envelope: Envelope, now: number): void {
  const payload = envelope.payload as unknown as ExecutionRunFinishedPayload;
  const key = `run:${payload.ran.kind}:${payload.ran.ref}`;
  const endedAt = Date.parse(payload.ended_at);
  db.transaction(() => {
    const prior = getVigilSubject(db, key);
    if (prior && (endedAt < prior.last_ended_at || payload.run_id === prior.last_run_id)) return;
    const healthy = payload.outcome === "succeeded";
    const changed = prior ? prior.value !== payload.outcome : !healthy;
    db.query(`INSERT INTO vigil_subjects
      (subject_key, subject_kind, vocab, ref, value, healthy, goal_id, producer,
       run_kind, last_run_id, last_ended_at, last_seen_at, updated_at)
      VALUES (?, 'run', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET
        value = excluded.value, healthy = excluded.healthy, goal_id = excluded.goal_id,
        producer = excluded.producer, run_kind = excluded.run_kind,
        last_run_id = excluded.last_run_id, last_ended_at = excluded.last_ended_at,
        last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`).run(
      key, payload.ran.ref, payload.outcome, healthy ? 1 : 0,
      payload.serves?.goal ?? null, payload.producer, payload.ran.kind,
      payload.run_id, endedAt, now, now,
    );
    if (changed) {
      db.query(`INSERT INTO vigil_events
        (id, subject_key, event_kind, from_value, to_value, direction, run_id, occurred_at, created_at)
        VALUES (?, ?, 'transition', ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), key, prior?.value ?? null, payload.outcome,
        healthy ? "better" : "worse", payload.run_id, endedAt, now,
      );
    }
  }).immediate();
}
