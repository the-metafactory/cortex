import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { reflexCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { RoutineDecisionPageSchema, RoutineHistoryQuerySchema, type RoutineHistoryQuery, type RoutineLogQuery } from "./routine-evidence-contract";
import { processAuditContent, processExecution, readProcessAudit } from "../db/routine-executions";

export class RoutineEvidenceRefusal extends Error {}
interface Scope { principal: string; stack: string }

async function decisionPage(options: RoutineOptions, query: RoutineHistoryQuery & { decisionId?: string }, scope: Scope, run?: RoutineRunner) {
  const page = await reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, [
    "routine", "history", "--principal", scope.principal, "--stack", scope.stack, "--limit", String(query.limit),
    ...(query.routineId ? ["--routine-id", query.routineId] : []), ...(query.decisionId ? ["--decision-id", query.decisionId] : []), ...(query.cursor ? ["--cursor", query.cursor] : []),
  ], RoutineDecisionPageSchema, run);
  if (page.principal !== scope.principal || page.stack !== scope.stack || page.routineId !== (query.routineId ?? null) || page.records.length > query.limit || page.complete !== (page.nextCursor === null) || (!page.complete && !page.records.length)) throw new Error("The routine owner returned an inconsistent history page.");
  const seen = new Set<string>();
  let previous: { at: string; id: string } | undefined;
  for (const record of page.records) {
    if (seen.has(record.decisionId) || (query.routineId && record.routineId !== query.routineId) || (query.decisionId && record.decisionId !== query.decisionId) || (record.decision !== "fired" && record.correlationId) || (previous && (record.at > previous.at || (record.at === previous.at && record.decisionId > previous.id)))) throw new Error("The routine owner returned an invalid history record.");
    seen.add(record.decisionId); previous = { at: record.at, id: record.decisionId };
  }
  return page;
}

export async function readRoutineEvidence(db: Database, options: RoutineOptions, input: RoutineHistoryQuery, scope: Scope, run?: RoutineRunner, now = Date.now()) {
  const query = RoutineHistoryQuerySchema.parse(input);
  const page = await decisionPage(options, query, scope, run);
  const audit = readProcessAudit(db, scope, page.records);
  return { ...page, executionOwner: "cortex-process" as const, records: page.records.map((record) => ({ ...record, execution: processExecution(record, audit, now) })) };
}

export async function readRoutineLog(db: Database, options: RoutineOptions, query: RoutineLogQuery, scope: Scope, run?: RoutineRunner) {
  const page = await decisionPage(options, { routineId: query.routineId, decisionId: query.decisionId, limit: 1 }, scope, run);
  const decision = page.records[0];
  if (!decision) throw new RoutineEvidenceRefusal("The recorded routine decision is no longer available.");
  const audit = readProcessAudit(db, scope, [decision]);
  const execution = processExecution(decision, audit, Date.now());
  if (execution.kind !== "observed" || execution.executionId !== query.executionId) throw new RoutineEvidenceRefusal("This execution reference is unavailable or does not belong to the selected routine.");
  const file = execution.files.find((entry) => entry.ref === query.file);
  if (file?.availability !== "available") throw new RoutineEvidenceRefusal(file?.reason ?? "This file reference is not authorized.");
  const bytes = Buffer.from(processAuditContent(decision, audit), "utf8");
  const revision = createHash("sha256").update(bytes).digest("hex");
  if (query.revision && query.revision !== revision) throw new RoutineEvidenceRefusal("The process audit changed. Restart the file read from offset zero.");
  if (query.offset > bytes.length) throw new RoutineEvidenceRefusal("The requested offset is outside the audit file.");
  const end = Math.min(bytes.length, query.offset + query.limit);
  return { file, revision, offset: query.offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length, complete: end === bytes.length, content: bytes.subarray(query.offset, end).toString("utf8") };
}
