import type { Database } from "bun:sqlite";
import type { StreamInfo } from "nats";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { confirmSubjectStack, unverifiedVigilSubjects, getVigilSubject, writeVigilSubject, type VigilSubjectRow } from "./db";
import { stateSubjectKey, vocabularyOf } from "./state-subject";
import { runHealthKey } from "./ingest";
import { applyVigilAttention } from "./attention";
import { getAttentionItem } from "../surface/mc/db/attention";

export function hasLegacyVigilSubjects(db: Database): boolean {
  return unverifiedVigilSubjects(db).length > 0 || db.query("SELECT 1 FROM vigil_subject_stack_moves LIMIT 1").get() !== null;
}

export function reconnectReplayedEvents(db: Database, payload: ExecutionRunFinishedPayload, stack: string): void {
  for (const row of unverifiedVigilSubjects(db)) {
    const matches = row.subject_kind === "run"
      ? row.run_kind === payload.ran.kind && row.ref === payload.ran.ref
      : payload.state && row.vocab === vocabularyOf(payload.state.value) && row.ref === payload.state.subject;
    if (!matches) continue;
    const newKey = row.subject_kind === "run" ? runHealthKey(payload, stack)
      : stateSubjectKey(row.vocab ?? "unknown", stack, row.ref);
    db.query("UPDATE vigil_events SET subject_key = ?, attention_id = CASE WHEN attention_id IS NULL THEN NULL ELSE ? END WHERE subject_key = ? AND run_id = ?")
      .run(newKey, `att:vigil:${newKey}`, row.subject_key, payload.run_id);
    if (row.last_run_id === payload.run_id) {
      db.query(`INSERT OR REPLACE INTO vigil_subject_stack_moves (old_key, new_key, expected_run_id, expected_ended_at)
        VALUES (?, ?, ?, ?)`).run(row.subject_key, newKey, row.last_run_id, row.last_ended_at);
    }
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
  return `vigil: LEDGER is empty (aged out, wiped or recreated); ${carriedOver} legacy subject(s) kept under the local stack — history of a reference seen from several stacks is merged into the local stack`;
}

function isLocalChannelCheck(row: VigilSubjectRow): boolean {
  return row.producer === "vigil" && row.vocab === "check" && /^vigil:(dm|email)-channel$/.test(row.ref);
}

export function finishStackScopedReplay(db: Database, retainedSince: number, localStack = "default"): string[] {
  const carriedOver: string[] = [];
  for (const row of unverifiedVigilSubjects(db)) {
    if (row.subject_kind === "state" && row.vocab === null) throw new Error("Vigil state subject requires a vocabulary");
    if (row.subject_kind === "run" && row.run_kind === null) throw new Error("Vigil run subject requires a kind");
    const mapped = db.query<{ new_key: string }, [string]>("SELECT new_key FROM vigil_subject_stack_moves WHERE old_key = ?").get(row.subject_key);
    const scopedKey = mapped?.new_key ?? (row.subject_kind === "run"
      ? runHealthKey({ ran: { kind: row.run_kind ?? "unknown", ref: row.ref } }, localStack)
      : stateSubjectKey(row.vocab ?? "unknown", localStack, row.ref));
    const historyAgedOut = !mapped && row.last_ended_at < retainedSince;
    if (isLocalChannelCheck(row) || historyAgedOut) {
      const prior = getVigilSubject(db, scopedKey);
      if (!prior || prior.last_ended_at < row.last_ended_at
        || (prior.last_ended_at === row.last_ended_at && prior.last_run_id < row.last_run_id)) {
        writeVigilSubject(db, { ...row, stack: localStack, subject_key: scopedKey }, row.updated_at);
        db.query("UPDATE vigil_subjects SET cadence_ms = ? WHERE subject_key = ?").run(row.cadence_ms, scopedKey);
      }
      confirmSubjectStack(db, scopedKey);
      if (historyAgedOut) carriedOver.push(scopedKey);
    } else if (!mapped) {
      throw new Error("Vigil stack replay requires complete LEDGER history");
    }
    const rebuilt = getVigilSubject(db, scopedKey);
    if (!rebuilt || rebuilt.last_ended_at < row.last_ended_at
      || (rebuilt.last_ended_at === row.last_ended_at && rebuilt.last_run_id < row.last_run_id)) {
      throw new Error("Vigil stack replay requires complete LEDGER history");
    }
    const oldId = `att:vigil:${row.subject_key}`;
    db.query("UPDATE OR IGNORE attention_items SET id = ? WHERE id = ?").run(`att:vigil:${scopedKey}`, oldId);
    if (row.subject_key !== scopedKey) db.query("DELETE FROM attention_items WHERE id = ?").run(oldId);
    if (getAttentionItem(db, `att:vigil:${scopedKey}`)?.status === "open") {
      applyVigilAttention(db, { id: "", subject_key: scopedKey, to_value: rebuilt.value,
        direction: rebuilt.healthy ? "better" : "worse" }, localStack, { replay: true });
    }
    db.query("UPDATE vigil_events SET subject_key = ?, attention_id = CASE WHEN attention_id IS NULL THEN NULL ELSE ? END WHERE subject_key = ?")
      .run(scopedKey, `att:vigil:${scopedKey}`, row.subject_key);
    db.query(`UPDATE vigil_text_receipts SET subject_key =
      (SELECT subject_key FROM vigil_events WHERE vigil_events.id = vigil_text_receipts.event_id)
      WHERE subject_key = ? AND EXISTS (SELECT 1 FROM vigil_events WHERE vigil_events.id = vigil_text_receipts.event_id)`)
      .run(row.subject_key);
    if (row.subject_key !== scopedKey) {
      db.query("DELETE FROM vigil_result_subjects WHERE subject_key = ?").run(row.subject_key);
      db.query("DELETE FROM vigil_subjects WHERE subject_key = ?").run(row.subject_key);
    }
  }
  const incomplete = db.query(`SELECT 1 FROM vigil_subject_stack_moves AS move
    LEFT JOIN vigil_subjects AS subject ON subject.subject_key = move.new_key
    WHERE subject.subject_key IS NULL OR subject.last_ended_at < move.expected_ended_at
      OR (subject.last_ended_at = move.expected_ended_at AND subject.last_run_id < move.expected_run_id)
    LIMIT 1`).get();
  if (incomplete) throw new Error("Vigil stack replay requires complete LEDGER history");
  db.run(`UPDATE vigil_events SET delivery = 'digested', digested_at = unixepoch() * 1000
    WHERE to_value = 'stale' AND delivery IN ('pending', 'held')
    AND subject_key IN (SELECT new_key FROM vigil_subject_stack_moves)
    AND subject_key IN (SELECT subject_key FROM vigil_subjects WHERE value != 'stale')`);
  db.run("DELETE FROM vigil_subject_stack_moves");
  return carriedOver;
}
