import { randomUUID } from "node:crypto";
import type { Provenance } from "../operations/types";
import type { BoundaryError } from "../types";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";
import { GRANT_OPTIONS, type GrantChoice, type ReceiptState } from "./move-host";
import { dispatchMailOperation, type MailHostOptions } from "./host-operation";
import { judgementCapability, judgementHasUndo, mailJudgementSnapshot, MailJudgementInputSchema, MailJudgementOutputSchema, type MailJudgementAction, type MailJudgementInput } from "./judgement-contract";

export type MailJudgementHostOptions = MailHostOptions;

export interface MailJudgementReceipt {
  operationId: string;
  action: MailJudgementAction;
  messageId: string;
  state: ReceiptState;
  message: string;
  at: string;
  basis: "grant" | "confirmation";
  undo: boolean;
  undone: boolean;
  compensates?: string;
}

export type JudgementOutcome =
  | { kind: "needs-grant"; prompt: { connectionId: string; question: string; covers: string[]; options: typeof GRANT_OPTIONS } }
  | { kind: "needs-confirmation"; card: { connectionId: string; question: string; options: readonly ["Confirm", "Cancel"] } }
  | { kind: "cancelled" }
  | { kind: "unavailable" | "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailJudgementReceipt };

const unavailable = (code: string, message: string): JudgementOutcome => ({ kind: "unavailable", reason: { code, message } });

export class MailJudgementHost {
  private readonly undoing = new Set<string>();
  constructor(private readonly options: MailJudgementHostOptions) {}

  private available(action: MailJudgementAction): boolean {
    const capability = this.options.capability(judgementCapability(action));
    return capability.support === "declared" && capability.adapterId === this.options.adapterId && capability.availability.state === "available";
  }

  async press(raw: MailJudgementInput, provenance: Provenance, choice?: GrantChoice): Promise<JudgementOutcome> {
    if (choice === "cancel") return { kind: "cancelled" };
    const parsed = MailJudgementInputSchema.safeParse(raw);
    if (!parsed.success) return unavailable("mail.invalid_request", "The judgement does not match the Mail contract.");
    const input = parsed.data;
    if (input.action === "undo") return unavailable("mail.invalid_request", "Use the receipt's Undo for a completed judgement.");
    if (!this.available(input.action)) return unavailable("mail.capability_unavailable", "This connection does not offer that judgement change.");
    let snapshot;
    try { snapshot = mailJudgementSnapshot({ ...this.options, input, provenance }); }
    catch { return unavailable("mail.invalid_request", "The mail does not belong to this connection."); }
    const reversible = judgementHasUndo(input) && this.available("undo");
    const capabilityId = judgementCapability(input.action);
    let grantId = reversible ? await this.options.authority.findGrant(capabilityId) : null;
    if (!reversible && choice !== "once") return { kind: "needs-confirmation", card: { connectionId: this.options.connectionId, question: "Apply this Mail judgement change? It has no Undo.", options: ["Confirm", "Cancel"] } };
    if (!grantId && reversible) {
      const covers = [capabilityId, judgementCapability("undo")];
      if (choice === undefined) return { kind: "needs-grant", prompt: { connectionId: this.options.connectionId, question: `Use one click for ${input.action} on this Mail connection?`, covers, options: GRANT_OPTIONS } };
      if (choice === "always") {
        grantId = await this.options.authority.grant(covers);
        if (!grantId) return { kind: "denied", reason: { code: "authority_denied", message: "This connection cannot grant one-click permission." } };
      }
    }
    return this.run(snapshot, grantId);
  }

  async undo(operationId: string, provenance: Provenance): Promise<JudgementOutcome> {
    if (this.undoing.has(operationId)) return unavailable("mail.undo_unavailable", "This judgement is already being undone.");
    this.undoing.add(operationId);
    try {
      const receipt = await this.receipt(operationId);
      if (!receipt?.undo) return unavailable("mail.undo_unavailable", "This receipt has no available Undo.");
      const original = await this.options.journal.read(operationId);
      if (!original || "kind" in original.journal.snapshot) return unavailable("mail.undo_unavailable", "The original operation is unavailable.");
      const input = MailJudgementInputSchema.parse(original.journal.snapshot.input);
      const snapshot = mailJudgementSnapshot({ ...this.options, input: { action: "undo", message: input.message, operationId }, provenance });
      const grant = await this.options.authority.findGrant(judgementCapability("undo"));
      return await this.run(snapshot, grant, operationId);
    } finally { this.undoing.delete(operationId); }
  }

  private async run(snapshot: ReturnType<typeof mailJudgementSnapshot>, grantId: string | null, compensates?: string): Promise<JudgementOutcome> {
    const operationId = `mail-judgement:${randomUUID()}`;
    const decision = await dispatchMailOperation(this.options, snapshot, operationId, grantId, compensates);
    if (decision.kind === "denied") return { kind: "denied", reason: decision.reason };
    const receipt = await this.receipt(operationId);
    return receipt ? { kind: "receipt", receipt } : unavailable("mail.receipt_missing", "The attempt has no journal receipt.");
  }

  async receipt(operationId: string): Promise<MailJudgementReceipt | null> {
    const stored = await this.options.journal.read(operationId);
    if (!stored || "kind" in stored.journal.snapshot) return null;
    const { journal } = stored;
    const snapshot = journal.snapshot;
    if ("kind" in snapshot || snapshot.adapterId !== this.options.adapterId || snapshot.connectionId !== this.options.connectionId || snapshot.destinations[0]?.canonicalId !== this.options.account) return null;
    const parsed = MailJudgementInputSchema.safeParse(snapshot.input);
    if (!parsed.success || snapshot.capabilityId !== judgementCapability(parsed.data.action)) return null;
    const input = parsed.data;
    const responses = journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response.result] : []);
    const result = responses.at(-1);
    const success = result?.kind === "succeeded" ? MailJudgementOutputSchema.safeParse(result.output) : null;
    const links = await Promise.all((await this.options.index.compensations(operationId)).map(id => this.options.journal.read(id)));
    const undone = links.some(other => other?.journal.links?.compensatesOperationId === operationId && other.journal.state === "succeeded");
    const inFlight = links.some(other => other && ["confirmed", "dispatching", "pending", "uncertain"].includes(other.journal.state));
    const approved = journal.events[0]?.event;
    const at = journal.events[0]?.at ?? "";
    const local = journal.events.findLast(entry => entry.event.kind === "local-outcome");
    const state: ReceiptState = journal.state === "succeeded" && success?.success ? "done" : result?.kind === "failed" ? (result.error.code.endsWith(".vip_refused") ? "refused" : result.error.code.endsWith(".message_missing") ? "missing" : result.error.code.endsWith(".account_denied") ? "denied" : "failed") : result?.kind === "conflict" ? "conflict" : local ? "refused" : ["confirmed", "dispatching", "pending"].includes(journal.state) ? "pending" : "uncertain";
    const message = success?.success ? success.data.message : result && "error" in result ? result.error.message : local?.event.kind === "local-outcome" ? local.event.reason.message : state === "pending" ? "The judgement change is still running." : "Mail has not confirmed the change. Check Mail before trying again.";
    return { operationId, action: input.action, messageId: input.message.canonicalId, state, message, at, basis: approved?.kind === "approved" && approved.authority.basis.kind === "grant" ? "grant" : "confirmation", undo: state === "done" && success?.success === true && success.data.undo && judgementHasUndo(input) && !undone && !inFlight && (this.options.now ?? Date.now)() - Date.parse(at) <= UNDO_WINDOW_MS && this.available("undo"), undone, ...(journal.links?.compensatesOperationId ? { compensates: journal.links.compensatesOperationId } : {}) };
  }
}
