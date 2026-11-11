import type { ConversationHost } from "../../../conversations/host";
import type { DraftModel } from "../../../conversations/domain-adapters/drafting";
import { flowSaveDraftingBinding, withDefinitionName } from "../../../conversations/domain-adapters/drafting/flow";
import { FLOW_DESTINATIONS_CAPABILITY, flowStackRef } from "../../../conversations/domain-adapters/flow/destinations";
import { FlowSaveInputSchema, flowSaveApprovedSnapshot, flowSaveRefusal, type FlowSaveInput } from "../../../conversations/domain-adapters/flow/save-binding";
import { studioRequestId } from "../../../conversations/conversation-ids";
import { flowDraftDestinations, type FlowDraftDestinations } from "./flow-draft-destinations";
import { ownerDraftEditor, type OwnerDraft, type OwnerDraftEntryOptions, type OwnerDraftSession, type OwnerDraftSetup } from "./owner-draft-entry";

export type FlowDraftSession = OwnerDraftSession;

export interface FlowDraftEntryOptions extends OwnerDraftEntryOptions<FlowDraftSession> {
  readonly stack: string;
}

export type FlowDraftSetup = Omit<OwnerDraftSetup<FlowDraftSession>, "options"> & { readonly options: FlowDraftEntryOptions };

export function parseFlowSaveInput(raw: unknown, connectionId: string, stack: string): FlowSaveInput {
  const input = FlowSaveInputSchema.parse(raw);
  const ref = input.stack;
  if (ref.adapterId !== "flow" || ref.connectionId !== connectionId || ref.objectType !== "stack" || ref.canonicalId !== stack) throw new Error("The Flow belongs to another stack or connection.");
  return input;
}

export function deskFlowDraftEditor(host: ConversationHost, deps: FlowDraftSetup["deps"], options: FlowDraftEntryOptions) {
  const destinations = flowDraftDestinations({ connectionId: options.connectionId, stack: options.stack, authority: options.authority });
  const flowDraft: OwnerDraft<FlowSaveInput, FlowDraftDestinations> = {
    adapterId: "flow",
    capabilityId: "flow.saved.create",
    label: "Flow",
    binding: flowSaveDraftingBinding,
    resolveWith: FLOW_DESTINATIONS_CAPABILITY,
    unavailable: "The Flow stack is unavailable; review the draft again.",
    parse: raw => parseFlowSaveInput(raw, options.connectionId, options.stack),
    references: input => [input.stack],
    failure: operationId => flowSaveRefusal(host.lifecycleJournal(deps.registry), { operationId, connectionId: options.connectionId }),
    snapshot: ({ connectionId, provenance, input, policy }) => flowSaveApprovedSnapshot({ connectionId, stack: options.stack, provenance, input, policy }),
    requestId: studioRequestId,
  };
  const model: DraftModel = { ...deps.model, generate: async request => { const result = await deps.model.generate(request); return { ...result, output: withDefinitionName(result.output) }; } };
  const defaults = () => ({ "/stack": flowStackRef(options.connectionId, options.stack) });
  return ownerDraftEditor(host, { ...deps, model, defaults }, options, flowDraft, destinations);
}
