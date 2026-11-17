// ============================================================================
// glossary-ignore: host, run, message, body
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Types-only artifact for the Desk API. An external UI resolves it via
//   import type { DeskView, … } from "@the-metafactory/cortex/desk-api";
// (package.json exports["./desk-api"].types points here).
//
// Regenerate after ANY change to src/desk-api/index.ts or the wire types it
// re-exports:
//   bun run desk-api:dts
//
// CI fails on drift between this committed file and a fresh regeneration, and
// scripts/check-desk-api-types.ts requires a DESK_API_VERSION bump whenever
// the published shape changes.
// ============================================================================

export declare const DESK_API_VERSION = "1.12.0";
declare const INTERRUPT_REASON_CODES: readonly [
	"meeting.soon",
	"reminder.due",
	"mail.meeting-today",
	"mail.deadline-today",
	"mail.vip",
	"mail.ranked"
];
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
declare const MAIL_LOG_ACTIONS: readonly [
	"archive",
	"junk",
	"trash",
	"restore",
	"unimportant",
	"draft",
	"plan",
	"todo",
	"snooze",
	"opened",
	"ignored",
	"kept",
	"gone",
	"digest",
	"unsubscribe",
	"expect-answer",
	"no-answer",
	"waiting-done",
	"studio",
	"assistant",
	"accept",
	"decline",
	"not-phishing",
	"attach"
];
export type MailLogAction = (typeof MAIL_LOG_ACTIONS)[number];
declare const MAIL_LOG_WHERE: readonly [
	"desk",
	"client",
	"rule",
	"correction",
	"conversation",
	"auto"
];
export type MailLogWhere = (typeof MAIL_LOG_WHERE)[number];
declare const PREDICTED_ACTIONS: readonly [
	"archive",
	"junk",
	"trash",
	"reply",
	"plan",
	"todo",
	"keep"
];
export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];
declare const SIMILARITY_BASES: readonly [
	"content",
	"sender"
];
export type SimilarityBasis = (typeof SIMILARITY_BASES)[number];
declare const INVITE_REPLIES: readonly [
	"accept",
	"decline"
];
export type InviteReply = (typeof INVITE_REPLIES)[number];
declare const INVITE_STATUSES: readonly [
	"sending",
	"sent",
	"failed",
	"uncertain"
];
export type InviteStatus = (typeof INVITE_STATUSES)[number];
export interface InvitationConflict {
	title: string;
	at: number;
	end?: number;
	calendar: string;
	maybe: boolean;
}
export type ConflictCheck = {
	kind: "clear";
} | {
	kind: "conflicts";
	events: InvitationConflict[];
} | {
	kind: "unknown";
	reasons: string[];
};
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
declare const RULE_MATCHES: readonly [
	"sender",
	"domain",
	"list",
	"subject"
];
export type RuleMatch = (typeof RULE_MATCHES)[number];
declare const RULE_ACTIONS: readonly [
	"archive",
	"junk",
	"trash",
	"digest",
	"attach"
];
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
declare const SUSPICION_CODES: readonly [
	"dmarc",
	"spf",
	"dkim",
	"reply-to",
	"display-name",
	"link",
	"classifier"
];
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
export type UnsubscribeOffer = {
	kind: "one-click";
	url: string;
	host: string;
	dismissed: number;
	failed?: string;
} | {
	kind: "page";
	url: string;
	host: string;
	dismissed: number;
} | {
	kind: "rule";
	at: number;
	host: string;
};
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
	refused: {
		subject: string;
		reason: string;
	}[];
	domains: DmarcWeekDomain[];
	line: string;
}
export interface MailYesFilter {
	questions: string[];
	commitments: Commitment[];
	problems: string[];
}
declare const SNOOZE_TIMES: readonly [
	"later",
	"tomorrow",
	"next-week"
];
export type SnoozeTime = (typeof SNOOZE_TIMES)[number];
export type SnoozeTimes = Record<SnoozeTime, number>;
/** The body of a snooze or defer that succeeded. `until` is the English label, `untilIso` the end as an instant (null when the end is a person or a meeting not yet known), `labelPhrase` the same wording as a code. */
export interface SnoozeResult {
	ok: true;
	message: string;
	until: string;
	untilIso: string | null;
	labelPhrase?: DeskPhrase;
}
export type ParserProvider = "codex" | "pi";
export type CandidateProvider = "claude" | ParserProvider;
export type CandidateReason = "not-configured" | "not-permitted" | "already-attempted" | "parser-incapable" | "missing-reading" | "stale-reading" | "capped" | "quota-ineligible" | "eligible";
export interface ParserRoutingEvidence {
	version: 1;
	attempted: ParserProvider[];
	candidates: {
		substrate: CandidateProvider;
		reason: CandidateReason;
	}[];
	fallbackReasons: {
		provider: ParserProvider;
		reason: "quota-exhausted";
	}[];
	capabilityExclusions: {
		provider: CandidateProvider;
		reason: string;
	}[];
}
export interface ParserRoutingSelected extends ParserRoutingEvidence {
	kind: "selected";
	provider: ParserProvider;
	reason: "most-headroom" | "pi-fallback";
}
export interface ParserRoutingUnavailable extends ParserRoutingEvidence {
	kind: "unavailable";
	reason: string;
}
export type ParserRouting = ParserRoutingSelected | ParserRoutingUnavailable;
export type ParserUnavailableCause = CandidateReason | "quota-exhausted";
export type CalendarGapReason = {
	code: "calendar.not-read" | "calendar.read-failed" | "calendar.stale" | "calendar.capability-unknown" | "calendar.output-incomplete" | "calendar.coverage-missing" | "calendar.reading-incomplete" | "calendar.event-outside-coverage" | "calendar.source-unavailable" | "calendar.interval-uncovered";
	params: {
		source: string;
	};
} | {
	code: "calendar.no-coverage" | "calendar.event-unverified";
};
/** Unknown sources use reasonPhrase as their canonical reason; the English reason field is deprecated. */
export type CalendarSourceState = {
	id: string;
	kind: "attention";
} | {
	id: string;
	kind: "unknown";
	reason: string;
	reasonPhrase: CalendarGapReason;
} | {
	id: string;
	kind: "calendar";
	from: number;
	to: number;
	readAt: number;
	calendars: string[];
	provenance: string;
};
export interface CalendarInterval {
	key: string;
	source: string;
	calendar: string;
	calendarId: string;
	title: string;
	at: number;
	end?: number;
	availability: EventAvailability;
}
export interface CalendarAvailability {
	sources: CalendarSourceState[];
	events: CalendarInterval[];
}
export type CalendarGap = {
	kind: "busy";
	until: number;
	event: CalendarInterval;
	overlaps: CalendarInterval[];
} | {
	kind: "unknown";
	reasons: CalendarGapReason[];
} | {
	kind: "bounded";
	until: number;
	minutes: number;
	event: CalendarInterval;
} | {
	kind: "open";
	through: number;
	asOf: number;
};
export interface EventAvailability {
	status: "busy" | "free" | "unknown";
	provenance: string;
}
export interface DeskCalendar {
	source: string;
	name: string;
	calendarId?: string;
	enabled: boolean;
	color: string;
}
export type NodeId = string;
export type Effort = 1 | 2 | 4;
export interface Recurrence {
	unit: "day" | "week" | "month";
	interval: number;
	weekdays?: number[];
	count?: number;
	until?: string;
	timesDone?: number;
	mode?: RecurrenceMode;
	anchor?: string;
	occurrence?: string;
}
export type RecurrenceMode = "calendar" | "completion";
export interface OutlineNode {
	id: NodeId;
	title: string;
	weight: number;
	ordering: "parallel" | "sequential";
	children: OutlineNode[];
	note?: string;
	done?: boolean;
	completedAt?: string;
	createdAt?: string;
	touchedAt?: string;
	effort?: Effort;
	estimateMinutes?: number;
	dueDate?: string;
	leadDays?: number;
	startDate?: string;
	deferredUntil?: string;
	focusMonth?: string;
	repeat?: Recurrence;
	context?: string;
	external?: {
		source: string;
		url?: string;
		syncedAt: string;
	};
}
export interface TodayItem {
	task: OutlineNode;
	areaId: NodeId;
	areaTitle: string;
	path: string[];
	context?: string;
	score: number;
	urgency: number;
	reason: "due" | "balance" | "focus";
	trace: string;
}
export interface AreaReview {
	areaId: string;
	areaTitle: string;
	targetShare: number;
	actualShare: number;
	completions: number;
}
export interface CompletionReview {
	wins: {
		title: string;
		date: string;
		areaTitle: string;
	}[];
	areas: AreaReview[];
	focus: {
		title: string;
		done: number;
		total: number;
	}[];
	totalCompletions: number;
}
/** When a repeating leaf comes back. `returnsOn` is its next occurrence and `reappearsOn` that date minus its lead days, the day `applyRecurrence` reopens it; both are null while the row is open or once the repeat is finished. */
export interface RecurrenceProjection {
	returnsOn: string | null;
	finished: boolean;
	reappearsOn: string | null;
}
export type BalanceDayHealth = "fresh" | "stale" | "unavailable" | "conflicted";
export interface BalanceProjectedTask {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
	readonly dueDate: string | null;
	readonly note?: string;
	readonly effort?: 1 | 2 | 4;
}
export interface BalanceDayProjection {
	readonly status: BalanceDayHealth;
	readonly observedAt: string | null;
	readonly tasks: readonly BalanceProjectedTask[];
}
export interface BalanceDestination {
	id: string;
	label: string;
	title: string;
	area: string;
	project: boolean;
}
declare const BALANCE_PROJECT_MISSES: readonly [
	"none",
	"ambiguous",
	"id-shaped"
];
export type BalanceProjectMiss = (typeof BALANCE_PROJECT_MISSES)[number];
export type BalanceProjectResolved = {
	id: string;
} | {
	none: true;
	reason: BalanceProjectMiss;
};
export interface BalanceDestinationsResponse {
	destinations: BalanceDestination[];
	resolved?: BalanceProjectResolved;
}
declare const THREAD_TYPES: readonly [
	"question",
	"topic",
	"making"
];
declare const THREAD_STATES: readonly [
	"active",
	"parked",
	"closed"
];
declare const THREAD_OUTCOMES: readonly [
	"decided",
	"shipped",
	"dropped"
];
declare const NOTE_KINDS: readonly [
	"note",
	"stand",
	"idea",
	"relation"
];
declare const NOTE_STATUSES: readonly [
	"open",
	"kept",
	"dismissed"
];
export type ThreadType = (typeof THREAD_TYPES)[number];
export type ThreadState = (typeof THREAD_STATES)[number];
export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export interface AssistantNote {
	at: string;
	trigger: string;
	model: string;
	mode?: string;
	run?: string;
	kind: NoteKind;
	status: NoteStatus;
	sample: boolean;
	because?: string;
	relates?: MaterialLink;
	text: string;
}
export interface StudioResponse {
	at: string;
	re?: string;
	text: string;
}
export interface MaterialLink {
	kind: string;
	label: string;
	href?: string;
	text?: string;
	textTruncated?: true;
}
export interface LogEntry {
	at?: string;
	text: string;
}
export interface StudioThread {
	id?: string;
	slug: string;
	path: string;
	type: ThreadType;
	areas: string[];
	state: ThreadState;
	opened: string;
	closed?: string;
	thinkTonight: boolean;
	outcome?: ThreadOutcome;
	expect?: string;
	reviewOn?: string;
	question: string;
	stand: string;
	notes: AssistantNote[];
	responses: StudioResponse[];
	material: MaterialLink[];
	log: LogEntry[];
	outcomeText: string;
}
export interface SparPersona {
	name: string;
	from: "config" | "thread";
}
export type ThinkingBudget = "open" | "spent" | "off";
export type ThreadThinking = {
	kind: "unavailable";
	reason: string;
} | {
	kind: "ready";
	budget: ThinkingBudget;
	reason: string | null;
	runs: {
		id: string;
		mode: string;
		status: "pending" | "failed";
		reason: string;
	}[];
};
export interface StudioThreadView extends StudioThread {
	policy: AreaPolicy;
	place?: number;
	overCap: boolean;
	personas: SparPersona[];
	thinking?: ThreadThinking;
}
/** A Studio thread's outline row with its thread's state; `state` and `openNotes` are null when the Studio is off or this request could not read it. */
export interface StudioProjectLink {
	id: string;
	slug: string;
	state: ThreadState | null;
	openNotes: number | null;
}
declare const HANDOFF_STATES: readonly [
	"working",
	"ready",
	"failed",
	"approved",
	"discarded"
];
export type HandoffState = (typeof HANDOFF_STATES)[number];
/** What a Desk card carries about its hand-off: the state, the status line and, once finished, what came back. */
export interface HandoffView {
	id: string;
	state: HandoffState;
	line: string;
	since: number;
	findings?: string[];
	draft?: string;
	result?: string;
	brief?: string;
}
export type TaskHandoffLines = Record<string, {
	state: HandoffState;
	line: string;
}>;
declare const LINK_FROM_KINDS: readonly [
	"mail",
	"task",
	"thread",
	"note"
];
export type LinkFromKind = (typeof LINK_FROM_KINDS)[number];
declare const LINK_TO_KINDS: readonly [
	"task",
	"meeting",
	"thread"
];
export type LinkToKind = (typeof LINK_TO_KINDS)[number];
/** Who made a link: the principal on the Desk, an approved rule, or the Desk on its own under the `mail.link-meeting` grant. */
export type LinkOrigin = "desk" | "rule" | "auto";
/** What a mail link keeps of the mail, so the link still reads after the mail leaves the inbox. */
export interface MailSnapshot {
	sourceId?: string;
	sender: string;
	senderName: string | null;
	receivedAt: string;
	url: string | null;
	account: string | null;
}
/** The link as a response returns it. */
export interface LinkReceipt {
	id: string;
	from: {
		kind: LinkFromKind;
		key: string;
		title: string;
	};
	to: {
		kind: LinkToKind;
		key: string;
		title: string;
		at?: number;
		end?: number;
	};
	origin: LinkOrigin;
	at: number;
}
/** A link as My day lists it with its task, with the mail snapshot for a mail link. */
export interface DeskLinkView extends LinkReceipt {
	mail: MailSnapshot | null;
}
export interface EventLink {
	id: string;
	kind: LinkFromKind;
	key: string;
	title: string;
	origin: LinkOrigin;
}
export type TaskRecommendation = {
	kind: "fit";
	item: TodayItem;
	minutes: number;
	reason: {
		code: "day.task-fits";
	};
} | {
	kind: "normal";
	item: TodayItem;
	reason: {
		code: "day.first-task";
	};
} | {
	kind: "unverified";
	item: TodayItem;
	reason: {
		code: "day.fit-unverified";
	};
} | {
	kind: "none";
	reason: {
		code: "day.closed" | "day.no-task" | "day.calendar-busy" | "day.no-task-fits";
	};
};
export type TaskRecommendationReason = TaskRecommendation["reason"];
export interface MyDayResponse extends MyDayView {
	now: {
		at: number;
		gap: CalendarGap;
		next: TaskRecommendation;
	};
}
export interface MyDaySource {
	taskId: string;
	key: string;
	fingerprint: string;
	kind: string;
	url?: string;
}
/** An outline row as My day serves it: a row with a `repeat` rule also carries `recurrence`, computed by the Balance engine's recurrence rule. */
export type MyDayOutlineNode = Omit<OutlineNode, "children"> & {
	children: MyDayOutlineNode[];
	recurrence?: RecurrenceProjection;
};
export interface MyDayView {
	work: {
		confirmedIds: string[];
		selection: {
			kind: "automatic";
		} | {
			kind: "manual";
			id: string;
		} | {
			kind: "unavailable";
			id: string;
			reason: string;
		};
	};
	studioStatus: "synced" | "unavailable" | "disabled";
	studioTasks: {
		id: string;
		slug: string;
	}[];
	studioProjects: StudioProjectLink[];
	revision: number;
	configuredCaps: {
		cap: number;
		topN: number;
	};
	capsOverridden: boolean;
	inbox: OutlineNode[];
	date: string;
	phase: "proposed" | "started" | "closed";
	cap: number;
	topN: number;
	items: TodayItem[];
	alternates: TodayItem[];
	wins: {
		taskId: string;
		title: string;
	}[];
	outline: MyDayOutlineNode;
	observation: Pick<BalanceDayProjection, "status" | "observedAt"> | null;
	sources: MyDaySource[];
	touchTrackingSince: string | null;
	yesFilter: string[];
	undos: {
		receipt: string;
		title: string;
	}[];
	dayUndo: {
		receipt: string;
		text: string;
	} | null;
	handoffs?: TaskHandoffLines;
	links: DeskLinkView[];
}
export interface UnavailableParser {
	provider: "claude" | "codex" | "pi";
	cause: ParserUnavailableCause;
}
export interface MailPhraseModifiers {
	vip?: string;
	unsubscribeKind?: "one-click" | "page" | "rule";
	unsubscribeHost?: string;
	unsubscribeAt?: string;
	dismissed?: number;
	unsubscribeFailed?: boolean;
}
export type DeskPhrase = {
	code: "ranger.resume-queued";
	params: {
		position: number;
		behind?: string;
	};
} | {
	code: "ranger.blocked";
	params: {
		repo: string;
	};
} | {
	code: "ranger.stopped";
	params: {
		repo: string;
		endedAt: string;
		failed: boolean;
	};
} | {
	code: "ranger.approval-needed";
	params: {
		repo: string;
	};
} | {
	code: "ranger.discussion-needed";
	params: {
		repo: string;
	};
} | {
	code: "ranger.map-read-only";
} | {
	code: "ranger.approval-unavailable";
} | {
	code: "ranger.question";
	params: {
		repo: string;
		questionAvailable: boolean;
	};
} | {
	code: "ranger.conversations-unavailable";
} | {
	code: "ranger.retry-failed";
	params: {
		at: string;
	};
} | {
	code: "ranger.retried";
	params: {
		at: string;
	};
} | {
	code: "goal.check-regressed";
	params: {
		lastRanAt: string;
	};
} | {
	code: "goal.reading";
	params: {
		at: string;
		wordingAvailable: boolean;
	};
} | {
	code: "meeting.soon";
	params?: {
		startsAt: string;
	};
} | {
	code: "meeting.ended";
	params: {
		endedAt: string;
	};
} | {
	code: "meeting.dismissed";
} | {
	code: "reminder.due";
	params?: {
		dueAt: string;
	};
} | {
	code: "mail.meeting-today";
	params: {
		eventKey: string;
	};
} | {
	code: "mail.deadline-today";
	params: {
		dueAt: string;
	};
} | {
	code: "mail.vip";
	params: {
		target: string;
		receivedAt?: string;
	} & MailPhraseModifiers;
} | {
	code: "mail.ranked";
} | {
	code: "mail.received";
	params: {
		receivedAt: string;
	} & MailPhraseModifiers;
} | {
	code: "mail.meeting-possible";
	params: {
		meetingStart: string;
	} & MailPhraseModifiers;
} | {
	code: "mail.meeting-linked";
	params: {
		meetingStart: string;
	} & MailPhraseModifiers;
} | {
	code: "mail.unimportant";
	params: MailPhraseModifiers;
} | {
	code: "mail.precedent";
	params: {
		action: PredictedAction;
		basis: SimilarityBasis;
		count: number;
	} & MailPhraseModifiers;
} | {
	code: "mail.unsubscribe";
	params: MailPhraseModifiers;
} | {
	code: "mail.invitation";
	params: {
		start: string;
		attendee: boolean;
		reply?: InviteReply;
		status?: InviteStatus;
		decidedAt?: string;
	};
} | {
	code: "mail.suspicious";
} | {
	code: "act.done";
	params?: {
		kind?: string;
	};
} | {
	code: "act.invalid";
	params?: {
		field?: string;
	};
} | {
	code: "act.forbidden";
	params?: {
		reason?: string;
	};
} | {
	code: "act.unknown-target";
	params?: {
		kind?: string;
	};
} | {
	code: "act.closed-item";
	params?: {
		kind?: string;
	};
} | {
	code: "act.busy";
	params?: {
		kind?: string;
	};
} | {
	code: "act.not-set-up";
	params?: {
		feature?: string;
	};
} | {
	code: "act.unavailable";
	params?: {
		feature?: string;
	};
} | {
	code: "act.duplicate";
	params?: {
		kind?: string;
	};
} | {
	code: "act.method";
} | {
	code: "act.failed";
	params?: {
		kind?: string;
	};
} | {
	code: "act.refused";
	params?: {
		kind?: string;
	};
} | {
	code: "mail.moved";
	params: {
		target: string;
	};
} | {
	code: "mail.restored";
	params: {
		target: string;
		correctionWithdrawn?: boolean;
	};
} | {
	code: "mail.domain-blocked";
	params: {
		domain: string;
	};
} | {
	code: "mail.unimportant-moved";
	params: {
		target: string;
		sender: string;
	};
} | {
	code: "mail.unimportant-hidden";
	params: {
		sender: string;
	};
} | {
	code: "mail.reply-drafted";
	params: {
		account: string;
	};
} | {
	code: "mail.reported";
	params: {
		to?: string;
	};
} | {
	code: "mail.correction-recorded";
	params: {
		correction: string;
	};
} | {
	code: "mail.corrected";
	params: {
		correction: string;
		target: string;
	};
} | {
	code: "mail.swept";
	params: {
		moved: number;
		failed: number;
		skipped: number;
	};
} | {
	code: "mail.sweep-undone";
	params: {
		restored: number;
	};
} | {
	code: "mail.snoozed";
	params: {
		until: string;
	};
} | {
	code: "mail.snooze-cancelled";
} | {
	code: "mail.hidden";
} | {
	code: "mail.hide-undone";
} | {
	code: "mail.put-back";
	params: {
		nextAt: string;
	};
} | {
	code: "mail.put-back-undone";
} | {
	code: "mail.put-back-next-round";
} | {
	code: "mail.kept";
} | {
	code: "mail.unsubscribed";
	params: {
		host?: string;
		status?: number;
	};
} | {
	code: "mail.unsubscribe-rule-archived";
} | {
	code: "mail.dismissed";
	params: {
		count?: number;
	};
} | {
	code: "mail.dismissal-undone";
} | {
	code: "mail.sender-trusted";
	params: {
		sender: string;
	};
} | {
	code: "mail.opened";
	params: {
		recorded: boolean;
	};
} | {
	code: "mail.attached";
	params: {
		to: string;
		kind: string;
	};
} | {
	code: "mail.attach-undone";
	params: {
		to: string;
		restored: boolean;
	};
} | {
	code: "mail.linked";
	params: {
		to: string;
		kind: string;
		at?: string;
	};
} | {
	code: "mail.link-undone";
	params: {
		to: string;
	};
} | {
	code: "mail.handed";
	params: {
		name: string;
	};
} | {
	code: "mail.handoff-approved";
	params: {
		name: string;
	};
} | {
	code: "mail.handoff-discarded";
	params: {
		name: string;
	};
} | {
	code: "mail.handoff-retried";
	params: {
		name: string;
	};
} | {
	code: "mail.invite-proposed";
	params: {
		slots: number;
	};
} | {
	code: "mail.invite-replied";
	params: {
		reply: string;
	};
} | {
	code: "mail.studio-added";
	params: {
		thread: string;
	};
} | {
	code: "mail.studio-proposed";
} | {
	code: "create.done";
	params: {
		kind: string;
	};
} | {
	code: "create.kept";
	params: {
		kind: string;
	};
} | {
	code: "autonomy.set";
	params: {
		action: string;
		on: boolean;
	};
} | {
	code: "handoff.done";
	params: {
		name: string;
	};
} | {
	code: "routine.saved";
} | {
	code: "routine.paused";
} | {
	code: "routine.resumed";
} | {
	code: "routine.removed";
} | {
	code: "routine.installed";
} | {
	code: "routine.denied";
} | {
	code: "routine.approved";
} | {
	code: "routine.auto";
} | {
	code: "routine.approval";
} | {
	code: "routine.discarded";
} | {
	code: "studio.done";
	params: {
		act: string;
	};
} | {
	code: "studio.spar-queued";
	params: {
		mode: string;
	};
} | {
	code: "ranger.action-done";
	params: {
		action: string;
	};
} | {
	code: "ranger.action-queued";
	params: {
		action: string;
	};
} | {
	code: "mailrule.release";
	params: {
		count: number;
	};
} | {
	code: "mail.assistant";
	params: {
		name: string;
	};
} | {
	code: "assistant.retry";
	params: {
		name: string;
	};
} | {
	code: "vip.add";
	params: {
		name?: string;
	};
} | {
	code: "task.link";
	params: {
		id: string;
	};
} | {
	code: "mail.put-away-time";
	params: {
		until: string;
	};
} | {
	code: "mail.put-away-meeting";
	params: {
		title: string;
	};
} | {
	code: "mail.put-away-person";
	params: {
		person: string;
	};
} | {
	code: "correction.source";
	params: {
		kind: DeskItemKind;
		source: string;
	};
} | {
	code: "mail.correction";
	params: {
		subject: string | null;
		sender: string;
		action: string;
		learnedAction?: PredictedAction;
		category: string | null;
	};
} | {
	code: "mail.sweep-category";
	params: {
		category: string;
	};
} | {
	code: "ask.answered";
	params: {
		provider: "claude" | "codex" | "pi";
		unavailable: UnavailableParser[];
	};
} | {
	code: "ask.no-provider";
	params: {
		unavailable: UnavailableParser[];
	};
} | {
	code: "ask.invalid-output";
} | {
	code: "ask.timeout";
} | {
	code: "ask.quota-reached";
} | {
	code: "ask.connection-unavailable";
} | {
	code: "ask.failed";
} | {
	code: "brief.gap-no-adapter";
	params: {
		kind: string;
	};
} | {
	code: "brief.gap-access-denied";
	params: {
		kind: string;
	};
} | {
	code: "brief.gap-read-failed";
	params: {
		kind: string;
	};
} | {
	code: "brief.gap-no-linked-material";
	params: {
		kind: string;
	};
} | {
	code: "brief.gap-relink-required";
} | {
	code: "brief.refresh-required";
} | {
	code: "brief.previous-unidentified";
} | {
	code: "brief.previous-identified";
} | {
	code: "brief.previous-unavailable";
} | {
	code: "brief.previous-set";
} | {
	code: "brief.previous-cleared";
} | {
	code: "brief.previous-self";
} | {
	code: "brief.previous-not-earlier";
} | {
	code: "brief.previous-target-unavailable";
} | {
	code: "brief.previous-invalid";
} | {
	code: "brief.meeting-gone";
} | {
	code: "brief.synthesis-not-configured";
} | CalendarGapReason | TaskRecommendationReason;
export interface RulingChoice {
	label: string;
	consequence: string;
	ruling: string;
}
export interface RulingExplanation {
	sentence: string;
	choices: RulingChoice[];
}
export type VoiceProviderId = "browser" | "elevenlabs";
export interface DeskWakeOptions {
	enabled: boolean;
	assistantName?: string;
	detector: "sherpa-2.0.1";
	model: "gigaspeech-3.3m-2024-01-01";
	phrase: string;
	tokens?: string[];
	tokenizerSha256?: string;
	threshold: number;
	score: number;
	preRollMs: number;
	silenceMs: number;
	maxCommandMs: number;
	speechThreshold: number;
}
export interface DeskVoice {
	enabled: boolean;
	input: VoiceProviderId;
	output: VoiceProviderId;
	wake?: DeskWakeOptions;
}
declare const ASK_KINDS: readonly [
	"reminder",
	"note",
	"capture",
	"task",
	"goal",
	"calendar",
	"routine",
	"conversation",
	"row"
];
export type AskKind = (typeof ASK_KINDS)[number];
export interface DeskProposal {
	kind: AskKind;
	label: string;
	fields: Record<string, unknown>;
	at?: number;
	end?: number;
	problem?: string;
	unwritable?: true;
	via: "parser" | "rules";
	automatic?: boolean;
	routing?: Extract<ParserRouting, {
		kind: "selected";
	}>;
	alternative?: ConversationOffer;
	capabilities?: CapabilityRefusal;
}
export interface ConversationOffer {
	kind: "conversation";
	label: string;
	fields: {
		text: string;
		area?: string;
	};
}
/** Added to the body of an ask that answered or failed through a routed parser. The English `error` of a failure stays through 1.x. */
export interface DeskAskRouting {
	routingPhrase?: DeskPhrase;
}
export interface RoutineRequest<A> {
	requestId: string;
	action: A;
	target: string;
}
export type RoutineAction = RoutineRequest<"install" | "discard" | "remove" | "auto" | "stop" | "approve" | "deny"> | (RoutineRequest<"schedule"> & {
	schedule: string;
	timezone: string | null;
	revision: string;
	proposedRevision: string;
}) | (RoutineRequest<"pause" | "resume"> & {
	revision: string;
	proposedRevision: string;
}) | (RoutineRequest<"delete"> & {
	revision: string;
});
export interface CapabilityStep {
	label: string;
	prompt: string;
	sovereignty: {
		model_class?: "local-only" | "frontier" | "any";
		frontier_ok?: boolean;
		data_residency?: string;
	};
}
export interface MissingCapability {
	capability: string;
	steps: CapabilityStep[];
}
export interface CapabilityRefusal {
	proposalId: string;
	missing: MissingCapability[];
	offer: boolean;
	nodes: Record<string, {
		ref: string;
		url: string;
		existing: boolean;
		notStarted?: string;
	}>;
}
export interface InstalledRoutine {
	id: string;
	schedule: string;
	timezone: string | null;
	policy: "approval" | "auto" | "disabled";
	paused: boolean;
	runtimeConfirmed: boolean;
	target: string;
	file: string;
	lastDecision: {
		id: string;
		outcome: string;
		at: string;
		reason: string | null;
	} | null;
}
export interface PendingRoutine {
	decisionId: string;
	blueprintId: string;
	matchedAt: string;
	expiresAt: string;
	impulseSummary: string;
}
declare const BUILD_STATES: readonly [
	"filed",
	"building",
	"in-review",
	"merged",
	"failed"
];
export type BuildState = {
	state: (typeof BUILD_STATES)[number] | "live";
	reason?: string;
	pr?: string;
} | {
	state: "unknown";
	error: string;
};
export interface CapabilityInstallView {
	id: string;
	bundle: string;
	state: "running" | "installed" | "failed" | "undoing" | "undone";
	error: string | null;
	at: number;
}
export interface DraftNodeView {
	capability: string;
	ref: string;
	url: string;
	notStarted?: string;
	build: BuildState | null;
	install?: CapabilityInstallView;
	canInstall?: boolean;
	presenceLate?: boolean;
}
export interface RoutineDraftView {
	proposalId: string;
	title: string;
	nodes: DraftNodeView[];
	missing: MissingCapability[];
	proposal?: DeskProposal;
	error?: string;
}
export interface RoutineView {
	installed: (InstalledRoutine & {
		title: string;
		words: string;
	})[];
	pending: PendingRoutine[];
	done: {
		routineId: string;
		title: string;
		decisionId: string;
		at: string;
	}[];
	changes: RoutineAction[];
	drafts?: RoutineDraftView[];
	capabilityInstalls?: CapabilityInstallView[];
	error?: string;
}
export type RoutineDisplayMode = "scheduled" | "background";
export type RoutineDisplayChoice = "automatic" | RoutineDisplayMode;
export type RoutineDisplaySource = "stored" | "frequency" | "unknown";
/** How one routine shows on the calendar: the stored choice, the mode its frequency suggests, and the effective mode with where it came from. */
export interface RoutineDisplayEntry {
	routineId: string;
	stored: RoutineDisplayMode | null;
	automatic: RoutineDisplayMode | null;
	maxDailyStarts: number | null;
	mode: RoutineDisplayMode;
	source: RoutineDisplaySource;
}
/** The body of a routine display change that succeeded. `entry` is the effective display afterwards. */
export interface RoutineDisplayResult {
	owner: "reflex";
	principal: string;
	stack: string;
	routineId: string;
	mode: RoutineDisplayChoice;
	entry: RoutineDisplayEntry;
}
export interface ObjectReference {
	adapterId: string;
	connectionId: string;
	objectType: string;
	canonicalId: string;
}
declare const MAIL_ROUND_GROUP_KINDS: readonly [
	"bundle",
	"sweep",
	"digest"
];
export type MailRoundGroupKind = (typeof MAIL_ROUND_GROUP_KINDS)[number];
export interface MailRoundGroupView {
	id: string;
	kind: MailRoundGroupKind;
	label: string;
	title: string;
	target: MoveTarget;
	area: string | null;
	mails: string[];
}
export interface MailRoundMailView {
	key: string;
	subject: string;
	from: string;
	at: string;
	unread: boolean;
	area: string | null;
	url?: string;
	groupId?: string;
}
export interface MailRoundUnavailable {
	mail: string[];
	calendar: string[];
}
export interface MailRoundView {
	id: string | null;
	revision: number;
	due: boolean;
	scheduledFor: string | null;
	nextScheduledAt: string;
	waiting: number;
	groups: MailRoundGroupView[];
	mails: MailRoundMailView[];
	unavailable: MailRoundUnavailable;
}
export type DecisionAction = "ranger.rule" | "ranger.approve" | "ranger.retry" | "ranger.run-now";
export type DecisionOutcomeState = "not-requested" | "pending" | "accepted" | "queued" | "failed";
export interface DecisionOutcome {
	state: DecisionOutcomeState;
	detail: string | null;
	at: number;
}
export interface DeskDecision {
	id: string;
	key: string;
	title: string;
	target: {
		repo: string;
		nodeId: string;
		link: string | null;
	};
	action: DecisionAction;
	text: string | null;
	decidedAt: number;
	outcome: DecisionOutcome;
	withdrawable: false;
	supersededBy: {
		id: string;
		decidedAt: number;
	} | null;
}
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
	rule: {
		match: "list" | "sender";
		value: string;
		action: "archive";
		sentence: string;
	};
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
export interface MirrorWeek {
	timeZone: string;
	from: string;
	through: string;
	start: number;
	end: number;
}
export interface MirrorCalendar {
	sources: {
		id: string;
		readAt: number | null;
		status: "snapshot" | "stale" | "failed" | "missing";
		problems: number;
	}[];
	areas: {
		id: string | null;
		hours: number;
	}[];
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
	threads: {
		available: boolean;
		partial: boolean;
		opened: MirrorThread[];
		parked: MirrorThread[];
		closed: MirrorThread[];
		reviews: MirrorThread[];
	};
	dmarc: DmarcWeek | null;
	mail: MailMirror | null;
}
export type AreaPolicy = "local" | "cloud";
export type DeadlineSource = "source" | "classifier";
export type DeskUrgency = "now" | "today" | "this-week" | "waiting";
declare const DESK_ITEM_KINDS: readonly [
	"goal",
	"sensor",
	"agent-failed",
	"agent-blocked",
	"decision",
	"grilling",
	"escalation",
	"mail",
	"mail-junk",
	"reminder",
	"meeting",
	"meeting-after",
	"mail-rule",
	"dmarc",
	"mail-waiting",
	"mail-handoff",
	"task-handoff",
	"adapter"
];
export type DeskItemKind = (typeof DESK_ITEM_KINDS)[number];
declare const DESK_OUTCOMES: readonly [
	"archive",
	"attach",
	"draft",
	"ask"
];
/** The outcome the Desk suggests for a card, served on mail cards today; the vocabulary is the Desk's, so a later rule may suggest one for another kind. */
export type DeskOutcome = (typeof DESK_OUTCOMES)[number];
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
	from: {
		name?: string;
		address: string;
	};
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
	junkReview?: {
		mails: JunkReviewMail[];
	};
	readOnly?: boolean;
	badge?: string;
	destination?: ObjectReference;
	freshness?: "fresh" | "stale" | "conflicted" | "unavailable";
	rangerMap?: {
		key: string;
		label: string;
	};
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
	question?: {
		condition: string | null;
		reason: string;
	};
	explanation?: RulingExplanation;
	mailDecision?: MailDecisionSummary;
	yesFilter?: MailYesFilter;
	reply?: {
		to: string;
		subject: string;
	};
	suspicious?: boolean;
	handoff?: HandoffView;
	invitation?: InvitationView;
	back?: {
		line: string;
		at: number;
	};
}
export type InterruptReasonCode = (typeof INTERRUPT_REASON_CODES)[number];
export interface DeskInterruptReason {
	code: InterruptReasonCode;
	phrase: Extract<DeskPhrase, {
		code: InterruptReasonCode;
	}>;
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
	vips: {
		address: string;
		label: string | null;
	}[];
	agents: {
		line: string;
		working: {
			title: string;
			note: string;
			since: number;
		}[];
		waiting: number;
	};
	goals: DeskGoal[];
	notes: {
		id: number;
		text: string;
		createdAt: number;
	}[];
	ask: {
		kinds: string[];
		maps: {
			ref: string;
			label: string;
		}[];
	};
	systems: string[];
	sources: {
		id: string;
		ok: boolean;
		error?: string;
	}[];
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
export type DeskMailClassifier = {
	kind: "endpoint";
	host: string;
	model: string;
	keyNeeded: boolean;
	keyFound: boolean;
	heldMail?: number;
	localModel?: string;
	localProblem?: string;
} | {
	kind: "command";
	command: string;
	keyNeeded: boolean;
	keyFound: boolean;
	heldMail?: number;
	localModel?: string;
	localProblem?: string;
};
/** Each type's `label` and `note` are deprecated in favour of its `action` code. Served through 1.x; removed in 2.0. */
export interface DeskAutonomy {
	types: {
		action: string;
		label: string;
		note: string;
		on: boolean;
	}[];
	done: {
		key: string;
		action?: string;
		undo?: string;
		stop?: string;
		title: string;
		message: string;
		at: number;
		ok: boolean;
	}[];
}
declare const DESK_SEARCH_KINDS: readonly [
	"desk-note",
	"desk-reminder",
	"studio-capture",
	"studio-thread",
	"desk-item",
	"balance-task",
	"balance-project"
];
export type DeskSearchKind = (typeof DESK_SEARCH_KINDS)[number];
export interface DeskSearchOpenRoute {
	method: "GET";
	path: string;
}
export interface DeskSearchHit {
	kind: DeskSearchKind;
	id: string;
	title: string;
	snippet: string;
	at: string | null;
	open: DeskSearchOpenRoute & {
		query: Record<string, string>;
	};
}
export interface DeskSearchResponse {
	status: "ok" | "empty";
	hits: DeskSearchHit[];
	next: string | null;
	unavailableKinds: DeskSearchKind[];
}
declare const BODY: unique symbol;
/** A `Response` that carries the JSON body type it was built from, so a handler that declares it as its return type cannot send another shape. */
export interface TypedResponse<Body> extends Response {
	readonly [BODY]: Body;
}
export interface DeskDisabled {
	enabled: false;
}
export interface DeskErrorBody {
	error: string;
}
/** The request and response types of the pinned Desk routes, keyed `METHOD /path` as in DESK_API_ROUTES. */
export interface DeskApiRouteTypes {
	"GET /api/desk": {
		response: DeskView | DeskDisabled;
	};
	"GET /api/desk/my-day": {
		response: MyDayResponse;
	};
}
export type DeskApiRouteKey = keyof DeskApiRouteTypes;

export {};
