import type { Database } from "bun:sqlite";
import type { CalendarAvailability } from "./calendar-availability";
import type { ListedMail } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import { snoozeAt, snoozeWhen, type SnoozeChoice } from "./mail-snooze-schema";
import type { SourceReading } from "./sources/command";
import { DAY_MS } from "./time";
import { sightEvent, type EventFacts, type FollowedEvent } from "./event-follow";
import type { DeskItem } from "./types";

export { SNOOZE_MORNING_HOUR, SNOOZE_SQL, SNOOZE_TIMES, snoozeAt, snoozeWhen, type SnoozeChoice, type SnoozeTime } from "./mail-snooze-schema";

export type SnoozeKind = "time" | "meeting" | "person" | "hidden";
export type SnoozeState = "snoozed" | "back";

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
  state: SnoozeState;
  backAt: number | null;
  reason: string | null;
  createdAt: number;
}

export type SnoozeEvent = FollowedEvent;

export interface WakeFacts extends EventFacts {
  wrote: (person: string, since: number, except: string) => { name?: string; subject?: string } | null;
}

export type WakeDecision =
  | { kind: "wait" }
  | { kind: "back"; reason: string }
  | { kind: "moved"; event: SnoozeEvent };

const BACK_KEEP_DAYS = 14;
const BACK_SHOWN_MS = DAY_MS;
const SNOOZE_KEEP_DAYS = 400;

const quoted = (title: string): string => `“${title}”`;

/** Whether a snooze is over, over fixture-able facts: the time passed, the meeting ended or can no longer happen, or the person wrote after the snooze. */
export function wakeOf(row: SnoozeRow, facts: WakeFacts, now: number): WakeDecision {
  if (row.kind === "hidden") return { kind: "wait" };
  if (row.kind === "time") return row.untilAt !== null && now >= row.untilAt ? { kind: "back", reason: "the time you chose came" } : { kind: "wait" };
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
  const reason = row.kind === "time" && row.untilAt !== null ? `you snoozed it until ${snoozeWhen(row.untilAt, now)}` : row.reason ?? "its snooze ended";
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
      if (Number.isFinite(at)) out.set(`cal:${r.id}:${e.id}`, { title: e.title, at, end: eventEnd(at, e.end, e.allDay) });
    }
  }
  return out;
}

/** The facts the wake evaluation reads from the readings, the calendar coverage and the reply index. */
export function snoozeFacts(db: Database, readings: readonly SourceReading[], availability: CalendarAvailability | undefined): WakeFacts {
  const mail = readings.filter((r) => r.error === null).flatMap((r) => r.mail);
  return {
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
});

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
    db.query("DELETE FROM desk_mail_snoozes WHERE created_at < ?").run(now - SNOOZE_KEEP_DAYS * DAY_MS);
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
type SnoozeResult = { ok: true; message: string; until: string } | SnoozeFailure;

const refuse = (status: number, error: string): SnoozeFailure => ({ ok: false, status, error });
const ADDRESS_RE = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

type Resolved = Pick<SnoozeRow, "kind" | "untilAt" | "eventKey" | "eventTitle" | "eventStart" | "person" | "personName" | "label">;

function resolve(choice: SnoozeChoice, ctx: { now: number; events: ReadonlyMap<string, SnoozeEvent>; names: ReadonlyMap<string, string> }): Resolved | string {
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

export function snoozeMail(db: Database, mail: ListedMail, choice: SnoozeChoice, ctx: { now: number; readings: readonly SourceReading[] }): SnoozeResult {
  const names = new Map(ctx.readings.flatMap((r) => r.mail.flatMap((m): [string, string][] => (m.from.name ? [[m.from.address.toLowerCase(), m.from.name]] : []))));
  const resolved = resolve(choice, { now: ctx.now, events: readingEvents(ctx.readings), names });
  if (typeof resolved === "string") return refuse(409, resolved);
  const features = mailFeatures(db, mail);
  upsertSnooze(db, mail, resolved, ctx.now);
  logMailDecision(db, features, "snooze", "desk", ctx.now);
  return { ok: true, message: `Snoozed ${quoted(mail.subject)} ${resolved.label}. Its read status in your mail stays unchanged.`, until: resolved.label };
}

function upsertSnooze(db: Database, mail: ListedMail, resolved: Resolved, now: number): void {
  db.query(
    `INSERT INTO desk_mail_snoozes (message_id, source_id, sender, subject, kind, until_at, event_key, event_title, event_start, person, person_name, label, state, back_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snoozed', NULL, NULL, ?)
     ON CONFLICT(message_id) DO UPDATE SET source_id = excluded.source_id, sender = excluded.sender, subject = excluded.subject, kind = excluded.kind, until_at = excluded.until_at,
       event_key = excluded.event_key, event_title = excluded.event_title, event_start = excluded.event_start, person = excluded.person, person_name = excluded.person_name,
       label = excluded.label, state = 'snoozed', back_at = NULL, reason = NULL, created_at = excluded.created_at`,
  ).run(mail.id, mail.sourceId, mail.from.address.toLowerCase(), mail.subject.slice(0, 300), resolved.kind, resolved.untilAt, resolved.eventKey, resolved.eventTitle, resolved.eventStart, resolved.person, resolved.personName, resolved.label, now);
}

const HIDDEN: Resolved = { kind: "hidden", untilAt: null, eventKey: null, eventTitle: null, eventStart: null, person: null, personName: null, label: "hidden" };

/** Hides one mail from the Desk until the principal undoes it: a snooze that never wakes. The mailbox is not touched; hiding a hidden mail changes nothing. */
export function hideMail(db: Database, mail: ListedMail, now: number): { ok: true; message: string } {
  const message = `Hid ${quoted(mail.subject)} from the Desk. It stays in your mailbox as it is.`;
  const row = readSnooze(db, mail.id);
  if (row?.kind === "hidden" && row.state === "snoozed") return { ok: true, message };
  const features = mailFeatures(db, mail);
  upsertSnooze(db, mail, HIDDEN, now);
  logMailDecision(db, features, "ignored", "desk", now);
  return { ok: true, message };
}

/** Shows a hidden mail again, without a reason line. A real snooze is refused: it ends through its own door. */
export function unhideMail(db: Database, messageId: string): { ok: true; message: string } | SnoozeFailure {
  const row = readSnooze(db, messageId);
  if (row?.kind !== "hidden" || row.state !== "snoozed") return refuse(409, "This mail is not hidden.");
  db.query("DELETE FROM desk_mail_snoozes WHERE message_id = ? AND kind = 'hidden'").run(messageId);
  return { ok: true, message: `${quoted(row.subject)} is back on the Desk.` };
}

export interface HiddenMail {
  key: string;
  subject: string;
  sender: string;
  at: number;
}

/** Every hidden mail, so a UI can offer Show again after the response is gone. */
export const hiddenMail = (db: Database): HiddenMail[] =>
  readSnoozes(db, "snoozed").filter((r) => r.kind === "hidden").map((r) => ({ key: `mail:${r.messageId}`, subject: r.subject, sender: r.sender, at: r.createdAt }));

/** Ends a snooze now: the mail is back on the Desk as it was, without a reason line. */
export function cancelSnooze(db: Database, messageId: string): { ok: true; message: string } | SnoozeFailure {
  const row = readSnooze(db, messageId);
  if (!row) return refuse(409, "This mail is not snoozed.");
  db.query("DELETE FROM desk_mail_snoozes WHERE message_id = ?").run(messageId);
  return { ok: true, message: `${quoted(row.subject)} is back on the Desk.` };
}
