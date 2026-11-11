import type { ConversationHost } from "../../../conversations/host";
import type { DraftServiceDeps } from "../../../conversations/domain-adapters/drafting";
import { balanceTaskApprovedSnapshot, balanceTaskReceiptId, parseBalanceTaskInput, type BalanceTaskCreateInput } from "../../../conversations/domain-adapters/balance/task-binding";
import { balanceTaskDraftingBinding } from "../../../conversations/domain-adapters/drafting/balance";
import { balanceDraftDestinations, type BalanceDraftReadSession } from "./balance-draft-destinations";
import { ownerDraftEditor, type OwnerDraft, type OwnerDraftEntryOptions, type OwnerDraftSession } from "./owner-draft-entry";

export interface BalanceDraftSession extends BalanceDraftReadSession, OwnerDraftSession {}
export type BalanceDraftEntryOptions = OwnerDraftEntryOptions<BalanceDraftSession>;

export interface BalanceDraftSetup {
  readonly host: ConversationHost;
  readonly deps: Omit<DraftServiceDeps, "destinations" | "bindings">;
  readonly options: BalanceDraftEntryOptions;
}

export function deskBalanceDraftEditor(host: ConversationHost, deps: BalanceDraftSetup["deps"], options: BalanceDraftEntryOptions) {
  const destinations = balanceDraftDestinations(options);
  const balanceTaskDraft: OwnerDraft<BalanceTaskCreateInput> = {
    adapterId: "balance",
    capabilityId: "balance.task.create",
    label: "Balance task",
    binding: balanceTaskDraftingBinding,
    resolveWith: "balance.destinations",
    unavailable: "A Balance area or project is unavailable or ambiguous; review the draft again.",
    parse: parseBalanceTaskInput,
    references: input => [input.area, ...input.project ? [input.project] : []],
    inconsistency: async (input, conversationId) => input.project && !await destinations.inArea(conversationId, input.area, input.project) ? "The project is not open in the chosen area; review the draft again." : null,
    snapshot: options => ({ ...balanceTaskApprovedSnapshot(options), destinations: [options.input.area] }),
    requestId: balanceTaskReceiptId,
  };
  return ownerDraftEditor(host, deps, options, balanceTaskDraft, destinations);
}
