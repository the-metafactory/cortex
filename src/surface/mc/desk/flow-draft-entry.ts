import type { ConversationHost } from "../../../conversations/host";
import { studioRequestId } from "../../../conversations/conversation-ids";
import type { DraftDestinations } from "../../../conversations/domain-adapters/drafting";
import { flowSaveApprovedSnapshot, FLOW_STACK_RESOLVER, FlowSaveInputSchema, type FlowSaveInput } from "../../../conversations/domain-adapters/flow/save-binding";
import { flowSaveDraftingBinding } from "../../../conversations/domain-adapters/drafting/flow";
import { ownerDraftEditor, type OwnerDraft, type OwnerDraftEntryOptions, type OwnerDraftSession, type OwnerDraftSetup } from "./owner-draft-entry";

export type FlowDraftSession = OwnerDraftSession;
export type FlowDraftEntryOptions = OwnerDraftEntryOptions<FlowDraftSession> & { readonly stack: string };
export type FlowDraftSetup = OwnerDraftSetup<FlowDraftSession>;

export function singleStackDestinations(options: { connectionId: string; stack: string }): DraftDestinations & { batch(): DraftDestinations } {
  const destinations: DraftDestinations & { batch(): DraftDestinations } = {
    batch: () => destinations,
    resolve: request => Promise.resolve(request.connectionId !== options.connectionId || request.capabilityId !== FLOW_STACK_RESOLVER || request.objectType !== "stack" ? { kind: "unavailable" } : request.label.trim() === "" ? { kind: "none" } : { kind: "unique", ref: { adapterId: "flow", connectionId: options.connectionId, objectType: "stack", canonicalId: options.stack } }),
  };
  return destinations;
}

export function deskFlowDraftEditor(host: ConversationHost, deps: FlowDraftSetup["deps"], options: FlowDraftEntryOptions) {
  const flowSaveDraft: OwnerDraft<FlowSaveInput> = {
    adapterId: "flow",
    capabilityId: "flow.saved.create",
    label: "Flow",
    binding: flowSaveDraftingBinding,
    resolveWith: FLOW_STACK_RESOLVER,
    unavailable: "The Flow stack is unavailable; review the draft again.",
    savesLocally: true,
    conversationSourcesOnly: true,
    parse: raw => FlowSaveInputSchema.parse(raw),
    references: input => [input.stack],
    snapshot: snapshot => flowSaveApprovedSnapshot({ connectionId: snapshot.connectionId, stack: options.stack, provenance: snapshot.provenance, input: snapshot.input, policy: "local" }),
    requestId: studioRequestId,
  };
  return ownerDraftEditor(host, deps, options, flowSaveDraft, singleStackDestinations({ connectionId: options.connectionId, stack: options.stack }));
}
