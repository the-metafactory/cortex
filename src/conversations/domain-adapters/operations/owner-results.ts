import type { Attempt, OperationLookup, ApprovedSnapshot, DispatchRequest, Json, OwnerResult, Provenance } from "./types";
import type { OperationJournalStore, StoredOperation } from "./journal";
import type { BoundaryError, ObjectReference, SchemaRef } from "../types";
import type { CreateResult } from "../../types";
import { snapshotDigest } from "./validation";

export const boundaryReason = (code: string, message: string): BoundaryError => ({ code, message });

export interface OwnerResultParts {
  readonly operationId: string;
  readonly attemptId: string;
  readonly ownerRequestId: string;
  readonly snapshotDigest: string;
}

export const requestParts = (request: DispatchRequest): OwnerResultParts => ({ operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest });

export const resultsOf = (stored: StoredOperation) => stored.journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response] : []);
export const attemptsOf = (stored: StoredOperation) => stored.journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt] : []);

export type CreateOutcome = "created" | "refused" | "uncertain" | "accepted";

export function createOutcome(response: OwnerResult): CreateOutcome {
  if (response.result.kind === "succeeded") return "created";
  if (response.result.kind === "failed") return "refused";
  if (response.result.kind === "uncertain") return "uncertain";
  return "accepted";
}

export interface ApprovedSnapshotParts {
  readonly provenance: Provenance;
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilityId: string;
  readonly inputSchemaRef: SchemaRef;
  readonly outputSchemaRef: SchemaRef;
  readonly errorSchemaRef: SchemaRef;
  readonly input: unknown;
  readonly destinations: ObjectReference[];
  readonly policy: "local" | "cloud";
}

export function buildApprovedSnapshot(parts: ApprovedSnapshotParts): ApprovedSnapshot {
  const base = { ...parts, input: parts.input as Json, sources: [] };
  return { ...base, digest: snapshotDigest(base) };
}

export interface OwnerResultKit {
  readonly succeeded: (parts: OwnerResultParts, ref: ObjectReference, receipt: Json, at: string) => OwnerResult;
  readonly found: (parts: OwnerResultParts, ref: ObjectReference, receipt: Json, at: string) => OwnerResult;
  readonly refused: (request: DispatchRequest, message: string, at: string) => OwnerResult;
  readonly uncertain: (request: DispatchRequest, message: string, at: string, receipt?: Json) => OwnerResult;
  readonly accepted: (request: DispatchRequest, receipt: Json, at: string) => OwnerResult;
  readonly legacyResult: (stored: StoredOperation | null, noun: string) => CreateResult;
  readonly lookupReplies: (request: { operationId: string }, checkedAt: string) => { respond: (result: OperationLookup["result"]) => OperationLookup; unknown: (code: string, message: string) => OperationLookup };
  readonly approvedForLookup: (journal: OperationJournalStore, request: { operationId: string; ownerRequestId: string }, checkedAt: string, noun: string) => Promise<{ stored: StoredOperation; snapshotDigest: string; attempt: Attempt; replies: ReturnType<OwnerResultKit["lookupReplies"]> } | { reply: OperationLookup }>;
}

const replies: OwnerResultKit["lookupReplies"] = (request, checkedAt) => {
  const respond = (result: OperationLookup["result"]): OperationLookup => ({ lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt, result });
  return { respond, unknown: (code, message) => respond({ kind: "unknown", reason: boundaryReason(code, message) }) };
};

export function ownerResultKit(prefix: string): OwnerResultKit {
  const base = (parts: OwnerResultParts, at: string, stem = "create") => ({
    lifecycleVersion: "1.0.0" as const,
    operationId: parts.operationId,
    attemptId: parts.attemptId,
    snapshotDigest: parts.snapshotDigest,
    resultId: `${prefix}.${stem}:${parts.operationId}:${parts.attemptId}`,
    reportedAt: at,
  });
  const success = (stem: string) => (parts: OwnerResultParts, ref: ObjectReference, receipt: Json, at: string): OwnerResult => ({
    ...base(parts, at, stem),
    result: {
      kind: "succeeded",
      output: { ref },
      evidence: { kind: "effect", evidenceId: `${prefix}.effect:${parts.operationId}:${parts.attemptId}`, observedAt: at, ownerRequestId: parts.ownerRequestId, receipt, refs: [ref] },
    },
  });
  return {
    succeeded: success("create"),
    found: success("lookup"),
    refused: (request, message, at) => ({
      ...base(requestParts(request), at),
      result: {
        kind: "failed",
        error: boundaryReason(`${prefix}.refused`, message),
        evidence: { kind: "no-effect", evidenceId: `${prefix}.refused:${request.operationId}:${request.attemptId}`, observedAt: at, ownerRequestId: request.ownerRequestId, receipt: { refused: true, draftKept: true, message }, final: true },
      },
    }),
    uncertain: (request, message, at, receipt) => ({
      ...base(requestParts(request), at),
      result: { kind: "uncertain", error: boundaryReason(`${prefix}.uncertain`, message), ownerRequestId: request.ownerRequestId, ...(receipt === undefined ? {} : { receipt }) },
    }),
    accepted: (request, receipt, at) => ({ ...base(requestParts(request), at), result: { kind: "accepted", ownerRequestId: request.ownerRequestId, receipt } }),
    legacyResult: (stored, noun) => {
      if (!stored) return { state: "failed", error: `The ${noun} operation has no journal record. Nothing was created.` };
      const results = resultsOf(stored);
      const success = results.findLast(response => response.result.kind === "succeeded");
      if (success?.result.kind === "succeeded") {
        const ref = success.result.evidence.refs[0];
        if (ref) return { state: "created", canonicalId: ref.canonicalId };
        return { state: "failed", error: `The ${noun} owner reported success without a reference. Nothing was created.` };
      }
      const failure = results.findLast(response => response.result.kind === "failed");
      if (failure?.result.kind === "failed") return { state: "failed", error: failure.result.error.message };
      const local = stored.journal.events.findLast(entry => entry.event.kind === "local-outcome");
      if (local?.event.kind === "local-outcome") return { state: "failed", error: local.event.reason.message };
      const accepted = results.findLast(response => response.result.kind === "accepted");
      if (accepted?.result.kind === "accepted" && typeof accepted.result.receipt === "string") return { state: "accepted", receipt: accepted.result.receipt };
      return { state: "accepted" };
    },
    approvedForLookup: async (journal, request, checkedAt, noun) => {
      const { unknown } = replies(request, checkedAt);
      const stored = await journal.read(request.operationId);
      if (!stored || "kind" in stored.journal.snapshot) return { reply: unknown(`${prefix}.operation_unavailable`, `The ${noun} operation has no approved snapshot.`) };
      if (stored.journal.ownerRequestId !== request.ownerRequestId) return { reply: unknown(`${prefix}.request_mismatch`, `The ${noun} operation belongs to another request.`) };
      const attempt = attemptsOf(stored).at(-1);
      if (!attempt) return { reply: unknown(`${prefix}.attempt_missing`, `The ${noun} operation has no prepared attempt.`) };
      return { stored, snapshotDigest: stored.journal.snapshot.digest, attempt, replies: replies(request, checkedAt) };
    },
    lookupReplies: replies,
  };
}
