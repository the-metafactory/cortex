import type { MailPhraseModifiers, DeskPhrase } from "../../../desk-api/wire/phrases";
export type { MailPhraseModifiers, DeskPhrase };

export const DESK_ITEM_PHRASE_CODES = [
  "ranger.resume-queued", "ranger.blocked", "ranger.stopped", "ranger.approval-needed", "ranger.discussion-needed",
  "ranger.map-read-only", "ranger.approval-unavailable", "ranger.question", "ranger.conversations-unavailable",
  "ranger.retry-failed", "ranger.retried", "goal.check-regressed", "goal.reading", "meeting.soon", "meeting.ended", "reminder.due",
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
  "mail.put-back", "mail.put-back-undone", "mail.put-back-next-round", "meeting.dismissed",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_BRIEF_PHRASE_CODES = [
  "brief.gap-no-adapter", "brief.gap-access-denied", "brief.gap-read-failed", "brief.gap-no-linked-material",
  "brief.gap-relink-required", "brief.refresh-required", "brief.previous-unidentified", "brief.synthesis-not-configured",
  "brief.previous-identified", "brief.previous-unavailable", "brief.previous-set", "brief.previous-cleared", "brief.previous-self",
  "brief.previous-not-earlier", "brief.previous-target-unavailable", "brief.previous-invalid", "brief.meeting-gone",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_TIME_FIRST_PHRASE_CODES = [
  "day.closed", "day.no-task", "day.calendar-busy", "day.fit-unverified", "day.first-task", "day.task-fits", "day.no-task-fits",
  "calendar.not-read", "calendar.read-failed", "calendar.stale", "calendar.capability-unknown", "calendar.output-incomplete",
  "calendar.coverage-missing", "calendar.reading-incomplete", "calendar.event-outside-coverage", "calendar.source-unavailable",
  "calendar.interval-uncovered", "calendar.no-coverage", "calendar.event-unverified",
] as const satisfies readonly DeskPhrase["code"][];

export const DESK_PHRASE_CODES = [
  ...DESK_TIME_FIRST_PHRASE_CODES,
  ...DESK_ITEM_PHRASE_CODES,
  ...DESK_ACT_PHRASE_CODES,
  ...DESK_BRIEF_PHRASE_CODES,
] as const satisfies readonly DeskPhrase["code"][];
