import type { ConversationHost } from "../../../conversations/host";
import { parseWorkGraphNodeInput, workGraphNodeApprovedSnapshot, workGraphNodeRequestId } from "../../../conversations/domain-adapters/work-graph/node-binding";
import { workGraphNodeDraftingBinding } from "../../../conversations/domain-adapters/drafting/graph";
import { graphDraftDestinations, type GraphDraftReadSession } from "./graph-draft-destinations";
import { ownerDraftEditor, type OwnerDraft, type OwnerDraftEntryOptions, type OwnerDraftSession, type OwnerDraftSetup } from "./owner-draft-entry";

export interface GraphDraftSession extends GraphDraftReadSession, OwnerDraftSession {}
export type GraphDraftEntryOptions = OwnerDraftEntryOptions<GraphDraftSession>;

export type GraphDraftSetup = OwnerDraftSetup<GraphDraftSession>;

const graphNodeDraft: OwnerDraft<ReturnType<typeof parseWorkGraphNodeInput>> = {
  adapterId: "work-graph",
  capabilityId: "work-graph.node.create",
  label: "Graph node",
  binding: workGraphNodeDraftingBinding,
  resolveWith: "work-graph.destinations",
  unavailable: "A graph reference is unavailable or ambiguous; review the draft again.",
  parse: parseWorkGraphNodeInput,
  references: input => [input.repository, input.parent, ...input.dependencies ?? []],
  snapshot: workGraphNodeApprovedSnapshot,
  requestId: workGraphNodeRequestId,
};

export const deskGraphDraftEditor = (host: ConversationHost, deps: GraphDraftSetup["deps"], options: GraphDraftEntryOptions) => ownerDraftEditor(host, deps, options, graphNodeDraft, graphDraftDestinations(options));
