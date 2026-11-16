import type { Database } from "bun:sqlite";
import type { CalendarAvailability } from "./calendar-availability";
import type { ListedMail } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import { snoozeAt, snoozeWhen, type SnoozeChoice } from "./mail-snooze-schema";
import type { SourceReading } from "./sources/command";
import { DAY_MS } from "./time";
import { parentsOf } from "./mail-waiting";
import { sightEvent, type EventFacts, type FollowedEvent } from "./event-follow";
import type { DeferredItem, DeskItem } from "./types";
import type { DeskPhrase } from "./phrases";

export { SNOOZE_MORNING_HOUR, SNOOZE_SQL, SNOOZE_TIMES, snoozeAt, snoozeWhen, type SnoozeChoice, type SnoozeTime } from "./mail-snooze-schema";
import type { HiddenMail } from "../../../desk-api/wire/mail";

export type SnoozeKind = "time" | "meeting" | "person" | "hidden";
export type SnoozeState = "snoozed" | "back";

/** `label` is deprecated in favour of `labelPhrase`, or `kind` for hidden mail. Served through 1.x; removed in 2.0. */
export interface SnoozeRow {
  messageId: string;
  sourceId: string | null;
  sender: string;
  subject: string;
  kind: SnoozeKind;
  untilAt: number | null;
  eventKey: string | null;
  eventTitle: string | null;
  eventStart: number | null;
  person: string | null;
  personName: string | null;
  label: string;
  labelPhrase?: DeskPhrase;
  state: SnoozeState;
  backAt: number | null;
  reason: string | null;
  createdAt: number;
}

export type SnoozeEvent = FollowedEvent;

export interface WakeFacts extends EventFacts {
  wrote: (person: string, since: number, except: string) => { name?: string; subject?: string } | null;
  threadReply: (messageId: string, since: number) => { name?: string; subject?: string } | null;
  urgentNow: ReadonlySet<string>;
}

export type WakeDecision =
  | { kind: "wait" }
  | { kind: "back"; reason: string }
  | { kind: "moved"; event: SnoozeEvent };

const BACK_KEEP_DAYS = 14;
const BACK_SHOWN_MS = DAY_MS;
const SNOOZE_KEEP_DAYS = 400;

const quoted = (title: string): string => `“${title}”`;

const TIME_CAME = "the time you chose came";
export const URGENT_NOW_REASON = "it is urgent now";

function earlyWake(row: SnoozeRow, facts: WakeFacts, key: string, mailRow: boolean): WakeDecision | null {
  if (facts.urgentNow.has(key)) return { kind: "back", reason: URGENT_NOW_REASON };
  if (!mailRow) return null;
  const wrote = facts.threadReply(row.messageId, row.createdAt);
  if (!wrote) return null;
  const who = wrote.name ?? row.sender;
  return { kind: "back", reason: `${who} wrote again: ${quoted(wrote.subject ?? row.subject)}` };
}

/** Whether a snooze is over, over fixture-able facts: the time passed, the meeting ended or can no longer happen, the person wrote after the snooze, or it ended early (see earlyWake). `key` is the Desk item key; a mail row's is its message id. */
export function wakeOf(row: SnoozeRow, facts: WakeFacts, now: number, key: string | null = null): WakeDecision {
  if (row.kind === "hidden") return { kind: "wait" };
  const decision = scheduledWake(row, facts, now);
  if (decision.kind === "back") return decision;
  return earlyWake(row, facts, key ?? `mail:${row.messageId}`, key === null) ?? decision;
}

function scheduledWake(row: SnoozeRow, facts: WakeFacts, now: number): WakeDecision {
  if (row.kind === "time") return row.untilAt !== null && now >= row.untilAt ? { kind: "back", reason: TIME_CAME } : { kind: "wait" };
  if (row.kind === "person") {
    if (!row.person) return { kind: "back", reason: "the snooze named no person" };
    const wrote = facts.wrote(row.person, row.createdAt, row.messageId);
    if (!wrote) return { kind: "wait" };
    const who = wrote.name ?? row.personName ?? row.person;
    return { kind: "back", reason: wrote.subject ? `${who} wrote: ${quoted(wrote.subject)}` : `${who} wrote` };
  }
  const title = row.eventTitle ?? "the meeting";
  const key = row.eventKey;
  const sighting = key ? sightEvent(facts, key, { title: row.eventTitle, at: row.eventStart, end: row.untilAt }) : null;
  if (sighting?.kind === "seen") {
    if (now >= sighting.event.end) return { kind: "back", reason: `${quoted(sighting.event.title)} has ended` };
    return sighting.moved ? { kind: "moved", event: sighting.event } : { kind: "wait" };
  }
  if (row.untilAt !== null && now >= row.untilAt) return { kind: "back", reason: `${quoted(title)} has ended` };
  if (!key || row.eventStart === null) return { kind: "back", reason: `the Desk lost track of ${quoted(title)}` };
  return sighting?.kind === "cancelled" ? { kind: "back", reason: `${quoted(title)} was cancelled` } : { kind: "wait" };
}

/** The line a returned card leads with. A time snooze names the time it was snoozed until. */
export function backLine(row: Pick<SnoozeRow, "kind" | "untilAt" | "reason">, now: number): string {
  const reason = row.kind === "time" && row.untilAt !== null && (row.reason === null || row.reason === TIME_CAME) ? `you snoozed it until ${snoozeWhen(row.untilAt, now)}` : row.reason ?? "its snooze ended";
  return `Back because ${reason}.`;
}

const eventEnd = (start: number, end: string | undefined, allDay: boolean | undefined): number => {
  const parsed = end ? Date.parse(end) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  return allDay ? start + DAY_MS : start;
};

/** Every event the readings list, by Desk event key, whatever the calendar settings show. */
export function readingEvents(readings: readonly SourceReading[]): Map<string, SnoozeEvent> {
  const out = new Map<string, SnoozeEvent>();
  for (const r of readings) {
    for (const e of r.events) {
      const at = Date.parse(e.start);
      if (!Number.isFinite(at)) continue;
      const listed = e.organizer !== undefined || e.attendees !== undefined;
      const people = new Set([...(e.organizer ? [e.organizer.address] : []), ...(e.attendees ?? []).map((a) => a.address)]);
      out.set(`cal:${r.id}:${e.id}`, { title: e.title, at, end: eventEnd(at, e.end, e.allDay), ...(listed ? { organizerAndAttendees: people } : {}) });
    }
  }
  return out;
}

/** The facts the wake evaluation reads from the readings, the calendar coverage and the reply index. */
export function snoozeFacts(db: Database, readings: readonly SourceReading[], availability: CalendarAvailability | undefined, urgentNow: ReadonlySet<string> = new Set()): WakeFacts {
  const mail = readings.filter((r) => r.error === null).flatMap((r) => r.mail);
  const own = new Set(readings.flatMap((r) => (r.sent ?? []).map((s) => s.from.address.toLowerCase())));
  const isOwn = (address: string): boolean => own.has(address.toLowerCase());
  return {
    urgentNow,
    threadReply: (messageId, since) => {
      const source = mail.find((m) => m.id === messageId);
      const thread = new Set([messageId, ...(source ? parentsOf(source.headers?.inReplyTo, source.headers?.references) : [])]);
      const listed = mail
        .filter((m) => m.id !== messageId && !isOwn(m.from.address) && Date.parse(m.receivedAt) >= since && parentsOf(m.headers?.inReplyTo, m.headers?.references).some((p) => thread.has(p)))
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
      if (listed) return { ...(listed.from.name ? { name: listed.from.name } : {}), subject: listed.subject };
      const threaded = db
        .query<{ sender: string }, [string, number, string]>("SELECT sender FROM desk_mail_thread WHERE parent_id = ? AND at >= ? AND reply_id != ? ORDER BY at")
        .all(messageId, since, messageId)
        .find((r) => !isOwn(r.sender));
      return threaded ? {} : null;
    },
    events: readingEvents(readings),
    covered: (key, at) => (availability?.sources ?? []).some((s) => s.kind === "calendar" && key.startsWith(`cal:${s.id}:`) && s.from <= at && at < s.to),
    wrote: (person, since, except) => {
      const listed = mail
        .filter((m) => m.id !== except && m.from.address.toLowerCase() === person && Date.parse(m.receivedAt) >= since)
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
      if (listed) return { ...(listed.from.name ? { name: listed.from.name } : {}), subject: listed.subject };
      const threaded = db
        .query<{ reply_id: string }, [string, number, string]>("SELECT reply_id FROM desk_mail_thread WHERE sender = ? AND at >= ? AND reply_id != ? ORDER BY at LIMIT 1")
        .get(person, since, except);
      return threaded ? {} : null;
    },
  };
}

interface Raw {
  message_id: string;
  source_id: string | null;
  sender: string;
  subject: string;
  kind: SnoozeKind;
  until_at: number | null;
  event_key: string | null;
  event_title: string | null;
  event_start: number | null;
  person: string | null;
  person_name: string | null;
  label: string;
  state: SnoozeState;
  back_at: number | null;
  reason: string | null;
  created_at: number;
}

const rowOf = (r: Raw): SnoozeRow => ({
  messageId: r.message_id, sourceId: r.source_id, sender: r.sender, subject: r.subject, kind: r.kind, untilAt: r.until_at,
  eventKey: r.event_key, eventTitle: r.event_title, eventStart: r.event_start, person: r.person, personName: r.person_name,
  label: r.label, state: r.state, backAt: r.back_at, reason: r.reason, createdAt: r.created_at,
  labelPhrase: putAwayPhrase({ kind: r.kind, untilAt: r.until_at, eventTitle: r.event_title, person: r.person, personName: r.person_name }),
});

function putAwayPhrase(row: Pick<SnoozeRow, "kind" | "untilAt" | "eventTitle" | "person" | "personName">): DeskPhrase | undefined {
  if (row.kind === "time" && row.untilAt !== null) return { code: "mail.put-away-time", params: { until: new Date(row.untilAt).toISOString() } };
  if (row.kind === "meeting" && row.eventTitle !== null) return { code: "mail.put-away-meeting", params: { title: row.eventTitle } };
  if (row.kind === "person" && row.person !== null) return { code: "mail.put-away-person", params: { person: row.personName ?? row.person } };
  return undefined;
}

export function readSnoozes(db: Database, state?: SnoozeState): SnoozeRow[] {
  const rows = state
    ? db.query<Raw, [string]>("SELECT * FROM desk_mail_snoozes WHERE state = ? ORDER BY created_at").all(state)
    : db.query<Raw, []>("SELECT * FROM desk_mail_snoozes ORDER BY created_at").all();
  return rows.map(rowOf);
}

export function readSnooze(db: Database, messageId: string): SnoozeRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM desk_mail_snoozes WHERE message_id = ?").get(messageId);
  return r ? rowOf(r) : null;
}

/** Wakes every snooze whose condition happened, follows a moved meeting, and forgets old rows. Returns the woken message ids. */
export function wakeSnoozes(db: Database, facts: WakeFacts, now: number): string[] {
  const woken: string[] = [];
  db.transaction(() => {
    for (const row of readSnoozes(db, "snoozed")) {
      if (row.kind === "hidden") continue;
      const decision = wakeOf(row, facts, now);
      if (decision.kind === "back") {
        db.query("UPDATE desk_mail_snoozes SET state = 'back', back_at = ?, reason = ? WHERE message_id = ? AND state = 'snoozed'").run(now, decision.reason, row.messageId);
        woken.push(row.messageId);
      } else if (decision.kind === "moved") {
        const { event } = decision;
        db.query("UPDATE desk_mail_snoozes SET event_title = ?, event_start = ?, until_at = ?, label = ? WHERE message_id = ?").run(event.title, event.at, event.end, `until ${quoted(event.title)} ends`, row.messageId);
      }
    }
    db.query("DELETE FROM desk_mail_snoozes WHERE state = 'back' AND back_at < ?").run(now - BACK_KEEP_DAYS * DAY_MS);
    db.query("DELETE FROM desk_mail_snoozes WHERE kind <> 'hidden' AND created_at < ?").run(now - SNOOZE_KEEP_DAYS * DAY_MS);
  })();
  return woken;
}

/** Message ids the principal snoozed that have not come back. */
export function snoozedIds(db: Database): Set<string> {
  return new Set(db.query<{ message_id: string }, []>("SELECT message_id FROM desk_mail_snoozes WHERE state = 'snoozed'").all().map((r) => r.message_id));
}

/** The readings without snoozed mail: what rules, sweeps, bundles and digests may see. */
export function withoutSnoozed<R extends SourceReading>(readings: readonly R[], snoozed: ReadonlySet<string>): R[] {
  if (snoozed.size === 0) return [...readings];
  return readings.map((r) => ({ ...r, mail: r.mail.filter((m) => !snoozed.has(m.id)) }));
}

export interface SnoozeBack {
  line: string;
  at: number;
}

/** Mail that came back within the last day: after that the card is an ordinary mail card again. */
export function backSnoozes(db: Database, now: number): Map<string, SnoozeBack> {
  return new Map(readSnoozes(db, "back").flatMap((r): [string, SnoozeBack][] => (r.backAt !== null && now - r.backAt < BACK_SHOWN_MS ? [[r.messageId, { line: backLine(r, now), at: r.backAt }]] : [])));
}

/** A mail card that came back from a snooze leads with why, and asks for attention today. */
export function withSnoozeBack(item: DeskItem, back: SnoozeBack | undefined): DeskItem {
  if (!back || item.kind !== "mail") return item;
  return { ...item, urgency: item.urgency === "now" ? "now" : "today", why: `${back.line} ${item.why}`, back: { line: back.line, at: back.at } };
}

interface SnoozeFailure { ok: false; status: number; error: string }
type SnoozeResult = { ok: true; message: string; until: string; untilIso: string | null; labelPhrase?: DeskPhrase } | SnoozeFailure;

const refuse = (status: number, error: string): SnoozeFailure => ({ ok: false, status, error });
const ADDRESS_RE = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

type Resolved = Pick<SnoozeRow, "kind" | "untilAt" | "eventKey" | "eventTitle" | "eventStart" | "person" | "personName" | "label">;

export function resolveSnoozeChoice(choice: SnoozeChoice, ctx: { now: number; events: ReadonlyMap<string, SnoozeEvent>; names: ReadonlyMap<string, string> }): Resolved | string {
  const none = { eventKey: null, eventTitle: null, eventStart: null, person: null, personName: null };
  if (choice.kind === "meeting") {
    const event = ctx.events.get(choice.event);
    if (!event) return "The Desk no longer sees that meeting. Pick another one.";
    if (event.end <= ctx.now) return "That meeting is already over.";
    return { ...none, kind: "meeting", untilAt: event.end, eventKey: choice.event, eventTitle: event.title, eventStart: event.at, label: `until ${quoted(event.title)} ends` };
  }
  if (choice.kind === "person") {
    const person = choice.address.trim().toLowerCase();
    if (!ADDRESS_RE.test(person) || person.length > 320) return "That is not a mail address.";
    const name = ctx.names.get(person) ?? null;
    return { ...none, kind: "person", untilAt: null, person, personName: name, label: `until ${name ?? person} writes` };
  }
  const at = snoozeAt(choice, ctx.now);
  if (at === null) return "That is not a date.";
  if (at <= ctx.now) return "That time has already passed.";
  return { ...none, kind: "time", untilAt: at, label: `until ${snoozeWhen(at, ctx.now)}` };
}

function insertSnooze(db: Database, mail: ListedMail, resolved: Resolved, now: number): void {
  db.query(
    `INSERT INTO desk_mail_snoozes (message_id, source_id, sender, subject, kind, until_at, event_key, event_title, event_start, person, person_name, label, state, back_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snoozed', NULL, NULL, ?)
     ON CONFLICT(message_id) DO UPDATE SET source_id = excluded.source_id, sender = excluded.sender, subject = excluded.subject, kind = excluded.kind, until_at = excluded.until_at,
       event_key = excluded.event_key, event_title = excluded.event_title, event_start = excluded.event_start, person = excluded.person, person_name = excluded.person_name,
       label = excluded.label, state = 'snoozed', back_at = NULL, reason = NULL, created_at = excluded.created_at`,
  ).run(mail.id, mail.sourceId, mail.from.address.toLowerCase(), mail.subject.slice(0, 300), resolved.kind, resolved.untilAt, resolved.eventKey, resolved.eventTitle, resolved.eventStart, resolved.person, resolved.personName, resolved.label, now);
}

export function snoozeMail(db: Database, mail: ListedMail, choice: SnoozeChoice, ctx: { now: number; readings: readonly SourceReading[] }): SnoozeResult {
  const names = new Map(ctx.readings.flatMap((r) => r.mail.flatMap((m): [string, string][] => (m.from.name ? [[m.from.address.toLowerCase(), m.from.name]] : []))));
  const resolved = resolveSnoozeChoice(choice, { now: ctx.now, events: readingEvents(ctx.readings), names });
  if (typeof resolved === "string") return refuse(409, resolved);
  const features = mailFeatures(db, mail);
  insertSnooze(db, mail, resolved, ctx.now);
  logMailDecision(db, features, "snooze", "desk", ctx.now);
  return { ok: true, message: `Snoozed ${quoted(mail.subject)} ${resolved.label}. Its read status in your mail stays unchanged.`, until: resolved.label, untilIso: resolved.untilAt === null ? null : new Date(resolved.untilAt).toISOString(), labelPhrase: putAwayPhrase(resolved) };
}

/** Ends a snooze now: the mail is back on the Desk as it was, without a reason line. */
export function cancelSnooze(db: Database, messageId: string): { ok: true; message: string } | SnoozeFailure {
  const row = readSnooze(db, messageId);
  if (!row) return refuse(409, "This mail is not snoozed.");
  db.query("DELETE FROM desk_mail_snoozes WHERE message_id = ?").run(messageId);
  return { ok: true, message: `${quoted(row.subject)} is back on the Desk.` };
}

const HIDDEN: Resolved = { kind: "hidden", untilAt: null, eventKey: null, eventTitle: null, eventStart: null, person: null, personName: null, label: "hidden from the Desk" };

/** Hides a mail from the Desk for good: a snooze row that never wakes. The mailbox is not touched. */
export function hideMail(db: Database, mail: ListedMail, now: number): { ok: true; message: string } {
  const message = `Hid ${quoted(mail.subject)} from the Desk. It stays in your mailbox as it is.`;
  if (readSnooze(db, mail.id)?.kind === "hidden") return { ok: true, message };
  const features = mailFeatures(db, mail);
  db.transaction(() => {
    insertSnooze(db, mail, HIDDEN, now);
    logMailDecision(db, features, "ignored", "desk", now);
  })();
  return { ok: true, message };
}

/** Brings a hidden mail back as it was, without a reason line. */
export function undoHide(db: Database, messageId: string): { ok: true; message: string } | SnoozeFailure {
  const row = readSnooze(db, messageId);
  if (row?.kind !== "hidden") return refuse(409, "This mail is not hidden.");
  db.query("DELETE FROM desk_mail_snoozes WHERE message_id = ?").run(messageId);
  return { ok: true, message: `${quoted(row.subject)} is back on the Desk.` };
}

export function hiddenMail(db: Database): HiddenMail[] {
  return readSnoozes(db, "snoozed").filter((r) => r.kind === "hidden").map((r) => ({ key: `mail:${r.messageId}`, subject: r.subject, sender: r.sender, at: r.createdAt }));
}

export function deferredMail(db: Database, now: number): DeferredItem[] {
  return readSnoozes(db, "snoozed")
    .filter((row) => row.kind !== "hidden")
    .sort((a, b) => (a.untilAt ?? Infinity) - (b.untilAt ?? Infinity) || a.createdAt - b.createdAt)
    .map((row) => ({ key: `mail:${row.messageId}`, title: row.subject, until: row.kind === "time" && row.untilAt !== null ? `until ${snoozeWhen(row.untilAt, now)}` : row.label }));
}

/** Ids of snoozed mail that waits for its time, meeting or person; hidden mail never returns. */
export function waitingMailIds(db: Database): Set<string> {
  return new Set(readSnoozes(db, "snoozed").filter((r) => r.kind !== "hidden").map((r) => r.messageId));
}

/** A mail that returned from a snooze interrupts only when it is rated urgency now. */
export function quietSnoozeReturns(items: DeskItem[], returned: ReadonlyMap<string, SnoozeBack>): DeskItem[] {
  return items.map((item) => {
    if (item.kind !== "mail" || item.urgency === "now" || !item.interrupt || !returned.has(item.key.replace(/^mail:/, ""))) return item;
    const { interrupt: _interrupt, interruptRequested: _requested, ...rest } = item;
    return rest;
  });
}
