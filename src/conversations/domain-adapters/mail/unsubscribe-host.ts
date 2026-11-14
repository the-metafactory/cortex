import { randomUUID } from "node:crypto";
import type { StoredOperation } from "../operations/journal";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import type { BoundaryError } from "../types";
import { dispatchMailOperation, type MailHostOptions } from "./host-operation";
import { GRANT_OPTIONS, type GrantChoice, type ReceiptState } from "./move-host";
import { receiptMessage, receiptState, type ReceiptWording } from "./receipt";
import { MAIL_UNSUBSCRIBE_CAPABILITY, MailUnsubscribeInputSchema, MailUnsubscribeOutputSchema, mailUnsubscribeSnapshot, type MailUnsubscribeInput } from "./unsubscribe-contract";

export const UNSUBSCRIBE_QUESTION = "Unsubscribe from this list with one click on this connection? The change to the subscription may not be reversible.";
export const NO_UNDO = "There is no Undo.";

const WORDING: ReceiptWording = { running: "The unsubscribe is still running.", unconfirmed: "Mail has not confirmed the unsubscribe. Check the list before trying again." };

export interface UnsubscribePrompt {
  connectionId: string;
  covers: readonly string[];
  question: string;
  options: typeof GRANT_OPTIONS;
}

export interface MailUnsubscribeReceipt {
  operationId: string;
  messageId: string;
  account: string;
  host?: string;
  state: ReceiptState;
  message: string;
  at: string;
  basis: "grant" | "confirmation";
  undo: false;
}

export type UnsubscribeOutcome =
  | { kind: "needs-grant"; prompt: UnsubscribePrompt }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailUnsubscribeReceipt };

export interface MailUnsubscribeHostOptions extends MailHostOptions {
  newId?: () => string;
}

const reason = (code: string, message: string): BoundaryError => ({ code, message });
const doneMessage = (host: string): string => `Unsubscribed from the list at ${host}. ${NO_UNDO}`;

/** Coordinates one-click unsubscribe for one Mail connection: its own standing grant, a prompt that warns the change may not be reversible, and a receipt that never offers Undo. */
export class MailUnsubscribeHost {
  private readonly newId: () => string;

  constructor(private readonly options: MailUnsubscribeHostOptions) {
    this.newId = options.newId ?? randomUUID;
  }

  available(): boolean {
    const found = this.options.capability(MAIL_UNSUBSCRIBE_CAPABILITY);
    return found.support === "declared" && found.adapterId === this.options.adapterId && found.availability.state === "available";
  }

  async press(input: MailUnsubscribeInput, provenance: Provenance, choice?: GrantChoice): Promise<UnsubscribeOutcome> {
    if (choice === "cancel") return { kind: "cancelled" };
    if (!this.available()) return { kind: "unavailable", reason: reason("mail.capability_unavailable", "This connection does not offer one-click unsubscribe.") };
    let snapshot: ApprovedSnapshot;
    try {
      snapshot = mailUnsubscribeSnapshot({ adapterId: this.options.adapterId, connectionId: this.options.connectionId, account: this.options.account, input, provenance });
    } catch {
      return { kind: "unavailable", reason: reason("mail.invalid_request", "That mail cannot be unsubscribed: the request does not match the Mail contract.") };
    }
    let grantId = await this.options.authority.findGrant(MAIL_UNSUBSCRIBE_CAPABILITY);
    if (!grantId) {
      if (choice === undefined) return { kind: "needs-grant", prompt: { connectionId: this.options.connectionId, covers: [MAIL_UNSUBSCRIBE_CAPABILITY], question: UNSUBSCRIBE_QUESTION, options: GRANT_OPTIONS } };
      if (choice === "always") {
        grantId = await this.options.authority.grant([MAIL_UNSUBSCRIBE_CAPABILITY]);
        if (!grantId) return { kind: "denied", reason: reason("authority_denied", "The Cortex runtime does not allow a standing permission for this connection.") };
      }
    }
    return this.run(snapshot, grantId);
  }

  async receipt(operationId: string): Promise<MailUnsubscribeReceipt | null> {
    const stored = await this.options.journal.read(operationId);
    return stored ? this.project(stored) : null;
  }

  async receipts(limit = 100): Promise<MailUnsubscribeReceipt[]> {
    const stored = await Promise.all((await this.options.index.list()).map(id => this.options.journal.read(id)));
    return stored
      .filter((item): item is StoredOperation => item !== null)
      .map(item => this.project(item))
      .filter((receipt): receipt is MailUnsubscribeReceipt => receipt !== null)
      .sort((a, b) => b.at.localeCompare(a.at) || b.operationId.localeCompare(a.operationId))
      .slice(0, limit);
  }

  private async run(snapshot: ApprovedSnapshot, grantId: string | null): Promise<UnsubscribeOutcome> {
    const operationId = `mail-unsubscribe:${this.newId()}`;
    const decision = await dispatchMailOperation(this.options, snapshot, operationId, grantId);
    if (decision.kind === "denied") return { kind: "denied", reason: decision.reason };
    const receipt = await this.receipt(operationId);
    return receipt ? { kind: "receipt", receipt } : { kind: "denied", reason: reason("mail.receipt_missing", "The attempt left no journal record.") };
  }

  private project(stored: StoredOperation): MailUnsubscribeReceipt | null {
    const { journal } = stored;
    const snapshot = journal.snapshot;
    if ("kind" in snapshot) return null;
    if (snapshot.adapterId !== this.options.adapterId || snapshot.connectionId !== this.options.connectionId || snapshot.destinations[0]?.canonicalId !== this.options.account) return null;
    if (snapshot.capabilityId !== MAIL_UNSUBSCRIBE_CAPABILITY) return null;
    const parsed = MailUnsubscribeInputSchema.safeParse(snapshot.input);
    if (!parsed.success) return null;
    const responses = journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response.result] : []);
    const result = responses.at(-1);
    const output = result?.kind === "succeeded" ? MailUnsubscribeOutputSchema.safeParse(result.output) : null;
    const success = output?.success ? output.data : null;
    const approved = journal.events[0]?.event;
    const state = receiptState(journal, result, success !== null);
    return {
      operationId: journal.operationId,
      messageId: parsed.data.message.canonicalId,
      account: this.options.account,
      ...(success ? { host: success.host } : {}),
      state,
      message: receiptMessage(journal, result, success ? { message: doneMessage(success.host) } : null, state, WORDING),
      at: journal.events[0]?.at ?? "",
      basis: approved?.kind === "approved" && approved.authority.basis.kind === "grant" ? "grant" : "confirmation",
      undo: false,
    };
  }
}
