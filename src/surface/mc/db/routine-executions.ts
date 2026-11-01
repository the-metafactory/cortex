import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RoutineDecision, RoutineExecution, RoutineLogFile } from "../desk/routine-evidence-contract";

const eventSchema = z.object({
  envelope_id: z.uuid(), timestamp: z.iso.datetime({ offset: true }), payload: z.string().max(2000),
});
const payloadSchema = z.object({
  decision_id: z.uuid(), correlation_id: z.uuid(), outcome: z.enum(["started", "completed", "failed"]),
  process: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/), started_at: z.iso.datetime({ offset: true }),
});
export type ProcessAuditEvent = { id: string; at: string } & z.infer<typeof payloadSchema>;
export interface ProcessAuditRead { events: ProcessAuditEvent[]; complete: boolean }
const RAW_UNAVAILABLE = "This execution owner streams stdout and stderr to a shared daemon log. It has no safe per-execution output-file reader.";

export function readProcessAudit(db: Database, scope: { principal: string; stack: string }, decisions: RoutineDecision[]): ProcessAuditRead {
  const ids = decisions.filter((d) => d.decision === "fired" && d.correlationId).map((d) => d.decisionId);
  if (!ids.length) return { events: [], complete: true };
  const subject = `local.${scope.principal}.${scope.stack}.system.bus.process`;
  const rows = db.query(`SELECT envelope_id, timestamp, CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN json_object(
      'decision_id', substr(json_extract(payload, '$.decision_id'), 1, 100),
      'correlation_id', substr(json_extract(payload, '$.correlation_id'), 1, 100),
      'outcome', substr(json_extract(payload, '$.outcome'), 1, 100),
      'process', substr(json_extract(payload, '$.process'), 1, 101),
      'started_at', substr(json_extract(payload, '$.started_at'), 1, 100)
    ) ELSE NULL END AS payload FROM observability_events
    WHERE type = 'system.bus.process' AND origin_kind = 'local' AND json_valid(payload)
    AND json_extract(payload, '$.__cortexProcessSubject') = ?
    AND json_extract(payload, '$.decision_id') IN (${ids.map(() => "?").join(",")})
    ORDER BY timestamp ASC, envelope_id ASC LIMIT 2001`).all(subject, ...ids);
  const events: ProcessAuditEvent[] = [];
  let valid = true;
  for (const raw of rows.slice(0, 2000)) {
    const row = eventSchema.safeParse(raw);
    if (!row.success) { valid = false; continue; }
    let value: unknown;
    try { value = JSON.parse(row.data.payload); }
    catch { valid = false; continue; }
    const payload = payloadSchema.safeParse(value);
    if (!payload.success) { valid = false; continue; }
    if (!decisions.some((d) => d.decisionId === payload.data.decision_id && d.correlationId === payload.data.correlation_id)) continue;
    events.push({ ...payload.data, id: row.data.envelope_id, at: row.data.timestamp });
  }
  return { events, complete: valid && rows.length <= 2000 };
}

export function processExecution(decision: RoutineDecision, audit: ProcessAuditRead, now: number): RoutineExecution {
  if (decision.decision !== "fired") return { kind: "not-started", reason: "This is an approval or decision record, not an execution." };
  if (!decision.correlationId) return { kind: "unavailable", evidence: "unscoped", reason: "The routine owner did not record a dispatch correlation. No execution was guessed." };
  if (!audit.complete) return { kind: "unavailable", evidence: "incomplete", reason: "The bounded owner audit read is incomplete. No terminal outcome is inferred." };
  const events = audit.events.filter((e) => e.decision_id === decision.decisionId && e.correlation_id === decision.correlationId);
  if (!events.length) return { kind: "unavailable", evidence: "missing-or-delayed", reason: "Dispatched. Scoped execution evidence is missing, delayed or outside the audit retention window." };
  const identities = new Set(events.map((e) => `${e.process}/${e.started_at}`));
  const terminal = events.filter((e) => e.outcome !== "started");
  const outcomes = new Set(terminal.map((e) => e.outcome));
  const first = events[0];
  if (!first || identities.size !== 1 || outcomes.size > 1 || events.some((e) => Date.parse(e.at) < Date.parse(e.started_at))) return { kind: "unavailable", evidence: "conflicting", reason: "The owner recorded conflicting execution events for this dispatch. No outcome or duration is inferred." };
  const end = terminal.at(-1);
  const startedAt = first.started_at;
  const executionId = createHash("sha256").update(JSON.stringify([decision.decisionId, decision.correlationId, first.process, startedAt])).digest("hex");
  const files: RoutineLogFile[] = [
    { ref: "process-audit", filename: "process-audit.jsonl", type: "application/x-ndjson", availability: "available", reason: "Redacted structured process lifecycle events. This file does not contain action stdout or stderr." },
    ...(["stdout", "stderr"] as const).map((ref) => ({ ref, filename: `${ref}.log`, type: "text/plain", availability: "unavailable" as const, reason: RAW_UNAVAILABLE })),
  ];
  return {
    kind: "observed", owner: "cortex-process", executionId,
    state: end ? end.outcome === "completed" ? "succeeded" : "failed" : "running",
    freshness: !end && now - Date.parse(startedAt) > 20 * 60000 ? "stale" : "recorded", startedAt,
    endedAt: end?.at ?? null, durationMs: end ? Date.parse(end.at) - Date.parse(startedAt) : null, files,
  };
}

export function processAuditContent(decision: RoutineDecision, audit: ProcessAuditRead): string {
  return audit.events.filter((e) => e.decision_id === decision.decisionId && e.correlation_id === decision.correlationId).map((e) => JSON.stringify({
    eventId: e.id, recordedAt: e.at, decisionId: e.decision_id, dispatchId: e.correlation_id,
    process: e.process, outcome: e.outcome, startedAt: e.started_at, redacted: true,
  }) + "\n").join("");
}
