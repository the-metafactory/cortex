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
  | { code: "mail.sweep-category"; params: { category: string } };

export const DESK_PHRASE_CODES = [
  "ranger.resume-queued", "ranger.blocked", "ranger.stopped", "ranger.approval-needed", "ranger.discussion-needed",
  "ranger.map-read-only", "ranger.approval-unavailable", "ranger.question", "ranger.conversations-unavailable",
  "ranger.retry-failed", "ranger.retried", "goal.check-regressed", "goal.reading", "meeting.soon", "reminder.due",
  "mail.meeting-today", "mail.deadline-today", "mail.vip", "mail.ranked", "mail.received", "mail.meeting-possible",
  "mail.meeting-linked", "mail.unimportant", "mail.precedent", "mail.unsubscribe", "mail.invitation", "mail.suspicious",
  "mailrule.release", "mail.assistant", "assistant.retry", "vip.add", "task.link", "mail.put-away-time",
  "mail.put-away-meeting", "mail.put-away-person", "correction.source", "mail.correction", "mail.sweep-category",
] as const satisfies readonly DeskPhrase["code"][];
