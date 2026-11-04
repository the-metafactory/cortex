import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { RoutineOptions } from "./routine-command";
import { BuiltNodeSchema, MissingCapabilitySchema, type BuiltNode } from "./routine-capability-contract";
import { RoutineActionSchema, RoutineResultSchema, type RoutineAction, type RoutineResult } from "./routine-action-contract";
export { LegacyRoutineActionSchema, RoutineActionSchema, RoutineResultSchema } from "./routine-action-contract";
export type { LegacyRoutineAction, RoutineAction, RoutineResult } from "./routine-action-contract";

export const RoutineDraftSchema = z.object({
  text: z.string(),
  missing: z.array(MissingCapabilitySchema).min(1),
  nodes: z.record(z.string(), BuiltNodeSchema).default({}),
});
export type RoutineDraft = z.infer<typeof RoutineDraftSchema>;

export const RoutineProposalSchema = z.object({
  id: z.uuid(), routineId: z.string(), title: z.string(), request: z.string(),
  schedule: z.string(), words: z.string(), timezone: z.string(), yaml: z.string(),
  steps: z.array(z.string()), configHash: z.string(), createdAt: z.number(),
  draft: RoutineDraftSchema.optional(),
});
export type RoutineProposal = z.infer<typeof RoutineProposalSchema>;
export const routineConfigHash = (options: RoutineOptions): string => createHash("sha256").update(JSON.stringify(options)).digest("hex");

export function saveRoutineProposal(db: Database, proposal: RoutineProposal): void {
  db.query("INSERT INTO desk_routine_proposals (id, routine_id, document) VALUES (?, ?, ?)").run(proposal.id, proposal.routineId, JSON.stringify(proposal));
}

export function recordDraftNode(db: Database, id: string, capability: string, node: BuiltNode): RoutineProposal | null {
  const proposal = readRoutineProposal(db, id);
  if (!proposal?.draft) return null;
  const next: RoutineProposal = { ...proposal, draft: { ...proposal.draft, nodes: { ...proposal.draft.nodes, [capability]: node } } };
  db.query("UPDATE desk_routine_proposals SET document = ? WHERE id = ?").run(JSON.stringify(next), id);
  return next;
}

const DRAFT_LIST_LIMIT = 10;
const DRAFT_SCAN_LIMIT = 200;

export function listRoutineDrafts(db: Database): RoutineProposal[] {
  const rows = db.query<{ document: string }, [number]>("SELECT document FROM desk_routine_proposals WHERE json_extract(document, '$.draft') IS NOT NULL ORDER BY rowid DESC LIMIT ?").all(DRAFT_SCAN_LIMIT);
  return rows.map((row) => RoutineProposalSchema.parse(JSON.parse(row.document))).slice(0, DRAFT_LIST_LIMIT);
}

export function discardRoutineDraft(db: Database, id: string): RoutineResult {
  const pending = db.query("SELECT 1 FROM desk_routine_operations WHERE resource = (SELECT routine_id FROM desk_routine_proposals WHERE id = ?) AND result IS NULL").get(id);
  if (pending) return { ok: false, error: "An install is awaiting confirmation. Check the pending change before discarding this draft." };
  const deleted = db.query("DELETE FROM desk_routine_proposals WHERE id = ? AND json_extract(document, '$.draft') IS NOT NULL").run(id);
  if (deleted.changes === 0 && readRoutineProposal(db, id)) return { ok: false, error: "This proposal is not a draft." };
  return { ok: true, message: "Routine draft discarded. Its capability build nodes are unchanged." };
}

export function readRoutineProposal(db: Database, id: string, column: "id" | "routine_id" = "id"): RoutineProposal | null {
  const row = db.query<{ document: string }, [string]>(`SELECT document FROM desk_routine_proposals WHERE ${column} = ?`).get(id);
  return row ? RoutineProposalSchema.parse(JSON.parse(row.document)) : null;
}

export function routineOperationBinding(options: RoutineOptions, request: RoutineAction): string {
  return JSON.stringify({ action: request.action, target: request.target, ...("revision" in request ? { revision: request.revision, ...("proposedRevision" in request ? { proposedRevision: request.proposedRevision } : {}), ...(request.action === "schedule" ? { schedule: request.schedule, timezone: request.timezone } : {}) } : {}), configHash: routineConfigHash(options) });
}
export function claimRoutineOperation(db: Database, requestId: string, binding: string, resource: string): boolean {
  return db.query("INSERT OR IGNORE INTO desk_routine_operations (request_id, binding, resource) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM desk_routine_operations WHERE resource = ? AND result IS NULL)").run(requestId, binding, resource, resource).changes > 0;
}
export interface RoutineOperation {
  request_id: string;
  binding: string;
  resource: string;
  result: string | null;
}

export function readRoutineOperation(db: Database, requestId: string): RoutineOperation | null {
  return db.query<RoutineOperation, [string]>("SELECT request_id, binding, resource, result FROM desk_routine_operations WHERE request_id = ?").get(requestId);
}

export function pendingRoutineOperations(db: Database, options: RoutineOptions): RoutineAction[] {
  const bindingSchema = z.looseObject({ configHash: z.string() });
  return db.query<RoutineOperation, []>("SELECT request_id, binding, resource, result FROM desk_routine_operations WHERE result IS NULL").all().flatMap((row) => {
    const { configHash, ...binding } = bindingSchema.parse(JSON.parse(row.binding));
    return configHash === routineConfigHash(options) ? [RoutineActionSchema.parse({ ...binding, requestId: row.request_id })] : [];
  });
}

export function finishRoutineOperation(db: Database, requestId: string, result: RoutineResult): RoutineResult {
  db.transaction(() => {
    db.query("UPDATE desk_routine_operations SET result = ? WHERE request_id = ?").run(JSON.stringify(result), requestId);
    if (result.ok) db.query("UPDATE desk_routine_proposals SET document = json_remove(document, '$.draft') WHERE routine_id = (SELECT resource FROM desk_routine_operations WHERE request_id = ? AND json_extract(binding, '$.action') = 'install')").run(requestId);
  })();
  return result;
}

export async function checkRoutineOperation(db: Database, requestId: string, binding: string, operation: RoutineOperation, reconcile: () => Promise<RoutineResult | null>, unknown: string): Promise<RoutineResult> {
  if (operation.binding !== binding) return { ok: false, error: "This request id belongs to a different routine action." };
  if (operation.result) return RoutineResultSchema.parse(JSON.parse(operation.result));
  try { const result = await reconcile(); return result ? finishRoutineOperation(db, requestId, result) : { ok: false, error: unknown, uncertain: true }; }
  catch { return { ok: false, error: unknown, uncertain: true }; }
}
