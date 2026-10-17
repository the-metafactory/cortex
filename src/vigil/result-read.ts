import type { Database } from "bun:sqlite";
import { createVigilAttentionResolved, validateVigilAttentionResolved } from "@the-metafactory/myelin";
import { buildBaseEnvelope } from "../bus/envelope-builder";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { defaultSystemSovereignty } from "../bus/system-events";
import { resolveAttentionItem } from "../surface/mc/db/attention";

export interface ResultReadLedger {
  principal: string;
  stack: string;
  publish: NonNullable<MyelinRuntime["publishOnSubject"]>;
}

interface ResultReadRow {
  result_ref: string;
  id: string;
  ran_ref: string;
  resolved_at: string;
}

const publications = new WeakMap<Database, Promise<void>>();

export async function readResult(db: Database, ref: string, ledger?: ResultReadLedger): Promise<void> {
  db.transaction(() => {
    const result = db.query<{ attention_id: string; ran_ref: string }, [string]>(
      `SELECT r.attention_id, r.ran_ref FROM vigil_results r JOIN attention_items a ON a.id = r.attention_id
       WHERE r.result_ref = ? AND a.kind = 'result' AND a.status = 'open'`,
    ).get(ref);
    if (!result || !resolveAttentionItem(db, result.attention_id)) return;
    db.query(`INSERT INTO vigil_result_reads (result_ref, id, ran_ref, resolved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(result_ref) DO NOTHING`).run(ref, crypto.randomUUID(), result.ran_ref, new Date().toISOString());
  }).immediate();
  if (!ledger) return;
  const previous = publications.get(db) ?? Promise.resolve();
  const pending = previous.then(async () => {
    const receipt = db.query<ResultReadRow, [string]>(
      "SELECT * FROM vigil_result_reads WHERE result_ref = ? AND published = 0",
    ).get(ref);
    if (!receipt) return;
    const sovereignty = defaultSystemSovereignty({ principal: ledger.principal, agent: "cortex", instance: "local" });
    const event = createVigilAttentionResolved({
      principal: ledger.principal, stack: ledger.stack, source: `${ledger.principal}.${ledger.stack}.cortex`, sovereignty,
      payload: { key: ref, kind: "result", resolution: "read", ran_ref: receipt.ran_ref, resolved_at: receipt.resolved_at },
    });
    const envelope = buildBaseEnvelope({ ...event.input, sovereignty });
    envelope.id = receipt.id;
    envelope.timestamp = receipt.resolved_at;
    await ledger.publish(envelope, event.subject);
    db.query("UPDATE vigil_result_reads SET published = 1 WHERE result_ref = ?").run(ref);
  });
  const settled = pending.catch(() => {
    process.stderr.write("Vigil: result read receipt pending; retry on next open\n");
  });
  publications.set(db, settled);
  await settled;
}

export function replayResultRead(db: Database, envelope: Envelope): { kind: "skip"; reason: string } | undefined {
  const { id, source, type, timestamp, sovereignty, payload } = envelope;
  const validation = validateVigilAttentionResolved({ id, source, type, timestamp, sovereignty, payload });
  if (!validation.valid) return { kind: "skip", reason: "attention resolution payload" };
  if (payload.kind !== "result" || payload.resolution !== "read") return;
  db.transaction(() => {
    const ref = String(payload.key);
    const result = db.query<{ attention_id: string }, [string]>(
      "SELECT attention_id FROM vigil_results WHERE result_ref = ?",
    ).get(ref);
    if (result) resolveAttentionItem(db, result.attention_id);
    db.query(`INSERT INTO vigil_result_reads (result_ref, id, ran_ref, resolved_at, published)
      VALUES (?, ?, ?, ?, 1) ON CONFLICT(result_ref) DO UPDATE SET published = 1`)
      .run(ref, envelope.id, String(payload.ran_ref), String(payload.resolved_at));
  }).immediate();
}
