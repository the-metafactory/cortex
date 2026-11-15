import { z } from "zod";
import { isDmarcReportMail } from "../../../surface/mc/desk/mail-dmarc";
import { matchesRule } from "../../../surface/mc/desk/mail-rules";
import { RULE_MATCHES } from "../../../surface/mc/desk/mail-rules-schema";
import { MailStandingGrantBaseSchema } from "./grant-primitives";
import { MAIL_ACTIONS, type MailAction, type MailTarget } from "./move-contract";

export const MAIL_LOOP_KINDS = ["rule", "dmarc"] as const;
export type MailLoopKind = (typeof MAIL_LOOP_KINDS)[number];

export const MAIL_LOOP_ACTIONS = MAIL_ACTIONS;
export type MailLoopAction = MailAction;

export const MailRuleSelectionSchema = z.object({ kind: z.literal("rule"), ruleId: z.string().min(1), match: z.enum(RULE_MATCHES), value: z.string().min(1).max(200) }).strict();
export const MailDmarcSelectionSchema = z.object({ kind: z.literal("dmarc"), ruleIds: z.array(z.string().min(1)).min(1).max(20) }).strict();
export const MailLoopSelectionSchema = z.discriminatedUnion("kind", [MailRuleSelectionSchema, MailDmarcSelectionSchema]);
export type MailLoopSelection = z.infer<typeof MailLoopSelectionSchema>;

export const MailLoopGrantSchema = MailStandingGrantBaseSchema.extend({
  authorityGrantId: z.string().min(1).nullable(),
  loop: z.enum(MAIL_LOOP_KINDS),
  actions: z.array(z.enum(MAIL_LOOP_ACTIONS)).min(1).max(MAIL_LOOP_ACTIONS.length),
  selection: MailLoopSelectionSchema,
}).strict();
export type MailLoopGrant = z.infer<typeof MailLoopGrantSchema>;

/** One listed mail a loop may act on: its identity, sender, subject and the digest rule that held it. */
export interface LoopMail {
  id: string;
  account: string | null;
  subject: string;
  from: { address: string };
  headers?: { listId?: string };
  heldBy?: string | null;
}

export type MailLoopTarget = MailTarget;

export const loopSelectionFits = (loop: MailLoopKind, selection: MailLoopSelection): boolean => (loop === "rule" ? selection.kind === "rule" : selection.kind === "dmarc");

/** True when the mail is inside the named selection: a rule's own match, or a report a named digest rule held. */
export function inLoopSelection(selection: MailLoopSelection, mail: LoopMail): boolean {
  if (selection.kind === "rule") return matchesRule({ match: selection.match, value: selection.value }, mail);
  return isDmarcReportMail(mail) && typeof mail.heldBy === "string" && selection.ruleIds.includes(mail.heldBy);
}
