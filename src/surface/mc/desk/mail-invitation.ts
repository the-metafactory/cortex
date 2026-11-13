import type { Database } from "bun:sqlite";
import { accountOf } from "../../../common/types/config";
import { oneLine } from "./actions";
import type { CalendarAvailability, CalendarInterval } from "./calendar-availability";
import { createFromCard, type DeskWriters, type WriterRunner } from "./create";
import type { ListedMail, MailActionResult } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import { refuse } from "./mail-move";
import { removeDeclined } from "./mail-invitation-remove";
import type { Commitment } from "./mail-yes-filter";
import { CommandTimeout } from "../common/spawn";
import type { MailInvitation, SourceReading } from "./sources/command";
import { clock, DAY_MS, startOfDay } from "./time";
import { DEFAULT_SLOTS, type InvitationSlotsConfig, type InvitationsConfig, type InviteReply, type InviteStatus } from "./mail-invitation-schema";

export { DEFAULT_SLOTS, INVITATIONS_SQL, INVITE_REPLIES, type InvitationsConfig, type InviteReply } from "./mail-invitation-schema";

const HOUR_MS = 3_600_000;
const STEP_MS = 30 * 60_000;
const MAX_CONFLICTS = 5;
const PER_DAY = 2;

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

export interface Slot {
  at: number;
  end: number;
}

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

export const invitationSpan = (inv: Pick<MailInvitation, "start" | "end" | "allDay">): Slot => {
  const at = Date.parse(inv.start);
  const end = inv.end ? Date.parse(inv.end) : at + (inv.allDay ? DAY_MS : HOUR_MS);
  return { at, end: Math.max(end, at + 60_000) };
};

const sameEvent = (event: CalendarInterval, inv: Pick<MailInvitation, "summary">, span: Slot): boolean =>
  event.at === span.at && event.title.trim().toLowerCase() === inv.summary.trim().toLowerCase();

const blocking = (event: CalendarInterval): boolean => event.availability.status !== "free";

const overlaps = (event: CalendarInterval, span: Slot): boolean => event.at < span.end && (event.end ?? event.at + 1) > span.at;

function qualifiedCalendars(calendar: CalendarAvailability, span: Slot): { covered: Map<string, string[]>; reasons: string[] } {
  const covered = new Map<string, string[]>();
  const reasons: string[] = [];
  for (const source of calendar.sources) {
    if (source.kind === "attention") continue;
    if (source.kind === "unknown") reasons.push(`${source.id}: ${source.reason}`);
    else if (source.from > span.at || source.to < span.end) reasons.push(`${source.id} is read only through ${new Date(source.to).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}.`);
    else covered.set(source.id, source.calendars);
  }
  if (covered.size === 0 && reasons.length === 0) reasons.push("No calendar reports which times are busy.");
  return { covered, reasons };
}

/**
 * The principal's events that overlap the invitation, from every calendar source that covers its time. An event that is
 * the invitation itself (same title and start, as a calendar service that places invitations shows it) is not a conflict. Events
 * with unknown availability count as possible conflicts. With no conflict and a calendar that does not cover the time,
 * the answer is unknown, never clear.
 */
export function invitationConflicts(inv: Pick<MailInvitation, "summary" | "start" | "end" | "allDay">, calendar: CalendarAvailability): ConflictCheck {
  const span = invitationSpan(inv);
  const { covered, reasons } = qualifiedCalendars(calendar, span);
  const events = calendar.events
    .filter((e) => blocking(e) && overlaps(e, span) && !sameEvent(e, inv, span))
    .filter((e) => covered.get(e.source)?.includes(e.calendarId) ?? reasons.length > 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_CONFLICTS)
    .map((e): InvitationConflict => ({ title: e.title, at: e.at, ...(e.end !== undefined ? { end: e.end } : {}), calendar: e.calendar, maybe: e.availability.status === "unknown" }));
  if (events.length > 0) return { kind: "conflicts", events };
  return reasons.length > 0 ? { kind: "unknown", reasons } : { kind: "clear" };
}

const mailOnly = (reading: SourceReading): boolean => reading.capabilities !== undefined && !reading.capabilities.includes("calendar");

/**
 * The calendar coverage without the sources whose last reading declared no calendar capability (mail sources), whose
 * stale or failed readings say nothing about busy time. A source that never declared its capabilities is kept: unknown.
 */
export function calendarsOnly(calendar: CalendarAvailability, readings: SourceReading[]): CalendarAvailability {
  const mail = new Set(readings.filter(mailOnly).map((r) => r.id));
  return { ...calendar, sources: calendar.sources.filter((s) => !mail.has(s.id)) };
}

const dayLabel = (at: number): string => new Date(at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const shortDay = (at: number): string => new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function whenLine(inv: Pick<MailInvitation, "start" | "end" | "allDay">): string {
  const span = invitationSpan(inv);
  if (inv.allDay) {
    const days = Math.round((startOfDay(span.end - 1) - startOfDay(span.at)) / DAY_MS);
    return days > 0 ? `${dayLabel(span.at)} to ${dayLabel(span.end - 1)}, all day` : `${dayLabel(span.at)}, all day`;
  }
  const sameDay = startOfDay(span.at) === startOfDay(span.end - 1);
  return sameDay ? `${dayLabel(span.at)}, ${clock(span.at)}–${clock(span.end)}` : `${dayLabel(span.at)} ${clock(span.at)} to ${dayLabel(span.end)} ${clock(span.end)}`;
}

export function conflictLine(check: ConflictCheck): string {
  if (check.kind === "clear") return "Your calendars are free then.";
  if (check.kind === "unknown") return `The Desk cannot tell whether you are free then: ${check.reasons.join(" ")}`;
  const names = check.events.map((e) => `"${e.title}" (${clock(e.at)}${e.end !== undefined ? `–${clock(e.end)}` : ""}${e.maybe ? ", may be busy" : ""})`);
  return `It overlaps ${names.join(", ")}.`;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Free times of the invitation's length on working days, from the invitation's day (or today, if that is past) for
 * `days` working days, between dayStart and dayEnd local time, inside every calendar's coverage. A slot is free when no
 * busy or unknown event overlaps it. At most two per day and `max` in all; the invitation's own time is left out.
 */
export function freeSlots(inv: Pick<MailInvitation, "summary" | "start" | "end" | "allDay">, calendar: CalendarAvailability, now: number, config: InvitationSlotsConfig = DEFAULT_SLOTS): { slots: Slot[]; reason?: string } {
  const span = invitationSpan(inv);
  const length = inv.allDay ? HOUR_MS : span.end - span.at;
  const sources = calendar.sources.filter((s) => s.kind !== "attention");
  const unknown = sources.flatMap((s) => (s.kind === "unknown" ? [s] : []))[0];
  if (unknown) return { slots: [], reason: `${unknown.id}: ${unknown.reason}` };
  const read = sources.flatMap((s) => (s.kind === "calendar" ? [s] : []));
  if (read.length === 0) return { slots: [], reason: "No calendar reports which times are busy." };
  const through = Math.min(...read.map((s) => s.to));
  const from = Math.max(...read.map((s) => s.from), now);
  const busy = calendar.events.filter((e) => blocking(e) && !sameEvent(e, inv, span) && read.some((s) => s.id === e.source && s.calendars.includes(e.calendarId)));
  const slots: Slot[] = [];
  let day = startOfDay(Math.max(span.at, now));
  for (let worked = 0; worked < config.days && day < through && slots.length < config.max; day = startOfDay(day + DAY_MS + HOUR_MS * 2)) {
    const weekday = new Date(day).getDay();
    if (weekday === 0 || weekday === 6) continue;
    worked += 1;
    const open = new Date(day).setHours(0, minutesOf(config.dayStart), 0, 0);
    const close = new Date(day).setHours(0, minutesOf(config.dayEnd), 0, 0);
    let today = 0;
    for (let at = open; at + length <= close && today < PER_DAY && slots.length < config.max; at += STEP_MS) {
      const slot = { at, end: at + length };
      if (at < from || slot.end > through || (at === span.at && slot.end === span.end)) continue;
      if (busy.some((e) => overlaps(e, slot))) continue;
      slots.push(slot);
      today += 1;
      at = slot.end - STEP_MS;
    }
  }
  return slots.length > 0 ? { slots } : { slots, reason: "Your calendars show no free time of that length in the next working days." };
}

export function proposalBody(inv: Pick<MailInvitation, "summary" | "start" | "end" | "allDay">, slots: Slot[]): string {
  const when = inv.allDay ? shortDay(Date.parse(inv.start)) : `${shortDay(Date.parse(inv.start))} at ${clock(Date.parse(inv.start))}`;
  const lines = slots.map((s) => `- ${shortDay(s.at)}, ${clock(s.at)}–${clock(s.end)}`);
  return [`Thank you for the invitation to "${inv.summary}". I cannot make ${when}. Would one of these times work instead?`, "", ...lines, ""].join("\n");
}

interface InvitationRow {
  request_id: string;
  message_id: string;
  reply: InviteReply;
  commitment: string | null;
  status: InviteStatus;
  result: string | null;
  calendar: string | null;
  created_at: number;
}

const fallsAwayOf = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "label" in parsed && typeof parsed.label === "string" ? parsed.label : null;
  } catch {
    return null;
  }
};

const toDecision = (row: InvitationRow): InvitationDecision => ({ reply: row.reply, status: row.status, at: row.created_at, fallsAway: fallsAwayOf(row.commitment), result: row.result, calendar: row.calendar });

/** The newest answer per mail, for the cards. */
export function invitationDecisions(db: Database, messageIds: string[]): Map<string, InvitationDecision> {
  const out = new Map<string, InvitationDecision>();
  if (messageIds.length === 0) return out;
  const rows = db.query<InvitationRow, string[]>(`SELECT * FROM desk_mail_invitations WHERE message_id IN (${messageIds.map(() => "?").join(", ")}) ORDER BY created_at DESC, rowid DESC`).all(...messageIds);
  for (const row of rows) if (!out.has(row.message_id)) out.set(row.message_id, toDecision(row));
  return out;
}

export function invitationView(mail: ListedMail, calendar: CalendarAvailability, config: InvitationsConfig | undefined, decision?: InvitationDecision): InvitationView | undefined {
  const inv = mail.invitation;
  if (!inv) return undefined;
  const conflicts = invitationConflicts(inv, calendar);
  return {
    uid: inv.uid,
    summary: inv.summary,
    when: whenLine(inv),
    start: inv.start,
    ...(inv.end ? { end: inv.end } : {}),
    ...(inv.allDay ? { allDay: true } : {}),
    ...(inv.location ? { location: inv.location } : {}),
    organizer: inv.organizer.name ? `${inv.organizer.name} <${inv.organizer.address}>` : inv.organizer.address,
    ...(inv.recurring ? { recurring: true } : {}),
    ...(inv.attendee ? { status: inv.attendee.status } : {}),
    attendee: Boolean(inv.attendee),
    conflicts,
    conflictLine: conflictLine(conflicts),
    canReply: Boolean(config?.command.length && mail.account && inv.attendee),
    ...(decision ? { decision } : {}),
  };
}

export function withoutAnsweredRead<M extends { id: string; unread: boolean; invitation?: unknown }>(mail: readonly M[], answers: ReadonlyMap<string, InvitationDecision>): M[] {
  return mail.filter((m) => m.unread || !m.invitation || answers.get(m.id)?.status !== "sent");
}

const PAST: Record<InviteReply, string> = { accept: "accepted", decline: "declined" };
const NOUN: Record<InviteReply, string> = { accept: "acceptance", decline: "decline" };

export function decisionSentence(decision: InvitationDecision, ago: string): string {
  const falls = decision.fallsAway ? ` Falls away: ${decision.fallsAway}.` : decision.reply === "accept" ? " Nothing was named to fall away." : "";
  if (decision.status === "sent") return `You ${PAST[decision.reply]} this invitation on the Desk (${ago}).${falls}`;
  if (decision.status === "sending") return `Your ${NOUN[decision.reply]} is being sent (${ago}).${falls}`;
  if (decision.status === "uncertain") return `Your ${NOUN[decision.reply]} may have been sent (${ago}); check Sent before answering again.${falls}`;
  return `Your ${NOUN[decision.reply]} was not sent (${ago}): ${decision.result ?? "the reply command failed"}.`;
}

/** The stdin of the calendar-reply command for one answer. */
export function invitePayload(mail: ListedMail, reply: InviteReply, requestId: string): { action: "invite-reply"; account: string; messageId: string; uid: string; reply: InviteReply; requestId: string } | null {
  if (!mail.account || !mail.invitation) return null;
  return { action: "invite-reply", account: mail.account, messageId: mail.id, uid: mail.invitation.uid, reply, requestId };
}

/** The calendar writer's card for an accepted invitation. */
export function acceptedEventCard(mail: ListedMail): { kind: "calendar"; fields: { title: string; start: string; end?: string; allDay?: boolean; location?: string; notes: string } } | null {
  const inv = mail.invitation;
  if (!inv) return null;
  return {
    kind: "calendar",
    fields: {
      title: inv.summary.slice(0, 200),
      start: inv.start,
      ...(inv.end ? { end: inv.end } : {}),
      ...(inv.allDay ? { allDay: true } : {}),
      ...(inv.location ? { location: inv.location.slice(0, 200) } : {}),
      notes: `Accepted on the Desk. Organizer: ${inv.organizer.address}.`,
    },
  };
}

export interface InviteReplyInput {
  reply: InviteReply;
  requestId: string;
  commitment: Commitment | null;
  confirmed: boolean;
  suspicious: boolean;
}

export interface InviteReplyDeps {
  db: Database;
  config: InvitationsConfig | undefined;
  writers: DeskWriters;
  run: WriterRunner;
  now: number;
  writerTimeoutMs: number;
}

const binding = (messageId: string, uid: string, reply: InviteReply, commitment: unknown): string => JSON.stringify({ messageId, uid, reply, commitment });
const bindingOf = (row: InvitationRow & { uid: string }): string => binding(row.message_id, row.uid, row.reply, row.commitment ? (JSON.parse(row.commitment) as unknown) : null);

/**
 * Sends the principal's confirmed answer to one invitation through the calendar-reply command, records it with the
 * Yes-filter choice, logs the mail decision and, for an accepted invitation in an account listed under addToCalendar,
 * adds the event through the calendar writer, to the calendar that entry names. Nothing is sent without `confirmed`, for suspicious mail, for a mail without
 * an invitation the principal is invited to, or when an answer to this mail is already sent or may have been.
 */
export async function replyToInvitation(mail: ListedMail, input: InviteReplyInput, deps: InviteReplyDeps): Promise<MailActionResult> {
  const { db, config, now } = deps;
  if (!input.confirmed) return refuse(409, "Confirm the answer first. Nothing was sent.");
  if (input.suspicious) return refuse(409, "This mail may be phishing, so the Desk does not answer its invitation.");
  if (!config?.command.length) return refuse(409, "Answering invitations is not set up on this stack.");
  const payload = invitePayload(mail, input.reply, input.requestId);
  const inv = mail.invitation;
  if (!payload || !inv) return refuse(409, "This mail carries no calendar invitation the Desk can answer.");
  if (!inv.attendee) return refuse(409, "You are not listed as an attendee of this invitation, so the Desk does not answer it.");
  const bound = binding(mail.id, inv.uid, input.reply, input.commitment);
  const claimed = db.transaction((): MailActionResult | null => {
    const same = db.query<InvitationRow & { uid: string }, [string]>("SELECT * FROM desk_mail_invitations WHERE request_id = ?").get(input.requestId);
    if (same) {
      if (bindingOf(same) !== bound) return refuse(409, "This answer changed. Start again before sending it.");
      if (same.status === "sent") return { ok: true, message: same.result ?? "The answer was already sent." };
      if (same.status !== "failed") return refuse(409, "This answer may already be sent. Check Sent before answering again.");
    }
    const open = db.query<InvitationRow, [string, string]>("SELECT * FROM desk_mail_invitations WHERE message_id = ? AND request_id != ? AND status IN ('sending', 'sent', 'uncertain') ORDER BY created_at DESC LIMIT 1").get(mail.id, input.requestId);
    if (open) return refuse(409, `You already ${open.status === "sent" ? PAST[open.reply] : "answered"} this invitation.`);
    db.query("INSERT INTO desk_mail_invitations (request_id, message_id, account, source_id, uid, sequence, reply, commitment, status, result, calendar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', NULL, NULL, ?) ON CONFLICT(request_id) DO UPDATE SET status = 'sending', result = NULL, created_at = excluded.created_at")
      .run(input.requestId, mail.id, payload.account, mail.sourceId, inv.uid, inv.sequence, input.reply, input.commitment ? JSON.stringify(input.commitment) : null, now);
    return null;
  }).immediate();
  if (claimed) return claimed;
  const features = mailFeatures(db, mail);
  const finish = (status: InviteStatus, result: string, calendar: string | null = null): void => {
    db.query("UPDATE desk_mail_invitations SET status = ?, result = ?, calendar = ?, finished_at = ? WHERE request_id = ?").run(status, result, calendar, now, input.requestId);
  };
  let sent: string;
  try {
    const out = await deps.run(config.command, JSON.stringify(payload), config.timeoutSeconds * 1000);
    if (out.code !== 0) {
      const why = oneLine(out.stderr || out.stdout, `the reply command exited with code ${out.code}.`);
      finish("failed", why);
      return refuse(502, `The answer was not sent: ${why}`);
    }
    sent = sentMessage(out.stdout, input.reply);
  } catch (err) {
    if (err instanceof CommandTimeout) {
      finish("uncertain", `the reply command ${err.message}`);
      return refuse(504, `The reply command ${err.message}. The answer may have been sent; check Sent before answering again.`);
    }
    const why = err instanceof Error ? err.message : String(err);
    finish("failed", why);
    return refuse(502, `The reply command did not run: ${why}`);
  }
  const calendar = input.reply === "accept" ? await addAccepted(mail, input.requestId, deps).catch((err: unknown) => `The event was not added to your calendar: ${err instanceof Error ? err.message : String(err)}`) : await removeDeclined(mail, config, deps.run);
  finish("sent", sent, calendar);
  logMailDecision(db, features, input.reply, "desk", now);
  return { ok: true, message: calendar ? `${sent} ${calendar}` : sent };
}

const DONE: Record<InviteReply, string> = { accept: "Accepted", decline: "Declined" };

function sentMessage(stdout: string, reply: InviteReply): string {
  try {
    const out: unknown = JSON.parse(stdout);
    if (typeof out === "object" && out !== null && "message" in out && typeof out.message === "string" && out.message.trim() && out.message.length <= 300) return `${DONE[reply]}. ${oneLine(out.message, "")}`;
  } catch {
    return `${DONE[reply]}.`;
  }
  return `${DONE[reply]}.`;
}

function calendarFor(config: InvitationsConfig | undefined, account: string): { calendar?: string } | null {
  const entry = config?.addToCalendar.find((e) => accountOf(e) === account);
  if (entry === undefined) return null;
  return typeof entry !== "string" && entry.calendar ? { calendar: entry.calendar } : {};
}

async function addAccepted(mail: ListedMail, requestId: string, deps: InviteReplyDeps): Promise<string | null> {
  const target = mail.account ? calendarFor(deps.config, mail.account) : null;
  if (!target) return null;
  const card = acceptedEventCard(mail);
  const writer = deps.config?.calendarWriter ?? deps.writers.calendar;
  if (!card || !writer?.length) return "The event was not added to your calendar: no calendar writer is set up.";
  const argv = target.calendar ? [...writer, "--calendar", target.calendar] : writer;
  const created = await createFromCard(card, { requestId, db: deps.db, writers: { calendar: argv }, run: deps.run, now: deps.now, timeoutMs: deps.writerTimeoutMs });
  if (!created.ok) return `The event was not added to your calendar: ${created.error}`;
  return target.calendar ? created.message : "The event is in your calendar.";
}
