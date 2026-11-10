import type { AuthorityMediator, HostContext, WriterLease } from "../../../conversations/authority";
import type { ConversationHost } from "../../../conversations/host";
import type { DraftServiceDeps, Handoff, Lane } from "../../../conversations/domain-adapters/drafting";
import type { OperationBridge } from "../../../conversations/domain-adapters/operations/dispatch";
import type { ApprovedSnapshot } from "../../../conversations/domain-adapters/operations/types";
import { canonicalWire, snapshotDigest } from "../../../conversations/domain-adapters/operations/validation";
import { parseWorkGraphNodeInput, workGraphNodeApprovedSnapshot, workGraphNodeRequestId } from "../../../conversations/domain-adapters/work-graph/node-binding";
import { deskDraftEditor } from "./draft-editor";
import type { DraftConfirmation, DraftConfirmationRequest } from "./draft-editor-contract";
import { graphDraftDestinations, type GraphDraftReadSession } from "./graph-draft-destinations";

export interface GraphDraftSession extends GraphDraftReadSession {
  readonly context: HostContext;
  readonly lease: WriterLease;
  readonly principal: string;
}
export interface GraphDraftEntryOptions {
  readonly connectionId: string;
  readonly audience: Lane;
  readonly authority: AuthorityMediator;
  readonly bridge: Pick<OperationBridge, "dispatch">;
  readonly session: (conversationId: string) => Promise<GraphDraftSession | null>;
  readonly sourceRestrictions: (handoff: Handoff) => Promise<ApprovedSnapshot["sources"] | null>;
}

export function deskGraphDraftEditor(host: ConversationHost, deps: Omit<DraftServiceDeps, "destinations">, options: GraphDraftEntryOptions) {
  const destinations = graphDraftDestinations(options);
  const blocked = (reason: string): DraftConfirmation => ({ kind: "blocked", reason });
  const editor = deskDraftEditor(host, { ...deps, destinations }, {
    audience: options.audience,
    targets: () => [{ connectionId: options.connectionId, capabilityId: "work-graph.node.create", label: "Graph node" }],
    confirm: async (request: DraftConfirmationRequest): Promise<DraftConfirmation> => {
      const { handoff } = request;
      if (handoff.adapterId !== "work-graph" || handoff.capabilityId !== "work-graph.node.create" || handoff.connectionId !== options.connectionId) return blocked("The draft belongs to another graph connection or capability.");
      const current = await editor.service.handoff(handoff.draftId, handoff.draftRevision);
      if (!current.ok || canonicalWire(current.handoff) !== canonicalWire(handoff)) return blocked("The draft changed; review it again.");
      const view = await editor.service.read(handoff.draftId, request.audience);
      if (!view || view.withheld.length || handoff.policy === "local") return blocked("Graph creation needs a cloud-permitted draft and sources.");
      const draft = view.draft;
      const session = await options.session(draft.conversationId);
      if (session?.principal !== request.principal) return blocked("The current principal session is unavailable.");
      const sources = await options.sourceRestrictions(handoff);
      if (sources === null || handoff.sources.length > 0 && sources.length === 0) return blocked("Source authority is unavailable; review the draft again.");
      const input = parseWorkGraphNodeInput(handoff.input, options.connectionId);
      for (const ref of [input.repository, input.parent, ...input.dependencies ?? []]) {
        const resolved = await destinations.resolve({ capabilityId: "work-graph.destinations", connectionId: options.connectionId, conversationId: draft.conversationId, objectType: ref.objectType, label: ref.canonicalId });
        if (resolved.kind !== "unique" || canonicalWire(resolved.ref) !== canonicalWire(ref)) return blocked("A graph reference is unavailable or ambiguous; review the draft again.");
      }
      const snapshot = workGraphNodeApprovedSnapshot({ connectionId: options.connectionId, provenance: { conversationId: draft.conversationId, proposalId: draft.draftId, revision: draft.revision, entryId: draft.entryId, link: `?desk=conversation&conversation=${encodeURIComponent(draft.conversationId)}` }, input, policy: handoff.policy });
      snapshot.sources = sources;
      snapshot.digest = snapshotDigest(snapshot);
      const operationId = `${draft.conversationId}:${draft.draftId}:${draft.revision}`;
      const rechecked = await editor.service.handoff(draft.draftId, draft.revision);
      if (!rechecked.ok || canonicalWire(rechecked.handoff) !== canonicalWire(handoff)) return blocked("The draft changed; review it again.");
      const approval = await options.authority.confirm(session.context, { operationId, idempotencyKey: operationId, ownerRequestId: workGraphNodeRequestId(operationId), snapshot });
      if (approval.kind !== "allowed") return blocked(approval.reason.message);
      const outcome = await options.bridge.dispatch(session.context, operationId, session.lease);
      return outcome.kind === "refused" ? blocked(outcome.reason.message) : { kind: "accepted", operationId };
    },
  });
  return editor;
}
