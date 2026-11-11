import type { Database } from "bun:sqlite";
import type { CreateRequest } from "../../../conversations/types";
import type { WorkerState } from "../../../conversations/tools/worker-handoff";
import type { WorkerStateView } from "./worker-handoff-contract";

export const WORKER_HANDOFF_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_worker_operations (
    operation_id TEXT PRIMARY KEY,
    node TEXT,
    request TEXT NOT NULL,
    state TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS desk_worker_start_pending ON desk_worker_operations (node) WHERE state = 'starting'",
  `CREATE TABLE IF NOT EXISTS desk_worker_handoffs (
    node TEXT PRIMARY KEY,
    map TEXT NOT NULL,
    repository TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    entry_id TEXT,
    proposal_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    generation INTEGER,
    state TEXT NOT NULL,
    reason TEXT,
    pr TEXT,
    result TEXT,
    url TEXT,
    pr_url TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_worker_handoff_conversation ON desk_worker_handoffs (conversation_id, updated_at)",
];

export interface WorkerRecord {
  node: string;
  map: string;
  repository: string;
  conversationId: string;
  entryId: string | null;
  proposalId: string;
  operationId: string;
  generation: number | null;
  state: WorkerState;
  reason: string | null;
  pr: string | null;
  result: string | null;
  url: string | null;
  prUrl: string | null;
  startedAt: number;
  updatedAt: number;
}

interface RawRow {
  node: string;
  map: string;
  repository: string;
  conversation_id: string;
  entry_id: string | null;
  proposal_id: string;
  operation_id: string;
  generation: number | null;
  state: string;
  reason: string | null;
  pr: string | null;
  result: string | null;
  url: string | null;
  pr_url: string | null;
  started_at: number;
  updated_at: number;
}

const toRecord = (row: RawRow): WorkerRecord => ({
  node: row.node, map: row.map, repository: row.repository, conversationId: row.conversation_id, entryId: row.entry_id,
  proposalId: row.proposal_id, operationId: row.operation_id, generation: row.generation, state: row.state as WorkerState,
  reason: row.reason, pr: row.pr, result: row.result, url: row.url, prUrl: row.pr_url, startedAt: row.started_at, updatedAt: row.updated_at,
});

export function readWorkerRecord(db: Database, node: string): WorkerRecord | null {
  const row = db.query<RawRow, [string]>("SELECT * FROM desk_worker_handoffs WHERE node = ?").get(node);
  return row ? toRecord(row) : null;
}

export function recordWorkerRecord(db: Database, record: WorkerRecord): void {
  db.query(`INSERT INTO desk_worker_handoffs
    (node, map, repository, conversation_id, entry_id, proposal_id, operation_id, generation, state, reason, pr, result, url, pr_url, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node) DO UPDATE SET
      map = excluded.map, repository = excluded.repository, conversation_id = excluded.conversation_id, entry_id = excluded.entry_id,
      proposal_id = excluded.proposal_id, operation_id = excluded.operation_id,
      generation = COALESCE(excluded.generation, desk_worker_handoffs.generation),
      state = excluded.state, reason = excluded.reason, pr = COALESCE(excluded.pr, desk_worker_handoffs.pr),
      result = COALESCE(excluded.result, desk_worker_handoffs.result),
      url = COALESCE(excluded.url, desk_worker_handoffs.url), pr_url = COALESCE(excluded.pr_url, desk_worker_handoffs.pr_url),
      updated_at = excluded.updated_at`)
    .run(record.node, record.map, record.repository, record.conversationId, record.entryId, record.proposalId, record.operationId,
      record.generation, record.state, record.reason, record.pr, record.result, record.url, record.prUrl, record.startedAt, record.updatedAt);
}

export function recordWorkerState(db: Database, node: string, view: WorkerStateView, now: number): WorkerRecord | null {
  const found = readWorkerRecord(db, node);
  if (!found) return null;
  if (view.generation !== null && found.generation !== null && view.generation < found.generation) return found;
  const next: WorkerRecord = {
    ...found, generation: view.generation ?? found.generation, state: view.state, reason: view.reason,
    pr: view.pr ?? found.pr, result: view.result ?? found.result, url: view.url ?? found.url, prUrl: view.prUrl ?? found.prUrl, updatedAt: now,
  };
  recordWorkerRecord(db, next);
  return next;
}

export function handoffRowFor(db: Database, conversationId: string, node: string): WorkerRecord | null {
  const found = readWorkerRecord(db, node);
  return found?.conversationId === conversationId ? found : null;
}


export interface WorkerOperation {
  operationId: string;
  node: string | null;
  request: Pick<CreateRequest, "operationId" | "type" | "fields" | "provenance">;
  state: "filing" | "starting" | "stopping" | "complete" | "refused";
}

interface OperationRow { operation_id: string; node: string | null; request: string; state: WorkerOperation["state"] }
const operationOf = (row: OperationRow): WorkerOperation => ({ operationId: row.operation_id, node: row.node, request: JSON.parse(row.request) as WorkerOperation["request"], state: row.state });

export function readWorkerOperation(db: Database, operationId: string): WorkerOperation | null {
  const row = db.query<OperationRow, [string]>("SELECT * FROM desk_worker_operations WHERE operation_id = ?").get(operationId);
  return row ? operationOf(row) : null;
}

export function pendingWorkerStart(db: Database, node: string): WorkerOperation | null {
  const row = db.query<OperationRow, [string]>("SELECT * FROM desk_worker_operations WHERE node = ? AND state = 'starting'").get(node);
  return row ? operationOf(row) : null;
}

export function recordWorkerOperation(db: Database, request: CreateRequest, node: string | null, state: WorkerOperation["state"]): boolean {
  const saved = { operationId: request.operationId, type: request.type, fields: request.fields, provenance: request.provenance };
  return db.query("INSERT INTO desk_worker_operations (operation_id, node, request, state) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(request.operationId, node, JSON.stringify(saved), state).changes === 1;
}

export function settleWorkerOperation(db: Database, operationId: string, state: WorkerOperation["state"]): void {
  db.query("UPDATE desk_worker_operations SET state = ? WHERE operation_id = ?").run(state, operationId);
}
