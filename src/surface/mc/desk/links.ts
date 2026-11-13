import type { Database } from "bun:sqlite";
import { findNode, type OutlineNode } from "../../../balance";
import type { ListedMail } from "./mail-actions";
import { loggedFeatures, logMailDecision, mailFeatures } from "./mail-log";
import { snoozedIds, type SnoozeBack } from "./mail-snooze";
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

const one = (db: Database, where: string, value: string): LinkRow | null => {
  const r = db.query<Raw, [string]>(`SELECT * FROM desk_links WHERE ${where} = ?`).get(value);
  return r ? rowOf(r) : null;
};

export const readLink = (db: Database, id: string): LinkRow | null => one(db, "id", id);

const mailKey = (messageId: string): string => `mail:${messageId}`;
const messageIdOf = (key: string): string => key.slice("mail:".length);

/** The one active link a mail has, or null. */
export function activeMailLink(db: Database, messageId: string): LinkRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM desk_links WHERE from_kind = 'mail' AND from_key = ? AND state = 'linked'").get(mailKey(messageId));
  return r ? rowOf(r) : null;
}

export const linkOf = (row: LinkRow): LinkReceipt => ({
  id: row.id,
  from: { kind: row.fromKind, key: row.fromKey, title: row.fromTitle },
  to: { kind: row.toKind, key: row.toKey, title: row.toTitle },
  origin: row.origin,
  at: row.createdAt,
});

const viewOf = (row: LinkRow): DeskLinkView => ({ ...linkOf(row), mail: row.mail });

/** Every active link to or from a task the day still has, for My day. */
export function taskLinks(db: Database, day: OutlineDay): DeskLinkView[] {
  const kept = (r: LinkRow): boolean => r.toKind !== "task" || nodeIn(day, r.toKey) !== null;
  return db.query<Raw, []>("SELECT * FROM desk_links WHERE state = 'linked' AND (to_kind = 'task' OR from_kind = 'task') ORDER BY created_at").all().map(rowOf).filter(kept).map(viewOf);
}

/** Message ids whose mail is attached somewhere. */
export function linkedMailIds(db: Database): Set<string> {
  return new Set(db.query<{ from_key: string }, []>("SELECT from_key FROM desk_links WHERE from_kind = 'mail' AND state = 'linked'").all().map((r) => messageIdOf(r.from_key)));
}

/** Mail that is off the Desk without leaving the mailbox: snoozed, hidden or attached. */
export function offDeskIds(db: Database): Set<string> {
  return new Set([...snoozedIds(db), ...linkedMailIds(db)]);
}

export interface LinkTarget {
  kind: "task" | "thread";
  key: string;
  title: string;
}

export interface OutlineDay {
  outline: OutlineNode;
  inbox: readonly OutlineNode[];
}

const nodeIn = (day: OutlineDay, id: string): OutlineNode | null => {
  if (id === day.outline.id) return null;
  return findNode(day.outline, id) ?? day.inbox.map((n) => findNode(n, id)).find((n) => n !== null) ?? null;
};

/** A task a mail may be attached to: it is in the synced outline or the Balance inbox, and it is not done. */
export function taskTarget(day: OutlineDay, id: string): LinkTarget | null {
  const node = nodeIn(day, id);
  return node && !node.done ? { kind: "task", key: node.id, title: node.title } : null;
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

interface LinkInput {
  id: string;
  requestId: string;
  origin: LinkOrigin;
  ruleRun?: string;
  now: number;
}

function insertMailLink(db: Database, mail: ListedMail, target: LinkTarget, input: LinkInput): boolean {
  return db.query(
    `INSERT INTO desk_links (id, request_id, from_kind, from_key, from_title, from_detail, to_kind, to_key, to_title, to_at, to_end, origin, rule_run, state, reason, created_at, updated_at)
     VALUES (?, ?, 'mail', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'linked', NULL, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(input.id, input.requestId, mailKey(mail.id), mail.subject.slice(0, 300), JSON.stringify(snapshot(mail)), target.kind, target.key, target.title, input.origin, input.ruleRun ?? null, input.now, input.now).changes > 0;
}

export type AttachResult = { ok: true; message: string; link: LinkReceipt } | LinkFailure;

/** Attaches a mail to a task as material: one link row, a mail log entry, and the card leaves the Desk. A replay of the same request returns the same link; a null target is a task that is gone or done. */
export function attachMail(db: Database, mail: ListedMail, target: LinkTarget | null, input: LinkInput): AttachResult {
  const replayed = one(db, "request_id", input.requestId);
  if (replayed) return { ok: true, message: `Attached ${quoted(replayed.fromTitle)} to ${quoted(replayed.toTitle)}.`, link: linkOf(replayed) };
  const refused = attachRefusal(db, mail.id, input.requestId);
  if (refused) return refused;
  if (!target) return refuse(409, "That task no longer exists or is done. Pick another one.");
  const features = mailFeatures(db, mail);
  db.transaction(() => {
    if (insertMailLink(db, mail, target, input)) logMailDecision(db, features, "attach", input.origin, input.now, target.title);
  })();
  const row = one(db, "request_id", input.requestId);
  if (!row) return attachRefusal(db, mail.id, input.requestId) ?? refuse(409, "The Desk could not record the link.");
  return { ok: true, message: `Attached ${quoted(mail.subject)} to ${quoted(target.title)}.`, link: linkOf(row) };
}

/** Records that Add to thread filed a mail in a Studio thread, so the card leaves the Desk like any attach. The link id is the capture id. A mail attached elsewhere in the meantime keeps that link, and the capture stays undoable under Done for you. */
export function linkStudioMail(db: Database, mail: ListedMail, target: LinkTarget, input: LinkInput): boolean {
  return insertMailLink(db, mail, target, input);
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

/** Undoes an attach: the link ends, a restore is logged, and the mail is back on the Desk while it is still listed. A thread link also removes the capture from its thread. */
export async function undoAttach(db: Database, id: string, deps: UndoAttachDeps): Promise<UndoAttachResult> {
  const row = readLink(db, id);
  if (!row) return refuse(404, "The Desk has no record of that link.");
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

/** Marks every active mail link to a task the outline no longer has as lost, so the mail comes back with the reason. */
export function loseTaskLinks(db: Database, day: OutlineDay, now: number): void {
  const rows = db.query<Raw, []>("SELECT * FROM desk_links WHERE state = 'linked' AND to_kind = 'task'").all().map(rowOf);
  db.transaction(() => {
    for (const row of rows) if (!nodeIn(day, row.toKey)) endLink(db, row.id, "lost", `${quoted(row.toTitle)} was removed`, now);
  })();
}

/** Mail whose link was lost within the last day leads its card with why it is back. */
export function backLinks(db: Database, now: number): Map<string, SnoozeBack> {
  const rows = db.query<Raw, [number]>("SELECT * FROM desk_links WHERE state = 'lost' AND from_kind = 'mail' AND updated_at > ?").all(now - DAY_MS).map(rowOf);
  return new Map(rows.map((r): [string, SnoozeBack] => [messageIdOf(r.fromKey), { line: `Back because ${r.reason ?? "its link ended"}.`, at: r.updatedAt }]));
}
