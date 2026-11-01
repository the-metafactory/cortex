import { RoutineEvidencePageSchema, RoutineLogPageSchema, type RoutineEvidenceRecord, type RoutineLogFile, type RoutineLogPage } from "../../desk/routine-evidence-contract";
import { getJson } from "./api";

export const evidenceLimit = 4_000_000;
export function evidenceLabel(record: RoutineEvidenceRecord): string {
  const execution = record.execution;
  if (execution.kind === "observed") return execution.state === "succeeded" ? "Succeeded" : execution.state === "failed" ? "Failed" : execution.freshness === "stale" ? "Running observation is stale" : "Running";
  if (record.approval?.state === "denied" || record.decision === "denied") return "Denied · no execution";
  if (record.approval?.state === "expired" || record.decision === "expired") return "Approval expired · no execution";
  if (record.decision === "fired") return "Dispatched · completion unconfirmed";
  if (record.approval?.state === "approved") return "Approved · execution unconfirmed";
  if (record.approval?.state === "waiting") return "Awaiting approval · no execution";
  return `${record.decision === "blocked" ? "Blocked" : record.decision === "matched" ? "Matched" : "Ignored"} · no execution`;
}
export function evidenceOrigin(record: RoutineEvidenceRecord, records: RoutineEvidenceRecord[] = []): string {
  if (record.approval?.state === "approved") return "Explicitly approved";
  if (record.decision !== "fired") return "Scheduled decision";
  let current = record; const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    if (current.approval?.state === "approved") return "Explicitly approved";
    if (current.approval !== null || current.decision === "matched") break;
    if (current.resolutionOf === null) return "Automatic";
    if (seen.has(current.decisionId)) break;
    seen.add(current.decisionId);
    const parent = records.find((entry) => entry.decisionId === current.resolutionOf && entry.routineId === record.routineId);
    if (!parent) break;
    current = parent;
  }
  return "Approval origin unconfirmed in loaded evidence";
}
export const failedExecution = (record: RoutineEvidenceRecord): boolean => record.execution.kind === "observed" && record.execution.state === "failed";
export async function readEvidence(routineId: string | null, cursor: string | null, signal: AbortSignal, read: (path: string, init?: RequestInit) => Promise<unknown> = getJson) {
  const query = new URLSearchParams({ limit: "25" });
  if (routineId) query.set("routineId", routineId);
  if (cursor) query.set("cursor", cursor);
  const page = RoutineEvidencePageSchema.parse(await read(`/api/desk/routine-history?${query}`, { signal }));
  if (page.routineId !== routineId || page.complete !== (page.nextCursor === null) || (!page.complete && !page.records.length) || page.nextCursor === cursor && cursor !== null || page.records.some((record) => routineId !== null && record.routineId !== routineId)) throw new Error("The owner returned inconsistent history. Refresh to restart.");
  return page;
}
export function appendEvidence(previous: RoutineEvidenceRecord[], incoming: RoutineEvidenceRecord[]): RoutineEvidenceRecord[] {
  const seen = new Set(previous.map((record) => record.decisionId));
  let last = previous.at(-1);
  for (const record of incoming) {
    if (seen.has(record.decisionId) || last && (record.at > last.at || record.at === last.at && record.decisionId > last.decisionId)) throw new Error("History changed or repeated. Refresh to restart.");
    seen.add(record.decisionId); last = record;
  }
  return [...previous, ...incoming];
}
export function logQuery(record: RoutineEvidenceRecord, file: RoutineLogFile, offset = 0, revision?: string): URLSearchParams {
  if (record.execution.kind !== "observed" || file.availability !== "available") throw new Error(file.reason ?? "No authorized file is available.");
  return new URLSearchParams({ routineId: record.routineId, decisionId: record.decisionId, executionId: record.execution.executionId, file: file.ref, offset: String(offset), limit: "65536", ...(revision ? { revision } : {}) });
}
export function validateLogPage(page: RoutineLogPage, file: RoutineLogFile, offset: number, revision?: string, expectedTotal?: number): void {
  const bytes = new TextEncoder().encode(page.content).byteLength;
  const end = offset + bytes;
  if (page.file.ref !== file.ref || page.offset !== offset || revision && page.revision !== revision || page.totalBytes > evidenceLimit || expectedTotal !== undefined && page.totalBytes !== expectedTotal || bytes > 65536 || end > page.totalBytes || page.complete !== (page.nextOffset === null) || (page.complete ? end !== page.totalBytes : page.nextOffset !== end || end <= offset || end >= page.totalBytes)) throw new Error("The log page changed, repeated, exceeded limits or skipped bytes. Restart the file read.");
}
export async function readLog(record: RoutineEvidenceRecord, file: RoutineLogFile, signal: AbortSignal, offset = 0, revision?: string, expectedTotal?: number) {
  const page = RoutineLogPageSchema.parse(await getJson(`/api/desk/routine-log?${logQuery(record, file, offset, revision)}`, { signal }));
  validateLogPage(page, file, offset, revision, expectedTotal);
  return page;
}
export async function downloadLog(record: RoutineEvidenceRecord, file: RoutineLogFile, signal: AbortSignal, read: (path: string, init?: RequestInit) => Promise<Response> = fetch): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0; let revision: string | undefined; let total: number | undefined;
  for (let request = 0; request < 64; request++) {
    const query = logQuery(record, file, offset, revision); query.set("download", "1");
    const response = await read(`/api/desk/routine-log?${query}`, { signal });
    if (!response.ok) throw new Error(response.status === 409 ? "This file changed or is unavailable. Restart its read before downloading." : `The download owner returned HTTP ${response.status}.`);
    const current = response.headers.get("X-Audit-Revision");
    const size = Number(response.headers.get("X-Total-Bytes"));
    const next = response.headers.get("X-Next-Offset");
    if (!current || !/^[a-f0-9]{64}$/.exec(current) || revision && revision !== current || !Number.isSafeInteger(size) || size < 0 || size > evidenceLimit || total !== undefined && total !== size || next === null) throw new Error("The bounded download changed or is too large.");
    revision = current; total = size;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 65536 || offset + bytes.byteLength > size) throw new Error("The download exceeded its owner page limit.");
    parts.push(bytes);
    if (next === "") {
      if (response.status !== 200 || offset + bytes.byteLength !== size) throw new Error("The download is incomplete.");
      return new Blob(parts, { type: "text/plain;charset=utf-8" });
    }
    const following = Number(next);
    if (response.status !== 206 || !Number.isSafeInteger(following) || following !== offset + bytes.byteLength || following <= offset || following >= size) throw new Error("The download repeated or skipped bytes.");
    offset = following;
  }
  throw new Error("The download reached its bounded request limit.");
}
