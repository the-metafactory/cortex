import { randomUUID } from "node:crypto";
import type { HostContext, ObservedRead, WriterLease } from "../../authority";
import type { ReleaseSink } from "../../authority-records";
import type { CreateResult, OperationRecord } from "../../types";
import type { BoundaryError } from "../types";
import type { OperationBridge, SupportLookup, RedispatchOutcome } from "./dispatch";
import { JournalConflict, type OperationJournalStore, type StoredOperation } from "./journal";
import { boundedWaitMs, timeBoxed } from "./readback";
import { OperationLookupSchema, parseWire, type ApprovedSnapshot, type EffectEvidence, type NoEffectEvidence, type OperationLookup, type OperationState } from "./types";
import { fenceTargetOf, signalFence, type FenceSink } from "./triggers";

export const AUTOMATIC_LOOKUP_OFFSETS_MS = [0, 5_000, 30_000] as const;
export const MAX_AUTOMATIC_LOOKUPS = AUTOMATIC_LOOKUP_OFFSETS_MS.length;
const JOURNAL_RETRIES = 5;
export const RECOVERY_CONCURRENCY = 8;

export interface LookupAuthority {
  lookupObserved(context: HostContext, request: { lifecycleVersion: "1.0.0"; operationId: string; ownerRequestId: string }, sink: ReleaseSink, signal?: AbortSignal): Promise<ObservedRead>;
}
export interface OperationInventory { inFlight(): Promise<readonly string[]> }
export interface ReconcilerOptions {
  journal: OperationJournalStore;
  authority: LookupAuthority;
  bridge: Pick<OperationBridge, "recover" | "redispatch">;
  supportFor: SupportLookup;
  fences?: FenceSink;
  now?: () => Date;
  lookupWaitMs?: (snapshot: ApprovedSnapshot) => number;
}
export type LookupKind = OperationLookup["result"]["kind"];
export type ReconcileOutcome =
  | { kind: "settled"; operation: StoredOperation; lookup: LookupKind }
  | { kind: "still-uncertain"; operation: StoredOperation; lookup: LookupKind; nextAt: string | null }
  | { kind: "waiting"; operation: StoredOperation; dueAt: string }
  | { kind: "exhausted"; operation: StoredOperation; reason: BoundaryError }
  | { kind: "replayed"; outcome: RedispatchOutcome }
  | { kind: "contended"; operation: StoredOperation | null }
  | { kind: "not-applicable"; operation: StoredOperation | null; reason: BoundaryError };

const reason = (code: string, message: string): BoundaryError => ({ code, message });
const notApplicable = (operation: StoredOperation | null, code: string, message: string): ReconcileOutcome => ({ kind: "not-applicable", operation, reason: reason(code, message) });
const attempts = (stored: StoredOperation) => stored.journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt] : []);

export class OperationReconciler {
  private readonly now: () => Date;
  private readonly waitFor: (snapshot: ApprovedSnapshot) => number;

  constructor(private readonly options: ReconcilerOptions) {
    this.now = options.now ?? (() => new Date());
    this.waitFor = options.lookupWaitMs ?? (snapshot => boundedWaitMs(snapshot.capabilityId));
  }

  async recoverAll(context: HostContext, lease: WriterLease, sink: ReleaseSink, inventory: OperationInventory): Promise<Map<string, ReconcileOutcome>> {
    const results = new Map<string, ReconcileOutcome>();
    const queue = [...new Set(await inventory.inFlight())];
    const worker = async (): Promise<void> => {
      for (let operationId = queue.shift(); operationId !== undefined; operationId = queue.shift()) results.set(operationId, await this.advance(context, operationId, lease, sink));
    };
    await Promise.all(Array.from({ length: Math.min(RECOVERY_CONCURRENCY, queue.length) }, worker));
    return results;
  }

  private async load(operationId: string): Promise<{ stored: StoredOperation; snapshot: ApprovedSnapshot } | ReconcileOutcome> {
    let stored = await this.options.journal.read(operationId);
    if (!stored) return notApplicable(null, "operation_unknown", "The operation does not exist.");
    if (["dispatching", "pending"].includes(stored.journal.state)) stored = await this.options.bridge.recover(operationId) ?? stored;
    const snapshot = stored.journal.snapshot;
    if ("kind" in snapshot) return notApplicable(stored, "legacy_ambiguous", "A legacy operation has no approved snapshot; no owner call is made.");
    if (stored.journal.state !== "uncertain") return notApplicable(stored, "not_uncertain", "Only an uncertain operation is reconciled.");
    const support = this.options.supportFor(snapshot);
    if (support?.operationLookup !== "historical") return notApplicable(stored, "lookup_unsupported", "The owner declares no historical lookup; the outcome stays uncertain.");
    return { stored, snapshot };
  }

  private expiryOfInitialWait(stored: StoredOperation): number {
    const first = attempts(stored)[0];
    if (!first) throw new Error("Uncertain lifecycle operation has no prepared attempt.");
    const expired = stored.journal.events.find(entry => entry.event.kind === "wait-expired" && entry.event.attemptId === first.attemptId);
    return Date.parse(expired?.at ?? first.deadlineAt);
  }

  private nextAutomaticAt(stored: StoredOperation): string | null {
    const count = stored.budgets?.lookupCount ?? MAX_AUTOMATIC_LOOKUPS;
    const offset = AUTOMATIC_LOOKUP_OFFSETS_MS[count];
    return offset === undefined ? null : new Date(this.expiryOfInitialWait(stored) + offset).toISOString();
  }

  async advance(context: HostContext, operationId: string, lease: WriterLease, sink: ReleaseSink): Promise<ReconcileOutcome> {
    const loaded = await this.load(operationId);
    if (!("stored" in loaded)) return loaded;
    const { stored, snapshot } = loaded;
    const budget = stored.budgets;
    if (!budget) return notApplicable(stored, "no_budget", "The operation has no persisted reconciliation budget.");
    const now = this.now();
    if (budget.lookupCount >= MAX_AUTOMATIC_LOOKUPS) {
      const replay = await this.options.bridge.redispatch(context, operationId, lease);
      if (replay.kind === "not-eligible") return { kind: "exhausted", operation: replay.operation ?? stored, reason: replay.reason };
      return { kind: "replayed", outcome: replay };
    }
    if (now.getTime() < Date.parse(budget.lastObservedAt)) return { kind: "exhausted", operation: stored, reason: reason("clock_discontinuity", "The clock moved backwards; the outcome stays uncertain.") };
    if (now.getTime() >= Date.parse(budget.deadlineAt)) return { kind: "exhausted", operation: stored, reason: reason("work_budget_exhausted", "The 120 s reconciliation work budget is spent; use a manual Check.") };
    const dueAt = this.nextAutomaticAt(stored);
    if (dueAt && now.getTime() < Date.parse(dueAt)) return { kind: "waiting", operation: stored, dueAt };
    let reserved: StoredOperation;
    try { reserved = await this.options.journal.reserveLookup(operationId, stored.revision, now.toISOString()); }
    catch (error) {
      if (!(error instanceof JournalConflict)) throw error;
      return { kind: "contended", operation: await this.options.journal.read(operationId) };
    }
    const remaining = Date.parse(budget.deadlineAt) - now.getTime();
    return this.lookupOnce(context, reserved, snapshot, sink, Math.min(this.waitFor(snapshot), remaining));
  }

  async check(context: HostContext, operationId: string, sink: ReleaseSink): Promise<ReconcileOutcome> {
    const loaded = await this.load(operationId);
    if (!("stored" in loaded)) return loaded;
    return this.lookupOnce(context, loaded.stored, loaded.snapshot, sink, this.waitFor(loaded.snapshot));
  }

  private async lookupOnce(context: HostContext, stored: StoredOperation, snapshot: ApprovedSnapshot, sink: ReleaseSink, waitMs: number): Promise<ReconcileOutcome> {
    const operationId = stored.journal.operationId;
    const request = { lifecycleVersion: "1.0.0" as const, operationId, ownerRequestId: stored.journal.ownerRequestId };
    const lookup = await this.fetch(context, request, sink, waitMs);
    const recorded = await this.record(operationId, lookup);
    if (!recorded) return { kind: "contended", operation: await this.options.journal.read(operationId) };
    await this.observe(recorded, lookup, snapshot);
    if (recorded.journal.state !== "uncertain") return { kind: "settled", operation: recorded, lookup: lookup.result.kind };
    return { kind: "still-uncertain", operation: recorded, lookup: lookup.result.kind, nextAt: this.nextAutomaticAt(recorded) };
  }

  private async observe(stored: StoredOperation, lookup: OperationLookup, snapshot: ApprovedSnapshot): Promise<void> {
    const result = lookup.result;
    if (result.kind === "known" || result.kind === "no-effect") return;
    const target = fenceTargetOf(snapshot);
    if (result.kind === "unavailable" && result.reason.code !== "work_budget_exhausted") await signalFence(this.options.fences, { kind: "readback_failed", target, evidence: { operationId: stored.journal.operationId, detail: result.reason.message } });
    await signalFence(this.options.fences, { kind: "repeated_uncertain", target, evidence: { operationId: stored.journal.operationId, detail: `The owner lookup stayed ${result.kind}.` } });
  }

  private async fetch(context: HostContext, request: { lifecycleVersion: "1.0.0"; operationId: string; ownerRequestId: string }, sink: ReleaseSink, waitMs: number): Promise<OperationLookup> {
    const checkedAt = this.now().toISOString();
    const synthetic = (kind: "denied" | "unavailable", code: string, message: string): OperationLookup => ({ lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt, result: { kind, reason: reason(code, message) } });
    if (waitMs <= 0) return synthetic("unavailable", "work_budget_exhausted", "No reconciliation time remains for this lookup.");
    const waited = await timeBoxed(waitMs, signal => this.options.authority.lookupObserved(context, request, sink, signal));
    if (!waited.done) return synthetic("unavailable", "deadline_exceeded", "The owner did not answer the historical lookup within its bounded wait.");
    const observed = waited.value;
    if (!observed.called) return synthetic("denied", "authority_denied", "Current read authority did not permit the historical lookup.");
    if (observed.value === undefined) return synthetic("unavailable", "lookup_unavailable", "The owner lookup failed or did not validate.");
    try {
      const parsed = parseWire(OperationLookupSchema, observed.value);
      return parsed.operationId === request.operationId ? parsed : synthetic("unavailable", "invalid_output", "The owner answered for a different operation.");
    } catch { return synthetic("unavailable", "invalid_output", "The owner lookup failed lifecycle validation."); }
  }

  private async record(operationId: string, lookup: OperationLookup): Promise<StoredOperation | null> {
    for (let tries = 0; tries < JOURNAL_RETRIES; tries++) {
      const stored = await this.options.journal.read(operationId);
      if (!stored) return null;
      if (stored.journal.state !== "uncertain") return stored;
      try { return await this.options.journal.append(operationId, stored.revision, { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at: this.now().toISOString(), event: { kind: "reconciliation", lookup } }); }
      catch (error) { if (!(error instanceof JournalConflict)) throw error; }
    }
    return this.options.journal.read(operationId);
  }
}

export interface ReceiptStatus {
  state: OperationState;
  cleanSuccess: boolean;
  investigation: boolean;
  retryBlocked: boolean;
  quarantined: number;
  effects: EffectEvidence[];
  noEffect: NoEffectEvidence[];
}

export function receiptStatus(stored: StoredOperation): ReceiptStatus {
  const responses = stored.journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response] : []);
  const effects = responses.flatMap(response => response.result.kind === "succeeded" ? [response.result.evidence] : []);
  const noEffect = [
    ...responses.flatMap(response => "evidence" in response.result && response.result.evidence.kind === "no-effect" ? [response.result.evidence] : []),
    ...stored.journal.events.flatMap(entry => entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "no-effect" ? [entry.event.lookup.result.evidence] : []),
  ];
  const legacy = stored.journal.events[0]?.event.kind === "legacy-import";
  const investigation = stored.quarantine.length > 0 || (stored.retryBlocked && !legacy);
  return { state: stored.journal.state, cleanSuccess: stored.journal.state === "succeeded" && !investigation, investigation, retryBlocked: stored.retryBlocked, quarantined: stored.quarantine.length, effects, noEffect };
}

export interface LegacyOwnerConversion { owner: OperationRecord["owner"]; failureProvesNoEffect: boolean }
export const LEGACY_OWNER_CONVERSIONS: ReadonlyMap<OperationRecord["owner"], LegacyOwnerConversion> = new Map();
export interface LegacyCreateProjection {
  state: "succeeded" | "pending" | "uncertain" | "failed";
  canonicalId?: string;
  url?: string;
  receipt?: string;
  raw: CreateResult;
  retryPermitted: false;
}

export function convertLegacyCreateResult(result: CreateResult, owner: OperationRecord["owner"], conversions: ReadonlyMap<OperationRecord["owner"], LegacyOwnerConversion> = LEGACY_OWNER_CONVERSIONS): LegacyCreateProjection {
  const raw = structuredClone(result);
  if (result.state === "created") return { state: "succeeded", canonicalId: result.canonicalId, ...(result.url === undefined ? {} : { url: result.url }), raw, retryPermitted: false };
  if (result.state === "accepted") return result.receipt === undefined ? { state: "uncertain", raw, retryPermitted: false } : { state: "pending", receipt: result.receipt, raw, retryPermitted: false };
  return { state: conversions.get(owner)?.failureProvesNoEffect === true ? "failed" : "uncertain", raw, retryPermitted: false };
}
