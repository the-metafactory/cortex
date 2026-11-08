import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type JsonObject, type Session, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { DomainAdapterRegistry } from "../registry";
import { AuthoritySchema, JournalEventSchema, OperationJournalSchema, OwnerSupportSchema, parseWire, type ApprovedSnapshot, type Authority, type JournalEvent, type OperationJournal, type OwnerResult, type OwnerSupport } from "./types";
import { canonicalWire, validateResultPayload, validateSnapshot } from "./validation";

const ACTIVE = new Set(["dispatching", "pending", "uncertain"]);
export const StoreDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.lifecycle-operation", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });
const budgets = z.object({ startedAt: z.iso.datetime(), deadlineAt: z.iso.datetime(), lookupCount: z.number().int().nonnegative().max(3), redispatchCount: z.number().int().nonnegative().max(1), lastObservedAt: z.iso.datetime(), dedupValidUntil: z.iso.datetime().optional() }).strict();
export const StoredSchema = z.object({
  format: z.literal("desk-operation-journal/1"), revision: z.number().int().positive(), journal: OperationJournalSchema,
  cancelRequested: z.boolean(), retryBlocked: z.boolean(), quarantine: z.array(z.object({ at: z.iso.datetime(), code: z.string(), raw: z.json() }).strict()),
  budgets: budgets.nullable(), outbox: z.array(z.object({ key: z.string(), event: JournalEventSchema, delivered: z.boolean() }).strict()),
}).strict();
export type StoredOperation = z.infer<typeof StoredSchema>;
export class JournalConflict extends Error {}
export interface Approval { operationId: string; idempotencyKey: string; ownerRequestId: string; snapshot: ApprovedSnapshot; authority: Authority; at: string; links?: OperationJournal["links"] }
export interface AppendOptions { support?: OwnerSupport; retryAuthorized?: boolean }
const jsonObject = (value: StoredOperation): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const attempts = (journal: OperationJournal) => journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt] : []);
const outcomes = (journal: OperationJournal): OwnerResult[] => journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response] : []);
const noEffect = (response: OwnerResult): boolean => ["failed", "conflict", "cancelled"].includes(response.result.kind);
const requireState = (condition: boolean, reason: string): void => { if (!condition) throw new JournalConflict(reason); };

export class OperationJournalStore {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly registry: DomainAdapterRegistry, private readonly context: Context = BACKGROUND_CONTEXT) {}

  async read(operationId: string): Promise<StoredOperation | null> {
    const doc = await this.engine.snapshot(StoreDoc, operationId, this.context);
    return doc?.record ? StoredSchema.parse(doc.record) : null;
  }

  async approve(approval: Approval): Promise<StoredOperation> {
    return this.engine.commit(tx => this.approveInTransaction(tx, approval), this.context);
  }

  async approveInTransaction(tx: Tx, approval: Approval): Promise<StoredOperation> {
    const snapshot = validateSnapshot(this.registry, approval.snapshot);
    const journal = parseWire(OperationJournalSchema, { lifecycleVersion: "1.0.0", operationId: approval.operationId, sequence: 1, state: "confirmed", idempotencyKey: approval.idempotencyKey, ownerRequestId: approval.ownerRequestId, snapshot, events: [{ sequence: 1, eventId: randomUUID(), at: approval.at, event: { kind: "approved", snapshot, authority: parseWire(AuthoritySchema, approval.authority) } }], ...(approval.links ? { links: approval.links } : {}) });
      const doc = await tx.doc(StoreDoc, journal.operationId, journal.operationId);
      if (doc.record) {
        const stored = StoredSchema.parse(doc.record);
        requireState(canonicalWire(stored.journal.snapshot) === canonicalWire(snapshot) && stored.journal.ownerRequestId === journal.ownerRequestId && stored.journal.idempotencyKey === journal.idempotencyKey && canonicalWire(stored.journal.links ?? {}) === canonicalWire(journal.links ?? {}), "Operation approval conflicts with the persisted identity or snapshot.");
        return stored;
      }
      const stored: StoredOperation = { format: "desk-operation-journal/1", revision: 1, journal, cancelRequested: false, retryBlocked: false, quarantine: [], budgets: null, outbox: [] };
      doc.record = jsonObject(stored);
      return stored;
  }

  async importLegacy(journal: OperationJournal): Promise<StoredOperation> {
    const checked = parseWire(OperationJournalSchema, journal);
    const event = checked.events[0];
    requireState(checked.sequence === 1 && checked.events.length === 1 && event?.sequence === 1 && event.event.kind === "legacy-import" && "kind" in checked.snapshot && ["succeeded", "uncertain"].includes(checked.state), "Legacy import requires isolated legacy evidence and no approval.");
    return this.engine.commit(async tx => {
      const doc = await tx.doc(StoreDoc, checked.operationId, checked.operationId);
      if (doc.record) {
        const stored = StoredSchema.parse(doc.record);
        const prior = stored.journal.events[0];
        requireState(prior?.event.kind === "legacy-import" && event?.event.kind === "legacy-import" && prior.event.sourceDigest === event.event.sourceDigest && canonicalWire(prior.event.rawRecord) === canonicalWire(event.event.rawRecord) && stored.journal.ownerRequestId === checked.ownerRequestId && stored.journal.state === checked.state, "Legacy import source changed; review is required.");
        return stored;
      }
      const stored: StoredOperation = { format: "desk-operation-journal/1", revision: 1, journal: checked, cancelRequested: false, retryBlocked: true, quarantine: [], budgets: null, outbox: [] };
      doc.record = jsonObject(stored);
      return stored;
    }, this.context);
  }

  private async mutate(operationId: string, expectedRevision: number, change: (stored: StoredOperation) => void): Promise<StoredOperation> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(StoreDoc, operationId, operationId);
      requireState(doc.record !== null, "Operation does not exist.");
      const stored = StoredSchema.parse(doc.record);
      requireState(stored.revision === expectedRevision, "Operation revision changed.");
      const before = canonicalWire(stored);
      change(stored);
      if (canonicalWire(stored) !== before) stored.revision++;
      doc.record = jsonObject(StoredSchema.parse(stored));
      return structuredClone(stored);
    }, this.context);
  }

  async append(operationId: string, expectedRevision: number, raw: unknown, options: AppendOptions = {}): Promise<StoredOperation> {
    const entry = parseWire(JournalEventSchema, raw);
    return this.mutate(operationId, expectedRevision, stored => {
      const existing = stored.journal.events.find(event => event.eventId === entry.eventId);
      if (existing) { requireState(canonicalWire(existing) === canonicalWire(entry), "Event identity was reused."); return; }
      if (entry.event.kind === "owner-result" && this.duplicate(stored, entry.event.response)) return;
      requireState(entry.sequence === stored.journal.sequence + 1, "Event sequence must advance by one.");
      this.transition(stored, entry, options);
      stored.journal.events.push(entry);
      stored.journal.sequence = entry.sequence;
    });
  }

  async receive(operationId: string, expectedRevision: number, raw: unknown, at: string): Promise<StoredOperation> {
    const stored = await this.read(operationId);
    requireState(stored !== null && stored.revision === expectedRevision, "Operation revision changed.");
    if (!stored) throw new JournalConflict("Operation does not exist.");
    let entry: JournalEvent;
    try {
      entry = parseWire(JournalEventSchema, { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at, event: { kind: "owner-result", response: raw } });
    } catch (error) {
      const safeRaw = parseWire(z.json(), raw);
      return this.mutate(operationId, expectedRevision, current => {
        current.quarantine.push({ at: z.iso.datetime().parse(at), code: error instanceof Error ? "invalid_output" : "invalid_response", raw: safeRaw });
        current.retryBlocked = true;
        if (["dispatching", "pending"].includes(current.journal.state)) {
          const attempt = attempts(current.journal).at(-1);
          if (!attempt) throw new Error("Active operation has no prepared attempt.");
          current.journal.events.push({ sequence: ++current.journal.sequence, eventId: randomUUID(), at, event: { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "invalid_output", message: "Owner response failed lifecycle validation." } } });
          current.journal.state = "uncertain";
        }
      });
    }
    return this.append(operationId, expectedRevision, entry);
  }

  async recover(operationId: string, expectedRevision: number, at: string): Promise<StoredOperation> {
    const stored = await this.read(operationId);
    requireState(stored !== null && stored.revision === expectedRevision, "Operation revision changed.");
    if (!stored) throw new JournalConflict("Operation does not exist.");
    if (stored.journal.state !== "dispatching" && stored.journal.state !== "pending") return stored;
    const attempt = attempts(stored.journal).at(-1);
    if (!attempt) throw new Error("Active operation has no prepared attempt.");
    return this.append(operationId, expectedRevision, { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at, event: { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "recovery_required", message: "Prepared operation requires owner reconciliation after restart." } } });
  }

  private duplicate(stored: StoredOperation, response: OwnerResult): boolean {
    const prior = outcomes(stored.journal).find(item => item.resultId === response.resultId);
    return prior !== undefined && canonicalWire(prior) === canonicalWire(response);
  }

  private quarantine(stored: StoredOperation, entry: JournalEvent, code: string): void {
    stored.quarantine.push({ at: entry.at, code, raw: entry });
    stored.retryBlocked = true;
  }

  private result(stored: StoredOperation, response: OwnerResult, entry: JournalEvent): void {
    const journal = stored.journal;
    const snapshot = journal.snapshot;
    requireState(!("kind" in snapshot), "Legacy snapshot cannot consume lifecycle evidence.");
    if ("kind" in snapshot) return;
    const requestId = "evidence" in response.result ? response.result.evidence.ownerRequestId : response.result.ownerRequestId;
    const identityMatches = response.operationId === journal.operationId && response.snapshotDigest === snapshot.digest && attempts(journal).some(attempt => attempt.attemptId === response.attemptId) && (requestId === undefined || requestId === journal.ownerRequestId);
    if (!identityMatches) { this.quarantine(stored, entry, "outcome_conflict"); if (["dispatching", "pending"].includes(journal.state)) journal.state = "uncertain"; return; }
    try { validateResultPayload(this.registry, snapshot, response); }
    catch (error) { this.quarantine(stored, entry, error instanceof Error ? error.message : "invalid_output"); if (["dispatching", "pending"].includes(journal.state)) journal.state = "uncertain"; return; }
    const prior = outcomes(journal);
    if (prior.some(item => item.resultId === response.resultId && canonicalWire(item) !== canonicalWire(response))) {
      this.quarantine(stored, entry, "outcome_conflict");
      if (["dispatching", "pending"].includes(journal.state)) journal.state = "uncertain";
      return;
    }
    const preparation = journal.events.find(item => item.event.kind === "attempt-prepared" && item.event.attempt.attemptId === response.attemptId);
    const lookupFence = response.result.kind === "succeeded" && journal.events.some(item => item.event.kind === "reconciliation" && item.event.lookup.result.kind === "no-effect" && item.event.lookup.result.evidence.ownerRequestId === journal.ownerRequestId && preparation !== undefined && item.sequence > preparation.sequence);
    const contradictory = lookupFence || prior.some(item => item.resultId === response.resultId && canonicalWire(item) !== canonicalWire(response) || item.result.kind === "succeeded" && noEffect(response) || noEffect(item) && response.result.kind === "succeeded" && (attempts(journal).find(attempt => attempt.attemptId === item.attemptId)?.number ?? 0) >= (attempts(journal).find(attempt => attempt.attemptId === response.attemptId)?.number ?? 0));
    if (contradictory || ["cancelled", "refused", "conflict"].includes(journal.state) && response.result.kind === "succeeded") this.quarantine(stored, entry, "outcome_conflict");
    if (response.result.kind === "succeeded") {
      journal.state = "succeeded";
      const key = `${journal.operationId}:succeeded`;
      if (!stored.outbox.some(item => item.key === key)) stored.outbox.push({ key, event: entry, delivered: false });
    } else if (contradictory || journal.state === "succeeded") return;
    else if (ACTIVE.has(journal.state)) journal.state = response.result.kind === "accepted" ? journal.state === "uncertain" ? "uncertain" : "pending" : response.result.kind;
    else this.quarantine(stored, entry, "outcome_conflict");
  }

  private prepare(stored: StoredOperation, entry: JournalEvent, options: AppendOptions): void {
    if (entry.event.kind !== "attempt-prepared") return;
    const { journal } = stored;
    const attempt = entry.event.attempt;
    const previous = attempts(journal);
    requireState(!stored.cancelRequested && !stored.retryBlocked && ["confirmed", "uncertain", "failed"].includes(journal.state), "Operation is not eligible for an attempt.");
    requireState(!previous.some(item => item.attemptId === attempt.attemptId) && attempt.number === previous.length + 1 && attempt.kind === (previous.length ? "retry" : "initial"), "Attempt identity or ordinal conflicts.");
    const start = Date.parse(attempt.preparedAt);
    const end = Date.parse(attempt.deadlineAt);
    requireState(start === Date.parse(entry.at) && end > start && end - start <= 30_000, "Attempt must have a bounded owner wait.");
    const support = options.support ? parseWire(OwnerSupportSchema, options.support) : undefined;
    const snapshot = journal.snapshot;
    requireState(!("kind" in snapshot), "Attempt requires an approved snapshot.");
    if ("kind" in snapshot) return;
    requireState(support?.declarationId === attempt.supportDeclarationId && support.adapterId === snapshot.adapterId && support.connectionId === snapshot.connectionId && support.capabilityId === snapshot.capabilityId, "Attempt requires the matching trusted execution binding.");
    if (!support) return;
    requireState(snapshot.expectedOwnerRevision === undefined || support.conditionalUpdate === "owner-enforced", "Owner does not support conditional updates.");
    if (!previous.length) {
      const dedupValidUntil = support.dedup.kind === "guaranteed" ? new Date(start + support.dedup.retentionMs).toISOString() : undefined;
      requireState(attempt.dedupValidUntil === dedupValidUntil, "Attempt retention must derive from the support declaration.");
      stored.budgets = { startedAt: attempt.preparedAt, deadlineAt: new Date(start + 120_000).toISOString(), lookupCount: 0, redispatchCount: 0, lastObservedAt: attempt.preparedAt, ...(dedupValidUntil ? { dedupValidUntil } : {}) };
    } else {
      const budget = stored.budgets;
      requireState(options.retryAuthorized === true && budget !== null && start >= Date.parse(budget.lastObservedAt) && start >= Date.parse(previous.at(-1)?.preparedAt ?? attempt.preparedAt) + 1000 && end <= Date.parse(budget.deadlineAt) && budget.redispatchCount < 1, "Retry lacks authority or exceeds the persisted work budget.");
      if (!budget) return;
      const latestLookup = journal.events.findLast(item => item.event.kind === "reconciliation");
      if (journal.state === "uncertain") requireState(latestLookup !== undefined && start >= Date.parse(latestLookup.at) + 1000 && end - start === 30_000 && support.dedup.kind === "guaranteed" && support.operationLookup === "historical" && budget.lookupCount > 0 && budget.dedupValidUntil !== undefined && attempt.dedupValidUntil === budget.dedupValidUntil && end < Date.parse(budget.dedupValidUntil) && journal.events.some(item => item.event.kind === "reconciliation" && item.sequence > (journal.events.findLast(event => event.event.kind === "attempt-prepared")?.sequence ?? 0)), "Uncertain retry requires a completed lookup and a live same-key dedup guarantee.");
      else requireState(outcomes(journal).some(item => noEffect(item)) || journal.events.some(item => item.event.kind === "reconciliation" && item.event.lookup.result.kind === "no-effect" && item.event.lookup.result.evidence.ownerRequestId === journal.ownerRequestId), "Failed retry requires final operation-wide no-effect evidence.");
      budget.redispatchCount++;
      budget.lastObservedAt = attempt.preparedAt;
    }
    journal.state = "dispatching";
  }

  private transition(stored: StoredOperation, entry: JournalEvent, options: AppendOptions): void {
    const { journal } = stored;
    const event = entry.event;
    if (event.kind === "attempt-prepared") this.prepare(stored, entry, options);
    else if (event.kind === "owner-result") this.result(stored, event.response, entry);
    else if (event.kind === "wait-expired") {
      requireState(ACTIVE.has(journal.state) && attempts(journal).some(attempt => attempt.attemptId === event.attemptId), "Only a prepared active attempt may expire.");
      journal.state = "uncertain";
    } else if (event.kind === "cancel-requested") {
      requireState(journal.state === "confirmed" || ACTIVE.has(journal.state), "Operation is already terminal.");
      stored.cancelRequested = true;
      if (journal.state === "confirmed") journal.state = "cancelled";
    } else if (event.kind === "local-outcome") {
      requireState(journal.state === "confirmed" && attempts(journal).length === 0, "Local outcomes require zero dispatch attempts.");
      journal.state = event.state;
    } else if (event.kind === "reconciliation") {
      requireState(journal.state === "uncertain" && event.lookup.operationId === journal.operationId, "Lookup must belong to an uncertain operation.");
      if (event.lookup.result.kind === "known") {
        if (!this.duplicate(stored, event.lookup.result.response)) this.result(stored, event.lookup.result.response, entry);
      } else if (event.lookup.result.kind === "no-effect") {
        if (event.lookup.result.evidence.ownerRequestId !== journal.ownerRequestId) this.quarantine(stored, entry, "outcome_conflict");
        else journal.state = stored.cancelRequested ? "cancelled" : "failed";
      }
    } else throw new JournalConflict("Approval and legacy import use separate creation APIs.");
  }

  async reserveLookup(operationId: string, expectedRevision: number, at: string): Promise<StoredOperation> {
    z.iso.datetime().parse(at);
    return this.mutate(operationId, expectedRevision, stored => {
      const budget = stored.budgets;
      requireState(stored.journal.state === "uncertain" && budget !== null && budget.lookupCount < 3 && Date.parse(at) >= Date.parse(budget.lastObservedAt) && Date.parse(at) < Date.parse(budget.deadlineAt), "Automatic lookup budget is exhausted or clock moved backwards.");
      if (!budget) return;
      budget.lookupCount++;
      budget.lastObservedAt = at;
    });
  }

  async acknowledgeSuccess(operationId: string, expectedRevision: number, key: string): Promise<StoredOperation> {
    return this.mutate(operationId, expectedRevision, stored => {
      const item = stored.outbox.find(outbox => outbox.key === key);
      requireState(item !== undefined, "Outbox key does not exist.");
      if (item && !item.delivered) item.delivered = true;
    });
  }
}
