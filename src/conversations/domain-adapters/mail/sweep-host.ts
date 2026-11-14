import { randomUUID } from "node:crypto";
import { summarizeBatch } from "../operations/batches";
import type { OperationJournalStore } from "../operations/journal";
import type { OperationState, Provenance } from "../operations/types";
import type { BoundaryError } from "../types";
import { mailActionForTarget } from "./move-contract";
import { GRANT_OPTIONS, type GrantChoice, type MailMoveHost, type MailMoveReceipt, type ReceiptState } from "./move-host";
import type { MailMoveAuthority } from "./move-host";
import { MailSweepRuleSchema, MailSweepTargetSchema, sweepCapabilityIds, sweepDigest, sweepMailCount, sweepMembers, sweepPreviewMember, sweepPromptQuestion, sweepRulePhrase, type MailSweepPreview, type MailSweepRule, type MailSweepTarget, type SweepMail } from "./sweep-contract";
import { sweepGrantCovers, type MailSweepGrants } from "./sweep-grant-store";
import type { MailSweepGrant } from "./sweep-contract";
import type { MailSweepSet, MailSweepSets } from "./sweep-set-store";

export interface MailSweepHostOptions {
  adapterId: string;
  connectionId: string;
  account: string;
  moves: MailMoveHost;
  journal: OperationJournalStore;
  grants: MailSweepGrants;
  sets: MailSweepSets;
  authority: MailMoveAuthority;
  now?: () => number;
  newId?: () => string;
}

export interface MailSweepPrompt {
  connectionId: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
  phrase: string;
  count: number;
  capabilities: readonly string[];
  question: string;
  options: typeof GRANT_OPTIONS;
}

export interface MailSweepReceiptItem {
  messageId: string;
  subject: string;
  operationId: string;
  state: ReceiptState | "unattempted";
  message: string;
  undone: boolean;
  conflict: boolean;
  undo: MailMoveReceipt["undo"];
}

export interface MailSweepReceipt {
  sweepId: string;
  adapterId: string;
  connectionId: string;
  account: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
  phrase: string;
  count: number;
  summary: ReturnType<typeof summarizeBatch>;
  message: string;
  restored: number;
  conflicts: number;
  items: MailSweepReceiptItem[];
  undone: boolean;
  at: string;
}

export interface MailSweepRun {
  preview: MailSweepPreview;
  mail: readonly SweepMail[];
  provenance: Provenance;
  choice?: GrantChoice;
}

export type MailSweepOutcome =
  | { kind: "needs-grant"; prompt: MailSweepPrompt }
  | { kind: "cancelled" }
  | { kind: "stale"; preview: MailSweepPreview }
  | { kind: "refused"; reason: BoundaryError }
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "denied"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailSweepReceipt };

export type MailSweepUndoOutcome =
  | { kind: "unavailable"; reason: BoundaryError }
  | { kind: "receipt"; receipt: MailSweepReceipt };

const reason = (code: string, message: string): BoundaryError => ({ code, message });
const quoted = (text: string): string => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
const failureList = (items: readonly MailSweepReceiptItem[]): string => items.map(item => `${quoted(item.subject)} (${item.message.replace(/\.$/, "")})`).join("; ");
const movedTo = (target: MailSweepTarget): string => (target === "archive" ? "" : ` to ${target === "junk" ? "Junk" : "Trash"}`);
const UNDO_WHY: Record<Extract<MailMoveReceipt["undo"], { kind: "unavailable" }>["reason"], string> = {
  "not-done": "the move did not finish",
  undone: "it is already back",
  expired: "it is past the Undo window",
  unsupported: "this connection cannot restore it",
  "other-connection": "it belongs to another connection",
  restore: "it is a restore",
  "in-progress": "an Undo is already running",
};
const whyMoved = (item: MailSweepReceiptItem): string =>
  item.conflict || item.undo.kind === "available" ? item.message.replace(/\.$/, "") : UNDO_WHY[item.undo.reason];

/** Runs one previewed sweep of a Mail connection's listed mail under a permission that names the action and the rule. */
export class MailSweepHost {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly undoing = new Set<string>();

  constructor(private readonly options: MailSweepHostOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  available(target: MailSweepTarget): boolean {
    return this.options.moves.available(mailActionForTarget(target));
  }

  preview(input: { rule: MailSweepRule; target: MailSweepTarget; mail: readonly SweepMail[] }): MailSweepPreview {
    const rule = MailSweepRuleSchema.parse(input.rule);
    const target = MailSweepTargetSchema.parse(input.target);
    const members = sweepMembers(rule, input.mail, this.options.account, this.now());
    const messageIds = members.map(member => member.id);
    return {
      adapterId: this.options.adapterId,
      connectionId: this.options.connectionId,
      account: this.options.account,
      target,
      rule,
      phrase: sweepRulePhrase(rule),
      count: members.length,
      digest: sweepDigest(rule, target, messageIds),
      at: new Date(this.now()).toISOString(),
      members: members.map(sweepPreviewMember),
    };
  }

  async grant(input: { rule: MailSweepRule; target: MailSweepTarget }): Promise<MailSweepGrant | null> {
    const target = MailSweepTargetSchema.parse(input.target);
    const rule = MailSweepRuleSchema.parse(input.rule);
    if (!this.available(target)) return null;
    const authorityGrantId = await this.options.authority.grant(sweepCapabilityIds(target));
    if (!authorityGrantId) return null;
    return this.options.grants.issue({ adapterId: this.options.adapterId, connectionId: this.options.connectionId, target, rule, authorityGrantId }, this.now());
  }

  async run(input: MailSweepRun): Promise<MailSweepOutcome> {
    if (input.choice === "cancel") return { kind: "cancelled" };
    const preview = this.owned(input.preview);
    if (!preview) return { kind: "unavailable", reason: reason("mail.invalid_request", "That sweep does not belong to this Mail connection.") };
    if (!this.available(preview.target)) return { kind: "unavailable", reason: reason("mail.capability_unavailable", "This connection cannot move that mail, so the sweep cannot run.") };
    const fresh = this.preview({ rule: preview.rule, target: preview.target, mail: input.mail });
    if (fresh.digest !== preview.digest) return { kind: "stale", preview: fresh };
    if (fresh.count === 0) return { kind: "refused", reason: reason("mail.sweep_empty", "The rule matches no unread mail on this connection.") };
    const authorityGrantId = await this.permission(fresh, input.choice);
    if ("kind" in authorityGrantId) return authorityGrantId;
    const sweepId = this.newId();
    const set = this.options.sets.register({
      sweepId,
      adapterId: this.options.adapterId,
      connectionId: this.options.connectionId,
      account: this.options.account,
      target: fresh.target,
      rule: fresh.rule,
      digest: fresh.digest,
      count: fresh.count,
      items: fresh.members.map((member, position) => ({ messageId: member.messageId, subject: member.subject, operationId: `mail-sweep:${sweepId}:${position}` })),
    }, this.now());
    const refusal = await this.moveAll(set, fresh.members, input.provenance, authorityGrantId.grantId);
    const receipt = await this.derive(set);
    if (refusal && receipt.items.every(item => item.state === "unattempted")) {
      this.options.sets.discard(sweepId);
      return refusal.code === "mail.capability_unavailable" ? { kind: "unavailable", reason: refusal } : { kind: "denied", reason: refusal };
    }
    return { kind: "receipt", receipt };
  }

  async receipt(sweepId: string): Promise<MailSweepReceipt | null> {
    const set = this.options.sets.find(sweepId);
    return set && this.owns(set) ? this.derive(set) : null;
  }

  async receipts(limit = 50): Promise<MailSweepReceipt[]> {
    const sets = this.options.sets.list(this.options.connectionId, limit).filter(set => this.owns(set));
    return Promise.all(sets.map(set => this.derive(set)));
  }

  async undo(sweepId: string, provenance: Provenance): Promise<MailSweepUndoOutcome> {
    const set = this.options.sets.find(sweepId);
    if (!set || !this.owns(set)) return { kind: "unavailable", reason: reason("mail.sweep_unknown", "The Desk has no record of that sweep.") };
    if (set.undoneAt !== null) return { kind: "unavailable", reason: reason("mail.undo_unavailable", "That sweep is already undone.") };
    if (this.undoing.has(sweepId)) return { kind: "unavailable", reason: reason("mail.undo_unavailable", "That sweep is already being undone.") };
    this.undoing.add(sweepId);
    try {
      for (const item of set.items) {
        const receipt = await this.options.moves.receipt(item.operationId);
        if (!receipt || receipt.action === "restore" || receipt.state !== "done" || receipt.undone) continue;
        await this.options.moves.undo(item.operationId, provenance);
      }
      const current = this.options.sets.find(sweepId) ?? set;
      const receipt = await this.derive(current);
      if (!receipt.items.some(item => item.state === "done" && !item.undone)) this.options.sets.markUndone(sweepId, this.now());
      return { kind: "receipt", receipt: await this.derive(this.options.sets.find(sweepId) ?? current) };
    } finally {
      this.undoing.delete(sweepId);
    }
  }

  private async permission(preview: MailSweepPreview, choice: GrantChoice | undefined): Promise<{ grantId: string | null } | { kind: "needs-grant"; prompt: MailSweepPrompt } | { kind: "denied"; reason: BoundaryError }> {
    const active = this.options.grants.active(this.options.connectionId, preview.target);
    if (sweepGrantCovers(active, preview.target, preview.rule)) return { grantId: active.authorityGrantId };
    if (choice === undefined) {
      return { kind: "needs-grant", prompt: { connectionId: this.options.connectionId, target: preview.target, rule: preview.rule, phrase: preview.phrase, count: preview.count, capabilities: sweepCapabilityIds(preview.target), question: sweepPromptQuestion(preview.target, preview.phrase, preview.count), options: GRANT_OPTIONS } };
    }
    if (choice === "always") {
      const issued = await this.grant({ rule: preview.rule, target: preview.target });
      if (!issued?.authorityGrantId) return { kind: "denied", reason: reason("authority_denied", "The Cortex runtime does not allow a standing permission for this connection.") };
      return { grantId: issued.authorityGrantId };
    }
    return { grantId: null };
  }

  private async moveAll(set: MailSweepSet, members: MailSweepPreview["members"], provenance: Provenance, grantId: string | null): Promise<BoundaryError | null> {
    for (const [position, member] of members.entries()) {
      const item = set.items[position];
      if (!item) break;
      const outcome = set.target === "trash"
        ? await this.options.moves.move({ action: "trash", messageId: member.messageId, provenance, grantId, operationId: item.operationId })
        : await this.options.moves.move({ action: "move", messageId: member.messageId, target: set.target, provenance, grantId, operationId: item.operationId });
      if (outcome.kind === "denied" || outcome.kind === "unavailable") return outcome.reason;
    }
    return null;
  }

  private owned(preview: MailSweepPreview): MailSweepPreview | null {
    const rule = MailSweepRuleSchema.safeParse(preview.rule);
    const target = MailSweepTargetSchema.safeParse(preview.target);
    if (!rule.success || !target.success) return null;
    if (preview.adapterId !== this.options.adapterId || preview.connectionId !== this.options.connectionId || preview.account !== this.options.account) return null;
    const messageIds = preview.members.map(member => member.messageId);
    if (preview.count !== messageIds.length || sweepDigest(rule.data, target.data, messageIds) !== preview.digest) return null;
    return { ...preview, rule: rule.data, target: target.data };
  }

  private owns(set: MailSweepSet): boolean {
    return set.adapterId === this.options.adapterId && set.connectionId === this.options.connectionId && set.account === this.options.account;
  }

  private async derive(set: MailSweepSet): Promise<MailSweepReceipt> {
    const items: MailSweepReceiptItem[] = [];
    const states: ("unattempted" | OperationState)[] = [];
    let restoreAttempted = false;
    for (const item of set.items) {
      const stored = await this.options.journal.read(item.operationId);
      states.push(stored?.journal.state ?? "unattempted");
      const receipt = await this.options.moves.receipt(item.operationId);
      const restores = receipt ? await this.options.moves.restores(item.operationId) : [];
      restoreAttempted = restoreAttempted || restores.length > 0;
      const latest = restores.at(-1);
      const conflict = latest?.state === "conflict" ? latest : undefined;
      items.push({
        messageId: item.messageId,
        subject: item.subject,
        operationId: item.operationId,
        state: receipt?.state ?? (stored ? "uncertain" : "unattempted"),
        message: conflict?.message ?? receipt?.message ?? "",
        undone: receipt?.undone ?? false,
        conflict: conflict !== undefined,
        undo: receipt?.undo ?? { kind: "unavailable", reason: "not-done" },
      });
    }
    const restored = items.filter(item => item.undone).length;
    const conflicts = items.filter(item => item.conflict).length;
    return {
      sweepId: set.sweepId,
      adapterId: set.adapterId,
      connectionId: set.connectionId,
      account: set.account,
      target: set.target,
      rule: set.rule,
      phrase: sweepRulePhrase(set.rule),
      count: set.count,
      summary: summarizeBatch(states),
      message: restoreAttempted ? this.undoMessage(items, restored) : this.runMessage(set, items),
      restored,
      conflicts,
      items,
      undone: set.undoneAt !== null,
      at: new Date(set.createdAt).toISOString(),
    };
  }

  private runMessage(set: MailSweepSet, items: readonly MailSweepReceiptItem[]): string {
    const moved = items.filter(item => item.state === "done").length;
    const failed = items.filter(item => item.state !== "done" && item.state !== "unattempted");
    const done = set.target === "archive" ? "Archived" : "Moved";
    if (failed.length === 0) return `${done} ${sweepMailCount(moved)}${movedTo(set.target)} ${sweepRulePhrase(set.rule)}.`;
    return `${done} ${moved} of ${set.count}${movedTo(set.target)}. Not moved: ${failureList(failed)}.`;
  }

  private undoMessage(items: readonly MailSweepReceiptItem[], restored: number): string {
    const outstanding = items.filter(item => item.state === "done" && !item.undone);
    if (outstanding.length === 0) return `Moved ${sweepMailCount(restored)} back to INBOX.`;
    const still = outstanding.map(item => `${quoted(item.subject)} (${whyMoved(item)})`).join("; ");
    return `Moved ${restored} of ${restored + outstanding.length} back to INBOX. Still moved: ${still}. Undo again to retry.`;
  }
}
