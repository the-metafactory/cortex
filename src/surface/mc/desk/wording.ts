import type { DeskPhrase } from "../../../desk-api/wire/phrases";
import type { DeskAction, DeskItemKind, DeskLink, InterruptReasonCode } from "../../../desk-api/wire/types";
import type { MailSweepView } from "../../../desk-api/wire/mail";
import type { PromotableAction } from "./autonomy";
import type { DeskVip } from "./vips";

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const ACTION_TEXT: Readonly<Record<string, string>> = {
  detail: "Look first",
  snooze: "Not now",
  open: "Open in Mail",
  "ranger.run-now": "Run both now",
  "ranger.retry": "Let it retry",
  "ranger.park": "Park it",
  "ranger.approve": "Approve",
  "ranger.grill": "Start the grilling",
  "ranger.rule": "Give your ruling",
  "goal.check": "Check again now",
  "goal.pause": "Pause this goal",
  "mail.seen": "Seen, delete",
  "mail.trash": "Delete",
  "mail.archive": "Archive",
  "mail.spam": "Spam",
  "mail.unimportant": "Unimportant",
  "mail.report": "Report",
  "mail.trust": "Not phishing",
  "mail.studio": "Add to thread",
  "mail.snooze": "Snooze",
  "mail.draft": "Draft a reply",
  "mail.notspam": "Not spam",
  "mail.unsubscribe": "Unsubscribe",
  "mail.unsubscribe.page": "Open unsubscribe page",
  "mail.unsubscribe.rule": "Archive what still arrives",
  "invite.accept": "Accept",
  "invite.decline": "Decline",
  "invite.propose": "Propose times",
  "meeting.show": "Show on the meeting",
  "meeting.dismiss": "Dismiss",
  "dmarc.open": "Open the report",
  "dmarc.ack": "Got it",
  "mailrule.approve": "Approve",
  "mailrule.later": "Not now",
  "mailrule.never": "Never",
  "mailrule.stop": "Stop this rule",
  "studio.respond": "Respond in Studio",
  "reminder.done": "Done",
  "assistant.approve": "Approve",
  "assistant.edit": "Edit",
  "assistant.discard": "Discard",
  "task.retry": "Retry",
  "task.done": "Done",
  "task.keep": "Keep open",
  "task.discard": "Discard",
  "waiting.done": "Done",
  "waiting.no-answer": "No answer needed",
  "waiting.expect": "Yes, I expect an answer",
  todo: "Plan this",
};

function labelPhraseText(phrase: DeskPhrase): string | null {
  switch (phrase.code) {
    case "mailrule.release": return `Handle all ${phrase.params.count}`;
    case "mail.assistant": return `Hand to ${phrase.params.name}`;
    case "assistant.retry": return `Ask ${phrase.params.name} again`;
    case "vip.add": return `Always show mail from ${phrase.params.name ?? "this sender"}`;
    case "task.link": return `Task ${phrase.params.id}`;
    case "meeting.join": return "Join";
    case "meeting.open": return "Open";
    case "ranger.ruling": return "Give your ruling";
    case "mail.junk-review": return "Review junk";
    case "goal.run-check": return "Run the check now";
    case "waiting.nudge": return "Draft a nudge";
    case "waiting.snooze": return `Wait ${plural(phrase.params.days, "more day")}`;
    case "mail.sweep-category": return phrase.params.category;
    default: return null;
  }
}

/** The bundled Desk's English for an action: an adapter's own label, else its label phrase, else its id. */
export function actionText(action: Pick<DeskAction, "id" | "labelPhrase" | "content">): string {
  return action.content ?? (action.labelPhrase ? labelPhraseText(action.labelPhrase) : null) ?? ACTION_TEXT[action.id] ?? action.id;
}

const LINK_TEXT: Record<Exclude<DeskLink["kind"], "unsubscribe-page" | "task">, string> = {
  mail: "Open in Mail",
  issue: "Issue",
  report: "Raw report",
  source: "Open source",
  meeting: "Open",
  "meeting-join": "Join",
};

/** The bundled Desk's English for a detail link. */
export function linkText(link: DeskLink): string {
  if (link.labelPhrase) return labelPhraseText(link.labelPhrase) ?? link.url;
  if (link.kind === "unsubscribe-page") return `Unsubscribe page: ${link.url}`;
  if (link.kind === "task") return link.url;
  return LINK_TEXT[link.kind];
}

const SWEEP_TEXT: Record<MailSweepView["kind"], Partial<Record<MailSweepView["basis"], string>>> = {
  bundle: { list: "same mailing list", sender: "same sender", similar: "similar content" },
  sweep: { list: "mailing list", sender: "sender" },
  digest: { day: "newsletters" },
};

/** The bundled Desk's English for what a mail group has in common. */
export function sweepText(group: Pick<MailSweepView, "kind" | "basis" | "labelPhrase">): string {
  return (group.labelPhrase ? labelPhraseText(group.labelPhrase) : null) ?? SWEEP_TEXT[group.kind][group.basis] ?? "";
}

const REASON_TEXT: Record<InterruptReasonCode, string> = {
  "meeting.soon": "A meeting is about to start",
  "reminder.due": "A reminder is due",
  "mail.meeting-today": "Mail about a meeting later today",
  "mail.deadline-today": "Mail with a deadline today",
  "mail.vip": "Mail from a VIP",
  "mail.ranked": "Other mail ranked for today",
};

/** The English for an interruption reason; a VIP's reason names the VIP by label, else address. */
export function reasonLabel(code: InterruptReasonCode, vip?: Pick<DeskVip, "address" | "label">): string {
  return vip ? `Mail from ${vip.label ?? vip.address}` : REASON_TEXT[code];
}

export const AUTONOMY_TEXT: Record<PromotableAction, { label: string; note: string }> = {
  "capability.install": { label: "Install merged capabilities", note: "Each bundle installation shows here with Undo, which uninstalls the bundle." },
  "studio.capture": { label: "File thoughts in the Studio", note: "Each capture shows its reason and can be undone." },
  "mail.rules": { label: "Handle mail by the rules you approved", note: "Each mail shows here with Undo. A pass that would handle many mails at once asks first." },
  "mail.link-meeting": { label: "Link mail to its meeting", note: "When the classifier finds that a mail belongs to an upcoming meeting, the Desk links it there. Each link shows here with Undo, which brings the mail back." },
  "ranger.retry": {
    label: "Retry agent tasks that failed",
    note: "Each task is retried once a day at most. A retry cannot be taken back.",
  },
};

/** The bundled Desk's English for an autonomy type, by its `action` code. */
export function autonomyText(action: string): { label: string; note: string } {
  return Object.hasOwn(AUTONOMY_TEXT, action) ? AUTONOMY_TEXT[action as PromotableAction] : { label: action, note: "" };
}

export const FOLDED_LABELS: Record<DeskItemKind, string> = {
  adapter: "Connected items",
  sensor: "Goal checks that stopped working",
  goal: "Goals that need a look",
  "agent-blocked": "Agent tasks waiting for your ruling",
  "agent-failed": "Agent tasks parked after a failure",
  decision: "Decisions agents are waiting for",
  grilling: "Questions agents want to grill you on",
  escalation: "Older escalations",
  mail: "Mail you may want to read",
  "mail-junk": "Junk mail to review",
  reminder: "Reminders",
  meeting: "Meetings starting soon",
  "meeting-after": "Meetings that just ended",
  "mail-rule": "Mail rules the Desk proposes",
  dmarc: "DMARC failures for your domains",
  "mail-waiting": "Mail still waiting for an answer",
  "mail-handoff": "Mail you handed off",
  "task-handoff": "Tasks an agent worked on",
};
