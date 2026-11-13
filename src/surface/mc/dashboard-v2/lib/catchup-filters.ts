import { DESK_ITEM_KINDS, type DeskItem, type DeskItemKind } from "../../desk/types";
import type { MailSweepView } from "../../desk/mail-sweep";

export type CatchupKind = "all" | DeskItemKind;
export const CARD_KIND_LABELS: Record<DeskItemKind, string> = {
  adapter: "Connected items",
  goal: "Goals", sensor: "Checks", "agent-failed": "Failed agents",
  "agent-blocked": "Blocked agents", decision: "Decisions", grilling: "Grilling",
  escalation: "Escalations", mail: "Mail", reminder: "Reminders", meeting: "Meetings",
  "mail-rule": "Mail rules", dmarc: "Mail reports", "mail-waiting": "Waiting for replies",
  "mail-handoff": "Mail handed to Ivy",
  "task-handoff": "Tasks handed to an agent",
};
export function readCatchupKind(value: string | null): CatchupKind {
  return DESK_ITEM_KINDS.find(kind => kind === value) ?? "all";
}
export function matchesCatchupText(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const text = fields.filter(field => field != null).join(" ").normalize("NFKC").toLocaleLowerCase();
  return query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).every(term => text.includes(term));
}
export function matchesCatchupItem(item: DeskItem, kind: CatchupKind, query: string): boolean {
  return (kind === "all" || item.kind === kind) && matchesCatchupText(query, [
    item.title, item.why, item.excerpt, item.suggestion, item.source, item.goal,
    item.detail.summary, ...item.detail.history, ...item.detail.refs,
    ...item.detail.links.map(link => link.label),
    ...(item.detail.evidence ?? []).map(evidence => evidence.title),
    ...(item.detail.precedents ?? []).map(precedent => precedent.subject),
    ...(item.detail.suspicion ?? []), item.question?.condition, item.question?.reason,
    item.reply?.to, item.reply?.subject,
    item.explanation?.sentence,
    ...(item.explanation?.choices ?? []).flatMap(choice => [choice.label, choice.consequence, choice.ruling]),
  ]);
}
export function catchupMailGroups<T extends MailSweepView>(groups: readonly T[], area: string, kind: CatchupKind, query: string): T[] {
  if (kind !== "all" && kind !== "mail") return [];
  return groups.filter(group => (!area || group.area === null || group.area === area) && matchesCatchupText(query, [
    group.title, group.why, group.label, ...group.mails.flatMap(mail => [mail.subject, mail.from]),
  ]));
}
