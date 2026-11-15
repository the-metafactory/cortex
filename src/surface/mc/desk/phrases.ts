import type { PredictedAction } from "./classify";
import type { SimilarityBasis } from "./mail-similar";
import type { InviteReply, InviteStatus } from "./mail-invitation-schema";

export interface MailPhraseModifiers {
  vip?: string;
  unsubscribeKind?: "one-click" | "page" | "rule";
  unsubscribeHost?: string;
  unsubscribeUrl?: string;
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
  | { code: "mail.meeting-possible"; params: { meetingTitle: string; meetingStart: string } & MailPhraseModifiers }
  | { code: "mail.meeting-linked"; params: { meetingTitle: string; meetingStart: string } & MailPhraseModifiers }
  | { code: "mail.unimportant"; params: MailPhraseModifiers }
  | { code: "mail.precedent"; params: { action: PredictedAction; basis: SimilarityBasis; count: number } & MailPhraseModifiers }
  | { code: "mail.unsubscribe"; params: MailPhraseModifiers }
  | { code: "mail.invitation"; params: { start: string; attendee: boolean; reply?: InviteReply; status?: InviteStatus; decidedAt?: string } }
  | { code: "mail.suspicious" };

export const DESK_PHRASE_CODES = [
  "ranger.resume-queued", "ranger.blocked", "ranger.stopped", "ranger.approval-needed", "ranger.discussion-needed",
  "ranger.map-read-only", "ranger.approval-unavailable", "ranger.question", "ranger.conversations-unavailable",
  "ranger.retry-failed", "ranger.retried", "goal.check-regressed", "goal.reading", "meeting.soon", "reminder.due",
  "mail.meeting-today", "mail.deadline-today", "mail.vip", "mail.ranked", "mail.received", "mail.meeting-possible",
  "mail.meeting-linked", "mail.unimportant", "mail.precedent", "mail.unsubscribe", "mail.invitation", "mail.suspicious",
] as const satisfies readonly DeskPhrase["code"][];
