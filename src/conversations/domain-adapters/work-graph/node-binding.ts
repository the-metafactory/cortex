// glossary-ignore: node
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { GRAPH_AUTONOMIES, GRAPH_KINDS } from "../../catalog";
import type { LookupRequest, TrustedConnector } from "../../authority";
import type { CreateRequest, CreateResult, ReadbackResult } from "../../types";
import { studioRequestId } from "../../conversation-ids";
import type { DeskOptions } from "../../../surface/mc/desk/compose";
import { spawnWithStdin, type WriterRunner } from "../../../surface/mc/desk/create";
import { ADD_TIMEOUT_MS, GRAPH_LABEL, graphAnswer, graphBody, graphMarker, graphReadbackById, recordGraphOperation, repositoryRefusal, withBodyFile, type GraphWriterDeps } from "../../../surface/mc/desk/graph-conversation-writer";
import type { DispatchOutcome } from "../operations/dispatch";
import type { OperationJournalStore, StoredOperation } from "../operations/journal";
import type { ApprovedSnapshot, Authority, DispatchRequest, Json, OperationLookup, OwnerResult, OwnerSupport, Provenance } from "../operations/types";
import { buildApprovedSnapshot, createOutcome, ownerResultKit, requestParts, resultsOf, type CreateOutcome } from "../operations/owner-results";
import type { WriterBinding } from "../operations/writer-authority";
import { adapterErrorSchema, objectSchema, schemaRef } from "../schema-primitives";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { ObjectReferenceSchema } from "../types";
import { WORK_GRAPH_ADAPTER_ID as ADAPTER_ID, referenceSchema } from "./schema";

const CAPABILITY_ID = "work-graph.node.create";
const OWNER = "graph-node";
export const WORK_GRAPH_NODE_CREATE_SUPPORT_ID = "work-graph.node.create.v1";
export const WORK_GRAPH_NODE_DEDUP_RETENTION_MS = 31_536_000_000;
export const DEFAULT_GRAPH_AUTONOMY = "approve";
export const DEFAULT_GRAPH_KIND = "grilling";

const REPOSITORY_SCHEMA_REF = schemaRef("work-graph.node.create.repository");
const NODE_SCHEMA_REF = schemaRef("work-graph.node.create.node");
const INPUT_SCHEMA_REF = schemaRef("work-graph.node.create.input");
const OUTPUT_SCHEMA_REF = schemaRef("work-graph.node.create.output");
const ERROR_SCHEMA_REF = schemaRef("work-graph.node.create.error");

const NODE_VALUE_SCHEMA = objectSchema({ title: { type: "string", minLength: 1 } }, ["title"]);
const INPUT_SCHEMA = objectSchema({
  repository: referenceSchema("repository"),
  parent: referenceSchema("node"),
  title: { type: "string", minLength: 1, maxLength: 300 },
  checkpoint: { type: "string", minLength: 1 },
  body: { type: "string" },
  dependencies: { type: "array", items: referenceSchema("node") },
  autonomy: { type: "string", enum: [...GRAPH_AUTONOMIES] },
  kind: { type: "string", enum: [...GRAPH_KINDS] },
}, ["repository", "parent", "title", "checkpoint"]);
const OUTPUT_SCHEMA = objectSchema({ ref: referenceSchema("node") }, ["ref"]);
const ERROR_SCHEMA = adapterErrorSchema(ADAPTER_ID);

export function workGraphNodeCreateDeclaration(): AdapterDeclaration {
  return {
    adapterId: ADAPTER_ID,
    label: "Work graph",
    contractRange: "^1.0.0",
    schemas: [
      { ...REPOSITORY_SCHEMA_REF, schema: NODE_VALUE_SCHEMA },
      { ...NODE_SCHEMA_REF, schema: NODE_VALUE_SCHEMA },
      { ...INPUT_SCHEMA_REF, schema: INPUT_SCHEMA },
      { ...OUTPUT_SCHEMA_REF, schema: OUTPUT_SCHEMA },
      { ...ERROR_SCHEMA_REF, schema: ERROR_SCHEMA },
    ],
    objectTypes: [
      { objectType: "repository", label: "Repository", schemaRef: REPOSITORY_SCHEMA_REF, relationships: [] },
      { objectType: "node", label: "Node", schemaRef: NODE_SCHEMA_REF, relationships: [] },
      { objectType: "node-draft", label: "Node draft", schemaRef: INPUT_SCHEMA_REF, relationships: [
        { fieldPath: "/repository", targetAdapterId: ADAPTER_ID, targetObjectType: "repository", cardinality: "one" },
        { fieldPath: "/parent", targetAdapterId: ADAPTER_ID, targetObjectType: "node", cardinality: "one" },
        { fieldPath: "/dependencies", targetAdapterId: ADAPTER_ID, targetObjectType: "node", cardinality: "many" },
      ] },
    ],
    capabilities: [
      { capabilityId: CAPABILITY_ID, label: "File node", kind: "action", objectTypes: ["node"], inputSchemaRef: INPUT_SCHEMA_REF, outputSchemaRef: OUTPUT_SCHEMA_REF, errorSchemaRef: ERROR_SCHEMA_REF },
    ],
  };
}

export const workGraphNodeCreateBindings = (): AdapterBindings => ({ handlers: {}, observations: {} });

export function workGraphNodeCreateSupport(connectionId: string, declarationId = WORK_GRAPH_NODE_CREATE_SUPPORT_ID): OwnerSupport {
  return {
    lifecycleVersion: "1.0.0",
    adapterId: ADAPTER_ID,
    connectionId,
    capabilityId: CAPABILITY_ID,
    declarationId,
    dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: WORK_GRAPH_NODE_DEDUP_RETENTION_MS, bindsSnapshot: true, concurrent: true },
    operationLookup: "historical",
    conditionalUpdate: "none",
    cancellation: "none",
  };
}

export const WorkGraphNodeCreateInputSchema = z.object({
  repository: ObjectReferenceSchema,
  parent: ObjectReferenceSchema,
  title: z.string().min(1).max(300),
  checkpoint: z.string().min(1),
  body: z.string().optional(),
  dependencies: z.array(ObjectReferenceSchema).optional(),
  autonomy: z.enum(GRAPH_AUTONOMIES).optional(),
  kind: z.enum(GRAPH_KINDS).optional(),
}).strict();
export type WorkGraphNodeCreateInput = z.infer<typeof WorkGraphNodeCreateInputSchema>;

const reference = (connectionId: string, objectType: "repository" | "node", canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
const flagShaped = (value: string): boolean => value.startsWith("-");
const list = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(Boolean);
const oneOf = <T extends string>(values: readonly T[], value: string | undefined, fallback: T): T | null => {
  const chosen = value?.trim() ? value.trim() : fallback;
  return (values as readonly string[]).includes(chosen) ? (chosen as T) : null;
};

function checkedReference(raw: ObjectReference, connectionId: string, objectType: "repository" | "node"): void {
  if (raw.adapterId !== ADAPTER_ID || raw.connectionId !== connectionId || raw.objectType !== objectType) throw new Error("work-graph.invalid_input");
}

export function parseWorkGraphNodeInput(raw: unknown, connectionId: string): WorkGraphNodeCreateInput {
  const input = WorkGraphNodeCreateInputSchema.parse(raw);
  checkedReference(input.repository, connectionId, "repository");
  checkedReference(input.parent, connectionId, "node");
  for (const dependency of input.dependencies ?? []) checkedReference(dependency, connectionId, "node");
  return input;
}

export type WorkGraphNodeFields = Record<string, string>;
export type WorkGraphNodeReview =
  | { kind: "resolved"; input: WorkGraphNodeCreateInput; fields: WorkGraphNodeFields }
  | { kind: "refused"; reason: string; fields: WorkGraphNodeFields };

const refusedReview = (reason: string, fields: WorkGraphNodeFields): WorkGraphNodeReview => ({ kind: "refused", reason, fields: { ...fields } });

export function reviewWorkGraphNode(fields: WorkGraphNodeFields, connectionId: string, db: Database): WorkGraphNodeReview {
  const repository = fields.repository ?? "";
  if (repositoryRefusal(db, repository)) return refusedReview(`This conversation may not file to ${repository}.`, fields);
  const autonomy = oneOf(GRAPH_AUTONOMIES, fields.autonomy, DEFAULT_GRAPH_AUTONOMY);
  if (!autonomy) return refusedReview("A conversation may file only approve or propose nodes.", fields);
  const kind = oneOf(GRAPH_KINDS, fields.kind, DEFAULT_GRAPH_KIND);
  if (!kind) return refusedReview("A conversation may file only research, grilling, prototype, task or build nodes.", fields);
  const parent = (fields.parent ?? "").trim();
  const dependencies = list(fields.dependencies);
  if (!parent || [parent, ...dependencies].some(flagShaped)) return refusedReview("The parent and the dependencies must be node references, not options.", fields);
  const body = fields.body?.trim();
  const candidate = {
    repository: reference(connectionId, "repository", repository),
    parent: reference(connectionId, "node", parent),
    title: fields.title ?? "",
    checkpoint: fields.checkpoint ?? "",
    ...(body ? { body } : {}),
    ...(dependencies.length ? { dependencies: dependencies.map(dependency => reference(connectionId, "node", dependency)) } : {}),
    autonomy,
    kind,
  };
  const parsed = WorkGraphNodeCreateInputSchema.safeParse(candidate);
  return parsed.success ? { kind: "resolved", input: parsed.data, fields: { ...fields } } : refusedReview("A node needs a title of up to 300 characters and a checkpoint.", fields);
}

export interface WorkGraphNodeSnapshotOptions {
  connectionId: string;
  provenance: Provenance;
  input: WorkGraphNodeCreateInput;
  policy?: "local" | "cloud";
}

export function workGraphNodeApprovedSnapshot(options: WorkGraphNodeSnapshotOptions): ApprovedSnapshot {
  const parsed = parseWorkGraphNodeInput(options.input, options.connectionId);
  const input = { ...parsed, autonomy: parsed.autonomy ?? DEFAULT_GRAPH_AUTONOMY, kind: parsed.kind ?? DEFAULT_GRAPH_KIND };
  return buildApprovedSnapshot({
    provenance: options.provenance,
    adapterId: ADAPTER_ID,
    connectionId: options.connectionId,
    capabilityId: CAPABILITY_ID,
    inputSchemaRef: INPUT_SCHEMA_REF,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    errorSchemaRef: ERROR_SCHEMA_REF,
    input,
    destinations: [input.repository],
    policy: options.policy ?? "cloud",
  });
}

export const workGraphNodeRequestId = (operationId: string): string => studioRequestId(operationId);

const kit = ownerResultKit("work-graph");
const succeededResult = (parts: Parameters<typeof kit.succeeded>[0], connectionId: string, canonicalId: string, receipt: Json, at: string, via: "succeeded" | "found" = "succeeded"): OwnerResult => kit[via](parts, reference(connectionId, "node", canonicalId), receipt, at);
const { refused: refusedResult, uncertain: uncertainResult } = kit;

export type WorkGraphNodeCreateOutcome = CreateOutcome;
export const workGraphNodeCreateOutcome = createOutcome;

const lastLine = (text: string): string => text.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";
const receiptUrl = (receipt: Json): string | undefined => {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
  const url = receipt.url;
  return typeof url === "string" ? url : undefined;
};

export function workGraphNodeLegacyResult(stored: StoredOperation | null): CreateResult {
  const result = kit.legacyResult(stored, "graph");
  const success = stored ? resultsOf(stored).findLast(response => response.result.kind === "succeeded") : undefined;
  const url = success?.result.kind === "succeeded" ? receiptUrl(success.result.evidence.receipt) : undefined;
  return result.state === "created" && url ? { ...result, url } : result;
}

export interface WorkGraphNodeBindingOptions {
  stack: string;
  connectionId: string;
  db: Database;
  desk: () => DeskOptions | undefined;
  journal: OperationJournalStore;
  run?: WriterRunner;
  now?: () => number;
  supportDeclarationId?: string;
}

export interface WorkGraphNodeBinding {
  readonly declaration: AdapterDeclaration;
  readonly support: OwnerSupport;
  readonly bindings: AdapterBindings;
  readonly writerBinding: WriterBinding;
  readonly connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup">;
  dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult>;
  lookup(request: LookupRequest, signal?: AbortSignal): Promise<OperationLookup>;
  readback(operationId: string): Promise<ReadbackResult>;
}

export function createWorkGraphNodeBinding(options: WorkGraphNodeBindingOptions): WorkGraphNodeBinding {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const support = workGraphNodeCreateSupport(options.connectionId, options.supportDeclarationId);
  const run = options.run ?? spawnWithStdin;
  const deps: GraphWriterDeps = { db: options.db, desk: options.desk, run, ...(options.now ? { now: options.now } : {}) };
  const readback = graphReadbackById(deps);

  const dispatchUnserialized = async (request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult> => {
    const reportedAt = at();
    const refuse = (message: string): OwnerResult => refusedResult(request, `${message} Nothing was created.`, reportedAt);
    const snapshot = request.snapshot;
    if (snapshot.adapterId !== ADAPTER_ID || snapshot.capabilityId !== CAPABILITY_ID || snapshot.connectionId !== options.connectionId) return refuse("The approved snapshot belongs to another graph connection or capability.");
    let input: WorkGraphNodeCreateInput;
    try {
      input = parseWorkGraphNodeInput(snapshot.input, options.connectionId);
    } catch {
      return refuse("The approved snapshot is not a valid graph node.");
    }
    const somaBin = options.desk()?.somaBin;
    if (!somaBin) return refuse("Soma is not set up on this stack.");
    const repository = input.repository.canonicalId;
    if (repositoryRefusal(options.db, repository)) return refuse(`This conversation may not file to ${repository}.`);
    const autonomy = oneOf(GRAPH_AUTONOMIES, input.autonomy, DEFAULT_GRAPH_AUTONOMY);
    if (!autonomy) return refuse("A conversation may file only approve or propose nodes.");
    const kind = oneOf(GRAPH_KINDS, input.kind, DEFAULT_GRAPH_KIND);
    if (!kind) return refuse("A conversation may file only research, grilling, prototype, task or build nodes.");
    const parent = input.parent.canonicalId;
    const dependencies = (input.dependencies ?? []).map(dependency => dependency.canonicalId);
    if ([parent, ...dependencies].some(flagShaped)) return refuse("The parent and the dependencies must be node references, not options.");
    if (signal?.aborted) return refuse("The conversation stopped waiting before soma was called.");
    const head = ["graph", "add", parent, "--repo", repository, "--title", input.title, "--autonomy", autonomy, "--kind", kind, "--label", GRAPH_LABEL, "--checkpoint", input.checkpoint];
    const tail = [...dependencies.flatMap(dependency => ["--blocked-by", dependency]), "--once", graphMarker(request.operationId), "--json"];
    const provenance = { ...snapshot.provenance, operationId: request.operationId };
    try {
      recordGraphOperation(options.db, request.operationId, { repository, parent, args: [...head, ...tail] }, (options.now ?? Date.now)());
      const result = await withBodyFile(graphBody(input.body, provenance), file => run([somaBin, ...head, "--body-file", file, ...tail], "", ADD_TIMEOUT_MS));
      if (result.code !== 0) {
        const line = lastLine(result.stderr);
        return uncertainResult(request, line ? `soma graph add exited with code ${result.code}: ${line}` : `soma graph add exited with code ${result.code}.`, at());
      }
      const answer = graphAnswer(result, "add");
      if (answer.state !== "created") return uncertainResult(request, "soma graph add answered without a node. Check the graph before retrying.", at());
      return succeededResult(requestParts(request), options.connectionId, answer.canonicalId, { canonicalId: answer.canonicalId, ...(answer.url ? { url: answer.url } : {}) }, at());
    } catch (error) {
      return uncertainResult(request, error instanceof Error ? error.message : "The graph call failed without a result.", at());
    }
  };

  const filing = new Map<string, Promise<unknown>>();
  const dispatch = (request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult> => {
    const turn = (filing.get(request.operationId) ?? Promise.resolve()).then(() => dispatchUnserialized(request, signal));
    const settled = turn.catch(() => undefined);
    filing.set(request.operationId, settled);
    return turn.finally(() => { if (filing.get(request.operationId) === settled) filing.delete(request.operationId); });
  };

  const lookup = async (request: LookupRequest): Promise<OperationLookup> => {
    const checkedAt = at();
    const checked = await kit.approvedForLookup(options.journal, request, checkedAt, "graph");
    if ("reply" in checked) return checked.reply;
    const { stored, snapshotDigest, attempt, replies: { respond, unknown } } = checked;
    const success = resultsOf(stored).findLast(response => response.result.kind === "succeeded");
    if (success?.result.kind === "succeeded") return respond({ kind: "known", response: success });
    const found = await readback(request.operationId);
    if (!found?.found) return unknown("work-graph.node_unconfirmed", "The graph does not confirm a node for this operation under the requested parent.");
    const parts = { operationId: request.operationId, attemptId: attempt.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest };
    return respond({ kind: "known", response: succeededResult(parts, options.connectionId, found.canonicalId, { canonicalId: found.canonicalId, ...(found.url ? { url: found.url } : {}) }, checkedAt, "found") });
  };

  return {
    declaration: workGraphNodeCreateDeclaration(),
    support,
    bindings: workGraphNodeCreateBindings(),
    writerBinding: { stack: options.stack, owner: OWNER, adapterId: ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID },
    connector: { writerOwner: OWNER, support, dispatch: (request, signal) => dispatch(request, signal), lookup: request => lookup(request) },
    dispatch,
    lookup,
    readback,
  };
}

export interface WorkGraphNodeLifecycle {
  activate(): Promise<boolean>;
  dispatch(operationId: string): Promise<DispatchOutcome>;
}

export interface WorkGraphNodeFacadeOptions {
  binding: WorkGraphNodeBinding;
  journal: OperationJournalStore;
  db: Database;
  now?: () => number;
}

export type WorkGraphNodeFacadeOutcome =
  | { kind: "refused"; reason: string; result: CreateResult }
  | { kind: "dispatched"; outcome: DispatchOutcome; stored: StoredOperation | null; result: CreateResult };

export interface WorkGraphNodeFacade {
  review(fields: WorkGraphNodeFields): WorkGraphNodeReview;
  create(request: CreateRequest, authority: Authority, lifecycle: WorkGraphNodeLifecycle): Promise<WorkGraphNodeFacadeOutcome>;
}

const refusedEnvelope = (message: string): WorkGraphNodeFacadeOutcome => ({ kind: "refused", reason: message, result: { state: "failed", error: `${message} Nothing was created.` } });

export function createWorkGraphNodeFacade(options: WorkGraphNodeFacadeOptions): WorkGraphNodeFacade {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const facade: WorkGraphNodeFacade = {
    review: fields => reviewWorkGraphNode(fields, options.binding.support.connectionId, options.db),
    async create(request, authority, lifecycle) {
      const review = facade.review(request.fields);
      if (review.kind !== "resolved") return refusedEnvelope(review.reason);
      let snapshot: ApprovedSnapshot;
      try {
        snapshot = workGraphNodeApprovedSnapshot({ connectionId: options.binding.support.connectionId, provenance: { conversationId: request.provenance.conversationId, proposalId: request.provenance.proposalId, revision: request.provenance.revision, entryId: request.provenance.entryId, link: request.provenance.link }, input: review.input });
      } catch {
        return refusedEnvelope("The reviewed graph node is not an approvable node.");
      }
      try {
        await options.journal.approve({ operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: workGraphNodeRequestId(request.operationId), snapshot, authority, at: at() });
      } catch {
        return refusedEnvelope("The approved graph node no longer matches this operation.");
      }
      if (!await lifecycle.activate()) return refusedEnvelope("The graph node binding is inactive.");
      const outcome = await lifecycle.dispatch(request.operationId);
      const stored = await options.journal.read(request.operationId);
      return { kind: "dispatched", outcome, stored, result: workGraphNodeLegacyResult(stored) };
    },
  };
  return facade;
}
