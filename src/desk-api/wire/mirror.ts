import type { RuleMatch, MailRule, MailLogAction, MailLogWhere, UnsubscribeView, DmarcWeek } from "./mail";
import type { CompletionReview } from "./balance";
import type { StudioThreadView } from "./studio";

export interface MailMirrorConfig {
  checkAfterUndos: number;
  archivedUnread: number;
  top: number;
  openCapMinutes: number;
}

export interface MailMirrorCount<K extends string> {
  key: K;
  count: number;
}

export interface MailMirrorSender {
  kind: "list" | "sender";
  value: string;
  decisions: number;
}

export interface MailMirrorRule {
  id: string;
  sentence: string;
  match: RuleMatch;
  value: string;
  action: MailRule["action"];
  on: boolean;
  runs: number;
  failed: number;
  undone: number;
  check: boolean;
}

export interface MailMirrorUnsubscribe {
  key: string;
  view: UnsubscribeView;
}

export interface MailMirrorUnread {
  kind: "list" | "sender";
  value: string;
  count: number;
  rule: { match: "list" | "sender"; value: string; action: "archive"; sentence: string };
  unsubscribe?: MailMirrorUnsubscribe;
}

export interface MailMirrorTime {
  mails: number;
  totalMs: number;
  medianMs: number;
  capped: number;
  untimed: number;
  capMs: number;
}

export interface MailMirror {
  decisions: number;
  mails: number;
  partial: boolean;
  byAction: MailMirrorCount<MailLogAction>[];
  byWhere: MailMirrorCount<MailLogWhere>[];
  senders: MailMirrorSender[];
  rules: MailMirrorRule[];
  checkRules: MailMirrorRule[];
  archivedUnread: MailMirrorUnread[];
  time: MailMirrorTime | null;
  config: MailMirrorConfig;
}

export interface MirrorWeek { timeZone: string; from: string; through: string; start: number; end: number }

export interface MirrorCalendar {
  sources: { id: string; readAt: number | null; status: "snapshot" | "stale" | "failed" | "missing"; problems: number }[];
  areas: { id: string | null; hours: number }[];
  withoutDuration: number;
  allDay: number;
  available: boolean;
}

export type MirrorThread = Pick<StudioThreadView, "slug" | "question" | "outcome" | "outcomeText" | "expect" | "reviewOn">;

export interface WeeklyMirror {
  generatedAt: number;
  week: MirrorWeek;
  offered: boolean;
  balance: CompletionReview | null;
  recordedEffort: number;
  studioEffortShare: number | null;
  unallocatedEffortShare: number | null;
  calendar: MirrorCalendar;
  threads: { available: boolean; partial: boolean; opened: MirrorThread[]; parked: MirrorThread[]; closed: MirrorThread[]; reviews: MirrorThread[] };
  dmarc: DmarcWeek | null;
  mail: MailMirror | null;
}
