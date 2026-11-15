import { createHash } from "node:crypto";
import { z } from "zod";
import { DAY_MS } from "../../../surface/mc/desk/time";
import { canonicalWire } from "../operations/validation";
import { MailStandingGrantBaseSchema } from "./grant-primitives";
import { MAIL_TARGETS, mailActionCapabilityIds, mailActionForTarget, type MailTarget } from "./move-contract";

export const MailSweepRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sender"), address: z.string().trim().min(1).max(320) }).strict(),
  z.object({ kind: z.literal("age"), olderThanDays: z.number().int().min(1).max(365) }).strict(),
]);
export type MailSweepRule = z.infer<typeof MailSweepRuleSchema>;

export type MailSweepTarget = MailTarget;
export const MailSweepTargetSchema = z.enum(MAIL_TARGETS);

export const MailSweepGrantSchema = MailStandingGrantBaseSchema.extend({
  target: MailSweepTargetSchema,
  rule: MailSweepRuleSchema,
}).strict();
export type MailSweepGrant = z.infer<typeof MailSweepGrantSchema>;

export interface SweepMail {
  id: string;
  account: string | null;
  subject: string;
  from: { address: string };
  receivedAt: string;
  unread: boolean;
}

export const sameSweepRule = (left: MailSweepRule, right: MailSweepRule): boolean => canonicalWire(left) === canonicalWire(right);

export function inSweepRule(rule: MailSweepRule, mail: SweepMail, now: number): boolean {
  if (rule.kind === "sender") return mail.from.address.trim().toLowerCase() === rule.address.trim().toLowerCase();
  const received = Date.parse(mail.receivedAt);
  return Number.isFinite(received) && received < now - rule.olderThanDays * DAY_MS;
}

export function sweepMembers(rule: MailSweepRule, mail: readonly SweepMail[], account: string, now: number): SweepMail[] {
  const seen = new Set<string>();
  const picked: SweepMail[] = [];
  for (const item of mail) {
    if (!item.unread || item.account !== account || seen.has(item.id)) continue;
    seen.add(item.id);
    if (inSweepRule(rule, item, now)) picked.push(item);
  }
  return picked.sort((left, right) => left.id.localeCompare(right.id));
}

export const sweepRulePhrase = (rule: MailSweepRule): string =>
  rule.kind === "sender" ? `from ${rule.address}` : `older than ${rule.olderThanDays === 1 ? "1 day" : `${rule.olderThanDays} days`}`;

export const sweepCapabilityIds = (target: MailSweepTarget): string[] => mailActionCapabilityIds([mailActionForTarget(target)]);

export function sweepDigest(rule: MailSweepRule, target: MailSweepTarget, messageIds: readonly string[]): string {
  return createHash("sha256").update(canonicalWire({ rule, target, messageIds: [...messageIds] })).digest("hex");
}

export interface MailSweepPreviewMember {
  messageId: string;
  subject: string;
  from: string;
  at: string;
}

export interface MailSweepPreview {
  adapterId: string;
  connectionId: string;
  account: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
  phrase: string;
  count: number;
  digest: string;
  at: string;
  members: MailSweepPreviewMember[];
}

const TARGET_ACTION: Record<MailSweepTarget, string> = { archive: "Archive", junk: "Move to Junk", trash: "Move to Trash" };

export const sweepMailCount = (count: number): string => `${count} ${count === 1 ? "mail" : "mails"}`;

export function sweepPromptQuestion(target: MailSweepTarget, phrase: string, count: number): string {
  const subject = `${sweepMailCount(count)} ${phrase}`;
  if (target === "archive") return `Archive ${subject} with one click on this connection?`;
  return `Move ${subject} to ${target === "junk" ? "Junk" : "Trash"} with one click on this connection?`;
}

export const sweepGrantLabel = (target: MailSweepTarget): string => TARGET_ACTION[target];

export const sweepPreviewMember = (mail: SweepMail): MailSweepPreviewMember =>
  ({ messageId: mail.id, subject: mail.subject, from: mail.from.address, at: mail.receivedAt });
