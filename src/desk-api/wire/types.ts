import type { INTERRUPT_REASON_CODES } from "../../desk-sdk/interrupt-reason";
import type { DeskPhrase } from "./phrases";
import type { MyDayView } from "./my-day";
import type { CalendarAvailability, DeskCalendar, EventAvailability } from "./calendar";
import type { RulingExplanation } from "./ruling";
import type { DeskVoice } from "./voice";
import type { RoutineView } from "./routines";
import type { ObjectReference } from "./object-reference";
import type { MailRoundView } from "./mail-round";
import type { DeskDecision } from "./decisions";
import type { DmarcWeek, HiddenMail, InvitationView, MailDecisionSummary, MailDigestView, MailRuleView, MailSweepView, SnoozeTimes, MailYesFilter, TrustedView } from "./mail";
import type { HandoffView } from "./handoff";
import type { EventLink } from "./links";
import type { WeeklyMirror } from "./mirror";

export type AreaPolicy = "local" | "cloud";

export type DeadlineSource = "source" | "classifier";

export type DeskUrgency = "now" | "today" | "this-week" | "waiting";

export const DESK_ITEM_KINDS = ["goal", "sensor", "agent-failed", "agent-blocked", "decision", "grilling", "escalation", "mail", "mail-junk", "reminder", "meeting", "meeting-after", "mail-rule", "dmarc", "mail-waiting", "mail-handoff", "task-handoff", "adapter"] as const;

export type DeskItemKind = (typeof DESK_ITEM_KINDS)[number];

export const DESK_OUTCOMES = ["archive", "attach", "draft", "ask"] as const;

/** The outcome the Desk suggests for a card, served on mail cards today; the vocabulary is the Desk's, so a later rule may suggest one for another kind. */
export type DeskOutcome = (typeof DESK_OUTCOMES)[number];

export interface DeskArea {
  id: string;
  label: string;
  color: string;
}

/** A client phrases an action from its `id`, or from `labelPhrase` when the wording takes parameters or differs by card. `content` is wording shown as it is and never phrased: an adapter capability's own label. */
export interface DeskAction {
  id: string;
  labelPhrase?: DeskPhrase;
  content?: string;
  role: "primary" | "secondary";
  wired: boolean;
  url?: string;
  target?: string;
}

/** A client phrases a link from its `kind` and `url`, or from `labelPhrase` for a task identifier. */
export interface DeskLink {
  kind: "mail" | "issue" | "report" | "source" | "unsubscribe-page" | "task" | "meeting" | "meeting-join";
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
  outcome?: DeskOutcome;
  dueAt?: string;
  dueFrom?: DeadlineSource;
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
  whyPhrase?: DeskPhrase;
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
  mailDecision?: MailDecisionSummary;
  yesFilter?: MailYesFilter;
  reply?: { to: string; subject: string };
  suspicious?: boolean;
  handoff?: HandoffView;
  invitation?: InvitationView;
  back?: { line: string; at: number };
}

export type InterruptReasonCode = (typeof INTERRUPT_REASON_CODES)[number];

export interface DeskInterruptReason {
  code: InterruptReasonCode;
  phrase: Extract<DeskPhrase, { code: InterruptReasonCode }>;
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

/** A client phrases a reason from its `code` and, for VIP mail, `target` and the configured VIP label. */
export interface InterruptReasonView {
  code: InterruptReasonCode;
  target?: string;
  on: boolean;
  available: boolean;
  setBy: "default" | "switch" | "feedback";
  changedAt?: number;
}

/** A client phrases a group from its `kind`. */
export interface DeskFoldedGroup {
  kind: DeskItemKind;
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
  links?: EventLink[];
}

export interface DeskGoal {
  id: string;
  text: string;
  state: "on-track" | "at-risk" | "off-track" | "stale" | "unknown";
}

export interface DeferredItem {
  key: string;
  title: string;
  until: string;
}

export interface DeskView {
  timeZone: string;
  snoozeTimes: SnoozeTimes;
  calendarAvailability?: CalendarAvailability;
  routines?: RoutineView;
  mailRules?: MailRuleView[];
  mailLearning?: boolean;
  mailTrusted?: TrustedView[];
  mailHidden?: HiddenMail[];
  mailSweeps?: MailSweepView[];
  mailDigests?: MailDigestView[];
  mailRound?: MailRoundView;
  dmarc?: DmarcWeek;
  myDay?: MyDayView;
  mirror?: WeeklyMirror;
  calendars?: DeskCalendar[];
  generatedAt: number;
  displayName: string | null;
  assistantName: string;
  topN: number;
  areas: DeskArea[];
  items: DeskItem[];
  deferred: DeferredItem[];
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

/** A client phrases each type from its `action` code. */
export interface DeskAutonomy {
  types: { action: string; on: boolean }[];
  done: { key: string; action?: string; undo?: string; stop?: string; title: string; message: string; at: number; ok: boolean }[];
}
