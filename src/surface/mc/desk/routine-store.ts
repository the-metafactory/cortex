import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { RoutineOptions } from "./routine-command";

export const RoutineProposalSchema = z.object({
  id: z.uuid(), routineId: z.string(), title: z.string(), request: z.string(),
  schedule: z.string(), words: z.string(), timezone: z.string(), yaml: z.string(),
  steps: z.array(z.string()), configHash: z.string(), createdAt: z.number(),
});
export type RoutineProposal = z.infer<typeof RoutineProposalSchema>;
export const routineConfigHash = (options: RoutineOptions): string => createHash("sha256").update(JSON.stringify(options)).digest("hex");

export function saveRoutineProposal(db: Database, proposal: RoutineProposal): void {
  db.query("INSERT INTO desk_routine_proposals (id, routine_id, document) VALUES (?, ?, ?)").run(proposal.id, proposal.routineId, JSON.stringify(proposal));
}

export function readRoutineProposal(db: Database, id: string, column: "id" | "routine_id" = "id"): RoutineProposal | null {
  const row = db.query<{ document: string }, [string]>(`SELECT document FROM desk_routine_proposals WHERE ${column} = ?`).get(id);
  return row ? RoutineProposalSchema.parse(JSON.parse(row.document)) : null;
}

export const RoutineActionSchema = z.object({
  requestId: z.string().regex(/^[\w-]{8,64}$/),
  action: z.enum(["install", "remove", "auto", "stop", "approve", "deny"]),
  target: z.string().min(1).max(128),
}).strict();
export type RoutineAction = z.infer<typeof RoutineActionSchema>;
export const RoutineResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), uncertain: z.literal(true).optional() }),
]);
export type RoutineResult = z.infer<typeof RoutineResultSchema>;
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
  const bindingSchema = RoutineActionSchema.omit({ requestId: true }).extend({ configHash: z.string() });
  return db.query<RoutineOperation, []>("SELECT request_id, binding, resource, result FROM desk_routine_operations WHERE result IS NULL").all().flatMap((row) => {
    const binding = bindingSchema.parse(JSON.parse(row.binding));
    return binding.configHash === routineConfigHash(options) ? [{ requestId: row.request_id, action: binding.action, target: binding.target }] : [];
  });
}

export function finishRoutineOperation(db: Database, requestId: string, result: RoutineResult): RoutineResult {
  db.query("UPDATE desk_routine_operations SET result = ? WHERE request_id = ?").run(JSON.stringify(result), requestId);
  return result;
}
