import type { PredictedAction, SimilarityBasis } from "./mail-prediction-schema";
import type { InviteReply, InviteStatus } from "./mail-invitation-schema";
import type { DeskItemKind } from "./types";

export interface MailPhraseModifiers {
  vip?: string;
  unsubscribeKind?: "one-click" | "page" | "rule";
  unsubscribeHost?: string;
  unsubscribeAt?: string;
  dismissed?: number;
  unsubscribeFailed?: boolean;
}

export type DeskPhrase =
  | { code: "ranger.resume-queued"; params: { position: number; behind?: string } }
  | { code: "ranger.blocked"; params: { repo: string } }
  | { code: "ranger.stopped"; params: { repo: string; endedAt: string; failed: boolean } }
  | { code: "ranger.approval-needed"; params: { repo: string } }
  | { code: "ranger.discussion-needed"; params: { repo: string } }
  | { code: "ranger.map-read-only" }
  | { code: "ranger.approval-unavailable" }
  | { code: "ranger.question"; params: { repo: string; questionAvailable: boolean } }
  | { code: "ranger.conversations-unavailable" }
  | { code: "ranger.retry-failed"; params: { at: string } }
  | { code: "ranger.retried"; params: { at: string } }
  | { code: "goal.check-regressed"; params: { lastRanAt: string } }
  | { code: "goal.reading"; params: { at: string; wordingAvailable: boolean } }
  | { code: "meeting.soon"; params?: { startsAt: string } }
  | { code: "reminder.due"; params?: { dueAt: string } }
  | { code: "mail.meeting-today"; params: { eventKey: string } }
  | { code: "mail.deadline-today"; params: { dueAt: string } }
  | { code: "mail.vip"; params: { target: string; receivedAt?: string } & MailPhraseModifiers }
  | { code: "mail.ranked" }
  | { code: "mail.received"; params: { receivedAt: string } & MailPhraseModifiers }
  | { code: "mail.meeting-possible"; params: { meetingStart: string } & MailPhraseModifiers }
  | { code: "mail.meeting-linked"; params: { meetingStart: string } & MailPhraseModifiers }
  | { code: "mail.unimportant"; params: MailPhraseModifiers }
  | { code: "mail.precedent"; params: { action: PredictedAction; basis: SimilarityBasis; count: number } & MailPhraseModifiers }
  | { code: "mail.unsubscribe"; params: MailPhraseModifiers }
  | { code: "mail.invitation"; params: { start: string; attendee: boolean; reply?: InviteReply; status?: InviteStatus; decidedAt?: string } }
  | { code: "mail.suspicious" }
  | { code: "act.done"; params?: { kind?: string } }
  | { code: "act.invalid"; params?: { field?: string } }
  | { code: "act.forbidden"; params?: { reason?: string } }
  | { code: "act.unknown-target"; params?: { kind?: string } }
  | { code: "act.closed-item"; params?: { kind?: string } }
  | { code: "act.busy"; params?: { kind?: string } }
  | { code: "act.not-set-up"; params?: { feature?: string } }
  | { code: "act.unavailable"; params?: { feature?: string } }
  | { code: "act.duplicate"; params?: { kind?: string } }
  | { code: "act.method" }
  | { code: "act.failed"; params?: { kind?: string } }
  | { code: "act.refused"; params?: { kind?: string } }
  | { code: "mail.moved"; params: { target: string } }
  | { code: "mail.restored"; params: { target: string; correctionWithdrawn?: boolean } }
  | { code: "mail.domain-blocked"; params: { domain: string } }
  | { code: "mail.unimportant-moved"; params: { target: string; sender: string } }
  | { code: "mail.unimportant-hidden"; params: { sender: string } }
  | { code: "mail.reply-drafted"; params: { account: string } }
  | { code: "mail.reported"; params: { to?: string } }
  | { code: "mail.correction-recorded"; params: { correction: string } }
  | { code: "mail.corrected"; params: { correction: string; target: string } }
  | { code: "mail.swept"; params: { moved: number; failed: number; skipped: number } }
  | { code: "mail.sweep-undone"; params: { restored: number } }
  | { code: "mail.snoozed"; params: { until: string } }
  | { code: "mail.snooze-cancelled" }
  | { code: "mail.hidden" }
  | { code: "mail.hide-undone" }
  | { code: "mail.kept" }
  | { code: "mail.unsubscribed"; params: { host?: string; status?: number } }
  | { code: "mail.unsubscribe-rule-archived" }
  | { code: "mail.dismissed"; params: { count?: number } }
  | { code: "mail.dismissal-undone" }
  | { code: "mail.sender-trusted"; params: { sender: string } }
  | { code: "mail.opened"; params: { recorded: boolean } }
  | { code: "mail.attached"; params: { to: string; kind: string } }
  | { code: "mail.attach-undone"; params: { to: string; restored: boolean } }
  | { code: "mail.linked"; params: { to: string; kind: string; at?: string } }
  | { code: "mail.link-undone"; params: { to: string } }
  | { code: "mail.handed"; params: { name: string } }
  | { code: "mail.handoff-approved"; params: { name: string } }
  | { code: "mail.handoff-discarded"; params: { name: string } }
  | { code: "mail.handoff-retried"; params: { name: string } }
  | { code: "mail.invite-proposed"; params: { slots: number } }
  | { code: "mail.invite-replied"; params: { reply: string } }
  | { code: "mail.studio-added"; params: { thread: string } }
  | { code: "mail.studio-proposed" }
  | { code: "create.done"; params: { kind: string } }
  | { code: "create.kept"; params: { kind: string } }
  | { code: "autonomy.set"; params: { action: string; on: boolean } }
  | { code: "handoff.done"; params: { name: string } }
  | { code: "routine.saved" }
  | { code: "routine.paused" }
  | { code: "routine.resumed" }
  | { code: "routine.removed" }
  | { code: "routine.installed" }
  | { code: "routine.denied" }
  | { code: "routine.approved" }
  | { code: "routine.auto" }
  | { code: "routine.approval" }
  | { code: "routine.discarded" }
  | { code: "studio.done"; params: { act: string } }
  | { code: "studio.spar-queued"; params: { mode: string } }
  | { code: "ranger.action-done"; params: { action: string } }
  | { code: "ranger.action-queued"; params: { action: string } }
  | { code: "mailrule.release"; params: { count: number } }
  | { code: "mail.assistant"; params: { name: string } }
  | { code: "assistant.retry"; params: { name: string } }
  | { code: "vip.add"; params: { name?: string } }
  | { code: "task.link"; params: { id: string } }
  | { code: "mail.put-away-time"; params: { until: string } }
  | { code: "mail.put-away-meeting"; params: { title: string } }
  | { code: "mail.put-away-person"; params: { person: string } }
  | { code: "correction.source"; params: { kind: DeskItemKind; source: string } }
  | { code: "mail.correction"; params: { subject: string | null; sender: string; action: string; learnedAction?: PredictedAction; category: string | null } }
  | { code: "mail.sweep-category"; params: { category: string } }
  | { code: "brief.gap-no-adapter"; params: { kind: string } }
  | { code: "brief.gap-access-denied"; params: { kind: string } }
  | { code: "brief.gap-read-failed"; params: { kind: string } }
  | { code: "brief.gap-no-linked-material"; params: { kind: string } }
  | { code: "brief.refresh-required" }
  | { code: "brief.previous-unidentified" }
  | { code: "brief.synthesis-not-configured" };

export const DESK_ITEM_PHRASE_CODES = [
  "ranger.resume-queued", "ranger.blocked", "ranger.stopped", "ranger.approval-needed", "ranger.discussion-needed",
  "ranger.map-read-only", "ranger.approval-unavailable", "ranger.question", "ranger.conversations-unavailable",
  "ranger.retry-failed", "ranger.retried", "goal.check-regressed", "goal.reading", "meeting.soon", "reminder.due",
  "mail.meeting-today", "mail.deadline-today", "mail.vip", "mail.ranked", "mail.received", "mail.meeting-possible",
  "mail.meeting-linked", "mail.unimportant", "mail.precedent", "mail.unsubscribe", "mail.invitation", "mail.suspicious",
  "mailrule.release", "mail.assistant", "assistant.retry", "vip.add", "task.link", "mail.put-away-time",
  "mail.put-away-meeting", "mail.put-away-person", "correction.source", "mail.correction", "mail.sweep-category",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_ACT_PHRASE_CODES = [
  "act.done", "act.invalid", "act.forbidden", "act.unknown-target", "act.closed-item", "act.busy", "act.not-set-up",
  "act.unavailable", "act.duplicate", "act.method", "act.failed", "act.refused",
  "mail.moved", "mail.restored", "mail.domain-blocked", "mail.unimportant-moved", "mail.unimportant-hidden",
  "mail.reply-drafted", "mail.reported", "mail.correction-recorded", "mail.corrected", "mail.swept", "mail.sweep-undone",
  "mail.snoozed", "mail.snooze-cancelled", "mail.hidden", "mail.hide-undone", "mail.kept", "mail.unsubscribed",
  "mail.unsubscribe-rule-archived", "mail.dismissed", "mail.dismissal-undone", "mail.sender-trusted", "mail.opened",
  "mail.attached", "mail.attach-undone", "mail.linked", "mail.link-undone", "mail.handed", "mail.handoff-approved",
  "mail.handoff-discarded", "mail.handoff-retried", "mail.invite-proposed", "mail.invite-replied", "mail.studio-added",
  "mail.studio-proposed", "create.done", "create.kept", "autonomy.set", "handoff.done", "routine.saved", "routine.paused",
  "routine.resumed", "routine.removed", "routine.installed", "routine.denied", "routine.approved", "routine.auto",
  "routine.approval", "routine.discarded", "studio.done", "studio.spar-queued", "ranger.action-done", "ranger.action-queued",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_BRIEF_PHRASE_CODES = [
  "brief.gap-no-adapter", "brief.gap-access-denied", "brief.gap-read-failed", "brief.gap-no-linked-material",
  "brief.refresh-required", "brief.previous-unidentified", "brief.synthesis-not-configured",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_PHRASE_CODES = [
  ...DESK_ITEM_PHRASE_CODES,
  ...DESK_ACT_PHRASE_CODES,
  ...DESK_BRIEF_PHRASE_CODES,
] as const satisfies readonly DeskPhrase["code"][];
