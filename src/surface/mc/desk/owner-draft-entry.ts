import type { AuthorityMediator, WriterLease } from "../../../conversations/authority";
import type { ConversationHost } from "../../../conversations/host";
import { draftOperationId, DraftingBindings, type DraftingBindingDocument, type DraftDestinations, type DraftServiceDeps, type Handoff, type Lane } from "../../../conversations/domain-adapters/drafting";
import type { OperationBridge } from "../../../conversations/domain-adapters/operations/dispatch";
import type { StoredOperation } from "../../../conversations/domain-adapters/operations/journal";
import { receiptStatus } from "../../../conversations/domain-adapters/operations/reconciliation";
import type { ApprovedSnapshot, Provenance } from "../../../conversations/domain-adapters/operations/types";
import { canonicalWire, snapshotDigest } from "../../../conversations/domain-adapters/operations/validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { deskDraftEditor } from "./draft-editor";
import type { DraftConfirmation, DraftConfirmationRequest } from "./draft-editor-contract";
import type { HostQueryRunner } from "./query-run";

export interface OwnerDraftSession extends HostQueryRunner {
  readonly lease: WriterLease;
  readonly principal: string;
}

export type OwnerDraftDeps = Omit<DraftServiceDeps, "destinations" | "bindings">;

export interface OwnerDraftSetup<Session extends OwnerDraftSession> {
  readonly host: ConversationHost;
  readonly deps: OwnerDraftDeps;
  readonly options: OwnerDraftEntryOptions<Session>;
}

export interface OwnerDraftEntryOptions<Session extends OwnerDraftSession> {
  readonly connectionId: string;
  readonly audience: Lane;
  readonly authority: AuthorityMediator;
  readonly bridge: Pick<OperationBridge, "dispatch">;
  readonly session: (conversationId: string) => Promise<Session | null>;
  readonly sourceRestrictions: (handoff: Handoff) => Promise<ApprovedSnapshot["sources"] | null>;
}

export interface OwnerDraft<Input, Destinations extends DraftDestinations = DraftDestinations> {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly label: string;
  readonly binding: DraftingBindingDocument;
  readonly resolveWith: string;
  readonly unavailable: string;
  readonly savesLocally?: boolean;
  readonly conversationSourcesOnly?: boolean;
  parse(raw: unknown, connectionId: string): Input;
  references(input: Input): readonly ObjectReference[];
  inconsistency?(input: Input, conversationId: string, destinations: Destinations): Promise<string | null>;
  failure?(operationId: string): Promise<string | null>;
  snapshot(options: { connectionId: string; provenance: Provenance; input: Input; policy: Lane }): ApprovedSnapshot;
  requestId(operationId: string): string;
}

export function ownerDraftEditor<Session extends OwnerDraftSession, Input, Destinations extends DraftDestinations>(host: ConversationHost, deps: OwnerDraftDeps, options: OwnerDraftEntryOptions<Session>, owner: OwnerDraft<Input, Destinations>, destinations: Omit<DraftDestinations, "batch"> & { batch(): Destinations }) {
  const bindings = new DraftingBindings(deps.registry);
  const registered = bindings.register(owner.binding);
  if (!registered.ok) throw new Error(registered.error.message);
  const blocked = (reason: string): DraftConfirmation => ({ kind: "blocked", reason });
  const holdsDraft = (stored: StoredOperation): boolean => {
    const status = receiptStatus(stored);
    const definitivelyRefused = (status.state === "failed" || status.state === "refused") && status.effects.length === 0 && !status.investigation;
    return !definitivelyRefused;
  };
  const editor = deskDraftEditor(host, { ...deps, bindings, destinations }, {
    audience: options.audience,
    targets: () => [{ connectionId: options.connectionId, capabilityId: owner.capabilityId, label: owner.label }],
    hasOperation: async view => {
      const stored = await host.lifecycleJournal(deps.registry).read(draftOperationId(view.draft));
      return stored !== null && holdsDraft(stored);
    },
    receipt: async view => {
      const draft = view.draft;
      const operationId = draftOperationId(draft);
      const stored = await host.lifecycleJournal(deps.registry).read(operationId);
      if (!stored || !holdsDraft(stored)) return null;
      const session = await options.session(draft.conversationId);
      if (!session || view.withheld.length) return { kind: "withheld" };
      const snapshot = stored.journal.snapshot;
      if ("kind" in snapshot) return { kind: "withheld" };
      const status = receiptStatus(stored);
      const receipt = { kind: "receipt" as const, operationId, state: status.state, references: status.effects.flatMap(effect => effect.refs.map(ref => ref.canonicalId)) };
      const released = await options.authority.projectHostData(session.context, options.connectionId, session.sink, () => Promise.resolve(receipt), [{ capabilityId: snapshot.capabilityId, destinations: snapshot.destinations, sources: snapshot.sources, policy: snapshot.policy }]);
      return released.kind === "released" ? receipt : { kind: "withheld" };
    },
    confirm: async (request: DraftConfirmationRequest): Promise<DraftConfirmation> => {
      const { handoff } = request;
      if (handoff.adapterId !== owner.adapterId || handoff.capabilityId !== owner.capabilityId || handoff.connectionId !== options.connectionId) return blocked(`The draft belongs to another ${owner.label.toLowerCase()} connection or capability.`);
      const unchanged = async () => {
        const current = await editor.service.handoff(handoff.draftId, handoff.draftRevision);
        return current.ok && canonicalWire(current.handoff) === canonicalWire(handoff);
      };
      if (!await unchanged()) return blocked("The draft changed; review it again.");
      const view = await editor.service.read(handoff.draftId, request.audience);
      if (!view || view.withheld.length || handoff.policy === "local" && !owner.savesLocally) return blocked(`${owner.label} creation needs a cloud-permitted draft and sources.`);
      const draft = view.draft;
      const session = await options.session(draft.conversationId);
      if (session?.principal !== request.principal) return blocked("The current principal session is unavailable.");
      const sources = await options.sourceRestrictions(handoff);
      if (sources === null || handoff.sources.length > 0 && sources.length === 0 && !owner.conversationSourcesOnly) return blocked("Source authority is unavailable; review the draft again.");
      const input = owner.parse(handoff.input, options.connectionId);
      const batch = destinations.batch();
      const resolved = await Promise.all(owner.references(input).map(async ref => {
        const result = await batch.resolve({ capabilityId: owner.resolveWith, connectionId: options.connectionId, conversationId: draft.conversationId, objectType: ref.objectType, label: ref.canonicalId });
        return result.kind === "unique" && canonicalWire(result.ref) === canonicalWire(ref);
      }));
      if (resolved.some(valid => !valid)) return blocked(owner.unavailable);
      const inconsistent = await owner.inconsistency?.(input, draft.conversationId, batch);
      if (inconsistent) return blocked(inconsistent);
      const snapshot = owner.snapshot({ connectionId: options.connectionId, provenance: { conversationId: draft.conversationId, proposalId: draft.draftId, revision: draft.revision, entryId: draft.entryId, link: `?desk=conversation&conversation=${encodeURIComponent(draft.conversationId)}` }, input, policy: handoff.policy });
      snapshot.sources = sources;
      snapshot.digest = snapshotDigest(snapshot);
      const operationId = draftOperationId(draft);
      if (!await unchanged()) return blocked("The draft changed; review it again.");
      const approval = await options.authority.confirm(session.context, { operationId, idempotencyKey: operationId, ownerRequestId: owner.requestId(operationId), snapshot });
      if (approval.kind !== "allowed") return blocked(approval.reason.message);
      const outcome = await options.bridge.dispatch(session.context, operationId, session.lease);
      const failure = outcome.kind === "refused" ? outcome.reason.message : await owner.failure?.(operationId);
      return failure ? blocked(failure) : { kind: "accepted", operationId };
    },
  });
  return editor;
}
