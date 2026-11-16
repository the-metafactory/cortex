import type { DeskPhrase } from "./phrases";

export type MoveTarget = "archive" | "junk" | "trash";

export interface Commitment {
  kind: "thread" | "project";
  id: string;
  label: string;
}

export interface MailDecisionSummary {
  intent: "reply" | "decline" | "accept" | "propose";
  commitment: Commitment | null;
  status: "pending" | "saved" | "failed" | "uncertain";
}

export const MAIL_LOG_ACTIONS = ["archive", "junk", "trash", "restore", "unimportant", "draft", "plan", "todo", "snooze", "opened", "ignored", "kept", "gone", "digest", "unsubscribe", "expect-answer", "no-answer", "waiting-done", "studio", "assistant", "accept", "decline", "not-phishing", "attach"] as const;

export type MailLogAction = (typeof MAIL_LOG_ACTIONS)[number];

export const MAIL_LOG_WHERE = ["desk", "client", "rule", "correction", "conversation", "auto"] as const;

export type MailLogWhere = (typeof MAIL_LOG_WHERE)[number];

export const PREDICTED_ACTIONS = ["archive", "junk", "trash", "reply", "plan", "todo", "keep"] as const;

export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];

export const SIMILARITY_BASES = ["content", "sender"] as const;

export type SimilarityBasis = (typeof SIMILARITY_BASES)[number];

export const INVITE_REPLIES = ["accept", "decline"] as const;

export type InviteReply = (typeof INVITE_REPLIES)[number];

export const INVITE_STATUSES = ["sending", "sent", "failed", "uncertain"] as const;

export type InviteStatus = (typeof INVITE_STATUSES)[number];

export interface InvitationConflict {
  title: string;
  at: number;
  end?: number;
  calendar: string;
  maybe: boolean;
}

export type ConflictCheck =
  | { kind: "clear" }
  | { kind: "conflicts"; events: InvitationConflict[] }
  | { kind: "unknown"; reasons: string[] };

export interface InvitationDecision {
  reply: InviteReply;
  status: InviteStatus;
  at: number;
  fallsAway: string | null;
  result: string | null;
  calendar: string | null;
}

export interface InvitationView {
  uid: string;
  summary: string;
  when: string;
  startIso: string;
  endIso: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  organizer: string;
  recurring?: boolean;
  status?: string;
  attendee: boolean;
  conflicts: ConflictCheck;
  conflictLine: string;
  canReply: boolean;
  decision?: InvitationDecision;
}

export const RULE_MATCHES = ["sender", "domain", "list", "subject"] as const;

export type RuleMatch = (typeof RULE_MATCHES)[number];

export const RULE_ACTIONS = ["archive", "junk", "trash", "digest", "attach"] as const;

export type RuleAction = (typeof RULE_ACTIONS)[number];

export type RuleTargetKind = "task" | "thread";

/** Where an attach rule puts matching mail: a fixed task or Studio thread. */
export interface RuleTarget {
  kind: RuleTargetKind;
  key: string;
  title: string;
}

export interface MailRule {
  id: string;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  on: boolean;
  createdAt: number;
  lastRunAt: number | null;
  count: number;
  held: number | null;
  released: boolean;
  target: RuleTarget | null;
}

export interface MailRuleView {
  id: string;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  on: boolean;
  sentence: string;
  lastRunAt: number | null;
  count: number;
  held: number | null;
  target: RuleTarget | null;
}

export interface HiddenMail {
  key: string;
  subject: string;
  sender: string;
  at: number;
}

export const SUSPICION_CODES = ["dmarc", "spf", "dkim", "reply-to", "display-name", "link", "classifier"] as const;

export type SuspicionCode = (typeof SUSPICION_CODES)[number];

export interface TrustedOneMail {
  codes: SuspicionCode[];
  subject: string | null;
}

export interface TrustedView {
  notSpam?: boolean;
  sender: string;
  codes: SuspicionCode[];
  mails: TrustedOneMail[];
  at: number;
  sentence: string;
}

export type UnsubscribeOffer =
  | { kind: "one-click"; url: string; host: string; dismissed: number; failed?: string }
  | { kind: "page"; url: string; host: string; dismissed: number }
  | { kind: "rule"; at: number; host: string };

export interface UnsubscribeView {
  kind: UnsubscribeOffer["kind"];
  host: string;
  url?: string;
}

export type SweepKind = "bundle" | "sweep" | "digest";

export type SweepBasis = "similar" | "list" | "sender" | "age" | "day";

export interface SweepMailView {
  key: string;
  subject: string;
  from: string;
  at: string;
  url?: string;
  unsubscribe?: UnsubscribeView;
}

/** `label` is deprecated in favour of `kind` and `basis`, or `labelPhrase` for a category. Served through 1.x; removed in 2.0. */
export interface MailSweepView {
  id: string;
  kind: SweepKind;
  basis: SweepBasis;
  target: MoveTarget;
  label: string;
  labelPhrase?: DeskPhrase;
  title: string;
  why: string;
  area: string | null;
  mails: SweepMailView[];
}

export interface DigestFlagView {
  key: string;
  line: string;
}

export interface MailDigestView extends MailSweepView {
  day: string;
  flags: DigestFlagView[];
}

export interface DmarcWeekDomain {
  domain: string;
  owned: boolean;
  reports: number;
  messages: number;
  failures: number;
}

export interface DmarcWeek {
  from: string;
  reports: number;
  messages: number;
  failures: number;
  foreign: number;
  refused: { subject: string; reason: string }[];
  domains: DmarcWeekDomain[];
  line: string;
}

export interface MailYesFilter { questions: string[]; commitments: Commitment[]; problems: string[] }
