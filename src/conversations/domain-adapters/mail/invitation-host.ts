import { randomUUID } from "node:crypto";
import { UNDO_WINDOW_MS } from "./move-contract";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import type { StoredOperation } from "../operations/journal";
import type { BoundaryError } from "../types";
import { GRANT_OPTIONS, type GrantChoice, type MailMoveHostOptions, type ReceiptState } from "./move-host";
import { INVITATION_CAPABILITIES, INVITATION_LABELS, INVITATION_NO_UNDO, INVITATION_NOTIFICATION_WARNING, INVITATION_REPLIES, InvitationInputSchema, InvitationOutputSchema, invitationActionFor, mailInvitationSnapshot, type InvitationAction, type InvitationInput, type InvitationReply } from "./invitation-contract";

export type InvitationHostOptions = Omit<MailMoveHostOptions, "newId"> & {
  refreshInvitation(selection: { messageId: string; invitationId: string }, provenance: Provenance): Promise<void>;
};
export interface InvitationPrompt {
  connectionId: string;
  action: InvitationAction;
  covers: string[];
  question: string;
  warning: string;
  options: typeof GRANT_OPTIONS;
}
export interface InvitationReceipt {
  operationId: string;
  action: InvitationAction;
  messageId: string;
  invitationId: string;
  state: ReceiptState;
  message: string;
  basis: "grant" | "confirmation";
  undo: { kind: "available" } | { kind: "unavailable"; reason: string };
  nextActions: { action: "remove"; label: "Remove declined invitation"; declineOperationId: string }[];
  refreshInvitation: boolean;
}
export type InvitationOutcome =
  | { kind: "needs-grant"; prompt: InvitationPrompt }
  | { kind: "cancelled" }
  | { kind: "unavailable" | "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: InvitationReceipt };
interface Selection { messageId: string; invitationId: string; expectedRevision: string }
interface Intent { provenance: Provenance; choice?: GrantChoice }
const refused = (message: string): InvitationOutcome => ({ kind: "unavailable", reason: { code: "mail.invitation_unavailable", message } });
const isReply = (action: InvitationAction): action is InvitationReply => (INVITATION_REPLIES as readonly string[]).includes(action);
const selectionFrom = (origin: { input: InvitationInput; output: { revision: string } }): Selection => ({ messageId: origin.input.message.canonicalId, invitationId: origin.input.invitation.canonicalId, expectedRevision: origin.output.revision });

function promptDetails(mode: "reply" | "restorable" | "confirm-only", replies: InvitationReply[]): Pick<InvitationPrompt, "covers" | "question" | "warning" | "options"> {
  switch (mode) {
    case "reply": return {
      covers: replies.map(reply => INVITATION_CAPABILITIES[reply]),
      question: `Use one click for ${replies.map(reply => INVITATION_LABELS[reply]).join(", ")} on this mail connection?`,
      warning: INVITATION_NOTIFICATION_WARNING,
      options: GRANT_OPTIONS,
    };
    case "restorable": return {
      covers: [INVITATION_CAPABILITIES.remove, INVITATION_CAPABILITIES.restore],
      question: "Remove declined invitations with one click on this mail connection? Covers removal and restoration.",
      warning: "Removes only the declined invitation. Undo can restore it if it has not changed.",
      options: GRANT_OPTIONS,
    };
    case "confirm-only": return {
      covers: [],
      question: "Remove this declined invitation?",
      warning: "This connection cannot restore an event. No Undo is available; confirm each removal.",
      options: GRANT_OPTIONS.filter(option => option.choice !== "always"),
    };
  }
}

export class MailInvitationHost {
  private readonly undoing = new Set<string>();

  constructor(private readonly options: InvitationHostOptions) {}

  private declared(action: InvitationAction): boolean {
    const found = this.options.capability(INVITATION_CAPABILITIES[action]);
    return found.support === "declared" && found.adapterId === this.options.adapterId && found.availability.state === "available";
  }

  private owns(snapshot: ApprovedSnapshot): boolean {
    return snapshot.adapterId === this.options.adapterId && snapshot.connectionId === this.options.connectionId && snapshot.destinations[0]?.canonicalId === this.options.account;
  }

  reply(request: Selection & Intent & { reply: InvitationReply }): Promise<InvitationOutcome> {
    return this.press(request.reply, request, request);
  }

  async remove(request: Intent & { declineOperationId: string }): Promise<InvitationOutcome> {
    const origin = await this.load(request.declineOperationId);
    if (origin?.action !== "decline" || origin.stored.journal.state !== "succeeded" || !origin.output || !this.owns(origin.snapshot)) return refused("A successful decline on this connection is required before removing its invitation.");
    return this.press("remove", selectionFrom({ input: origin.input, output: origin.output }), request, request.declineOperationId);
  }

  async undo(operationId: string, provenance: Provenance): Promise<InvitationOutcome> {
    const receipt = await this.receipt(operationId);
    if (receipt?.undo.kind !== "available" || this.undoing.has(operationId)) return refused("This invitation action cannot be undone.");
    this.undoing.add(operationId);
    try {
      const origin = await this.load(operationId);
      if (!origin?.output) return refused("The removed invitation has no restoration evidence.");
      return await this.press("restore", selectionFrom({ input: origin.input, output: origin.output }), { provenance, choice: "once" }, operationId);
    } finally { this.undoing.delete(operationId); }
  }

  private async press(action: InvitationAction, selection: Selection, intent: Intent, parent?: string): Promise<InvitationOutcome> {
    if (intent.choice === "cancel") return { kind: "cancelled" };
    if (!this.declared(action)) return refused("This connection does not offer that invitation action.");
    let snapshot: ApprovedSnapshot;
    try { snapshot = mailInvitationSnapshot({ ...this.options, ...selection, action, provenance: intent.provenance }); }
    catch { return refused("The invitation request does not match the Mail contract."); }
    const mode = isReply(action) ? "reply" : this.declared("restore") ? "restorable" : "confirm-only";
    const canGrant = mode !== "confirm-only";
    const details = promptDetails(mode, INVITATION_REPLIES.filter(reply => this.declared(reply)));
    let grantId = canGrant ? await this.options.authority.findGrant(INVITATION_CAPABILITIES[action]) : null;
    if (!grantId) {
      if (intent.choice === undefined) return { kind: "needs-grant", prompt: {
        connectionId: this.options.connectionId, action, ...details,
      } };
      if (intent.choice === "always") {
        if (!canGrant) return refused("Removing an event without restoration requires confirmation each time.");
        grantId = await this.options.authority.grant(details.covers);
        if (!grantId) return { kind: "denied", reason: { code: "authority_denied", message: "Standing permission is not allowed on this connection." } };
      }
    }
    const operationId = `mail-invitation:${randomUUID()}`;
    const links = parent && action === "restore" ? { compensatesOperationId: parent } : undefined;
    const approved = await this.options.authority.approve({ operationId, idempotencyKey: operationId, ownerRequestId: randomUUID(), snapshot, ...(links ? { links } : {}) }, grantId);
    if (approved.kind === "denied") return approved;
    await this.options.index.add(operationId, action === "restore" ? parent : undefined);
    await this.options.dispatch(operationId);
    const receipt = await this.receipt(operationId);
    if (receipt?.refreshInvitation) {
      try { await this.options.refreshInvitation(selection, intent.provenance); }
      catch { console.error("mail.invitation_refresh_failed", operationId); }
    }
    return receipt ? { kind: "receipt", receipt } : refused("The invitation attempt left no journal record.");
  }

  private async load(operationId: string) {
    const stored = await this.options.journal.read(operationId);
    if (!stored || "kind" in stored.journal.snapshot) return null;
    const snapshot = stored.journal.snapshot;
    const action = invitationActionFor(snapshot.capabilityId);
    const parsed = InvitationInputSchema.safeParse(snapshot.input);
    if (!action || !parsed.success) return null;
    const results = stored.journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response.result] : []);
    const success = results.findLast(result => result.kind === "succeeded");
    const output = success?.kind === "succeeded" ? InvitationOutputSchema.safeParse(success.output) : null;
    const value = output?.success && Object.entries(parsed.data.invitation).every(([key, value]) => output.data.ref[key as keyof typeof output.data.ref] === value) ? output.data : null;
    return { stored, snapshot, action, input: parsed.data, output: value, results };
  }

  async receipt(operationId: string): Promise<InvitationReceipt | null> {
    const origin = await this.load(operationId);
    if (!origin || !this.owns(origin.snapshot)) return null;
    const { stored, action, input, output, results } = origin;
    const journal = stored.journal;
    const approval = journal.events[0]?.event;
    const base = { operationId, action, messageId: input.message.canonicalId, invitationId: input.invitation.canonicalId, basis: approval?.kind === "approved" && approval.authority.basis.kind === "grant" ? "grant" as const : "confirmation" as const, nextActions: [], refreshInvitation: false };
    const noUndo = (reason: string) => ({ kind: "unavailable" as const, reason });
    if (journal.state === "succeeded" && output) {
      const undo = action === "remove" ? await this.removalUndo(stored) : noUndo(isReply(action) ? "organizer-notified" : "restore");
      const message = isReply(action) ? `${INVITATION_LABELS[action]} reply sent. ${INVITATION_NO_UNDO}${action === "decline" ? " The invitation has not been removed." : ""}` : action === "remove" ? `Declined invitation removed.${undo.kind === "unavailable" ? " No Undo is available." : ""}` : "Declined invitation restored.";
      return { ...base, state: "done", message, undo, nextActions: action === "decline" && this.declared("remove") ? [{ action: "remove", label: "Remove declined invitation", declineOperationId: operationId }] : [] };
    }
    const failure = results.findLast(result => result.kind === "failed" || result.kind === "conflict");
    if (failure?.kind === "failed" || failure?.kind === "conflict") return { ...base, state: failure.kind === "conflict" ? "conflict" : failure.error.code.endsWith(".message_missing") ? "missing" : failure.error.code.endsWith(".account_denied") ? "denied" : "failed", message: failure.error.message, undo: noUndo("not-done"), refreshInvitation: failure.kind === "conflict" };
    const local = journal.events.findLast(entry => entry.event.kind === "local-outcome")?.event;
    if (local?.kind === "local-outcome") return { ...base, state: "refused", message: local.reason.message, undo: noUndo("not-done") };
    const pending = ["confirmed", "dispatching", "pending"].includes(journal.state);
    return { ...base, state: pending ? "pending" : "uncertain", message: `${pending ? "The invitation action is still running." : "The provider has not confirmed the invitation action. Check the invitation before trying again."}${isReply(action) ? ` ${INVITATION_NO_UNDO}` : ""}`, undo: noUndo("not-done") };
  }

  private async removalUndo(stored: StoredOperation): Promise<InvitationReceipt["undo"]> {
    const blocked = (reason: string): InvitationReceipt["undo"] => ({ kind: "unavailable", reason });
    if (!this.declared("restore")) return blocked("unsupported");
    const at = Date.parse(stored.journal.events.find(entry => entry.event.kind === "approved")?.at ?? "");
    if (!Number.isFinite(at) || (this.options.now ?? Date.now)() - at > UNDO_WINDOW_MS) return blocked("expired");
    const linked = await Promise.all((await this.options.index.compensations(stored.journal.operationId)).map(id => this.options.journal.read(id)));
    if (linked.some(item => item?.journal.state === "succeeded")) return blocked("undone");
    if (linked.some(item => item && ["confirmed", "dispatching", "pending", "uncertain"].includes(item.journal.state))) return blocked("in-progress");
    return { kind: "available" };
  }
}
