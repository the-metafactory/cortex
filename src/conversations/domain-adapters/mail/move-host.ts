import { randomUUID } from "node:crypto";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";
import type { StoredOperation } from "../operations/journal";
import type { ApprovedSnapshot, Authority, OperationJournal, Provenance } from "../operations/types";
import type { HostContext } from "../../authority";
import type { BoundaryError } from "../types";
import { MAIL_ACTION_CAPABILITY, MAIL_MOVE_CAPABILITIES, MAIL_REFUSAL, MAIL_RESTORE_CAPABILITY, MailMoveOutputSchema, mailAccountRef, mailMessageRef, mailMoveSnapshot, type MailMoveAction, type MailMoveInput, type MailMoveTarget } from "./move-contract";
import { readLegacyMove } from "./legacy-move";
import { dispatchMailOperation, type MailHostOptions } from "./host-operation";

export type GrantChoice = "always" | "once" | "cancel";
export const GRANT_OPTIONS: readonly { choice: GrantChoice; label: string }[] = [
  { choice: "always", label: "Use one click from now on" },
  { choice: "once", label: "Just this once" },
  { choice: "cancel", label: "Cancel" },
];

export interface GrantPrompt {
  connectionId: string;
  action: MailMoveAction;
  covers: string[];
  question: string;
  options: readonly { choice: GrantChoice; label: string }[];
}

export type ApprovalDecision = { kind: "allowed"; authority: Authority } | { kind: "denied"; reason: BoundaryError };
export interface MailApprovalInput { operationId: string; idempotencyKey: string; ownerRequestId: string; snapshot: ApprovedSnapshot; links?: OperationJournal["links"] }

/** What the Cortex runtime's authority offers one Mail connection: the standing grant for the move actions, and approval of one operation under it. */
export interface MailMoveAuthority {
  findGrant(capabilityId: string): Promise<string | null>;
  grant(capabilityIds: readonly string[]): Promise<string | null>;
  approve(input: MailApprovalInput, grantId: string | null): Promise<ApprovalDecision>;
}

export interface MailMoveHostOptions extends MailHostOptions {
  newId?: () => string;
}

export type ReceiptState = "done" | "pending" | "uncertain" | "missing" | "denied" | "conflict" | "failed" | "refused";
export type UndoState = { kind: "available" } | { kind: "unavailable"; reason: "not-done" | "undone" | "expired" | "unsupported" | "other-connection" | "restore" | "in-progress" };

export interface MailMoveReceipt {
  operationId: string;
  action: MailMoveAction;
  messageId: string;
  account: string;
  target?: string;
  folder?: string;
  state: ReceiptState;
  message: string;
  at: string;
  basis: "grant" | "confirmation" | "legacy";
  compensates?: string;
  undone: boolean;
  undo: UndoState;
}

export type PressRequest =
  | { action: "move"; messageId: string; target: MailMoveTarget; provenance: Provenance; choice?: GrantChoice }
  | { action: "trash"; messageId: string; provenance: Provenance; choice?: GrantChoice };

export type PressOutcome =
  | { kind: "needs-grant"; prompt: GrantPrompt }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailMoveReceipt };

export type UndoOutcome =
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailMoveReceipt; original: MailMoveReceipt };

const FOLDER_LABEL: Record<string, string> = { archive: "Archive", junk: "Junk", trash: "Trash" };
const DONE_MESSAGE: Record<string, string> = { archive: "Archived.", junk: "Moved to Junk.", trash: "Moved to Trash." };
const reason = (code: string, message: string): BoundaryError => ({ code, message });
const UNAVAILABLE_ACTION = (action: MailMoveAction): BoundaryError => reason("mail.capability_unavailable", action === "trash" ? "Moving mail to Trash is not available on this connection, because it cannot restore the mail." : "This connection does not offer that action.");
const QUESTION: Record<MailMoveAction, string> = { move: "Move mail with one click on this connection?", trash: "Move mail to Trash with one click on this connection?", restore: "Move mail back with one click on this connection?" };

function compensationLinks(all: readonly StoredOperation[]): Map<string, StoredOperation[]> {
  const links = new Map<string, StoredOperation[]>();
  for (const item of all) {
    const target = item.journal.links?.compensatesOperationId;
    if (target) links.set(target, [...(links.get(target) ?? []), item]);
  }
  return links;
}

const stateOfRefusal = (code: string): ReceiptState => code.endsWith(`.${MAIL_REFUSAL.missing}`) ? "missing" : code.endsWith(`.${MAIL_REFUSAL.denied}`) ? "denied" : "failed";

export class MailMoveHost {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly undoing = new Set<string>();

  constructor(private readonly options: MailMoveHostOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  available(action: MailMoveAction): boolean {
    const declared = (id: string): boolean => this.declared(id);
    if (action === "restore") return declared(MAIL_RESTORE_CAPABILITY);
    return declared(MAIL_ACTION_CAPABILITY[action]) && declared(MAIL_RESTORE_CAPABILITY);
  }

  private declared(capabilityId: string): boolean {
    const found = this.options.capability(capabilityId);
    return found.support === "declared" && found.adapterId === this.options.adapterId && found.availability.state === "available";
  }

  private coveredCapabilities(): string[] {
    return MAIL_MOVE_CAPABILITIES.filter(id => this.declared(id));
  }

  async press(request: PressRequest): Promise<PressOutcome> {
    const { action } = request;
    if (!this.available(action)) return { kind: "unavailable", reason: UNAVAILABLE_ACTION(action) };
    const capabilityId = MAIL_ACTION_CAPABILITY[action];
    let grantId = await this.options.authority.findGrant(capabilityId);
    if (request.choice === "cancel") return { kind: "cancelled" };
    if (!grantId) {
      if (request.choice === undefined) return { kind: "needs-grant", prompt: { connectionId: this.options.connectionId, action, covers: this.coveredCapabilities(), question: QUESTION[action], options: GRANT_OPTIONS } };
      if (request.choice === "always") {
        grantId = await this.options.authority.grant(this.coveredCapabilities());
        if (!grantId) return { kind: "denied", reason: reason("authority_denied", "The Cortex runtime does not allow a standing permission for this connection.") };
      }
    }
    const input: MailMoveInput = request.action === "move" ? { action: "move", message: this.message(request.messageId), target: request.target } : { action: "trash", message: this.message(request.messageId) };
    return this.run(input, request.provenance, grantId, undefined);
  }

  async undo(operationId: string, provenance: Provenance): Promise<UndoOutcome> {
    const original = await this.receipt(operationId);
    if (!original) return { kind: "unavailable", reason: reason("mail.receipt_unknown", "The Desk has no record of that move.") };
    if (original.undo.kind !== "available") return { kind: "unavailable", reason: reason("mail.undo_unavailable", `This move cannot be undone: ${original.undo.reason}.`) };
    if (this.undoing.has(operationId)) return { kind: "unavailable", reason: reason("mail.undo_unavailable", "This move is already being undone.") };
    this.undoing.add(operationId);
    try {
      const grantId = await this.options.authority.findGrant(MAIL_RESTORE_CAPABILITY);
      const from = original.folder ?? FOLDER_LABEL[original.target ?? ""] ?? original.target ?? "";
      const outcome = await this.run({ action: "restore", message: this.message(original.messageId), from }, provenance, grantId, operationId);
      if (outcome.kind !== "receipt") return outcome.kind === "denied" ? outcome : { kind: "unavailable", reason: reason("mail.undo_unavailable", "The move cannot be undone now.") };
      const refreshed = await this.receipt(operationId);
      return { kind: "receipt", receipt: outcome.receipt, original: refreshed ?? original };
    } finally {
      this.undoing.delete(operationId);
    }
  }

  async receipts(limit = 100): Promise<MailMoveReceipt[]> {
    const loaded = await this.loadAll();
    const links = compensationLinks(loaded);
    return loaded.map(item => this.project(item, links.get(item.journal.operationId) ?? [])).sort((a, b) => b.at.localeCompare(a.at) || b.operationId.localeCompare(a.operationId)).slice(0, limit);
  }

  async receipt(operationId: string): Promise<MailMoveReceipt | null> {
    return this.receiptOf(operationId, false);
  }

  private async receiptOf(operationId: string, fresh: boolean): Promise<MailMoveReceipt | null> {
    const found = await this.options.journal.read(operationId);
    if (!found) return null;
    const needsCompensations = !fresh && found.journal.state === "succeeded" && ("kind" in found.journal.snapshot || found.journal.snapshot.capabilityId !== MAIL_RESTORE_CAPABILITY);
    const compensations = needsCompensations ? await this.loadCompensations(operationId) : [];
    return this.project(found, compensations);
  }

  private message(messageId: string) { return mailMessageRef(this.options.adapterId, this.options.connectionId, messageId); }

  private async loadCompensations(operationId: string): Promise<StoredOperation[]> {
    const stored = await Promise.all((await this.options.index.compensations(operationId)).map(id => this.options.journal.read(id)));
    return stored.filter((item): item is StoredOperation => item !== null);
  }

  private async loadAll(): Promise<StoredOperation[]> {
    const stored = await Promise.all((await this.options.index.list()).map(id => this.options.journal.read(id)));
    return stored.filter((item): item is StoredOperation => item !== null);
  }

  private async run(input: MailMoveInput, provenance: Provenance, grantId: string | null, compensates: string | undefined): Promise<PressOutcome> {
    const { adapterId, connectionId, account } = this.options;
    let snapshot: ApprovedSnapshot;
    try {
      snapshot = mailMoveSnapshot({ adapterId, connectionId, account: mailAccountRef(adapterId, connectionId, account), input, provenance });
    } catch {
      return { kind: "unavailable", reason: reason("mail.invalid_request", "That mail cannot be moved: the request does not match the Mail contract.") };
    }
    const operationId = `mail-move:${this.newId()}`;
    const decision = await dispatchMailOperation(this.options, snapshot, operationId, grantId, compensates);
    if (decision.kind === "denied") return { kind: "denied", reason: decision.reason };
    const receipt = await this.receiptOf(operationId, true);
    if (!receipt) return { kind: "denied", reason: reason("mail.receipt_missing", "The attempt left no journal record.") };
    return { kind: "receipt", receipt };
  }

  private project(stored: StoredOperation, compensations: readonly StoredOperation[]): MailMoveReceipt {
    const journal = stored.journal;
    const legacy = readLegacyMove(stored);
    const undone = legacy?.row.undoneAt != null || compensations.some(other => other.journal.state === "succeeded");
    const inFlight = compensations.some(other => ["confirmed", "dispatching", "pending", "uncertain"].includes(other.journal.state));
    const base = legacy ? this.legacyReceipt(legacy, undone) : this.lifecycleReceipt(stored, undone);
    const connection = legacy ? legacy.connection : "kind" in journal.snapshot ? null : { adapterId: journal.snapshot.adapterId, connectionId: journal.snapshot.connectionId };
    return { ...base, undo: this.undoState(base, connection, inFlight) };
  }

  private undoState(receipt: Omit<MailMoveReceipt, "undo">, originConnection: { adapterId: string; connectionId: string } | null, inFlight: boolean): UndoState {
    const none = (why: Extract<UndoState, { kind: "unavailable" }>["reason"]): UndoState => ({ kind: "unavailable", reason: why });
    if (receipt.action === "restore") return none("restore");
    if (receipt.state !== "done") return none("not-done");
    if (originConnection?.adapterId !== this.options.adapterId || originConnection.connectionId !== this.options.connectionId) return none("other-connection");
    if (receipt.account !== this.options.account) return none("other-connection");
    if (receipt.undone) return none("undone");
    if (inFlight) return none("in-progress");
    if (this.now() - Date.parse(receipt.at) > UNDO_WINDOW_MS) return none("expired");
    return this.available("restore") ? { kind: "available" } : none("unsupported");
  }

  private legacyReceipt(legacy: NonNullable<ReturnType<typeof readLegacyMove>>, undone: boolean): Omit<MailMoveReceipt, "undo"> {
    const { row } = legacy;
    return { operationId: `mail-move:${row.id}`, action: row.target === "trash" ? "trash" : "move", messageId: row.messageId, account: row.account, target: row.target, ...(row.folder ? { folder: row.folder } : {}), state: "done", message: DONE_MESSAGE[row.target] ?? "Moved.", at: new Date(row.createdAt).toISOString(), basis: "legacy", undone };
  }

  private lifecycleReceipt(stored: StoredOperation, undone: boolean): Omit<MailMoveReceipt, "undo"> {
    const { journal } = stored;
    const snapshot = journal.snapshot;
    if ("kind" in snapshot) throw new Error("A legacy snapshot is not a Mail move.");
    const action = (Object.entries(MAIL_ACTION_CAPABILITY).find(([, id]) => id === snapshot.capabilityId)?.[0] ?? "move") as MailMoveAction;
    const body = snapshot.input as { message: { canonicalId: string }; target?: string; from?: string };
    const account = snapshot.destinations[0]?.canonicalId ?? "";
    const approved = journal.events[0]?.event;
    const basis = approved?.kind === "approved" && approved.authority.basis.kind === "grant" ? "grant" as const : "confirmation" as const;
    const results = journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response.result] : []);
    const success = results.findLast(item => item.kind === "succeeded");
    const output = success?.kind === "succeeded" ? MailMoveOutputSchema.safeParse(success.output) : null;
    const target = body.target ?? (action === "trash" ? "trash" : undefined);
    const common = { operationId: journal.operationId, action, messageId: body.message.canonicalId, account, ...(target ? { target } : {}), at: journal.events.at(-1)?.at ?? journal.events[0]?.at ?? "", basis, ...(journal.links?.compensatesOperationId ? { compensates: journal.links.compensatesOperationId } : {}), undone };
    if (journal.state === "succeeded" && output?.success) return { ...common, at: journal.events[0]?.at ?? common.at, state: "done", folder: output.data.folder, message: action === "restore" ? "Moved back." : DONE_MESSAGE[target ?? ""] ?? "Moved." };
    const failure = results.findLast(item => item.kind === "failed");
    if (failure?.kind === "failed") return { ...common, at: journal.events[0]?.at ?? common.at, state: stateOfRefusal(failure.error.code), message: failure.error.message };
    const conflict = results.findLast(item => item.kind === "conflict");
    if (conflict?.kind === "conflict") return { ...common, at: journal.events[0]?.at ?? common.at, state: "conflict", message: conflict.error.message };
    const local = journal.events.findLast(entry => entry.event.kind === "local-outcome");
    if (local?.event.kind === "local-outcome") return { ...common, at: journal.events[0]?.at ?? common.at, state: "refused", message: local.event.reason.message };
    const active = ["dispatching", "pending", "confirmed"].includes(journal.state);
    return { ...common, at: journal.events[0]?.at ?? common.at, state: active ? "pending" : "uncertain", message: active ? "The move is still running." : "The mail provider has not confirmed the move. Check the mailbox before trying again." };
  }
}

export interface MailMoveAuthorityService {
  findConnectionGrant(context: HostContext, connectionId: string, capabilityId: string): Promise<string | null>;
  grantConnectionActions(context: HostContext, connectionId: string, capabilityIds: readonly string[]): Promise<string | null>;
  confirm(context: HostContext, input: MailApprovalInput): Promise<ApprovalDecision>;
  approveGrant(context: HostContext, input: MailApprovalInput, grantId: string): Promise<ApprovalDecision>;
}

/** Binds the Cortex runtime authority to one authenticated session and one Mail connection. */
export function mailMoveAuthority(service: MailMoveAuthorityService, context: HostContext, connectionId: string): MailMoveAuthority {
  return {
    findGrant: capabilityId => service.findConnectionGrant(context, connectionId, capabilityId),
    grant: capabilityIds => service.grantConnectionActions(context, connectionId, capabilityIds),
    approve: (input, grantId) => grantId ? service.approveGrant(context, input, grantId) : service.confirm(context, input),
  };
}
