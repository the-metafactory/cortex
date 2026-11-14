import type { Database } from "bun:sqlite";
import { findNode, type OutlineNode } from "../../../balance";
import { sightEvent, type EventFacts } from "./event-follow";
import type { ListedMail } from "./mail-actions";
import { loggedFeatures, logMailDecision, mailFeatures } from "./mail-log";
import { snoozedIds, type SnoozeBack } from "./mail-snooze";
import { snoozeWhen } from "./mail-snooze-schema";
import { DAY_MS } from "./time";
import type { LinkReceipt, DeskLinkView, LinkFromKind, LinkOrigin, LinkRow, LinkState, LinkToKind, MailSnapshot } from "./links-schema";

export { LINKS_SQL, type LinkReceipt, type DeskLinkView, type LinkRow, type MailSnapshot } from "./links-schema";

interface Raw {
  id: string;
  request_id: string;
  from_kind: LinkFromKind;
  from_key: string;
  from_title: string;
  from_detail: string | null;
  to_kind: LinkToKind;
  to_key: string;
  to_title: string;
  to_at: number | null;
  to_end: number | null;
  origin: LinkOrigin;
  rule_run: string | null;
  state: LinkState;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

const snapshotOf = (detail: string | null): MailSnapshot | null => (detail ? (JSON.parse(detail) as MailSnapshot) : null);

const rowOf = (r: Raw): LinkRow => ({
  id: r.id, requestId: r.request_id, fromKind: r.from_kind, fromKey: r.from_key, fromTitle: r.from_title, mail: snapshotOf(r.from_detail),
  toKind: r.to_kind, toKey: r.to_key, toTitle: r.to_title, toAt: r.to_at, toEnd: r.to_end, origin: r.origin, ruleRun: r.rule_run,
  state: r.state, reason: r.reason, createdAt: r.created_at, updatedAt: r.updated_at,
});

type Param = string | number;

const rows = (db: Database, where: string, ...params: Param[]): LinkRow[] =>
  db.query<Raw, Param[]>(`SELECT * FROM desk_links WHERE ${where} ORDER BY created_at`).all(...params).map(rowOf);

const one = (db: Database, where: string, ...params: Param[]): LinkRow | null => rows(db, where, ...params)[0] ?? null;

export const readLink = (db: Database, id: string): LinkRow | null => one(db, "id = ?", id);

const mailKey = (messageId: string): string => `mail:${messageId}`;
const messageIdOf = (key: string): string => key.slice("mail:".length);
const taskKey = (id: string): string => `task:${id}`;
const taskIdOf = (key: string): string => key.slice("task:".length);

/** The one active link a mail has, or null. */
export const activeMailLink = (db: Database, messageId: string): LinkRow | null => one(db, "from_kind = 'mail' AND from_key = ? AND state = 'linked'", mailKey(messageId));

/** The link a rule run wrote, or null. */
export const linkByRun = (db: Database, runId: string): LinkRow | null => one(db, "rule_run = ?", runId);

/** Where the principal's own attach of a mail went, as of a logged decision: the newest Desk link from that mail made by then. */
export function linkTargetOf(db: Database, messageId: string, at: number): LinkTarget | null {
  const row = rows(db, "from_kind = 'mail' AND from_key = ? AND origin = 'desk' AND created_at <= ?", mailKey(messageId), at).at(-1);
  return row ? { kind: row.toKind, key: row.toKey, title: row.toTitle } : null;
}

export const linkOf = (row: LinkRow): LinkReceipt => ({
  id: row.id,
  from: { kind: row.fromKind, key: row.fromKey, title: row.fromTitle },
  to: { kind: row.toKind, key: row.toKey, title: row.toTitle, ...(row.toAt !== null ? { at: row.toAt } : {}), ...(row.toEnd !== null ? { end: row.toEnd } : {}) },
  origin: row.origin,
  at: row.createdAt,
});

const viewOf = (row: LinkRow): DeskLinkView => ({ ...linkOf(row), mail: row.mail });

export interface OutlineDay {
  outline: OutlineNode;
  inbox: readonly OutlineNode[];
}

const nodeIn = (day: OutlineDay, id: string): OutlineNode | null => {
  if (id === day.outline.id) return null;
  return findNode(day.outline, id) ?? day.inbox.map((n) => findNode(n, id)).find((n) => n !== null) ?? null;
};

/** Every active link to or from a task the day still has, for My day. */
export function taskLinks(db: Database, day: OutlineDay): DeskLinkView[] {
  const kept = (r: LinkRow): boolean => (r.toKind !== "task" || nodeIn(day, r.toKey) !== null) && (r.fromKind !== "task" || nodeIn(day, taskIdOf(r.fromKey)) !== null);
  return rows(db, "state = 'linked' AND (to_kind = 'task' OR from_kind = 'task')").filter(kept).map(viewOf);
}

export interface EventLink {
  id: string;
  kind: LinkFromKind;
  key: string;
  title: string;
  origin: LinkOrigin;
}

const MEETING_LINKED = "state = 'linked' AND to_kind = 'meeting' AND (to_end IS NULL OR to_end >= ?)";

/** The active links to each meeting that ends at or after `since`, by Desk event key. */
export function meetingLinks(db: Database, since: number): Map<string, EventLink[]> {
  const out = new Map<string, EventLink[]>();
  for (const r of rows(db, MEETING_LINKED, since)) out.set(r.toKey, [...(out.get(r.toKey) ?? []), { id: r.id, kind: r.fromKind, key: r.fromKey, title: r.fromTitle, origin: r.origin }]);
  return out;
}

/** Message ids whose mail is attached somewhere. */
export function linkedMailIds(db: Database): Set<string> {
  return new Set(rows(db, "from_kind = 'mail' AND state = 'linked'").map((r) => messageIdOf(r.fromKey)));
}

/** Mail that is off the Desk without leaving the mailbox: snoozed, hidden or attached. */
export function offDeskIds(db: Database): Set<string> {
  return new Set([...snoozedIds(db), ...linkedMailIds(db)]);
}

export interface LinkTarget {
  kind: LinkToKind;
  key: string;
  title: string;
  at?: number;
  end?: number;
}

export interface LinkSubject {
  kind: LinkFromKind;
  key: string;
  title: string;
  mail: MailSnapshot | null;
}

/** A task a mail may be attached to: it is in the synced outline or the Balance inbox, and it is not done. */
export function taskTarget(day: OutlineDay, id: string): LinkTarget | null {
  const target = taskTargetOrWhy(day, id);
  return typeof target === "string" ? null : target;
}

/** A task as a link target, or why it cannot take mail: "is done" or "is gone". */
export function taskTargetOrWhy(day: OutlineDay, id: string): LinkTarget | "is done" | "is gone" {
  const node = nodeIn(day, id);
  if (!node) return "is gone";
  return node.done ? "is done" : { kind: "task", key: node.id, title: node.title };
}

/** A task that may be linked to a meeting: it only has to exist in the synced outline or the Balance inbox. */
export function taskSubject(day: OutlineDay, id: string): LinkSubject | null {
  const node = nodeIn(day, id);
  return node ? { kind: "task", key: taskKey(node.id), title: node.title, mail: null } : null;
}

export const NO_MEETING = "The Desk no longer sees that meeting. Pick another one.";

/** A meeting the readings list, as a link target. A mail may only go to a meeting that has not ended. */
export function meetingTarget(events: EventFacts["events"], key: string, when: { upcoming: boolean; now: number }): LinkTarget | string {
  const event = events.get(key);
  if (!event) return NO_MEETING;
  if (when.upcoming && event.end <= when.now) return "That meeting is already over.";
  return { kind: "meeting", key, title: event.title, at: event.at, end: event.end };
}

const quoted = (title: string): string => `“${title}”`;

interface LinkFailure { ok: false; status: number; error: string }
const refuse = (status: number, error: string): LinkFailure => ({ ok: false, status, error });

/** Refuses a second attachment: a mail has at most one active link. A retry of the request that made the link is not refused. */
export function attachRefusal(db: Database, messageId: string, requestId: string): LinkFailure | null {
  const active = activeMailLink(db, messageId);
  return active && active.requestId !== requestId ? refuse(409, `This mail is already attached to ${quoted(active.toTitle)}. Undo that first.`) : null;
}

const snapshot = (mail: ListedMail): MailSnapshot => ({ sender: mail.from.address.toLowerCase(), senderName: mail.from.name ?? null, receivedAt: mail.receivedAt, url: mail.url ?? null, account: mail.account ?? null });

export const mailSubject = (mail: ListedMail): LinkSubject => ({ kind: "mail", key: mailKey(mail.id), title: mail.subject.slice(0, 300), mail: snapshot(mail) });

interface LinkInput {
  id: string;
  requestId: string;
  origin: LinkOrigin;
  ruleRun?: string;
  now: number;
}

function insertLink(db: Database, from: LinkSubject, to: LinkTarget, input: LinkInput): boolean {
  return db.query(
    `INSERT INTO desk_links (id, request_id, from_kind, from_key, from_title, from_detail, to_kind, to_key, to_title, to_at, to_end, origin, rule_run, state, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', NULL, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(input.id, input.requestId, from.kind, from.key, from.title, from.mail ? JSON.stringify(from.mail) : null, to.kind, to.key, to.title, to.at ?? null, to.end ?? null, input.origin, input.ruleRun ?? null, input.now, input.now).changes > 0;
}

const linkedMessage = (row: LinkRow, now: number): string =>
  row.toKind === "meeting" && row.toAt !== null
    ? `Linked ${quoted(row.fromTitle)} to ${quoted(row.toTitle)} ${snoozeWhen(row.toAt, now)}.`
    : `Attached ${quoted(row.fromTitle)} to ${quoted(row.toTitle)}.`;

export type LinkResult = { ok: true; message: string; link: LinkReceipt } | LinkFailure;

const REUSED_REQUEST = "That request id was already used for another link.";

const replayOf = (db: Database, requestId: string, fromKey: string, now: number): LinkResult | null => {
  const replayed = one(db, "request_id = ?", requestId);
  if (!replayed) return null;
  return replayed.fromKey === fromKey ? { ok: true, message: linkedMessage(replayed, now), link: linkOf(replayed) } : refuse(409, REUSED_REQUEST);
};

/** Attaches a mail to a task or a meeting: one link row, a mail log entry, and the card leaves the Desk. A replay of the same request returns the same link; a string target is the reason the target cannot be used. */
export function attachMail(db: Database, mail: ListedMail, target: LinkTarget | string, input: LinkInput): LinkResult {
  const subject = mailSubject(mail);
  const replayed = replayOf(db, input.requestId, subject.key, input.now);
  if (replayed) return replayed;
  const refused = attachRefusal(db, mail.id, input.requestId);
  if (refused) return refused;
  if (typeof target === "string") return refuse(409, target);
  const features = mailFeatures(db, mail);
  db.transaction(() => {
    if (insertLink(db, subject, target, input)) logMailDecision(db, features, "attach", input.origin, input.now, target.title);
  })();
  return receiptOf(db, input, () => attachRefusal(db, mail.id, input.requestId) ?? refuse(409, "The Desk could not record the link."));
}

const receiptOf = (db: Database, input: LinkInput, missing: () => LinkFailure): LinkResult => {
  const row = one(db, "request_id = ?", input.requestId);
  return row ? { ok: true, message: linkedMessage(row, input.now), link: linkOf(row) } : missing();
};

/** Links a task, thread or note to a meeting. A replay returns the same link; the same pair is linked once. */
export function linkToMeeting(db: Database, subject: LinkSubject, target: LinkTarget, input: LinkInput): LinkResult {
  const replayed = replayOf(db, input.requestId, subject.key, input.now);
  if (replayed) return replayed;
  const alreadyLinked = refuse(409, `This is already linked to ${quoted(target.title)}.`);
  if (one(db, "state = 'linked' AND from_kind = ? AND from_key = ? AND to_kind = ? AND to_key = ?", subject.kind, subject.key, target.kind, target.key)) return alreadyLinked;
  insertLink(db, subject, target, input);
  return receiptOf(db, input, () => alreadyLinked);
}

/** Records that Add to thread filed a mail in a Studio thread, so the card leaves the Desk like any attach. The link id is the capture id. A mail attached elsewhere in the meantime keeps that link, and the capture stays undoable under Done for you. */
export function linkStudioMail(db: Database, mail: ListedMail, target: LinkTarget, input: LinkInput): boolean {
  return insertLink(db, mailSubject(mail), target, input);
}

/** Ends an active link. Returns whether a row changed. */
export function endLink(db: Database, id: string, state: Exclude<LinkState, "linked">, reason: string | null, now: number): boolean {
  return db.query("UPDATE desk_links SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = 'linked'").run(state, reason, now, id).changes > 0;
}

export interface UndoAttachDeps {
  now: number;
  listed: (key: string) => boolean;
  undoCapture?: (captureId: string) => Promise<{ ok: true } | LinkFailure>;
}

export type UndoAttachResult = { ok: true; message: string; restored?: string } | LinkFailure;

/** Undoes an attach or a link: the link ends, a restore is logged for a mail, and the mail is back on the Desk while it is still listed. A thread link also removes the capture from its thread. */
export async function undoAttach(db: Database, id: string, deps: UndoAttachDeps): Promise<UndoAttachResult> {
  const row = readLink(db, id);
  if (!row) return refuse(404, "The Desk has no record of that link.");
  if (row.state === "lost") return refuse(409, `That link already ended: ${row.reason ?? "its target is gone"}.`);
  if (row.state !== "linked") return refuse(409, "That is already undone.");
  if (row.toKind === "thread") {
    if (!deps.undoCapture) return refuse(409, "The Studio is not set up on this stack.");
    const removed = await deps.undoCapture(row.id);
    if (!removed.ok) return removed;
  }
  endLink(db, row.id, "undone", null, deps.now);
  if (row.fromKind !== "mail") return { ok: true, message: `${quoted(row.fromTitle)} is no longer linked to ${quoted(row.toTitle)}.` };
  const features = loggedFeatures(db, messageIdOf(row.fromKey));
  if (features) logMailDecision(db, features, "restore", "desk", deps.now);
  if (!deps.listed(row.fromKey)) return { ok: true, message: `The link to ${quoted(row.toTitle)} is gone. ${quoted(row.fromTitle)} is no longer in your inbox, so nothing returns.` };
  return { ok: true, message: `${quoted(row.fromTitle)} is back on the Desk.`, restored: row.fromKey };
}

/** Marks every active link to or from a task the outline no longer has as lost: a mail attached to it comes back with the reason, and a meeting stops listing it. */
export function loseTaskLinks(db: Database, day: OutlineDay, now: number): void {
  const toGone = rows(db, "state = 'linked' AND to_kind = 'task'").filter((row) => !nodeIn(day, row.toKey));
  const fromGone = rows(db, "state = 'linked' AND from_kind = 'task'").filter((row) => !nodeIn(day, taskIdOf(row.fromKey)));
  db.transaction(() => {
    for (const row of toGone) endLink(db, row.id, "lost", `${quoted(row.toTitle)} was removed`, now);
    for (const row of fromGone) endLink(db, row.id, "lost", `${quoted(row.fromTitle)} was removed`, now);
  })();
}

/** Follows each linked meeting by its key until a day after it ended: a moved or renamed meeting updates the link, a cancelled one marks it lost so a linked mail comes back. A meeting that ended keeps its links. */
export function followMeetingLinks(db: Database, facts: EventFacts, now: number): void {
  const linked = rows(db, MEETING_LINKED, now - DAY_MS);
  db.transaction(() => {
    for (const row of linked) {
      const sighting = sightEvent(facts, row.toKey, { title: row.toTitle, at: row.toAt, end: row.toEnd });
      if (sighting.kind === "seen" && sighting.moved) {
        db.query("UPDATE desk_links SET to_title = ?, to_at = ?, to_end = ?, updated_at = ? WHERE id = ?").run(sighting.event.title, sighting.event.at, sighting.event.end, now, row.id);
      } else if (sighting.kind === "cancelled") endLink(db, row.id, "lost", `${quoted(row.toTitle)} was cancelled`, now);
    }
  })();
}

/** Mail whose link was lost within the last day leads its card with why it is back. */
export function backLinks(db: Database, now: number): Map<string, SnoozeBack> {
  return new Map(rows(db, "state = 'lost' AND from_kind = 'mail' AND updated_at > ?", now - DAY_MS).map((r): [string, SnoozeBack] => [messageIdOf(r.fromKey), { line: `Back because ${r.reason ?? "its link ended"}.`, at: r.updatedAt }]));
}
