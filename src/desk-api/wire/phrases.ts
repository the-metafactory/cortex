import type { PredictedAction, SimilarityBasis, InviteReply, InviteStatus } from "./mail";
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
  | { code: "meeting.ended"; params: { endedAt: string } }
  | { code: "meeting.dismissed" }
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
  | { code: "mail.put-back"; params: { nextAt: string } }
  | { code: "mail.put-back-undone" }
  | { code: "mail.put-back-next-round" }
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
  | { code: "brief.gap-relink-required" }
  | { code: "brief.refresh-required" }
  | { code: "brief.previous-unidentified" }
  | { code: "brief.previous-identified" }
  | { code: "brief.previous-unavailable" }
  | { code: "brief.previous-set" }
  | { code: "brief.previous-cleared" }
  | { code: "brief.previous-self" }
  | { code: "brief.previous-not-earlier" }
  | { code: "brief.previous-target-unavailable" }
  | { code: "brief.previous-invalid" }
  | { code: "brief.meeting-gone" }
  | { code: "brief.synthesis-not-configured" };
