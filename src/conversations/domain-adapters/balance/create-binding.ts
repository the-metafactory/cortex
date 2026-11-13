import type { Database } from "bun:sqlite";
import type { AppState, DestinationArea } from "../../../balance";
import { STALE_OUTLINE } from "../../../surface/mc/desk/balance-outline";
import { balanceWriter } from "../../../surface/mc/desk/balance-conversation-writer";
import type { DeskOptions } from "../../../surface/mc/desk/compose";
import { loadMeta } from "../../../surface/mc/desk/my-day";
import { operationUuid } from "../../conversation-ids";
import type { LookupRequest, TrustedConnector } from "../../authority";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../types";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { BALANCE_ADAPTER_ID } from "./schema";
import type { DispatchOutcome } from "../operations/dispatch";
import type { OperationJournalStore, StoredOperation } from "../operations/journal";
import type { WriterBinding } from "../operations/writer-authority";
import type { ApprovedSnapshot, Authority, DispatchRequest, Json, OperationLookup, OwnerResult, OwnerSupport, Provenance } from "../operations/types";
import { createOutcome, ownerResultKit, requestParts, resultsOf, type CreateOutcome, type OwnerResultParts } from "../operations/owner-results";

export const BALANCE_CREATE_DEDUP_RETENTION_MS = 86_400_000;
export function balanceCreateSupport(kind: "task" | "project", connectionId: string, declarationId: string): OwnerSupport {
  return { lifecycleVersion: "1.0.0", adapterId: BALANCE_ADAPTER_ID, connectionId, capabilityId: `balance.${kind}.create`, declarationId, dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: BALANCE_CREATE_DEDUP_RETENTION_MS, bindsSnapshot: true, concurrent: true }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" };
}

export type BalanceCreateFields = Record<string, string>;
export interface BalanceCreateInput { area: ObjectReference; project?: ObjectReference; title: string; note?: string }
export type BalanceCreateReview<I> = { kind: "resolved"; input: I; requiresFreshApproval: boolean; fields: BalanceCreateFields } | { kind: "refused"; reason: string; fields: BalanceCreateFields } | { kind: "choice"; reason: string; fields: BalanceCreateFields };
export interface BalanceCreateContract<I extends BalanceCreateInput, R extends BalanceCreateReview<I>> {
  kind: "task" | "project";
  owner: "balance-task" | "balance-project";
  capabilityId: string;
  declaration(): AdapterDeclaration;
  support(connectionId: string, declarationId?: string): OwnerSupport;
  parse(raw: unknown, connectionId: string): I;
  legacyFields(input: I): BalanceCreateFields;
  review: (fields: BalanceCreateFields, state: AppState, areas: readonly DestinationArea[], connectionId: string) => R;
  refusedReview(reason: string, fields: BalanceCreateFields): R;
  snapshot: (options: { connectionId: string; provenance: Provenance; input: I; policy?: "local" | "cloud" }) => ApprovedSnapshot;
}
export const balanceReference = (connectionId: string, objectType: "area" | "project" | "task", canonicalId: string): ObjectReference => ({ adapterId: BALANCE_ADAPTER_ID, connectionId, objectType, canonicalId });
export const balanceCreateBindings = (): AdapterBindings => ({ handlers: {}, observations: {} });

export function balanceCreateReceiptId(operationId: string): string {
  return operationUuid(operationId);
}

const refusedEnvelope = (reason: string): BalanceCreateFacadeOutcome => ({ kind: "refused", reason, result: { state: "failed", error: `${reason} Nothing was created.` } });

export type BalanceCreateReceipt = ReturnType<typeof loadMeta>["receipts"][number];

export interface BalanceCreateBindingOptions {
  stack: string;
  connectionId: string;
  db: Database;
  desk: () => DeskOptions | undefined;
  areas: () => readonly DestinationArea[];
  journal: OperationJournalStore;
  now?: () => number;
  owner?: Pick<OwnerWriter, "create" | "readback">;
  supportDeclarationId?: string;
}

export interface BalanceCreateBinding {
  readonly declaration: AdapterDeclaration;
  readonly support: OwnerSupport;
  readonly bindings: AdapterBindings;
  readonly writerBinding: WriterBinding;
  readonly connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup">;
  receipt(operationId: string): BalanceCreateReceipt | undefined;
  dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult>;
  lookup(request: LookupRequest, signal?: AbortSignal): Promise<OperationLookup>;
  readback(operation: OperationRecord): Promise<ReadbackResult>;
}

const kit = ownerResultKit("balance");
const succeededResult = (options: OwnerResultParts & { readonly connectionId: string; readonly objectType: "task" | "project"; readonly canonicalId: string; readonly receipt: Json; readonly at: string }): OwnerResult => kit.succeeded(options, balanceReference(options.connectionId, options.objectType, options.canonicalId), options.receipt, options.at);
const { refused: refusedResult, uncertain: uncertainResult } = kit;

const jsonReceipt = (receipt: BalanceCreateReceipt | undefined, canonicalId?: string): Json => {
  if (receipt !== undefined) return receipt;
  if (canonicalId === undefined) return {};
  return { canonicalId };
};

export type BalanceCreateOutcome = CreateOutcome;
export const balanceCreateOutcome = createOutcome;

export const balanceCreateLegacyResult = (stored: StoredOperation | null): CreateResult => kit.legacyResult(stored, "Balance");

export interface BalanceCreateLifecycle {
  activate(): Promise<boolean>;
  dispatch(operationId: string): Promise<DispatchOutcome>;
}

export interface BalanceCreateFacadeOptions {
  binding: BalanceCreateBinding;
  journal: OperationJournalStore;
  areas: () => readonly DestinationArea[];
  state: () => AppState | null;
  now?: () => number;
}

export type BalanceCreateFacadeOutcome =
  | { kind: "refused"; reason: string; result: CreateResult }
  | { kind: "dispatched"; outcome: DispatchOutcome; stored: StoredOperation | null; result: CreateResult };

export interface BalanceCreateFacade<R = BalanceCreateReview<BalanceCreateInput>> {
  review(fields: BalanceCreateFields): R;
  create(request: CreateRequest, authority: Authority, lifecycle: BalanceCreateLifecycle): Promise<BalanceCreateFacadeOutcome>;
}

export function createBalanceFacade<I extends BalanceCreateInput, R extends BalanceCreateReview<I>>(options: BalanceCreateFacadeOptions, contract: BalanceCreateContract<I, R>): BalanceCreateFacade<R> {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const facade: BalanceCreateFacade<R> = {
    review(fields) {
      const state = options.state();
      if (!state) return contract.refusedReview("Balance has no saved outline on this stack yet.", fields);
      return contract.review(fields, state, options.areas(), options.binding.support.connectionId);
    },
    async create(request, authority, lifecycle) {
      const review = facade.review(request.fields);
      if (review.kind !== "resolved") return refusedEnvelope(review.reason);
      let snapshot: ApprovedSnapshot;
      try {
        snapshot = contract.snapshot({ connectionId: options.binding.support.connectionId, provenance: { conversationId: request.provenance.conversationId, proposalId: request.provenance.proposalId, revision: request.provenance.revision, entryId: request.provenance.entryId, link: request.provenance.link }, input: review.input });
      } catch {
        return refusedEnvelope(`The reviewed Balance ${contract.kind} is not an approvable ${contract.kind}.`);
      }
      try {
        await options.journal.approve({ operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: operationUuid(request.operationId), snapshot, authority, at: at() });
      } catch {
        return refusedEnvelope(`The approved Balance ${contract.kind} no longer matches this operation.`);
      }
      if (!await lifecycle.activate()) return refusedEnvelope(`The Balance ${contract.kind} binding is inactive.`);
      const outcome = await lifecycle.dispatch(request.operationId);
      const stored = await options.journal.read(request.operationId);
      return { kind: "dispatched", outcome, stored, result: outcome.kind === "refused" ? { state: "failed", error: outcome.reason.message } : balanceCreateLegacyResult(stored) };
    },
  };
  return facade;
}

export function createBalanceBinding<I extends BalanceCreateInput, R extends BalanceCreateReview<I>>(options: BalanceCreateBindingOptions, contract: BalanceCreateContract<I, R>): BalanceCreateBinding {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const support = contract.support(options.connectionId, options.supportDeclarationId);
  const writer: Pick<OwnerWriter, "create" | "readback"> = options.owner ?? balanceWriter(contract.kind, { db: options.db, desk: options.desk, now: options.now });

  const receipt = (operationId: string): BalanceCreateReceipt | undefined => {
    try {
      const id = balanceCreateReceiptId(operationId);
      return loadMeta(options.db).receipts.find(item => item.id === id);
    } catch {
      return undefined;
    }
  };

  const dispatch = async (request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult> => {
    const reportedAt = at();
    if (request.snapshot.adapterId !== BALANCE_ADAPTER_ID || request.snapshot.capabilityId !== contract.capabilityId || request.snapshot.connectionId !== options.connectionId) {
      return refusedResult(request, "The approved snapshot belongs to another Balance connection or capability. Nothing was created.", reportedAt);
    }
    let input: I;
    try {
      input = contract.parse(request.snapshot.input, options.connectionId);
    } catch {
      return refusedResult(request, `The approved snapshot is not a valid Balance ${contract.kind}. Nothing was created.`, reportedAt);
    }
    const create: CreateRequest = {
      operationId: request.operationId,
      type: contract.owner,
      fields: contract.legacyFields(input),
      activation: "none",
      provenance: { ...request.snapshot.provenance, operationId: request.operationId },
      signal: signal ?? new AbortController().signal,
    };
    const earlier = receipt(request.operationId);
    if (earlier?.outlineId) return succeededResult({ ...requestParts(request), connectionId: options.connectionId, objectType: contract.kind, canonicalId: earlier.outlineId, receipt: earlier, at: reportedAt });
    const stale = (error: unknown): boolean => error instanceof Error && error.constructor === Error && error.message === STALE_OUTLINE;
    const call = async (): Promise<CreateResult> => writer.create(create);
    const uncertainFrom = (error: unknown): OwnerResult => uncertainResult(request, error instanceof Error ? error.message : "The Balance owner call failed without a result.", at(), jsonReceipt(receipt(request.operationId)));
    let result: CreateResult;
    try {
      result = await call();
    } catch (error) {
      if (!stale(error)) return uncertainFrom(error);
      try {
        result = await call();
      } catch (retry) {
        if (stale(retry)) return refusedResult(request, STALE_OUTLINE, at());
        return uncertainFrom(retry);
      }
    }
    if (result.state === "created") return succeededResult({ ...requestParts(request), connectionId: options.connectionId, objectType: contract.kind, canonicalId: result.canonicalId, receipt: jsonReceipt(receipt(request.operationId), result.canonicalId), at: at() });
    if (result.state === "failed") return refusedResult(request, result.error, at());
    return kit.accepted(request, jsonReceipt(receipt(request.operationId), result.receipt), at());
  };

  const lookup = async (request: LookupRequest): Promise<OperationLookup> => {
    const checkedAt = at();
    const checked = await kit.approvedForLookup(options.journal, request, checkedAt, "Balance");
    if ("reply" in checked) return checked.reply;
    const { stored, snapshotDigest, attempt, replies: { respond, unknown } } = checked;
    const found = receipt(request.operationId);
    if (found?.outlineId) {
      const response = succeededResult({ operationId: request.operationId, attemptId: attempt.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest, connectionId: options.connectionId, objectType: contract.kind, canonicalId: found.outlineId, receipt: found, at: checkedAt });
      return respond({ kind: "known", response });
    }
    const success = resultsOf(stored).findLast(response => response.result.kind === "succeeded");
    if (success?.result.kind === "succeeded") return respond({ kind: "known", response: success });
    const failure = resultsOf(stored).findLast(response => response.result.kind === "failed");
    if (failure?.result.kind === "failed" && failure.result.evidence.ownerRequestId === request.ownerRequestId) return respond({ kind: "no-effect", evidence: failure.result.evidence });
    return unknown("balance.receipt_missing", "Balance keeps no receipt for this operation.");
  };

  const connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup"> = {
    writerOwner: contract.owner,
    support,
    dispatch: (request, signal) => dispatch(request, signal),
    lookup: request => lookup(request),
  };

  return {
    declaration: contract.declaration(),
    support,
    bindings: balanceCreateBindings(),
    writerBinding: { stack: options.stack, owner: contract.owner, adapterId: BALANCE_ADAPTER_ID, connectionId: options.connectionId, capabilityId: contract.capabilityId },
    connector,
    receipt,
    dispatch,
    lookup,
    readback: operation => writer.readback(operation),
  };
}
