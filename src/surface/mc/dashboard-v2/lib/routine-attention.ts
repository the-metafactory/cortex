import { RoutineEvidencePageSchema, type RoutineEvidenceRecord } from "../../desk/routine-evidence-contract";
import type { PendingRoutine } from "../../desk/routine-command";
import type { RoutineInventory } from "../../desk/routine-editor-contract";
import { appendEvidence } from "./routine-evidence";
import { getJson } from "./api";

export const attentionPageLimit = 100;
export const attentionMaxPages = 10;
export interface PeriodHistory { records: RoutineEvidenceRecord[]; coverage: "complete" | "partial"; reachedStart: boolean; oldest: string | null; checked: number }
export async function readPeriodHistory(start: string, end: string, signal: AbortSignal, read: (path: string, init?: RequestInit) => Promise<unknown> = getJson): Promise<PeriodHistory> {
  let records: RoutineEvidenceRecord[] = []; let cursor: string | null = null; const cursors = new Set<string>();
  let scope: string | null = null;
  for (let page = 0; page < attentionMaxPages; page++) {
    const query = new URLSearchParams({ limit: String(attentionPageLimit), ...(cursor ? { cursor } : {}) });
    const result = RoutineEvidencePageSchema.parse(await read(`/api/desk/routine-history?${query}`, { signal }));
    const pageScope = JSON.stringify([result.owner, result.principal, result.stack]);
    if (result.routineId !== null || (scope !== null && scope !== pageScope) || result.complete !== (result.nextCursor === null) || (!result.complete && !result.records.length) || result.records.length > attentionPageLimit) throw new Error("The owner returned inconsistent history. Refresh to restart.");
    scope = pageScope;
    records = appendEvidence(records, result.records);
    const oldest = records.at(-1)?.at ?? null;
    const reachedStart = oldest !== null && Date.parse(oldest) < Date.parse(start);
    if (result.complete || reachedStart) return { records: records.filter((record) => inPeriod(record.at, start, end)), coverage: "complete", reachedStart, oldest, checked: records.length };
    if (!result.nextCursor || cursors.has(result.nextCursor)) throw new Error("History repeated a cursor. Refresh to restart.");
    cursor = result.nextCursor; cursors.add(cursor);
  }
  return { records: records.filter((record) => inPeriod(record.at, start, end)), coverage: "partial", reachedStart: false, oldest: records.at(-1)?.at ?? null, checked: records.length };
}
const inPeriod = (at: string, start: string, end: string): boolean => Date.parse(at) >= Date.parse(start) && Date.parse(at) < Date.parse(end);

export type AttentionKind = "approval" | "failure" | "evidence" | "scheduling";
export interface AttentionGroup { key: string; kind: AttentionKind; routineId: string; name: string; reason: string; count: number; latest: string | null; approvals: PendingRoutine[]; records: RoutineEvidenceRecord[] }
export function exceptionReason(record: RoutineEvidenceRecord): { kind: AttentionKind; reason: string } | null {
  const execution = record.execution;
  if (execution.kind === "observed" && execution.state === "failed") return { kind: "failure", reason: "Recorded execution failure" };
  if (execution.kind === "observed" && execution.state === "running" && execution.freshness === "stale") return { kind: "evidence", reason: "Running observation is stale; current state unconfirmed" };
  if (execution.kind === "unavailable" && execution.evidence === "conflicting") return { kind: "evidence", reason: "Execution evidence conflicts" };
  if (execution.kind === "unavailable" && execution.evidence === "incomplete") return { kind: "evidence", reason: "Execution evidence incomplete" };
  return null;
}
const order: Record<AttentionKind, number> = { approval: 0, failure: 1, evidence: 2, scheduling: 3 };
export function attentionGroups(input: { pending: PendingRoutine[]; records: RoutineEvidenceRecord[]; inventory: RoutineInventory | null }): AttentionGroup[] {
  const names = new Map(input.inventory?.map((routine) => [routine.id, routine.name ?? routine.id]));
  const groups = new Map<string, AttentionGroup>();
  const add = (kind: AttentionKind, routineId: string, name: string, reason: string, at: string | null): AttentionGroup => {
    const key = JSON.stringify([kind, routineId, reason]);
    const group = groups.get(key) ?? { key, kind, routineId, name, reason, count: 0, latest: null, approvals: [], records: [] };
    group.count++;
    if (at !== null && (group.latest === null || Date.parse(at) > Date.parse(group.latest))) group.latest = at;
    groups.set(key, group); return group;
  };
  for (const pending of input.pending) add("approval", pending.blueprintId, names.get(pending.blueprintId) ?? pending.blueprintId, "Awaiting approval", pending.matchedAt).approvals.push(pending);
  for (const record of input.records) {
    const exception = exceptionReason(record);
    if (exception) add(exception.kind, record.routineId, names.get(record.routineId) ?? record.routineName, exception.reason, record.execution.kind === "observed" ? record.execution.startedAt : record.at).records.push(record);
  }
  for (const routine of input.inventory ?? []) if (!routine.runtimeConfirmed) add("scheduling", routine.id, routine.name ?? routine.id, "Scheduling state unconfirmed", null);
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || (Date.parse(b.latest ?? "") || 0) - (Date.parse(a.latest ?? "") || 0) || a.name.localeCompare(b.name));
}
