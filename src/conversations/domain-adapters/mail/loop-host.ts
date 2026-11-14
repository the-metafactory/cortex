import type { Provenance } from "../operations/types";
import type { RuleMatch } from "../../../surface/mc/desk/mail-rules-schema";
import { MailMoveHost, type MailMoveAuthority, type MailMoveReceipt, type ReceiptState } from "./move-host";
import { inLoopSelection, loopActionOf, loopCapabilityIds, type LoopMail, type MailLoopAction, type MailLoopGrant, type MailLoopKind, type MailLoopSelection, type MailLoopTarget } from "./loop-contract";
import type { MailLoopGrants } from "./loop-grant-store";

export const MAIL_LOOP_REFUSALS = ["no-grant", "outside-selection", "denied"] as const;
export type MailLoopRefusal = (typeof MAIL_LOOP_REFUSALS)[number];

const NO_GRANT = "No standing permission names this action on this connection, so the loop proposes the change instead.";
const OUTSIDE = "This mail is outside what the standing permission names, so the loop leaves it alone.";

/** One rule pass: the approved rule, and the unread mail it matched on this connection. */
export interface RuleLoopWork {
  rule: { id: string; match: RuleMatch; value: string; target: MailLoopTarget };
  mail: readonly LoopMail[];
}

/** One DMARC pass: where a report goes, and the report mail a digest rule held on this connection. */
export interface DmarcLoopWork {
  target: MailLoopTarget;
  mail: readonly LoopMail[];
}

export interface MailLoopProposal {
  loop: MailLoopKind;
  adapterId: string;
  connectionId: string;
  grantId: string | null;
  ruleId: string | null;
  messageId: string;
  account: string | null;
  target: MailLoopTarget;
  subject: string;
  reason: MailLoopRefusal;
  message: string;
}

export interface MailLoopFailure {
  messageId: string;
  state: ReceiptState;
  message: string;
}

export interface MailLoopPass {
  loop: MailLoopKind;
  paused: boolean;
  acted: number;
  proposals: MailLoopProposal[];
  receipts: MailMoveReceipt[];
  failures: MailLoopFailure[];
}

export interface MailLoopHostOptions {
  adapterId: string;
  connectionId: string;
  account: string;
  moves: MailMoveHost;
  grants: MailLoopGrants;
  authority: MailMoveAuthority;
  now?: () => number;
}

interface LoopItem {
  mail: LoopMail;
  ruleId: string | null;
  target: MailLoopTarget;
  selection: MailLoopSelection | null;
}

type Runnable = { kind: "refused"; reason: MailLoopRefusal; message: string } | { kind: "grant"; grantId: string };

const sameRuleSelection = (grant: MailLoopSelection, item: MailLoopSelection | null): boolean =>
  item === null || grant.kind === "rule" && item.kind === "rule" && grant.ruleId === item.ruleId && grant.match === item.match && grant.value === item.value;

/** Runs unattended Mail loops through one connection's move verbs, only where a standing grant names the action and the mail. */
export class MailLoopHost {
  private readonly now: () => number;

  constructor(private readonly options: MailLoopHostOptions) {
    this.now = options.now ?? Date.now;
  }

  async grant(input: { loop: MailLoopKind; actions: readonly MailLoopAction[]; selection: MailLoopSelection }): Promise<MailLoopGrant | null> {
    const authorityGrantId = await this.options.authority.grant(loopCapabilityIds(input.actions));
    if (!authorityGrantId) return null;
    return this.options.grants.issue({ ...input, adapterId: this.options.adapterId, connectionId: this.options.connectionId, authorityGrantId }, this.now());
  }

  revoke(grantId: string): boolean {
    return this.options.grants.revoke(grantId, this.now());
  }

  pause(loop: MailLoopKind): void {
    this.options.grants.pause(loop, this.now());
  }

  resume(loop: MailLoopKind): void {
    this.options.grants.resume(loop);
  }

  paused(loop: MailLoopKind): boolean {
    return this.options.grants.paused(loop);
  }

  activeGrant(loop: MailLoopKind): MailLoopGrant | null {
    return this.options.grants.active(loop, this.options.connectionId);
  }

  receipts(limit?: number): Promise<MailMoveReceipt[]> {
    return this.options.moves.receipts(limit);
  }

  receipt(operationId: string): Promise<MailMoveReceipt | null> {
    return this.options.moves.receipt(operationId);
  }

  undo(operationId: string, provenance: Provenance): ReturnType<MailMoveHost["undo"]> {
    return this.options.moves.undo(operationId, provenance);
  }

  runRules(work: RuleLoopWork, provenance: Provenance): Promise<MailLoopPass> {
    const selection: MailLoopSelection = { kind: "rule", ruleId: work.rule.id, match: work.rule.match, value: work.rule.value };
    return this.pass("rule", provenance, work.mail.map(mail => ({ mail, ruleId: work.rule.id, target: work.rule.target, selection })));
  }

  runDmarc(work: DmarcLoopWork, provenance: Provenance): Promise<MailLoopPass> {
    return this.pass("dmarc", provenance, work.mail.map(mail => ({ mail, ruleId: null, target: work.target, selection: null })));
  }

  private async pass(loop: MailLoopKind, provenance: Provenance, items: readonly LoopItem[]): Promise<MailLoopPass> {
    const pass: MailLoopPass = { loop, paused: false, acted: 0, proposals: [], receipts: [], failures: [] };
    if (this.paused(loop)) {
      pass.paused = true;
      return pass;
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (this.paused(loop)) {
        pass.paused = true;
        break;
      }
      if (seen.has(item.mail.id)) continue;
      seen.add(item.mail.id);
      const grant = this.activeGrant(loop);
      const action = loopActionOf(item.target);
      const runnable = this.runnable(grant, loop, item, action);
      if (runnable.kind === "refused") {
        pass.proposals.push(this.proposal(loop, grant, item, runnable.reason, runnable.message));
        continue;
      }
      const outcome = item.target === "trash"
        ? await this.options.moves.move({ action: "trash", messageId: item.mail.id, provenance, grantId: runnable.grantId })
        : await this.options.moves.move({ action: "move", messageId: item.mail.id, target: item.target, provenance, grantId: runnable.grantId });
      if (outcome.kind === "receipt") {
        pass.receipts.push(outcome.receipt);
        if (outcome.receipt.state === "done") pass.acted += 1;
        else pass.failures.push({ messageId: item.mail.id, state: outcome.receipt.state, message: outcome.receipt.message });
      } else if (outcome.kind === "denied") {
        pass.proposals.push(this.proposal(loop, grant, item, "denied", outcome.reason.message));
      } else {
        pass.failures.push({ messageId: item.mail.id, state: "refused", message: outcome.reason.message });
      }
    }
    return pass;
  }

  private runnable(grant: MailLoopGrant | null, loop: MailLoopKind, item: LoopItem, action: MailLoopAction): Runnable {
    if (!grant?.authorityGrantId) return { kind: "refused", reason: "no-grant", message: NO_GRANT };
    const wants: MailLoopSelection["kind"] = loop === "rule" ? "rule" : "dmarc";
    if (grant.selection.kind !== wants) return { kind: "refused", reason: "outside-selection", message: OUTSIDE };
    if (!sameRuleSelection(grant.selection, item.selection)) return { kind: "refused", reason: "outside-selection", message: OUTSIDE };
    if (!grant.actions.includes(action)) return { kind: "refused", reason: "outside-selection", message: OUTSIDE };
    if (!inLoopSelection(grant.selection, item.mail)) return { kind: "refused", reason: "outside-selection", message: OUTSIDE };
    if (item.mail.account !== this.options.account) return { kind: "refused", reason: "outside-selection", message: OUTSIDE };
    return { kind: "grant", grantId: grant.authorityGrantId };
  }

  private proposal(loop: MailLoopKind, grant: MailLoopGrant | null, item: LoopItem, reason: MailLoopRefusal, message: string): MailLoopProposal {
    return {
      loop, adapterId: this.options.adapterId, connectionId: this.options.connectionId,
      grantId: grant?.grantId ?? null, ruleId: item.ruleId, messageId: item.mail.id, account: item.mail.account,
      target: item.target, subject: item.mail.subject, reason, message,
    };
  }
}
