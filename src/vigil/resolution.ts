// glossary-ignore: agent, instance
import type { Database } from "bun:sqlite";
import { createVigilAttentionResolved, validateVigilAttentionResolved, type VigilAttentionResolvedPayload } from "@the-metafactory/myelin";
import { buildBaseEnvelope } from "../bus/envelope-builder";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { defaultSystemSovereignty } from "../bus/system-events";
import { getAttentionItem, upsertAttentionItem } from "../surface/mc/db/attention";
import type { AttentionItem, AttentionResolution } from "../surface/mc/types";
import { getVigilSubject } from "./db";

export interface ResolutionLedger {
  principal: string;
  stack: string;
  publish: NonNullable<MyelinRuntime["publishOnSubject"]>;
}

interface ResolutionRow extends VigilAttentionResolvedPayload {
  attention_id: string;
  stack_id: string;
  id: string;
}

export function isVigilAttention(item: AttentionItem | null): item is AttentionItem {
  return item !== null && item.id.startsWith("att:vigil:")
    && ["state_change", "result", "proposal"].includes(item.kind);
}

function attentionIdentity(db: Database, item: AttentionItem): { key: string; ran_ref: string } {
  if (item.kind === "state_change") {
    const key = item.id.slice("att:vigil:".length);
    const subject = getVigilSubject(db, key);
    if (subject) return { key, ran_ref: subject.ref };
  } else {
    const table = item.kind === "result" ? "vigil_results" : "vigil_proposals";
    const column = item.kind === "result" ? "result_ref" : "proposal_ref";
    const row = db.query<{ key: string; ran_ref: string }, [string]>(
      `SELECT ${column} AS key, ran_ref FROM ${table} WHERE attention_id = ?`,
    ).get(item.id);
    if (row) return row;
  }
  throw new Error(`Vigil attention identity missing: ${item.id}`);
}

function resolutionPayload(row: VigilAttentionResolvedPayload): VigilAttentionResolvedPayload {
  return {
    key: row.key, kind: row.kind, resolution: row.resolution, ran_ref: row.ran_ref, resolved_at: row.resolved_at,
    ...(row.filed ? { filed: row.filed } : {}),
  };
}

export function resolveVigilAttention(
  db: Database, id: string, resolution: AttentionResolution,
  options: { now?: number; filed?: string; replay?: boolean } = {},
): boolean {
  return db.transaction(() => {
    const item = getAttentionItem(db, id);
    if (!isVigilAttention(item) || item.status !== "open") return false;
    const payload: VigilAttentionResolvedPayload = {
      ...attentionIdentity(db, item), kind: item.kind, resolution,
      resolved_at: new Date(options.now ?? Date.now()).toISOString(),
      ...(options.filed !== undefined ? { filed: options.filed } : {}),
    };
    createVigilAttentionResolved({ principal: "cortex", stack: item.stackId, source: `cortex.${item.stackId}.cortex`, sovereignty: {}, payload });
    db.query("UPDATE attention_items SET status = ?, resolution = ?, updated_at = unixepoch() WHERE id = ?")
      .run(resolution === "dismissed" ? "dismissed" : "resolved", resolution, id);
    if (!options.replay) {
      db.query(`INSERT INTO vigil_attention_resolutions
        (key, kind, resolution, attention_id, stack_id, id, ran_ref, resolved_at, filed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(payload.key, payload.kind, resolution, id, item.stackId, crypto.randomUUID(), payload.ran_ref,
          payload.resolved_at, payload.filed ?? null);
    }
    return true;
  })();
}

const publications = new WeakMap<Database, Promise<void>>();

export async function flushVigilResolutions(db: Database, ledger: ResolutionLedger): Promise<void> {
  const previous = publications.get(db) ?? Promise.resolve();
  const pending = previous.then(async () => {
    const rows = db.query<ResolutionRow, []>("SELECT * FROM vigil_attention_resolutions WHERE published = 0 ORDER BY rowid").all();
    for (const row of rows) {
      const sovereignty = defaultSystemSovereignty({ principal: ledger.principal, agent: "cortex", instance: "local" });
      const event = createVigilAttentionResolved({
        principal: ledger.principal, stack: row.stack_id, source: `${ledger.principal}.${row.stack_id}.cortex`,
        sovereignty, payload: resolutionPayload(row),
      });
      const envelope = buildBaseEnvelope({ ...event.input, sovereignty });
      envelope.id = row.id;
      envelope.timestamp = row.resolved_at;
      await ledger.publish(envelope, event.subject);
      db.query("UPDATE vigil_attention_resolutions SET published = 1 WHERE id = ?").run(row.id);
    }
  });
  const settled = pending.catch((error: unknown) => {
    process.stderr.write(`Vigil: attention resolution pending; retry on next tick: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  publications.set(db, settled);
  await settled;
}

export function replayVigilResolution(db: Database, envelope: Envelope): { kind: "skip"; reason: string } | undefined {
  const { id, source, type, timestamp, sovereignty, payload } = envelope;
  const validation = validateVigilAttentionResolved({ id, source, type, timestamp, sovereignty, payload });
  if (!validation.valid) return { kind: "skip", reason: "attention resolution payload" };
  const receipt = payload as unknown as VigilAttentionResolvedPayload;
  if (!["state_change", "result", "proposal"].includes(receipt.kind)) return { kind: "skip", reason: "attention resolution kind" };
  db.transaction(() => {
    const attentionId = `att:vigil:${receipt.kind === "state_change" ? "" : `${receipt.kind}:`}${receipt.key}`;
    const priorReceipt = db.query("SELECT 1 FROM vigil_attention_resolutions WHERE id = ? AND published = 1")
      .get(id);
    const item = getAttentionItem(db, attentionId);
    if (!priorReceipt || !item) {
      const terminal = { status: receipt.resolution === "dismissed" ? "dismissed" : "resolved", resolution: receipt.resolution } as const;
      if (item) db.query("UPDATE attention_items SET status = ?, resolution = ? WHERE id = ?").run(terminal.status, terminal.resolution, attentionId);
      else upsertAttentionItem(db, {
        id: attentionId, kind: receipt.kind as AttentionItem["kind"], stackId: source.split(".")[1] ?? "default",
        workItemId: null, sessionId: null, severity: receipt.kind === "state_change" ? "normal" : "low", ...terminal,
      });
    }
    db.query(`INSERT INTO vigil_attention_resolutions
      (key, kind, resolution, attention_id, stack_id, id, ran_ref, resolved_at, filed, published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET published = 1`)
      .run(receipt.key, receipt.kind, receipt.resolution, attentionId, source.split(".")[1] ?? "default",
        id, receipt.ran_ref, receipt.resolved_at, receipt.filed ?? null);
  })();
}
