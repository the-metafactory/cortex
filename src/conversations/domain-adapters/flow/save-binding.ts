import { z } from "zod";
import type { LookupRequest } from "../../authority";
import type { CreateRequest } from "../../types";
import type { FlowOptions } from "../../../common/types/config";
import { studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { spawnWithStdin, type WriterRunner } from "../../../surface/mc/desk/create";
import { flowJson, FlowSavedResponseSchema, runFlowSave, sentence, SHOW_TIMEOUT_MS } from "./pulse-contract";
import { FlowHashSchema } from "../../../surface/mc/desk/saved-flow-contract";
import type { DispatchOutcome } from "../operations/dispatch";
import type { OperationJournalStore } from "../operations/journal";
import { buildApprovedSnapshot, ownerResultKit, requestParts, resultsOf, type OwnerResultParts } from "../operations/owner-results";
import type { ApprovedSnapshot, Authority, DispatchRequest, OperationLookup, OwnerResult, OwnerSupport, Provenance } from "../operations/types";
import { canonicalWire } from "../operations/validation";
import { adapterErrorSchema, objectSchema } from "../schema-primitives";
import type { AdapterDeclaration, ObjectReference } from "../types";
import { ObjectReferenceSchema } from "../types";
import { FLOW_ADAPTER_ID, flowName, flowReferenceSchema, flowSchemaRef, flowReadDeclaration } from "./schema";

const CAPABILITY_ID = "flow.saved.create";
const INPUT_REF = flowSchemaRef(`${CAPABILITY_ID}.input`);
const OUTPUT_REF = flowSchemaRef(`${CAPABILITY_ID}.output`);
const ERROR_REF = flowSchemaRef(`${CAPABILITY_ID}.error`);
export const FLOW_SAVE_SUPPORT_ID = "flow.saved.create.v1";
const kit = ownerResultKit("flow");

export const FlowSaveInputSchema = z.object({ stack: ObjectReferenceSchema, name: flowName, definition: z.string().min(1) }).strict();
export type FlowSaveInput = z.infer<typeof FlowSaveInputSchema>;
const Saved = FlowSavedResponseSchema.extend({ name: flowName, sha256: FlowHashSchema });
const Found = z.object({ name: flowName, source: z.literal("saved"), sha256: FlowHashSchema, provenance: z.object({ request_id: z.string() }) });
const stackRef = (connectionId: string, stack: string): ObjectReference => ({ adapterId: FLOW_ADAPTER_ID, connectionId, objectType: "stack", canonicalId: stack });

export function flowSaveDeclaration(): AdapterDeclaration {
  const reads = flowReadDeclaration();
  return {
    ...reads,
    schemas: [
      ...reads.schemas,
      { ...INPUT_REF, schema: objectSchema({ stack: flowReferenceSchema("stack"), name: { type: "string", pattern: "^F_[A-Z0-9_]{1,64}$" }, definition: { type: "string", minLength: 1 } }, ["stack", "name", "definition"]) },
      { ...OUTPUT_REF, schema: objectSchema({ ref: flowReferenceSchema("saved"), name: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["ref", "name", "sha256"]) },
      { ...ERROR_REF, schema: adapterErrorSchema(FLOW_ADAPTER_ID) },
    ],
    capabilities: [{ capabilityId: CAPABILITY_ID, label: "Save Flow", kind: "action", objectTypes: ["saved"], inputSchemaRef: INPUT_REF, outputSchemaRef: OUTPUT_REF, errorSchemaRef: ERROR_REF }],
  };
}

export function flowSaveSupport(connectionId: string): OwnerSupport {
  return {
    lifecycleVersion: "1.0.0", adapterId: FLOW_ADAPTER_ID, connectionId, capabilityId: CAPABILITY_ID, declarationId: FLOW_SAVE_SUPPORT_ID,
    dedup: { kind: "none" },
    operationLookup: "historical", conditionalUpdate: "none", cancellation: "none",
  };
}

function checkedInput(raw: unknown, connectionId: string, stack: string): FlowSaveInput {
  const input = FlowSaveInputSchema.parse(raw);
  const ref = input.stack;
  if (ref.adapterId !== FLOW_ADAPTER_ID || ref.connectionId !== connectionId || ref.objectType !== "stack" || ref.canonicalId !== stack) throw new Error("The Flow belongs to another stack or connection.");
  return input;
}

export function flowSaveApprovedSnapshot(options: { connectionId: string; stack: string; provenance: Provenance; input: FlowSaveInput; policy?: "local" | "cloud" }): ApprovedSnapshot {
  const input = checkedInput(options.input, options.connectionId, options.stack);
  return buildApprovedSnapshot({ provenance: options.provenance, adapterId: FLOW_ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID, inputSchemaRef: INPUT_REF, outputSchemaRef: OUTPUT_REF, errorSchemaRef: ERROR_REF, input, destinations: [input.stack], policy: options.policy ?? "local" });
}

export interface FlowSaveBindingOptions {
  stack: string;
  connectionId: string;
  flows: () => FlowOptions | undefined;
  journal: OperationJournalStore;
  run?: WriterRunner;
  now?: () => number;
}

export function createFlowSaveBinding(options: FlowSaveBindingOptions) {
  const at = (): string => new Date((options.now ?? Date.now)()).toISOString();
  const run = options.run ?? spawnWithStdin;
  const support = flowSaveSupport(options.connectionId);
  const success = (parts: OwnerResultParts, saved: { name: string; sha256: string }, checkedAt: string, via: "succeeded" | "found" = "succeeded"): OwnerResult => {
    const ref = { adapterId: FLOW_ADAPTER_ID, connectionId: options.connectionId, objectType: "saved", canonicalId: saved.name };
    const response = kit[via](parts, ref, { name: saved.name, sha256: saved.sha256 }, checkedAt);
    if (response.result.kind === "succeeded") response.result.output = { ref, name: saved.name, sha256: saved.sha256 };
    return response;
  };
  const dispatch = async (request: DispatchRequest, signal?: AbortSignal): Promise<OwnerResult> => {
    const refuse = (message: string) => kit.refused(request, `${sentence(message)} Nothing was created.`, at());
    const snapshot = request.snapshot;
    if (snapshot.adapterId !== FLOW_ADAPTER_ID || snapshot.capabilityId !== CAPABILITY_ID || snapshot.connectionId !== options.connectionId || request.ownerRequestId !== studioRequestId(request.operationId)) return refuse("The approved save belongs to another capability, connection or owner request.");
    let input: FlowSaveInput;
    try { input = checkedInput(snapshot.input, options.connectionId, options.stack); }
    catch { return refuse("The approved snapshot is not a valid saved Flow."); }
    if (snapshot.destinations.length !== 1 || canonicalWire(snapshot.destinations[0]) !== canonicalWire(input.stack)) return refuse("The approved destination does not match the Flow stack.");
    const flows = options.flows();
    if (!flows) return refuse("Pulse is not set up on this stack.");
    if (signal?.aborted) return refuse("The conversation stopped waiting before Pulse was called.");
    const provenance = { ...snapshot.provenance, operationId: request.operationId };
    const outcome = await runFlowSave(run, flows, input, { operationId: request.operationId, provenance, ...(signal ? { signal } : {}) });
    if (outcome.kind === "refused") return refuse(outcome.reason);
    if (outcome.kind === "unconfirmed") return kit.uncertain(request, outcome.error.message, at());
    const saved = Saved.safeParse(outcome.value);
    if (saved.success) return success(requestParts(request), saved.data, at());
    return kit.uncertain(request, "Pulse did not return a valid name and sha256 for the save. Check its saved flows before retrying.", at());
  };
  const lookup = async (request: LookupRequest): Promise<OperationLookup> => {
    const checkedAt = at();
    const checked = await kit.approvedForLookup(options.journal, request, checkedAt, "Flow");
    if ("reply" in checked) return checked.reply;
    const { stored, snapshotDigest, attempt, replies: { respond, unknown } } = checked;
    const snapshot = stored.journal.snapshot;
    if ("kind" in snapshot || snapshot.adapterId !== FLOW_ADAPTER_ID || snapshot.connectionId !== options.connectionId || snapshot.capabilityId !== CAPABILITY_ID) return unknown("flow.operation_mismatch", "This operation belongs to another Flow connection or capability.");
    const prior = resultsOf(stored).findLast(response => response.result.kind === "succeeded" || response.result.kind === "failed");
    if (prior) return respond({ kind: "known", response: prior });
    const flows = options.flows();
    if (!flows) return unknown("flow.source_unavailable", "Pulse is not set up on this stack.");
    try {
      const input = checkedInput(snapshot.input, options.connectionId, options.stack);
      const result = await run([...flows.pulse, "flow", "show", "--request-id", request.ownerRequestId, "--json"], "", SHOW_TIMEOUT_MS);
      const found = Found.safeParse(flowJson(result.stdout));
      if (result.code === 0 && found.success && found.data.name === input.name && found.data.provenance.request_id === request.ownerRequestId) return respond({ kind: "known", response: success({ operationId: request.operationId, attemptId: attempt.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest }, found.data, checkedAt, "found") });
      return unknown("flow.save_unconfirmed", "Pulse does not confirm this save. Current absence does not prove that it never happened.");
    } catch (error) {
      return unknown("flow.lookup_unavailable", error instanceof Error ? error.message : "Pulse lookup failed without a result.");
    }
  };
  return {
    declaration: flowSaveDeclaration(), support, bindings: { handlers: {}, observations: {} },
    writerBinding: { stack: options.stack, owner: "flow", adapterId: FLOW_ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID },
    connector: { writerOwner: "flow" as const, support, dispatch, lookup }, dispatch, lookup,
  };
}
export type FlowSaveBinding = ReturnType<typeof createFlowSaveBinding>;

export interface FlowSaveLifecycle {
  activate(): Promise<boolean>;
  dispatch(operationId: string): Promise<DispatchOutcome>;
}

export function createFlowSaveFacade(options: { binding: FlowSaveBinding; journal: OperationJournalStore; now?: () => number }) {
  const refuse = (reason: string) => ({ kind: "refused" as const, reason, result: { state: "failed" as const, error: `${reason} Nothing was created.` } });
  return {
    async create(request: CreateRequest, authority: Authority, lifecycle: FlowSaveLifecycle) {
      if (request.type !== "flow") return refuse("This binding only saves Flows.");
      if (request.signal.aborted) return refuse("The conversation stopped waiting before Pulse was called.");
      const { operationId: _operationId, ...provenance } = request.provenance;
      let snapshot: ApprovedSnapshot;
      try {
        snapshot = flowSaveApprovedSnapshot({ connectionId: options.binding.support.connectionId, stack: options.binding.writerBinding.stack, provenance, input: { stack: stackRef(options.binding.support.connectionId, options.binding.writerBinding.stack), name: request.fields.name ?? "", definition: request.fields.definition ?? "" } });
      } catch { return refuse("The reviewed Flow is invalid or no longer matches this operation."); }
      await options.journal.approve({ operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: studioRequestId(request.operationId), snapshot, authority, at: new Date((options.now ?? Date.now)()).toISOString() });
      if (!await lifecycle.activate()) return refuse("The Flow save binding is inactive.");
      const outcome = await lifecycle.dispatch(request.operationId);
      const stored = await options.journal.read(request.operationId);
      return { kind: "dispatched" as const, outcome, stored, result: kit.legacyResult(stored, "Flow") };
    },
  };
}
