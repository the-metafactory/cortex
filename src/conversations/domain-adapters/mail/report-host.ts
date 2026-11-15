import { randomUUID } from "node:crypto";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";
import type { StoredOperation } from "../operations/journal";
import type { ApprovedSnapshot, OperationJournal, Provenance } from "../operations/types";
import type { BoundaryError } from "../types";
import { dispatchMailOperation, loadOperations, mailCapabilityDeclared, ownerResults, ownsMailOperation, settleMailOperation, type MailHostOptions } from "./host-operation";
import { MAIL_RESTORE_CAPABILITY, mailAccountRef, mailMessageRef, mailMoveSnapshot } from "./move-contract";
import { GRANT_OPTIONS, type GrantChoice, type ReceiptState } from "./move-host";
import { receiptMessage, receiptState, type ReceiptWording } from "./receipt";
import { MAIL_REPORT_CAPABILITY, MAIL_REPORT_KINDS, MailReportInputSchema, MailReportOutputSchema, isProviderReport, mailReportSnapshot, type MailReportKind } from "./report-contract";

export const REPORT_STANDS = "The report stands.";
export const REPORT_CANNOT_BE_RETRACTED = "Undo can move the mail back, but it cannot retract a report already sent to the provider.";

const KIND_NAME: Record<MailReportKind, string> = { draft: "a report draft", spam: "a spam report", phishing: "a phishing report" };
const grantQuestion = (kind: MailReportKind): string => `Report mail as ${kind} with one click on this connection? The report goes to the mail provider. ${REPORT_CANNOT_BE_RETRACTED}`;
const WORDING: ReceiptWording = { running: "The report is still running.", unconfirmed: "Mail has not confirmed the report. Check the mailbox before trying again." };

export interface ReportPrompt {
  connectionId: string;
  kind: MailReportKind;
  covers: readonly string[];
  question: string;
  options: typeof GRANT_OPTIONS;
}

export type ReportUndoState = { kind: "available" } | { kind: "unavailable"; reason: "not-done" | "draft" | "undone" | "expired" | "unsupported" | "in-progress" };

export interface MailReportReceipt {
  operationId: string;
  kind: MailReportKind;
  messageId: string;
  account: string;
  folder?: string;
  state: ReceiptState;
  message: string;
  at: string;
  basis: "grant" | "confirmation";
  undone: boolean;
  reportStands: boolean;
  undo: ReportUndoState;
}

export type ReportOutcome =
  | { kind: "needs-grant"; prompt: ReportPrompt }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailReportReceipt };

export type ReportUndoOutcome =
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "undo"; state: ReceiptState; message: string; receipt: MailReportReceipt };

export interface MailReportHostOptions extends MailHostOptions {
  newId?: () => string;
}

const reason = (code: string, message: string): BoundaryError => ({ code, message });

/** Coordinates Mail reports for one connection: a draft needs no grant, a provider report asks for its own grant per report type with a warning that Undo cannot retract it, and every attempt writes a receipt. */
export class MailReportHost {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly undoing = new Set<string>();

  constructor(private readonly options: MailReportHostOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  available(kind: MailReportKind): boolean {
    return this.declared(MAIL_REPORT_CAPABILITY[kind]) && (!isProviderReport(kind) || this.declared(MAIL_RESTORE_CAPABILITY));
  }

  async press(kind: MailReportKind, messageId: string, provenance: Provenance, choice?: GrantChoice): Promise<ReportOutcome> {
    if (choice === "cancel") return { kind: "cancelled" };
    if (!this.available(kind)) return { kind: "unavailable", reason: reason("mail.capability_unavailable", `This connection does not offer ${KIND_NAME[kind]}.`) };
    let snapshot: ApprovedSnapshot;
    try {
      snapshot = mailReportSnapshot({ adapterId: this.options.adapterId, connectionId: this.options.connectionId, account: this.options.account, kind, input: { message: mailMessageRef(this.options.adapterId, this.options.connectionId, messageId) }, provenance });
    } catch {
      return { kind: "unavailable", reason: reason("mail.invalid_request", "That mail cannot be reported: the request does not match the Mail contract.") };
    }
    let grantId: string | null = null;
    if (isProviderReport(kind)) {
      const capabilityId = MAIL_REPORT_CAPABILITY[kind];
      grantId = await this.options.authority.findGrant(capabilityId);
      if (!grantId) {
        if (choice === undefined) return { kind: "needs-grant", prompt: { connectionId: this.options.connectionId, kind, covers: [capabilityId], question: grantQuestion(kind), options: GRANT_OPTIONS } };
        if (choice === "always") {
          grantId = await this.options.authority.grant([capabilityId]);
          if (!grantId) return { kind: "denied", reason: reason("authority_denied", "The Cortex runtime does not allow a standing permission for this connection.") };
        }
      }
    }
    const operationId = `mail-report:${this.newId()}`;
    return settleMailOperation(this.options, snapshot, operationId, grantId, id => this.receipt(id));
  }

  async undo(operationId: string, provenance: Provenance): Promise<ReportUndoOutcome> {
    const original = await this.receipt(operationId);
    if (!original) return { kind: "unavailable", reason: reason("mail.receipt_unknown", "The Desk has no record of that report.") };
    if (original.undo.kind !== "available") return { kind: "unavailable", reason: reason("mail.undo_unavailable", `This report cannot be undone: ${original.undo.reason}.`) };
    if (this.undoing.has(operationId)) return { kind: "unavailable", reason: reason("mail.undo_unavailable", "This report is already being undone.") };
    this.undoing.add(operationId);
    try {
      const { adapterId, connectionId, account } = this.options;
      const snapshot = mailMoveSnapshot({ adapterId, connectionId, account: mailAccountRef(adapterId, connectionId, account), input: { action: "restore", message: mailMessageRef(adapterId, connectionId, original.messageId), from: original.folder ?? "" }, provenance });
      const restoreId = `mail-report-undo:${this.newId()}`;
      const decision = await dispatchMailOperation(this.options, snapshot, restoreId, await this.options.authority.findGrant(MAIL_RESTORE_CAPABILITY), operationId);
      if (decision.kind === "denied") return { kind: "denied", reason: decision.reason };
      const restore = await this.options.journal.read(restoreId);
      const refreshed = await this.receipt(operationId);
      if (!restore || !refreshed) return { kind: "denied", reason: reason("mail.receipt_missing", "The attempt left no journal record.") };
      const outcome = this.restoreOutcome(restore.journal);
      return { kind: "undo", state: outcome.state, message: outcome.state === "done" ? `${outcome.message} ${REPORT_STANDS}` : outcome.message, receipt: refreshed };
    } finally {
      this.undoing.delete(operationId);
    }
  }

  async receipt(operationId: string): Promise<MailReportReceipt | null> {
    const stored = await this.options.journal.read(operationId);
    return stored ? this.project(stored, await this.loadRestores(operationId)) : null;
  }

  async receipts(limit = 100): Promise<MailReportReceipt[]> {
    const stored = await loadOperations(this.options, await this.options.index.list());
    const projected = await Promise.all(stored.map(async item => this.project(item, await this.loadRestores(item.journal.operationId))));
    return projected.filter((receipt): receipt is MailReportReceipt => receipt !== null).sort((a, b) => b.at.localeCompare(a.at) || b.operationId.localeCompare(a.operationId)).slice(0, limit);
  }

  private declared(capabilityId: string): boolean {
    return mailCapabilityDeclared(this.options, capabilityId);
  }

  private async loadRestores(operationId: string): Promise<StoredOperation[]> {
    return loadOperations(this.options, await this.options.index.compensations(operationId));
  }

  private restoreOutcome(journal: OperationJournal): { state: ReceiptState; message: string } {
    const result = ownerResults(journal).at(-1);
    const output = result?.kind === "succeeded" ? MailReportOutputSchema.safeParse(result.output) : null;
    const state = receiptState(journal, result, output?.success === true);
    const folder = output?.success ? output.data.folder : "";
    return { state, message: receiptMessage(journal, result, output?.success ? { message: `Moved back to ${folder}.` } : null, state, { running: "The move back is still running.", unconfirmed: "Mail has not confirmed the move back. Check the mailbox before trying again." }) };
  }

  private project(stored: StoredOperation, restores: readonly StoredOperation[]): MailReportReceipt | null {
    const { journal } = stored;
    const snapshot = journal.snapshot;
    if (!ownsMailOperation(this.options, snapshot)) return null;
    const kind = MAIL_REPORT_KINDS.find(candidate => MAIL_REPORT_CAPABILITY[candidate] === snapshot.capabilityId);
    const parsed = MailReportInputSchema.safeParse(snapshot.input);
    if (!kind || !parsed.success) return null;
    const result = ownerResults(journal).findLast(item => item.kind === "succeeded") ?? ownerResults(journal).at(-1);
    const output = result?.kind === "succeeded" ? MailReportOutputSchema.safeParse(result.output) : null;
    const success = output?.success ? output.data : null;
    const state = receiptState(journal, result, success !== null);
    const approved = journal.events[0]?.event;
    const undone = restores.some(item => item.journal.state === "succeeded");
    const inFlight = restores.some(item => ["confirmed", "dispatching", "pending", "uncertain"].includes(item.journal.state));
    const at = journal.events[0]?.at ?? "";
    const done = state === "done";
    const base = receiptMessage(journal, result, success ? { message: kind === "draft" ? `A report draft is in ${success.folder}. Send it from there.` : `Reported as ${kind}. ${REPORT_CANNOT_BE_RETRACTED}` } : null, state, WORDING);
    const standing = done && isProviderReport(kind);
    return {
      operationId: journal.operationId, kind, messageId: parsed.data.message.canonicalId, account: this.options.account,
      ...(success ? { folder: success.folder } : {}),
      state,
      message: standing && undone ? `Moved back. ${REPORT_STANDS}` : base,
      at,
      basis: approved?.kind === "approved" && approved.authority.basis.kind === "grant" ? "grant" : "confirmation",
      undone,
      reportStands: standing,
      undo: this.undoState(kind, state, undone, inFlight, at),
    };
  }

  private undoState(kind: MailReportKind, state: ReceiptState, undone: boolean, inFlight: boolean, at: string): ReportUndoState {
    if (!isProviderReport(kind)) return { kind: "unavailable", reason: "draft" };
    if (state !== "done") return { kind: "unavailable", reason: "not-done" };
    if (undone) return { kind: "unavailable", reason: "undone" };
    if (inFlight) return { kind: "unavailable", reason: "in-progress" };
    if (this.now() - Date.parse(at) > UNDO_WINDOW_MS) return { kind: "unavailable", reason: "expired" };
    return this.available(kind) ? { kind: "available" } : { kind: "unavailable", reason: "unsupported" };
  }
}
