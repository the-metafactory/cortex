import type { Database } from "bun:sqlite";
import type { StreamInfo } from "nats";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { getVigilSubject, writeVigilSubject, type VigilSubjectRow } from "./db";
import { stateSubjectKey, vocabularyOf } from "./state-subject";
import { runHealthKey } from "./ingest";

function legacySubjects(db: Database): VigilSubjectRow[] {
  return db.query<VigilSubjectRow, []>(`SELECT * FROM vigil_subjects WHERE subject_key =
    CASE subject_kind WHEN 'run' THEN 'run:' || run_kind || ':' || ref
    ELSE 'state:' || vocab || ':' || ref END`).all();
}

export function hasLegacyVigilSubjects(db: Database): boolean {
  return legacySubjects(db).length > 0;
}

export function reconnectReplayedEvents(db: Database, payload: ExecutionRunFinishedPayload, stack: string): void {
  const keys: [string, string][] = [[`run:${payload.ran.kind}:${payload.ran.ref}`, runHealthKey(payload, stack)]];
  if (payload.state) {
    const vocab = vocabularyOf(payload.state.value);
    keys.push([`state:${vocab}:${payload.state.subject}`, stateSubjectKey(vocab, stack, payload.state.subject)]);
  }
  for (const [oldKey, newKey] of keys) {
    db.query("UPDATE vigil_events SET subject_key = ?, attention_id = CASE WHEN attention_id IS NULL THEN NULL ELSE ? END WHERE subject_key = ? AND run_id = ?")
      .run(newKey, `att:vigil:${newKey}`, oldKey, payload.run_id);
  }
}

/**
 * How much observation history LEDGER still holds when a replay starts:
 * `retainedSince` is the earliest retained observation time (`Infinity` when
 * the stream is empty); `empty` means the stream held no messages because it
 * aged out entirely, or was wiped or recreated.
 */
export interface LedgerRetention {
  retainedSince: number;
  empty: boolean;
}

/**
 * Reads LEDGER retention from its stream info. An empty stream retains
 * nothing, so every legacy subject's history counts as aged out.
 */
export function ledgerRetention(info: StreamInfo): LedgerRetention {
  const empty = info.state.messages === 0;
  return { empty, retainedSince: empty ? Number.POSITIVE_INFINITY : Date.parse(info.state.first_ts) };
}

/** The warning a replay logs once when it carried legacy subjects over from an empty LEDGER. */
export function emptyLedgerWarning(carriedOver: number): string {
  return `vigil: LEDGER is empty (aged out, wiped or recreated); ${carriedOver} legacy subject(s) kept under the stack of their last observation — history of a reference seen from several stacks is merged into that stack`;
}

function isLocalChannelCheck(row: VigilSubjectRow): boolean {
  return row.producer === "vigil" && row.vocab === "check" && /^vigil:(dm|email)-channel$/.test(row.ref);
}

/**
 * Re-keys legacy subjects after a replay. A subject the replay did not rebuild
 * and whose last observation predates `retainedSince` keeps its row under its
 * recorded stack; returns those keys. A subject missing inside the retained
 * window throws, leaving the migration pending.
 */
export function finishStackScopedReplay(db: Database, retainedSince: number): string[] {
  const carriedOver: string[] = [];
  for (const row of legacySubjects(db)) {
    if (row.subject_kind === "state" && row.vocab === null) throw new Error("Vigil state subject requires a vocabulary");
    if (row.subject_kind === "run" && row.run_kind === null) throw new Error("Vigil run subject requires a kind");
    const scopedKey = row.subject_kind === "run"
      ? runHealthKey({ ran: { kind: row.run_kind ?? "unknown", ref: row.ref } }, row.stack)
      : stateSubjectKey(row.vocab ?? "unknown", row.stack, row.ref);
    const historyAgedOut = row.last_ended_at < retainedSince && getVigilSubject(db, scopedKey) === null;
    if (isLocalChannelCheck(row) || historyAgedOut) {
      writeVigilSubject(db, { ...row, subject_key: scopedKey }, row.updated_at);
      db.query("UPDATE vigil_events SET subject_key = ?, attention_id = CASE WHEN attention_id IS NULL THEN NULL ELSE ? END WHERE subject_key = ?")
        .run(scopedKey, `att:vigil:${scopedKey}`, row.subject_key);
      if (historyAgedOut) carriedOver.push(scopedKey);
    }
    const rebuilt = getVigilSubject(db, scopedKey);
    if (!rebuilt || rebuilt.last_ended_at < row.last_ended_at
      || (rebuilt.last_ended_at === row.last_ended_at && rebuilt.last_run_id < row.last_run_id)) {
      throw new Error("Vigil stack replay requires complete LEDGER history");
    }
    const oldId = `att:vigil:${row.subject_key}`;
    const latest = db.query<{ subject_key: string }, [string, string]>(`SELECT subject_key FROM vigil_events
      WHERE attention_id IS NOT NULL AND (subject_key = ? OR attention_id = ?)
      ORDER BY occurred_at DESC, rowid DESC LIMIT 1`).get(scopedKey, oldId);
    const attentionKey = latest?.subject_key ?? scopedKey;
    db.query("UPDATE OR IGNORE attention_items SET id = ? WHERE id = ?").run(`att:vigil:${attentionKey}`, oldId);
    db.query("DELETE FROM attention_items WHERE id = ?").run(oldId);
    db.query(`UPDATE vigil_text_receipts SET subject_key =
      (SELECT subject_key FROM vigil_events WHERE vigil_events.id = vigil_text_receipts.event_id)
      WHERE subject_key = ? AND EXISTS (SELECT 1 FROM vigil_events WHERE vigil_events.id = vigil_text_receipts.event_id)`)
      .run(row.subject_key);
    db.query("DELETE FROM vigil_result_subjects WHERE subject_key = ?").run(row.subject_key);
    db.query("DELETE FROM vigil_subjects WHERE subject_key = ?").run(row.subject_key);
  }
  return carriedOver;
}
