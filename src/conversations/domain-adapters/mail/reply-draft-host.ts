import type { HostContext } from "../../authority";
import { studioRequestId } from "../../conversation-ids";
import type { CreateRequest, CreateResult, OwnerWriter, Policy } from "../../types";
import { MAX_REPLY_CHARS, type ListedMailLookup } from "../../../surface/mc/desk/mail-actions";
import type { OperationJournalStore } from "../operations/journal";
import { buildApprovedSnapshot, ownerResultKit } from "../operations/owner-results";
import type { ApprovedSnapshot } from "../operations/types";
import { canonicalWire } from "../operations/validation";
import type { CapabilityDeclaration } from "../types";
import type { MailApprovalInput, MailMoveAuthorityService } from "./move-host";
import { mailAccountRef, mailMessageRef } from "./move-contract";

export const MAIL_REPLY_DRAFT_CAPABILITY = "mail.reply-draft.create";

export interface MailReplyDraftConnection {
  adapterId: string;
  connectionId: string;
  sourceId: string;
  account: string;
  capability: CapabilityDeclaration;
}

export function mailReplyDraftScopeMatches(snapshot: ApprovedSnapshot, account: unknown): boolean {
  const input = snapshot.input;
  if (typeof input !== "object" || input === null || Array.isArray(input) || typeof account !== "string" || !account) return false;
  const message = snapshot.target;
  return message?.objectType === "message" && message.adapterId === snapshot.adapterId && message.connectionId === snapshot.connectionId && input.message !== undefined && canonicalWire(input.message) === canonicalWire(message) && typeof input.body === "string" && input.body.trim().length > 0 && input.body.length <= MAX_REPLY_CHARS && snapshot.destinations.length === 1 && canonicalWire(snapshot.destinations[0]) === canonicalWire(mailAccountRef(snapshot.adapterId, snapshot.connectionId, account));
}

export function mailReplyDraftSnapshot(request: CreateRequest, connection: MailReplyDraftConnection, lookup: ListedMailLookup, policy: Policy): ApprovedSnapshot {
  if (request.type !== "mail-draft" || connection.capability.kind !== "action" || connection.capability.capabilityId !== MAIL_REPLY_DRAFT_CAPABILITY) throw new Error("This connection does not offer reply drafts.");
  if (!lookup.ok) throw new Error(lookup.error);
  const mail = lookup.mail;
  if (!connection.account || mail.account !== connection.account || mail.sourceId !== connection.sourceId) throw new Error("A reply draft can only be saved to the source and account of the mail being discussed.");
  const { operationId: _operationId, ...provenance } = request.provenance;
  const message = mailMessageRef(connection.adapterId, connection.connectionId, mail.id);
  const snapshot = buildApprovedSnapshot({ provenance, adapterId: connection.adapterId, connectionId: connection.connectionId, capabilityId: MAIL_REPLY_DRAFT_CAPABILITY, inputSchemaRef: connection.capability.inputSchemaRef, outputSchemaRef: connection.capability.outputSchemaRef, errorSchemaRef: connection.capability.errorSchemaRef, input: { message, body: request.fields.body ?? "" }, target: message, destinations: [mailAccountRef(connection.adapterId, connection.connectionId, connection.account)], policy });
  if (!mailReplyDraftScopeMatches(snapshot, connection.account)) throw new Error("The reply text or Mail scope is invalid.");
  return snapshot;
}

export interface MailReplyDraftFacadeOptions {
  native: OwnerWriter;
  connection: MailReplyDraftConnection;
  journal: OperationJournalStore;
  lookupMail(key: string): ListedMailLookup;
  policy(conversationId: string): Promise<Policy>;
  authority: Pick<MailMoveAuthorityService, "confirm">;
  context: HostContext;
  lifecycle: { dispatch(operationId: string): Promise<unknown> };
  active?: boolean;
}

export function createMailReplyDraftFacade(options: MailReplyDraftFacadeOptions): OwnerWriter {
  const kit = ownerResultKit(options.connection.adapterId);
  const refused = (error: string): CreateResult => ({ state: "failed", error: `${error} Nothing was created.` });
  return {
    readback: options.native.readback,
    async create(request) {
      if (options.active !== true) return options.native.create(request);
      const stopped = () => request.signal.aborted;
      if (stopped()) return refused("The conversation stopped waiting before the draft was saved.");
      let snapshot: ApprovedSnapshot;
      try {
        snapshot = mailReplyDraftSnapshot(request, options.connection, options.lookupMail(request.fields.mail ?? ""), await options.policy(request.provenance.conversationId));
      } catch (error) {
        return refused(error instanceof Error ? error.message : "The reply draft is invalid.");
      }
      const input: MailApprovalInput = { operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: studioRequestId(request.operationId), snapshot };
      const approved = await options.authority.confirm(options.context, input);
      if (approved.kind === "denied") return refused(approved.reason.message);
      if (approved.authority.basis.kind !== "confirmation") return refused("Reply drafts require approval of the exact text.");
      if (stopped()) return refused("The conversation stopped waiting before the draft was saved.");
      await options.lifecycle.dispatch(request.operationId);
      return kit.legacyResult(await options.journal.read(request.operationId), "Mail draft");
    },
  };
}
