/** An invitation as the rule sees it: its SEQUENCE, its start and optional end as ISO instants, and whether it repeats. */
export interface InvitationFacts {
  readonly sequence: number;
  readonly start: string;
  readonly end?: string;
  readonly recurring?: boolean;
}

/** A mail as the reply rule sees it. `inReplyTo` and `references` hold message ids without angle brackets. */
export interface ReplyFacts {
  readonly id: string;
  readonly from: string;
  readonly receivedAt: string;
  readonly inReplyTo?: readonly string[];
  readonly references?: readonly string[];
}

export type InvitationOpenRule = (invitation: InvitationFacts, answeredSequence: number | undefined, now: number) => boolean;
export type RepliesToRule = (sent: Pick<ReplyFacts, "id" | "from">, candidates: readonly ReplyFacts[]) => string[];

export const MAX_REPLIES = 10;

/**
 * The reference rule for whether an invitation is still open. It is open when it is not answered at the same or a newer
 * SEQUENCE and not over. It is over at its end, or at its start when it has no end. A recurring invitation is never over.
 */
export const invitationOpen: InvitationOpenRule = (invitation, answeredSequence, now) => {
  if (answeredSequence !== undefined && answeredSequence >= invitation.sequence) return false;
  if (invitation.recurring === true) return true;
  return now < Date.parse(invitation.end ?? invitation.start);
};

const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The reference rule for which mails reply to a sent mail. A candidate replies when it names the sent mail's id in
 * In-Reply-To or References, has a different id and comes from a different address. At most 10, oldest first.
 */
export const repliesTo: RepliesToRule = (sent, candidates) =>
  candidates
    .filter((c) => c.id !== sent.id && !sameAddress(c.from, sent.from) && [...(c.inReplyTo ?? []), ...(c.references ?? [])].includes(sent.id))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
    .slice(0, MAX_REPLIES)
    .map((c) => c.id);

export interface InvitationOpenVector {
  readonly name: string;
  readonly input: { readonly invitation: InvitationFacts; readonly answeredSequence: number | undefined; readonly now: number };
  readonly expected: boolean;
}

export interface RepliesToVector {
  readonly name: string;
  readonly input: { readonly sent: Pick<ReplyFacts, "id" | "from">; readonly candidates: readonly ReplyFacts[] };
  readonly expected: readonly string[];
}

const NOW = Date.parse("2026-11-16T12:00:00Z");
const PAST = "2026-11-01T09:00:00Z";
const PAST_END = "2026-11-01T10:00:00Z";
const FUTURE = "2026-11-20T09:00:00Z";
const FUTURE_END = "2026-11-20T10:00:00Z";

export const INVITATION_OPEN_VECTORS: readonly InvitationOpenVector[] = [
  { name: "unanswered future invitation is open", input: { invitation: { sequence: 0, start: FUTURE, end: FUTURE_END }, answeredSequence: undefined, now: NOW }, expected: true },
  { name: "answered at the same sequence is closed", input: { invitation: { sequence: 1, start: FUTURE, end: FUTURE_END }, answeredSequence: 1, now: NOW }, expected: false },
  { name: "answered at a newer sequence is closed", input: { invitation: { sequence: 1, start: FUTURE, end: FUTURE_END }, answeredSequence: 3, now: NOW }, expected: false },
  { name: "answered at an older sequence is open", input: { invitation: { sequence: 2, start: FUTURE, end: FUTURE_END }, answeredSequence: 1, now: NOW }, expected: true },
  { name: "a past one-off invitation is over", input: { invitation: { sequence: 0, start: PAST, end: PAST_END }, answeredSequence: undefined, now: NOW }, expected: false },
  { name: "a recurring past invitation is open", input: { invitation: { sequence: 0, start: PAST, end: PAST_END, recurring: true }, answeredSequence: undefined, now: NOW }, expected: true },
  { name: "a recurring invitation answered at its sequence is closed", input: { invitation: { sequence: 0, start: PAST, end: PAST_END, recurring: true }, answeredSequence: 0, now: NOW }, expected: false },
  { name: "an event ending exactly now is over", input: { invitation: { sequence: 0, start: "2026-11-16T11:00:00Z", end: "2026-11-16T12:00:00Z" }, answeredSequence: undefined, now: NOW }, expected: false },
  { name: "an event started but not ended is open", input: { invitation: { sequence: 0, start: "2026-11-16T11:00:00Z", end: "2026-11-16T12:00:01Z" }, answeredSequence: undefined, now: NOW }, expected: true },
  { name: "without an end it is over at its start", input: { invitation: { sequence: 0, start: "2026-11-16T12:00:00Z" }, answeredSequence: undefined, now: NOW }, expected: false },
  { name: "without an end it is open before its start", input: { invitation: { sequence: 0, start: "2026-11-16T12:00:01Z" }, answeredSequence: undefined, now: NOW }, expected: true },
];

const sent = { id: "sent-1@example.org", from: "me@example.org" };
const reply = (id: string, over: Partial<ReplyFacts> = {}): ReplyFacts => ({ id, from: "ada@example.net", receivedAt: "2026-11-10T09:00:00Z", inReplyTo: [sent.id], ...over });
const many = Array.from({ length: 12 }, (_, i) => reply(`r${String(i).padStart(2, "0")}@example.net`, { receivedAt: `2026-11-10T09:${String(59 - i).padStart(2, "0")}:00Z` }));

export const REPLIES_TO_VECTORS: readonly RepliesToVector[] = [
  { name: "In-Reply-To names the sent mail", input: { sent, candidates: [reply("a@example.net")] }, expected: ["a@example.net"] },
  { name: "References names the sent mail", input: { sent, candidates: [reply("a@example.net", { inReplyTo: undefined, references: ["root@example.org", sent.id] })] }, expected: ["a@example.net"] },
  { name: "a mail naming another id is not a reply", input: { sent, candidates: [reply("a@example.net", { inReplyTo: ["other@example.org"] })] }, expected: [] },
  { name: "a mail naming nothing is not a reply", input: { sent, candidates: [reply("a@example.net", { inReplyTo: undefined })] }, expected: [] },
  { name: "a self-sent candidate is not a reply", input: { sent, candidates: [reply("a@example.org", { from: "me@example.org" })] }, expected: [] },
  { name: "the sender's address matches regardless of case", input: { sent, candidates: [reply("a@example.org", { from: "Me@Example.ORG" })] }, expected: [] },
  { name: "the sent mail itself is not a reply", input: { sent, candidates: [reply(sent.id, { references: [sent.id] })] }, expected: [] },
  { name: "replies come oldest first", input: { sent, candidates: [reply("late@example.net", { receivedAt: "2026-11-12T09:00:00Z" }), reply("early@example.net", { receivedAt: "2026-11-11T09:00:00Z" })] }, expected: ["early@example.net", "late@example.net"] },
  { name: "at most 10 replies, the oldest 10", input: { sent, candidates: many }, expected: many.slice().reverse().slice(0, MAX_REPLIES).map((c) => c.id) },
];

export interface ConformanceFailure {
  readonly rule: "invitationOpen" | "repliesTo";
  readonly name: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** Runs every vector against an adapter's own rules and returns the vectors it fails; an empty list means it conforms. */
export function runDeskRuleVectors(rules: { invitationOpen: InvitationOpenRule; repliesTo: RepliesToRule }): ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  for (const v of INVITATION_OPEN_VECTORS) {
    const actual = rules.invitationOpen(v.input.invitation, v.input.answeredSequence, v.input.now);
    if (actual !== v.expected) failures.push({ rule: "invitationOpen", name: v.name, expected: v.expected, actual });
  }
  for (const v of REPLIES_TO_VECTORS) {
    const actual = rules.repliesTo(v.input.sent, v.input.candidates);
    if (JSON.stringify(actual) !== JSON.stringify(v.expected)) failures.push({ rule: "repliesTo", name: v.name, expected: v.expected, actual });
  }
  return failures;
}
