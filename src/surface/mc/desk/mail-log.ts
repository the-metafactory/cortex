import type { Database } from "bun:sqlite";
import { readClassifications } from "./classify";
import { ago } from "./rank";
import type { SourceMail, SourceReading } from "./sources/command";
import { DAY_MS } from "./time";
import { DEFAULT_MAIL_LOG_RETENTION_DAYS, MAIL_LOG_ACTIONS, MAIL_LOG_WHERE, type MailLogAction, type MailLogWhere } from "./mail-log-schema";

export { DEFAULT_MAIL_LOG_RETENTION_DAYS, MAIL_LOG_ACTIONS, MAIL_LOG_WHERE, type MailLogAction, type MailLogWhere } from "./mail-log-schema";

const MAX_SUMMARY = 600;
const MAX_SUBJECT = 300;

/** What the log keeps about a mail: its features and a short summary, never the body. */
export interface MailFeatures {
  messageId: string;
  account: string | null;
  sourceId: string | null;
  sender: string;
  senderDomain: string;
  listId: string | null;
  category: string | null;
  subject: string | null;
  summary: string | null;
}

export interface MailLogEntry extends MailFeatures {
  id: number;
  action: MailLogAction;
  where: MailLogWhere;
  folder: string | null;
  at: number;
}

interface Row {
  id: number;
  message_id: string;
  account: string | null;
  source_id: string | null;
  sender: string;
  sender_domain: string;
  list_id: string | null;
  category: string | null;
  subject: string | null;
  summary: string | null;
  action: MailLogAction;
  origin: MailLogWhere;
  folder: string | null;
  created_at: number;
}

const COLUMNS = "id, message_id, account, source_id, sender, sender_domain, list_id, category, subject, summary, action, origin, folder, created_at";

const entry = (r: Row): MailLogEntry => ({
  id: r.id,
  messageId: r.message_id,
  account: r.account,
  sourceId: r.source_id,
  sender: r.sender,
  senderDomain: r.sender_domain,
  listId: r.list_id,
  category: r.category,
  subject: r.subject,
  summary: r.summary,
  action: r.action,
  where: r.origin,
  folder: r.folder,
  at: r.created_at,
});

const capped = (text: string | undefined | null, max: number): string | null => {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const senderDomain = (address: string): string => {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at >= 0 ? a.slice(at + 1) : "";
};

/** The features of one listed mail, with the classifier's category and summary when it has sorted the mail. */
export function mailFeatures(db: Database, mail: SourceMail & { sourceId?: string }): MailFeatures {
  const sorted = readClassifications(db, [mail.id]).get(mail.id);
  return {
    messageId: mail.id,
    account: mail.account ?? null,
    sourceId: mail.sourceId ?? null,
    sender: mail.from.address.trim().toLowerCase(),
    senderDomain: senderDomain(mail.from.address),
    listId: mail.headers?.listId ?? null,
    category: sorted?.category ?? null,
    subject: capped(mail.subject, MAX_SUBJECT),
    summary: capped(sorted?.summary ?? mail.firstParagraph, MAX_SUMMARY),
  };
}

/** The newest decision on one message, or null. */
export function lastMailDecision(db: Database, messageId: string): MailLogEntry | null {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM desk_mail_log WHERE message_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(messageId);
  return row ? entry(row) : null;
}

/** The features the log last recorded for a message, for a decision on a mail the Desk no longer lists (Undo). */
export function loggedFeatures(db: Database, messageId: string): MailFeatures | null {
  const e = lastMailDecision(db, messageId);
  if (!e) return null;
  return { messageId: e.messageId, account: e.account, sourceId: e.sourceId, sender: e.sender, senderDomain: e.senderDomain, listId: e.listId, category: e.category, subject: e.subject, summary: e.summary };
}

/** Appends one decision. Callers write it only after the action it records has succeeded. */
export function logMailDecision(db: Database, features: MailFeatures, action: MailLogAction, where: MailLogWhere, at: number, folder: string | null = null): number {
  if (!MAIL_LOG_ACTIONS.includes(action) || !MAIL_LOG_WHERE.includes(where)) throw new Error(`The mail log has no action "${action}" in "${where}".`);
  const result = db
    .query("INSERT INTO desk_mail_log (message_id, account, source_id, sender, sender_domain, list_id, category, subject, summary, action, origin, folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(features.messageId, features.account, features.sourceId, features.sender, features.senderDomain, features.listId, features.category, features.subject, features.summary, action, where, capped(folder, 200), at);
  return Number(result.lastInsertRowid);
}

const lowered = (v: string | undefined): string | undefined => {
  const t = v?.trim().toLowerCase();
  if (!t) return undefined;
  return t;
};

export interface MailLogQuery {
  since?: number;
  sender?: string;
  senderDomain?: string;
  listId?: string;
  actions?: readonly MailLogAction[];
  where?: MailLogWhere;
  limit?: number;
}

/** Decisions newest first, filtered by time, sender, domain, List-Id, action or where they happened. */
export function queryMailLog(db: Database, q: MailLogQuery = {}): MailLogEntry[] {
  const filters: [string, string | number | undefined][] = [
    ["created_at >= ?", q.since],
    ["sender = ?", lowered(q.sender)],
    ["sender_domain = ?", lowered(q.senderDomain)],
    ["list_id = ?", q.listId === "" ? undefined : q.listId],
    ["action IN (SELECT value FROM json_each(?))", q.actions?.length ? JSON.stringify(q.actions) : undefined],
    ["origin = ?", q.where],
  ];
  const active = filters.filter((f): f is [string, string | number] => f[1] !== undefined);
  const where = active.map(([clause]) => clause);
  const args = active.map(([, value]) => value);
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? 500)), 5000);
  const sql = `SELECT ${COLUMNS} FROM desk_mail_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return db.query<Row, (string | number)[]>(sql).all(...args).map(entry);
}

/** Each message's decisions, oldest first. */
export function mailLogFor(db: Database, messageIds: string[]): Map<string, MailLogEntry[]> {
  const out = new Map<string, MailLogEntry[]>();
  if (messageIds.length === 0) return out;
  const rows = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM desk_mail_log WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`).all(JSON.stringify(messageIds));
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), entry(r)]);
  return out;
}

/** Deletes every decision older than the retention, so no summary or sender outlives it. Returns how many went. */
export function purgeMailLog(db: Database, now: number, retentionDays: number = DEFAULT_MAIL_LOG_RETENTION_DAYS): number {
  return db.query("DELETE FROM desk_mail_log WHERE created_at < ?").run(now - retentionDays * DAY_MS).changes;
}

const FOLDER_NAMES: Partial<Record<MailLogAction, string>> = { archive: "Archive", junk: "Junk", trash: "Trash" };

/** One plain sentence for the detail panel's history. */
export function historySentence(e: MailLogEntry, now: number): string {
  const when = ago(now, e.at);
  const folder = e.folder ?? FOLDER_NAMES[e.action] ?? "";
  if (e.where === "client") {
    switch (e.action) {
      case "kept":
        return `You read it in your mail client and kept it in the inbox (${when}).`;
      case "gone":
        return `It left the inbox outside the Desk, and the Desk could not find where it went (${when}).`;
      case "archive":
      case "junk":
      case "trash":
        return `You moved it to ${folder} in your mail client (${when}).`;
      default:
        return `Your mail client recorded “${e.action}” for it (${when}).`;
    }
  }
  switch (e.action) {
    case "archive":
      return `You archived it on the Desk (${when}).`;
    case "junk":
      return `You moved it to Junk on the Desk (${when}).`;
    case "trash":
      return `You deleted it on the Desk (${when}).`;
    case "restore":
      return `You undid the move on the Desk and it went back to the inbox (${when}).`;
    case "unimportant":
      return `You marked its sender unimportant on the Desk (${when}).`;
    case "draft":
      return `You saved a reply draft on the Desk (${when}).`;
    case "todo":
      return `You made it a to-do on the Desk (${when}).`;
    case "plan":
      return `You planned it on the Desk (${when}).`;
    case "snooze":
      return `You snoozed it on the Desk (${when}).`;
    case "opened":
      return `You opened it from the Desk (${when}).`;
    case "ignored":
      return `You let it pass on the Desk (${when}).`;
    default:
      return `The Desk recorded “${e.action}” for it (${when}).`;
  }
}

export interface Departure {
  mail: SourceMail;
  sourceId: string;
  read: boolean;
}

/**
 * The unread mails of the previous reading that the next reading lists as read, or no longer lists. A failed reading
 * carries the last good list: as `next` it yields nothing, as `prev` it is diffed like the list it carries.
 */
export function departures(prev: SourceReading | undefined, next: SourceReading): Departure[] {
  if (!prev || next.error !== null) return [];
  const now = new Map(next.mail.map((m) => [m.id, m]));
  return prev.mail.flatMap((m): Departure[] => {
    if (!m.unread) return [];
    const later = now.get(m.id);
    if (!later) return [{ mail: m, sourceId: next.id, read: false }];
    return later.unread ? [] : [{ mail: later, sourceId: next.id, read: true }];
  });
}
