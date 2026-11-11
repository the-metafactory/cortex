import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppState, DestinationArea } from "../../../balance";
import { areaProjects, balanceDestinations, isBalanceProjectId, resolveBalanceProject, type BalanceDestination } from "../../../surface/mc/desk/balance-destinations";
import { STALE_OUTLINE } from "../../../surface/mc/desk/balance-outline";
import { balanceWriter } from "../../../surface/mc/desk/balance-conversation-writer";
import type { DeskOptions } from "../../../surface/mc/desk/compose";
import { operationUuid } from "../../../surface/mc/desk/conversation-ids";
import { loadMeta } from "../../../surface/mc/desk/my-day";
import type { LookupRequest, TrustedConnector } from "../../authority";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../types";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { ObjectReferenceSchema } from "../types";
import { BALANCE_ADAPTER_ID as ADAPTER_ID, objectSchema, ref, referenceSchema } from "./schema";
import type { DispatchOutcome } from "../operations/dispatch";
import type { OperationJournalStore, StoredOperation } from "../operations/journal";
import type { WriterBinding } from "../operations/writer-authority";
import type { ApprovedSnapshot, Authority, DispatchRequest, Json, OperationLookup, OwnerResult, OwnerSupport, Provenance } from "../operations/types";
import { adapterErrorSchema } from "../schema-primitives";
import { buildApprovedSnapshot, createOutcome, ownerResultKit, requestParts, resultsOf, type CreateOutcome, type OwnerResultParts } from "../operations/owner-results";

const CAPABILITY_ID = "balance.task.create";
const OWNER = "balance-task";
export const BALANCE_TASK_CREATE_SUPPORT_ID = "balance.task.create.v1";
export const BALANCE_TASK_DEDUP_RETENTION_MS = 86_400_000;

const AREA_SCHEMA_REF = ref("balance.task.create.area");
const PROJECT_SCHEMA_REF = ref("balance.task.create.project");
const TASK_SCHEMA_REF = ref("balance.task.create.task");
const INPUT_SCHEMA_REF = ref("balance.task.create.input");
const OUTPUT_SCHEMA_REF = ref("balance.task.create.output");
const ERROR_SCHEMA_REF = ref("balance.task.create.error");

const INPUT_SCHEMA = objectSchema({
  area: referenceSchema("area"),
  project: referenceSchema("project"),
  title: { type: "string", minLength: 1, maxLength: 300 },
  note: { type: "string", maxLength: 10_000 },
  due: { type: "string", format: "date" },
}, ["area", "title"]);
const OUTPUT_SCHEMA = objectSchema({ ref: referenceSchema("task") }, ["ref"]);
const ERROR_SCHEMA = adapterErrorSchema(ADAPTER_ID);
const TASK_RELATIONSHIPS: AdapterDeclaration["objectTypes"][number]["relationships"] = [{ fieldPath: "/area", targetAdapterId: ADAPTER_ID, targetObjectType: "area", cardinality: "one" }, { fieldPath: "/project", targetAdapterId: ADAPTER_ID, targetObjectType: "project", cardinality: "one" }];

export function balanceTaskCreateDeclaration(): AdapterDeclaration {
  return {
    adapterId: ADAPTER_ID,
    label: "Balance",
    contractRange: "^1.0.0",
    schemas: [
      { ...AREA_SCHEMA_REF, schema: referenceSchema("area") },
      { ...PROJECT_SCHEMA_REF, schema: referenceSchema("project") },
      { ...TASK_SCHEMA_REF, schema: INPUT_SCHEMA },
      { ...INPUT_SCHEMA_REF, schema: INPUT_SCHEMA },
      { ...OUTPUT_SCHEMA_REF, schema: OUTPUT_SCHEMA },
      { ...ERROR_SCHEMA_REF, schema: ERROR_SCHEMA },
    ],
    objectTypes: [
      { objectType: "task", label: "Task", schemaRef: TASK_SCHEMA_REF, relationships: TASK_RELATIONSHIPS },
      { objectType: "area", label: "Area", schemaRef: AREA_SCHEMA_REF, relationships: [] },
      { objectType: "project", label: "Project", schemaRef: PROJECT_SCHEMA_REF, relationships: [] },
      { objectType: "task-draft", label: "Task draft", schemaRef: INPUT_SCHEMA_REF, relationships: TASK_RELATIONSHIPS },
    ],
    capabilities: [
      { capabilityId: CAPABILITY_ID, label: "Create task", kind: "action", objectTypes: ["task"], inputSchemaRef: INPUT_SCHEMA_REF, outputSchemaRef: OUTPUT_SCHEMA_REF, errorSchemaRef: ERROR_SCHEMA_REF },
    ],
  };
}

export const balanceTaskCreateBindings = (): AdapterBindings => ({ handlers: {}, observations: {} });

export function balanceTaskCreateSupport(connectionId: string, declarationId = BALANCE_TASK_CREATE_SUPPORT_ID): OwnerSupport {
  return {
    lifecycleVersion: "1.0.0",
    adapterId: ADAPTER_ID,
    connectionId,
    capabilityId: CAPABILITY_ID,
    declarationId,
    dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: BALANCE_TASK_DEDUP_RETENTION_MS, bindsSnapshot: true, concurrent: true },
    operationLookup: "historical",
    conditionalUpdate: "none",
    cancellation: "none",
  };
}

export const BalanceTaskCreateInputSchema = z.object({
  area: ObjectReferenceSchema,
  project: ObjectReferenceSchema.optional(),
  title: z.string().min(1).max(300),
  note: z.string().max(10_000).optional(),
  due: z.iso.date().optional(),
}).strict();
export type BalanceTaskCreateInput = z.infer<typeof BalanceTaskCreateInputSchema>;

export type BalanceTaskFields = Record<string, string>;
export type BalanceTaskReview =
  | { kind: "resolved"; input: BalanceTaskCreateInput; requiresFreshApproval: boolean; fields: BalanceTaskFields }
  | { kind: "choice"; field: "project"; options: BalanceDestination[]; reason: string; fields: BalanceTaskFields }
  | { kind: "refused"; reason: string; fields: BalanceTaskFields };

const refusedReview = (reason: string, fields: BalanceTaskFields): BalanceTaskReview => ({ kind: "refused", reason, fields: { ...fields } });
const reference = (connectionId: string, objectType: "area" | "project" | "task", canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });

function checkedReference(raw: ObjectReference, connectionId: string, objectType: "area" | "project"): ObjectReference {
  if (raw.adapterId !== ADAPTER_ID || raw.connectionId !== connectionId || raw.objectType !== objectType) throw new Error("balance.invalid_input");
  return raw;
}

export function parseBalanceTaskInput(raw: unknown, connectionId: string): BalanceTaskCreateInput {
  const input = BalanceTaskCreateInputSchema.parse(raw);
  checkedReference(input.area, connectionId, "area");
  if (input.project) checkedReference(input.project, connectionId, "project");
  return input;
}

export function balanceTaskLegacyFields(input: BalanceTaskCreateInput): BalanceTaskFields {
  return {
    area: input.area.canonicalId,
    ...(input.project ? { project: input.project.canonicalId } : {}),
    title: input.title,
    ...(input.note ? { note: input.note } : {}),
    ...(input.due ? { due: input.due } : {}),
  };
}

const INVALID_TASK = "A Balance task takes a title of up to 300 characters, a note of up to 10,000 and a due date in the form YYYY-MM-DD.";

export function reviewBalanceTask(fields: BalanceTaskFields, state: AppState, areas: readonly DestinationArea[], connectionId: string): BalanceTaskReview {
  const areaId = fields.area ?? "";
  const area = areas.find(item => item.id === areaId);
  if (!area) return refusedReview(`${areaId} is not a configured area.`, fields);
  const title = fields.title ?? "";
  if (title.trim().length === 0) return refusedReview("A task needs a title.", fields);
  const areaRef = reference(connectionId, "area", area.id);
  const extra = { ...(fields.note ? { note: fields.note } : {}), ...(fields.due ? { due: fields.due } : {}) };
  const resolved = (input: Record<string, unknown>, requiresFreshApproval: boolean): BalanceTaskReview => {
    const parsed = BalanceTaskCreateInputSchema.safeParse(input);
    return parsed.success ? { kind: "resolved", input: parsed.data, requiresFreshApproval, fields: { ...fields } } : refusedReview(INVALID_TASK, fields);
  };
  const project = (fields.project ?? "").trim();
  if (!project) return resolved({ area: areaRef, ...extra, title }, false);
  const open = areaProjects(balanceDestinations(state.outline, areas), area.id);
  const chosen = resolveBalanceProject(open, project);
  if (chosen) return resolved({ area: areaRef, project: reference(connectionId, "project", chosen.id), ...extra, title }, chosen.id !== project);
  if (isBalanceProjectId(project)) return refusedReview(`That project is not open in ${area.label}.`, fields);
  const titled = open.filter(item => item.title.trim().toLocaleLowerCase() === project.toLocaleLowerCase());
  if (titled.length > 1) return { kind: "choice", field: "project", options: titled, reason: `More than one open project in ${area.label} is named ${project}. Choose one.`, fields: { ...fields } };
  return refusedReview(`That project is not open in ${area.label}.`, fields);
}

export interface BalanceTaskSnapshotOptions {
  connectionId: string;
  provenance: Provenance;
  input: BalanceTaskCreateInput;
  policy?: "local" | "cloud";
}

export function balanceTaskApprovedSnapshot(options: BalanceTaskSnapshotOptions): ApprovedSnapshot {
  const input = parseBalanceTaskInput(options.input, options.connectionId);
  return buildApprovedSnapshot({
    provenance: options.provenance,
    adapterId: ADAPTER_ID,
    connectionId: options.connectionId,
    capabilityId: CAPABILITY_ID,
    inputSchemaRef: INPUT_SCHEMA_REF,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    errorSchemaRef: ERROR_SCHEMA_REF,
    input,
    destinations: [input.area, ...(input.project ? [input.project] : [])],
    policy: options.policy ?? "local",
  });
}

export function balanceTaskReceiptId(operationId: string): string {
  return operationUuid(operationId);
}

const refusedEnvelope = (reason: string): BalanceTaskFacadeOutcome => ({ kind: "refused", reason, result: { state: "failed", error: `${reason} Nothing was created.` } });

export type BalanceTaskReceipt = ReturnType<typeof loadMeta>["receipts"][number];

export interface BalanceTaskBindingOptions {
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

export interface BalanceTaskBinding {
  readonly declaration: AdapterDeclaration;
  readonly support: OwnerSupport;
  readonly bindings: AdapterBindings;
  readonly writerBinding: WriterBinding;
  readonly connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup">;
  receipt(operationId: string): BalanceTaskReceipt | undefined;
  dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult>;
  lookup(request: LookupRequest, signal?: AbortSignal): Promise<OperationLookup>;
  readback(operation: OperationRecord): Promise<ReadbackResult>;
}

const kit = ownerResultKit("balance");
const succeededResult = (options: OwnerResultParts & { readonly connectionId: string; readonly canonicalId: string; readonly receipt: Json; readonly at: string }): OwnerResult => kit.succeeded(options, reference(options.connectionId, "task", options.canonicalId), options.receipt, options.at);
const { refused: refusedResult, uncertain: uncertainResult } = kit;

const jsonReceipt = (receipt: BalanceTaskReceipt | undefined, canonicalId?: string): Json => {
  if (receipt !== undefined) return receipt;
  if (canonicalId === undefined) return {};
  return { canonicalId };
};

export type BalanceTaskCreateOutcome = CreateOutcome;
export const balanceTaskCreateOutcome = createOutcome;

export const balanceTaskLegacyResult = (stored: StoredOperation | null): CreateResult => kit.legacyResult(stored, "Balance");

export interface BalanceTaskLifecycle {
  activate(): Promise<boolean>;
  dispatch(operationId: string): Promise<DispatchOutcome>;
}

export interface BalanceTaskFacadeOptions {
  binding: BalanceTaskBinding;
  journal: OperationJournalStore;
  areas: () => readonly DestinationArea[];
  state: () => AppState | null;
  now?: () => number;
}

export type BalanceTaskFacadeOutcome =
  | { kind: "refused"; reason: string; result: CreateResult }
  | { kind: "dispatched"; outcome: DispatchOutcome; stored: StoredOperation | null; result: CreateResult };

export interface BalanceTaskFacade {
  review(fields: BalanceTaskFields): BalanceTaskReview;
  create(request: CreateRequest, authority: Authority, lifecycle: BalanceTaskLifecycle): Promise<BalanceTaskFacadeOutcome>;
}

export function createBalanceTaskFacade(options: BalanceTaskFacadeOptions): BalanceTaskFacade {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const facade: BalanceTaskFacade = {
    review(fields) {
      const state = options.state();
      if (!state) return refusedReview("Balance has no saved outline on this stack yet.", fields);
      return reviewBalanceTask(fields, state, options.areas(), options.binding.support.connectionId);
    },
    async create(request, authority, lifecycle) {
      const review = facade.review(request.fields);
      if (review.kind !== "resolved") return refusedEnvelope(review.reason);
      let snapshot: ApprovedSnapshot;
      try {
        snapshot = balanceTaskApprovedSnapshot({ connectionId: options.binding.support.connectionId, provenance: { conversationId: request.provenance.conversationId, proposalId: request.provenance.proposalId, revision: request.provenance.revision, entryId: request.provenance.entryId, link: request.provenance.link }, input: review.input });
      } catch {
        return refusedEnvelope("The reviewed Balance task is not an approvable task.");
      }
      try {
        await options.journal.approve({ operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: operationUuid(request.operationId), snapshot, authority, at: at() });
      } catch {
        return refusedEnvelope("The approved Balance task no longer matches this operation.");
      }
      if (!await lifecycle.activate()) return refusedEnvelope("The Balance task binding is inactive.");
      const outcome = await lifecycle.dispatch(request.operationId);
      const stored = await options.journal.read(request.operationId);
      return { kind: "dispatched", outcome, stored, result: balanceTaskLegacyResult(stored) };
    },
  };
  return facade;
}

export function createBalanceTaskBinding(options: BalanceTaskBindingOptions): BalanceTaskBinding {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const support = balanceTaskCreateSupport(options.connectionId, options.supportDeclarationId);
  const writer: Pick<OwnerWriter, "create" | "readback"> = options.owner ?? balanceWriter("task", { db: options.db, desk: options.desk, now: options.now });

  const receipt = (operationId: string): BalanceTaskReceipt | undefined => {
    try {
      const id = balanceTaskReceiptId(operationId);
      return loadMeta(options.db).receipts.find(item => item.id === id);
    } catch {
      return undefined;
    }
  };

  const dispatch = async (request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult> => {
    const reportedAt = at();
    if (request.snapshot.adapterId !== ADAPTER_ID || request.snapshot.capabilityId !== CAPABILITY_ID || request.snapshot.connectionId !== options.connectionId) {
      return refusedResult(request, "The approved snapshot belongs to another Balance connection or capability. Nothing was created.", reportedAt);
    }
    let input: BalanceTaskCreateInput;
    try {
      input = parseBalanceTaskInput(request.snapshot.input, options.connectionId);
    } catch {
      return refusedResult(request, "The approved snapshot is not a valid Balance task. Nothing was created.", reportedAt);
    }
    const create: CreateRequest = {
      operationId: request.operationId,
      type: "balance-task",
      fields: balanceTaskLegacyFields(input),
      activation: "none",
      provenance: { ...request.snapshot.provenance, operationId: request.operationId },
      signal: signal ?? new AbortController().signal,
    };
    const earlier = receipt(request.operationId);
    if (earlier?.outlineId) return succeededResult({ ...requestParts(request), connectionId: options.connectionId, canonicalId: earlier.outlineId, receipt: earlier, at: reportedAt });
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
    if (result.state === "created") return succeededResult({ ...requestParts(request), connectionId: options.connectionId, canonicalId: result.canonicalId, receipt: jsonReceipt(receipt(request.operationId), result.canonicalId), at: at() });
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
      const response = succeededResult({ operationId: request.operationId, attemptId: attempt.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest, connectionId: options.connectionId, canonicalId: found.outlineId, receipt: found, at: checkedAt });
      return respond({ kind: "known", response });
    }
    const success = resultsOf(stored).findLast(response => response.result.kind === "succeeded");
    if (success?.result.kind === "succeeded") return respond({ kind: "known", response: success });
    const failure = resultsOf(stored).findLast(response => response.result.kind === "failed");
    if (failure?.result.kind === "failed" && failure.result.evidence.ownerRequestId === request.ownerRequestId) return respond({ kind: "no-effect", evidence: failure.result.evidence });
    return unknown("balance.receipt_missing", "Balance keeps no receipt for this operation.");
  };

  const connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup"> = {
    writerOwner: OWNER,
    support,
    dispatch: (request, signal) => dispatch(request, signal),
    lookup: request => lookup(request),
  };

  return {
    declaration: balanceTaskCreateDeclaration(),
    support,
    bindings: balanceTaskCreateBindings(),
    writerBinding: { stack: options.stack, owner: OWNER, adapterId: ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID },
    connector,
    receipt,
    dispatch,
    lookup,
    readback: operation => writer.readback(operation),
  };
}
