import type { DeskDecision } from "./decisions";
import type { MyDayView } from "./my-day";
import type { DeskCalendar } from "./calendars";
import type { ClassifierConfig } from "./classify";
import type { RulingExplanation } from "./ruling";
import type { DeskVoice } from "./voice";
import type { AREA_POLICIES } from "../../../common/types/config";
import type { RoutineView } from "./routine-command";
import type { CalendarAvailability } from "./calendar-availability";
import type { EventAvailability } from "./calendar-contract";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { DeskPhrase } from "./phrases";
import { INTERRUPT_REASON_CODES } from "../../../desk-sdk/interrupt-reason";

export { INTERRUPT_REASON_CODES };

export type DeskUrgency = "now" | "today" | "this-week" | "waiting";

export const DESK_ITEM_KINDS = ["goal", "sensor", "agent-failed", "agent-blocked", "decision", "grilling", "escalation", "mail", "mail-junk", "reminder", "meeting", "mail-rule", "dmarc", "mail-waiting", "mail-handoff", "task-handoff", "adapter"] as const;

export type DeskItemKind = (typeof DESK_ITEM_KINDS)[number];

export type AreaPolicy = (typeof AREA_POLICIES)[number];

export interface StudioOptions {
  dir: string;
  filer?: ClassifierConfig & { local?: ClassifierConfig };
  maxActive: number;
  yesFilter?: string[];
  personas?: string[];
}

export interface DeskArea {
  id: string;
  label: string;
  color: string;
}

/** `label` is deprecated in favour of `id` for fixed wording, or `labelPhrase` for wording with parameters. Adapter capability labels are content. Served through 1.x; removed in 2.0. */
export interface DeskAction {
  id: string;
  label: string;
  labelPhrase?: DeskPhrase;
  role: "primary" | "secondary";
  wired: boolean;
  url?: string;
  target?: string;
}

/** `label` is deprecated in favour of `kind` and `url`, or `labelPhrase` for a task identifier. Served through 1.x; removed in 2.0. */
export interface DeskLink {
  kind: "mail" | "issue" | "report" | "source" | "unsubscribe-page" | "task" | "meeting" | "meeting-join";
  label: string;
  labelPhrase?: DeskPhrase;
  url: string;
}

export interface DeskMention {
  text: string;
  url: string;
}

export interface JunkReviewMail {
  key: string;
  from: { name?: string; address: string };
  subject: string;
  receivedAt: string;
  action: DeskAction;
}

export interface DeskEvidence {
  kind: "mail" | "event" | "note";
  title: string;
  url?: string;
  eventKey?: string;
}

export interface DeskItemDetail {
  summary: string;
  history: string[];
  refs: string[];
  links: DeskLink[];
  evidence?: DeskEvidence[];
  precedents?: DeskPrecedent[];
  suspicion?: string[];
}

export interface DeskPrecedent {
  subject: string;
  at: number;
  action: string;
  correction?: boolean;
}

export type DeskCorrectionMode = "less" | "always";

export interface DeskCorrection {
  kind: DeskItemKind;
  source: string;
  mode: DeskCorrectionMode;
  label: string;
  labelPhrase?: DeskPhrase;
  createdAt: number;
}

export interface DeskWhyContent {
  reason?: string;
  sourceStatusReason?: string;
  goalWording?: string;
  precedentNote?: string;
  precedentSenders?: string[];
  unsubscribeFailure?: string;
  unsubscribeUrl?: string;
  meetingTitle?: string;
}

export interface DeskItem {
  junkReview?: { mails: JunkReviewMail[] };
  readOnly?: boolean;
  badge?: string;
  destination?: ObjectReference;
  freshness?: "fresh" | "stale" | "conflicted" | "unavailable";
  rangerMap?: { key: string; label: string };
  attention?: "action" | "update";
  dueAt?: string;
  dueFrom?: import("./deadline").DeadlineSource;
  sourceRevision?: string;
  todoFingerprint?: string;
  key: string;
  kind: DeskItemKind;
  source: string;
  area: string | null;
  urgency: DeskUrgency;
  title: string;
  why: string;
  mentions?: DeskMention[];
  whyPhrase?: import("./phrases").DeskPhrase;
  whyContent?: DeskWhyContent;
  score: number;
  actions: DeskAction[];
  more?: DeskAction[];
  detail: DeskItemDetail;
  excerpt?: string;
  suggestion?: string;
  eventKey?: string;
  since?: number;
  interrupt?: DeskInterrupt;
  interruptRequested?: boolean;
  correction?: DeskCorrectionMode;
  goal?: string;
  checking?: boolean;
  question?: { condition: string | null; reason: string };
  explanation?: RulingExplanation;
  mailDecision?: import("./mail-yes-filter").MailDecisionSummary;
  yesFilter?: import("./mail-yes-filter").MailYesFilter;
  reply?: { to: string; subject: string };
  suspicious?: boolean;
  handoff?: import("./handoff").HandoffView;
  invitation?: import("./mail-invitation").InvitationView;
  back?: { line: string; at: number };
}

const FRESHNESS_LABEL: Record<NonNullable<DeskItem["freshness"]>, string | null> = {
  fresh: null,
  stale: "Stale observation",
  conflicted: "Conflicting observation",
  unavailable: "Observation unavailable",
};

/** The freshness label is deprecated in favour of the item's `freshness` code. This helper remains through 1.x and is removed in 2.0. */
export function freshnessLabel(status: DeskItem["freshness"]): string | null {
  return status ? FRESHNESS_LABEL[status] : null;
}

export type InterruptReasonCode = (typeof INTERRUPT_REASON_CODES)[number];

export interface DeskInterruptReason {
  code: InterruptReasonCode;
  phrase: Extract<import("./phrases").DeskPhrase, { code: InterruptReasonCode }>;
  target?: string;
  eventKey?: string;
  dueAt?: string;
}

export type InterruptFeedback = "yes" | "no";

export interface MeetingHold {
  eventKey: string;
  title: string;
  until: number;
}

export interface DeskInterrupt {
  delivery: "off" | "held" | "pending" | "sending" | "sent" | "buffered" | "failed";
  error?: string;
  reason?: DeskInterruptReason;
  held?: MeetingHold;
  feedback?: InterruptFeedback;
}

/** `label` is deprecated in favour of `code` and, for VIP mail, `target` and the configured VIP label. Served through 1.x; removed in 2.0. */
export interface InterruptReasonView {
  code: InterruptReasonCode;
  target?: string;
  label: string;
  on: boolean;
  available: boolean;
  setBy: "default" | "switch" | "feedback";
  changedAt?: number;
}

/** `label` is deprecated in favour of `kind`. Served through 1.x; removed in 2.0. */
export interface DeskFoldedGroup {
  kind: DeskItemKind;
  label: string;
  count: number;
  example: string;
}

export interface DeskEvent {
  calendarId?: string;
  availability?: EventAvailability;
  color?: string;
  calendar?: string;
  key: string;
  at: number;
  end?: number;
  title: string;
  note?: string;
  area: string | null;
  kind: "agent" | "agent-stop" | "meeting" | "all-day" | "reminder";
  url?: string;
  online?: boolean;
  source?: string;
  links?: import("./links").EventLink[];
}

export interface DeskGoal {
  id: string;
  text: string;
  state: "on-track" | "at-risk" | "off-track" | "stale" | "unknown";
}

export interface DeskView {
  timeZone: string;
  calendarAvailability?: CalendarAvailability;
  routines?: RoutineView;
  mailRules?: import("./mail-rules").MailRuleView[];
  mailTrusted?: import("./mail-trust").TrustedView[];
  mailHidden?: import("./mail-snooze").HiddenMail[];
  mailSweeps?: import("./mail-sweep").MailSweepView[];
  mailDigests?: import("./mail-digest").MailDigestView[];
  dmarc?: import("./mail-dmarc").DmarcWeek;
  myDay?: MyDayView;
  mirror?: import("./mirror").WeeklyMirror;
  calendars?: DeskCalendar[];
  generatedAt: number;
  displayName: string | null;
  assistantName: string;
  topN: number;
  areas: DeskArea[];
  items: DeskItem[];
  today: DeskEvent[];
  ahead: DeskEvent[];
  vips: { address: string; label: string | null }[];
  agents: { line: string; working: { title: string; note: string; since: number }[]; waiting: number };
  goals: DeskGoal[];
  notes: { id: number; text: string; createdAt: number }[];
  ask: { kinds: string[]; maps: { ref: string; label: string }[] };
  systems: string[];
  sources: { id: string; ok: boolean; error?: string }[];
  chime: boolean;
  notifications: boolean;
  voice: DeskVoice;
  autonomy: DeskAutonomy;
  decisions: DeskDecision[];
  corrections: DeskCorrection[];
  interruptions: InterruptReasonView[];
  studioBriefing?: string | null;
  mailClassifier?: DeskMailClassifier | null;
}

export type DeskMailClassifier =
  | { kind: "endpoint"; host: string; model: string; keyNeeded: boolean; keyFound: boolean; heldMail?: number; localModel?: string; localProblem?: string }
  | { kind: "command"; command: string; keyNeeded: boolean; keyFound: boolean; heldMail?: number; localModel?: string; localProblem?: string };

/** Each type's `label` and `note` are deprecated in favour of its `action` code. Served through 1.x; removed in 2.0. */
export interface DeskAutonomy {
  types: { action: string; label: string; note: string; on: boolean }[];
  done: { key: string; action?: string; undo?: string; stop?: string; title: string; message: string; at: number; ok: boolean }[];
}
