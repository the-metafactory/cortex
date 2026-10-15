import type { Database } from "bun:sqlite";
import type { ExecutionRunState } from "@the-metafactory/myelin";
import { getVigilSubject, isNewObservation, writeVigilSubject, writeVigilTransition, type VigilObservation } from "./db";

/**
 * The fixed state registry (soma#787 Amendment 2, Q41): three ordered
 * vocabularies, healthiest value first. The vocabulary a value belongs to
 * decides the subject's class. There is no config map and no producer
 * registration; the three value sets are disjoint.
 */
export const STATE_VOCABULARIES = {
  goal: ["on-track", "at-risk", "off-track"],
  escalation: ["resolved", "needs-principal", "overdue"],
  check: ["ok", "regressed"],
} as const satisfies Record<string, readonly string[]>;

export type KnownStateVocab = keyof typeof STATE_VOCABULARIES;
export type StateVocab = KnownStateVocab | "unknown";
export type StateDirection = "better" | "worse";

/**
 * Not a reported value: A7c's sweep writes it into an existing `state:goal:…`
 * row. It ranks worse than every value of the vocabulary.
 */
export const STALE_VALUE = "stale";

/** Rank of every `unknown` value: unhealthy, and no order between them. */
const UNKNOWN_RANK = 1;

export function vocabularyOf(value: string): StateVocab {
  for (const vocab of Object.keys(STATE_VOCABULARIES) as KnownStateVocab[]) {
    if ((STATE_VOCABULARIES[vocab] as readonly string[]).includes(value)) return vocab;
  }
  return "unknown";
}

/** Position in the vocabulary, healthiest = 0; `stale` (or any non-member) ranks last. */
export function stateRank(vocab: StateVocab, value: string): number {
  if (vocab === "unknown") return UNKNOWN_RANK;
  const values: readonly string[] = STATE_VOCABULARIES[vocab];
  const rank = values.indexOf(value);
  return rank === -1 ? values.length : rank;
}

/** Only rank 0 is healthy. */
export function stateHealthy(vocab: StateVocab, value: string): boolean {
  return stateRank(vocab, value) === 0;
}

/**
 * Direction of a change, or null when it is not an attention event: a
 * repeated value, or a first observation (`from` null) that is healthy.
 * In `unknown` every change between two different values is `worse`.
 */
export function stateDirection(vocab: StateVocab, from: string | null, to: string): StateDirection | null {
  if (from === to) return null;
  if (from === null) return stateHealthy(vocab, to) ? null : "worse";
  if (vocab === "unknown") return "worse";
  return stateRank(vocab, to) < stateRank(vocab, from) ? "better" : "worse";
}

export function stateSubjectKey(vocab: StateVocab, subject: string): string {
  return `state:${vocab}:${subject}`;
}

/** What every subject an envelope updates shares; see `ingestLedgerEnvelope`. */
export type LedgerObservation = Pick<VigilObservation, "goal_id" | "producer" | "stack" | "last_run_id" | "last_ended_at" | "last_seen_at">;

/**
 * Update `state:{vocab}:{subject}` inside the caller's transaction. A repeated
 * value refreshes the observation (staleness counts from it) but writes no event.
 * Replay rebuilds the row without emitting transitions.
 */
export function updateStateSubject(
  db: Database, state: ExecutionRunState, observation: LedgerObservation, now: number,
  opts: { replay?: boolean } = {},
): void {
  const vocab = vocabularyOf(state.value);
  const key = stateSubjectKey(vocab, state.subject);
  const prior = getVigilSubject(db, key);
  if (!isNewObservation(prior, observation.last_run_id, observation.last_ended_at)) return;
  writeVigilSubject(db, {
    ...observation,
    subject_key: key, subject_kind: "state", vocab, ref: state.subject, value: state.value,
    healthy: stateHealthy(vocab, state.value) ? 1 : 0, run_kind: null,
  }, now);
  const direction = stateDirection(vocab, prior?.value ?? null, state.value);
  if (direction && !opts.replay) {
    writeVigilTransition(db, {
      subject_key: key, from_value: prior?.value ?? null, to_value: state.value, direction,
      run_id: observation.last_run_id, occurred_at: observation.last_ended_at,
    }, now);
  }
}
