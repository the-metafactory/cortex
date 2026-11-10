import { randomUUID } from "node:crypto";
import type { Denial, HostContext, WriterLease } from "../../authority";
import type { BoundaryError } from "../types";
import { JournalConflict, type OperationJournalStore, type StoredOperation } from "./journal";
import { CancelRequestSchema, parseWire, type ApprovedSnapshot, type Attempt, type Authority, type CancelRequest, type DispatchRequest, type OperationState, type OwnerSupport } from "./types";
import type { WriterAuthority, WriterBinding } from "./writer-authority";
import { fenceTargetOf, type FenceGate, type FenceTarget } from "./triggers";

export const OWNER_CALL_WAIT_MS = 30_000;
export const MAX_OUTSTANDING_OWNER_CALLS = 64;
export const MIN_REDISPATCH_GAP_MS = 1000;
const JOURNAL_RETRIES = 5;

export type SupportLookup = (snapshot: ApprovedSnapshot) => OwnerSupport | undefined;
export interface DispatchAuthority {
  preflight(context: HostContext, operationId: string, supplied: Authority, lease: WriterLease, purpose: "mutation" | "cancellation", cancelId?: string): Promise<{ kind: "allowed" } | Denial>;
  dispatch(context: HostContext, request: DispatchRequest, lease: WriterLease): Promise<{ kind: "admitted" } | Denial>;
  cancel(context: HostContext, request: CancelRequest, lease: WriterLease): Promise<{ kind: "admitted" } | Denial>;
}
export interface BridgeOptions {
  journal: OperationJournalStore;
  authority: DispatchAuthority;
  writers: Pick<WriterAuthority, "current" | "legacyAllowed">;
  supportFor: SupportLookup;
  fences?: FenceGate;
  connectorEntry?: (context: HostContext, snapshot: ApprovedSnapshot) => Promise<{ kind: "allowed" } | { kind: "denied"; reason: BoundaryError }>;
  now?: () => Date;
  waitMs?: number;
  maxOutstandingCalls?: number;
}
export type DispatchOutcome =
  | { kind: "settled"; operation: StoredOperation; attemptId: string }
  | { kind: "timed-out"; operation: StoredOperation; attemptId: string }
  | { kind: "refused"; reason: BoundaryError; operation: StoredOperation | null }
  | { kind: "not-dispatchable"; operation: StoredOperation };
export type RedispatchOutcome = DispatchOutcome | { kind: "not-eligible"; reason: BoundaryError; operation: StoredOperation | null };
export type CancelOutcome =
  | { kind: "cancelled-before-dispatch"; operation: StoredOperation }
  | { kind: "stop-recorded"; operation: StoredOperation; sent: boolean }
  | { kind: "refused"; reason: BoundaryError }
  | { kind: "not-cancellable"; operation: StoredOperation };
export type LegacyRoute = { route: "legacy" } | { route: "upgrade-required"; reason: BoundaryError } | { route: "fenced"; reason: BoundaryError } | { route: "bridge"; outcome: DispatchOutcome };

const reason = (code: string, message: string): BoundaryError => ({ code, message });
const INACTIVE = reason("bridge_inactive", "Operation dispatch is not active for this capability.");
const FENCED = reason("binding_fenced", "This binding is fenced; its mutation is off until the principal lifts the fence with a reason.");
const bindingKey = (snapshot: Pick<ApprovedSnapshot, "adapterId" | "connectionId" | "capabilityId">): string => JSON.stringify([snapshot.adapterId, snapshot.connectionId, snapshot.capabilityId]);
const attempts = (stored: StoredOperation) => stored.journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt] : []);
const ACTIVE: readonly OperationState[] = ["dispatching", "pending", "uncertain"];

interface LaunchArguments {
  context: HostContext;
  lease: WriterLease;
  stored: StoredOperation;
  snapshot: ApprovedSnapshot;
  authority: Authority;
  support: OwnerSupport;
  attempt: Attempt;
  retryAuthorized: boolean;
}

export class OperationBridge {
  private readonly activated = new Map<string, WriterBinding>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly now: () => Date;
  private readonly waitMs: number;
  private readonly maxOutstanding: number;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.waitMs = options.waitMs ?? OWNER_CALL_WAIT_MS;
    this.maxOutstanding = options.maxOutstandingCalls ?? MAX_OUTSTANDING_OWNER_CALLS;
  }

  async activate(binding: WriterBinding, lease: WriterLease): Promise<boolean> {
    if (!await this.options.writers.current(lease, binding)) return false;
    this.activated.set(bindingKey(binding), binding);
    return true;
  }

  deactivate(binding: WriterBinding): void { this.activated.delete(bindingKey(binding)); }

  settled(): Promise<void> { return Promise.allSettled([...this.inflight]).then(() => undefined); }

  private async mutate(operationId: string, change: (stored: StoredOperation) => Promise<boolean>): Promise<StoredOperation | null> {
    for (let tries = 0; tries < JOURNAL_RETRIES; tries++) {
      const stored = await this.options.journal.read(operationId);
      if (!stored) return null;
      try { if (!await change(stored)) return stored; return await this.options.journal.read(operationId); }
      catch (error) { if (!(error instanceof JournalConflict)) throw error; }
    }
    return this.options.journal.read(operationId);
  }

  private append(stored: StoredOperation, event: unknown, options: { at?: string; support?: OwnerSupport; retryAuthorized?: boolean } = {}): Promise<StoredOperation> {
    const entry = { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at: options.at ?? this.now().toISOString(), event };
    return this.options.journal.append(stored.journal.operationId, stored.revision, entry, { ...(options.support ? { support: options.support } : {}), ...(options.retryAuthorized ? { retryAuthorized: true } : {}) });
  }

  private async refuse(operationId: string, why: BoundaryError): Promise<DispatchOutcome> {
    const operation = await this.mutate(operationId, async stored => {
      if (stored.journal.state !== "confirmed" || attempts(stored).length) return false;
      await this.append(stored, { kind: "local-outcome", state: "refused", reason: why });
      return true;
    });
    return { kind: "refused", reason: why, operation };
  }

  async dispatch(context: HostContext, operationId: string, lease: WriterLease): Promise<DispatchOutcome> {
    const stored = await this.options.journal.read(operationId);
    if (!stored) return { kind: "refused", reason: reason("operation_unknown", "The operation does not exist."), operation: null };
    const snapshot = stored.journal.snapshot;
    if ("kind" in snapshot) return { kind: "refused", reason: reason("legacy_ambiguous", "A legacy operation has no approved snapshot to dispatch."), operation: stored };
    if (await this.options.fences?.isFenced(fenceTargetOf(snapshot))) return { kind: "refused", reason: FENCED, operation: stored };
    if (!this.activated.has(bindingKey(snapshot))) return { kind: "refused", reason: INACTIVE, operation: stored };
    if (stored.journal.state !== "confirmed" || attempts(stored).length || stored.cancelRequested || stored.retryBlocked) return { kind: "not-dispatchable", operation: stored };
    if (this.inflight.size >= this.maxOutstanding) return { kind: "refused", reason: reason("capacity_exceeded", "Too many owner calls are still outstanding; retry later."), operation: stored };
    const approval = stored.journal.events[0]?.event;
    if (approval?.kind !== "approved") return this.refuse(operationId, reason("legacy_ambiguous", "The operation has no recorded approval."));
    const support = this.options.supportFor(snapshot);
    if (!support) return this.refuse(operationId, reason("support_missing", "No execution declaration is registered for this capability."));
    if (snapshot.expectedOwnerRevision !== undefined && support.conditionalUpdate !== "owner-enforced") return this.refuse(operationId, reason("conditional_update_unsupported", "The owner does not enforce conditional updates."));
    const checked = await this.options.authority.preflight(context, operationId, approval.authority, lease, "mutation");
    if (checked.kind === "denied") return this.refuse(operationId, checked.reason);

    const start = this.now();
    const attempt = { attemptId: randomUUID(), number: 1, kind: "initial" as const, preparedAt: start.toISOString(), deadlineAt: new Date(start.getTime() + OWNER_CALL_WAIT_MS).toISOString(), authority: approval.authority, supportDeclarationId: support.declarationId, ...(support.dedup.kind === "guaranteed" ? { dedupValidUntil: new Date(start.getTime() + support.dedup.retentionMs).toISOString() } : {}) };
    return this.launch({ context, lease, stored, snapshot, authority: approval.authority, support, attempt, retryAuthorized: false });
  }

  async redispatch(context: HostContext, operationId: string, lease: WriterLease): Promise<RedispatchOutcome> {
    const stored = await this.options.journal.read(operationId);
    const blocked = (code: string, message: string): RedispatchOutcome => ({ kind: "not-eligible", reason: reason(code, message), operation: stored });
    if (!stored) return { kind: "not-eligible", reason: reason("operation_unknown", "The operation does not exist."), operation: null };
    const snapshot = stored.journal.snapshot;
    if ("kind" in snapshot) return blocked("legacy_ambiguous", "A legacy operation has no approved snapshot to replay.");
    if (await this.options.fences?.isFenced(fenceTargetOf(snapshot))) return blocked("binding_fenced", FENCED.message);
    if (!this.activated.has(bindingKey(snapshot))) return blocked("bridge_inactive", INACTIVE.message);
    const budget = stored.budgets;
    const prior = attempts(stored);
    const approval = stored.journal.events[0]?.event;
    const lookup = stored.journal.events.findLast(entry => entry.event.kind === "reconciliation");
    const lastPrepared = stored.journal.events.findLast(entry => entry.event.kind === "attempt-prepared");
    if (stored.journal.state !== "uncertain" || stored.cancelRequested || stored.retryBlocked) return blocked("replay_not_permitted", "The operation state forbids a replay.");
    if (!budget || approval?.kind !== "approved" || !prior.length || lookup?.event.kind !== "reconciliation" || !lastPrepared || lookup.sequence < lastPrepared.sequence) return blocked("lookup_required", "A replay needs a completed historical lookup after the latest attempt.");
    if (!["unknown", "denied", "unavailable"].includes(lookup.event.lookup.result.kind)) return blocked("lookup_conclusive", "The lookup was conclusive; there is nothing to replay.");
    if (budget.redispatchCount >= 1) return blocked("replay_budget_exhausted", "The single automatic replay is already spent.");
    const support = this.options.supportFor(snapshot);
    if (support?.dedup.kind !== "guaranteed" || support.operationLookup !== "historical") return blocked("dedup_unavailable", "No attested same-key concurrent deduplication guarantee exists.");
    if (snapshot.expectedOwnerRevision !== undefined && support.conditionalUpdate !== "owner-enforced") return blocked("conditional_update_unsupported", "The owner does not enforce conditional updates.");
    const now = this.now();
    const start = now.getTime();
    const end = start + OWNER_CALL_WAIT_MS;
    const retained = budget.dedupValidUntil;
    if (retained === undefined) return blocked("dedup_expired", "No persisted retention window exists for the owner guarantee.");
    const validUntil = Date.parse(retained);
    if (start < Date.parse(budget.lastObservedAt) || start < Date.parse(lookup.at)) return blocked("clock_discontinuity", "The clock moved backwards; the outcome stays uncertain.");
    if (start < Date.parse(lookup.at) + MIN_REDISPATCH_GAP_MS) return blocked("replay_too_early", "A replay waits at least one second after the lookup.");
    if (end > Date.parse(budget.deadlineAt)) return blocked("work_budget_exhausted", "The replay wait does not fit the total work budget.");
    if (!(end < validUntil)) return blocked("dedup_expired", "The replay wait does not fit the owner deduplication retention window.");
    const checked = await this.options.authority.preflight(context, operationId, approval.authority, lease, "mutation");
    if (checked.kind === "denied") return { kind: "not-eligible", reason: checked.reason, operation: stored };
    const attempt = { attemptId: randomUUID(), number: prior.length + 1, kind: "retry" as const, preparedAt: now.toISOString(), deadlineAt: new Date(end).toISOString(), authority: approval.authority, supportDeclarationId: support.declarationId, dedupValidUntil: retained };
    return this.launch({ context, lease, stored, snapshot, authority: approval.authority, support, attempt, retryAuthorized: true });
  }

  private async launch(launch: LaunchArguments): Promise<DispatchOutcome> {
    const { context, lease, stored, snapshot, authority, support, attempt, retryAuthorized } = launch;
    const operationId = stored.journal.operationId;
    try { await this.append(stored, { kind: "attempt-prepared", attempt }, { at: attempt.preparedAt, support, ...(retryAuthorized ? { retryAuthorized: true } : {}) }); }
    catch (error) {
      if (!(error instanceof JournalConflict)) throw error;
      const current = await this.options.journal.read(operationId);
      return current ? { kind: "not-dispatchable", operation: current } : { kind: "refused", reason: INACTIVE, operation: null };
    }
    const target = this.fenceTarget(snapshot);
    const entry = this.options.connectorEntry ? await this.options.connectorEntry(context, snapshot) : { kind: "allowed" as const };
    if (entry.kind === "denied") {
      if (entry.reason.code === "destination_denied") await this.options.fences?.trigger({ kind: "destination_denied_at_connector", target, evidence: { operationId, detail: entry.reason.message } });
      const operation = await this.expire(operationId, attempt.attemptId, entry.reason);
      return { kind: "refused", reason: entry.reason, operation };
    }
    const request: DispatchRequest = { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, idempotencyKey: stored.journal.idempotencyKey, ownerRequestId: stored.journal.ownerRequestId, snapshot, authority, supportDeclarationId: support.declarationId, deadlineAt: attempt.deadlineAt };
    return this.cross(this.options.authority.dispatch(context, request, lease), operationId, attempt.attemptId, target);
  }

  private fenceTarget(snapshot: ApprovedSnapshot): FenceTarget {
    const binding = this.activated.get(bindingKey(snapshot));
    return fenceTargetOf(snapshot, binding ? { stack: binding.stack, owner: binding.owner } : {});
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const forget = (): void => { this.inflight.delete(work); };
    work.then(forget, forget);
    return work;
  }

  private async wait<T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => { resolve({ done: false }); }, this.waitMs); });
    try { return await Promise.race([work.then(value => ({ done: true as const, value })), timeout]); }
    finally { clearTimeout(timer); }
  }

  private async cross(call: Promise<{ kind: "admitted" } | Denial>, operationId: string, attemptId: string, target: FenceTarget): Promise<DispatchOutcome> {
    const continuation = this.track(call.catch((): { kind: "failed" } => ({ kind: "failed" })));
    const waited = await this.wait(continuation);
    if (waited.done && waited.value.kind === "failed") {
      await this.options.fences?.trigger({ kind: "adapter_crash", target, evidence: { operationId, detail: "The owner call ended abnormally after the attempt was prepared." } });
      const operation = await this.expire(operationId, attemptId, reason("outcome_unknown", "The owner call ended abnormally after the attempt was prepared; the outcome is unknown."));
      return { kind: "timed-out", operation, attemptId };
    }
    if (!waited.done) {
      const operation = await this.expire(operationId, attemptId, reason("deadline_exceeded", "The owner did not answer within the wait; the outcome is unknown."));
      return { kind: "timed-out", operation, attemptId };
    }
    if (waited.value.kind === "denied") {
      const operation = await this.expire(operationId, attemptId, reason("authority_denied", "Admission was denied after the attempt was prepared; no owner call was made."));
      return { kind: "refused", reason: waited.value.reason, operation };
    }
    const operation = await this.options.journal.read(operationId);
    if (!operation) throw new Error("Dispatched operation vanished from the journal.");
    return { kind: "settled", operation, attemptId };
  }

  private async expire(operationId: string, attemptId: string, why: BoundaryError): Promise<StoredOperation> {
    const operation = await this.mutate(operationId, async stored => {
      if (!["dispatching", "pending"].includes(stored.journal.state) || !attempts(stored).some(item => item.attemptId === attemptId)) return false;
      await this.append(stored, { kind: "wait-expired", attemptId, reason: why });
      return true;
    });
    if (!operation) throw new Error("Expired operation vanished from the journal.");
    return operation;
  }

  async recover(operationId: string): Promise<StoredOperation | null> {
    return this.mutate(operationId, async stored => {
      if (!["dispatching", "pending"].includes(stored.journal.state)) return false;
      await this.options.journal.recover(operationId, stored.revision, this.now().toISOString());
      return true;
    });
  }

  async cancel(context: HostContext, raw: CancelRequest, lease: WriterLease): Promise<CancelOutcome> {
    const request = parseWire(CancelRequestSchema, raw);
    const stored = await this.options.journal.read(request.operationId);
    if (!stored || "kind" in stored.journal.snapshot) return { kind: "refused", reason: reason("operation_unknown", "The operation has no approved lifecycle snapshot.") };
    const checked = await this.options.authority.preflight(context, request.operationId, request.authority, lease, "cancellation", request.cancelId);
    if (checked.kind === "denied") return { kind: "refused", reason: checked.reason };
    const recorded = await this.mutate(request.operationId, async current => {
      if (current.journal.state !== "confirmed" && !ACTIVE.includes(current.journal.state)) return false;
      await this.append(current, { kind: "cancel-requested", cancelId: request.cancelId, authority: request.authority });
      return true;
    });
    if (!recorded) return { kind: "refused", reason: reason("operation_unknown", "The operation does not exist.") };
    if (!recorded.cancelRequested) return { kind: "not-cancellable", operation: recorded };
    if (!attempts(recorded).length) return { kind: "cancelled-before-dispatch", operation: recorded };
    const support = this.options.supportFor(recorded.journal.snapshot as ApprovedSnapshot);
    if (!support || support.cancellation === "none") return { kind: "stop-recorded", operation: recorded, sent: false };
    const continuation = this.track(this.options.authority.cancel(context, request, lease).catch((): Denial => ({ kind: "denied", reason: reason("authority_denied", "Cancellation admission failed."), recovery: "retry-later" })));
    const waited = await this.wait(continuation);
    const operation = await this.options.journal.read(request.operationId);
    if (!operation) throw new Error("Cancelled operation vanished from the journal.");
    return { kind: "stop-recorded", operation, sent: waited.done && waited.value.kind === "admitted" };
  }

  async legacyMutation(context: HostContext, binding: WriterBinding, operationId: string, lease: WriterLease, connectionQualified = true): Promise<LegacyRoute> {
    if (await this.options.fences?.isFenced(fenceTargetOf(binding))) return { route: "fenced", reason: FENCED };
    if (await this.options.writers.legacyAllowed(binding, connectionQualified)) return { route: "legacy" };
    if (!this.activated.has(bindingKey(binding))) return { route: "upgrade-required", reason: reason("upgrade_required", "This capability moved to lifecycle operations; upgrade the client.") };
    return { route: "bridge", outcome: await this.dispatch(context, operationId, lease) };
  }
}
