import type { Database } from "bun:sqlite";
import type { ListedMail } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import { refuse } from "./mail-move";
import { SENDER_WIDE_CODES, senderKey, type SuspicionCode, type SuspicionReason } from "./mail-suspicion";

export const TRUST_DONE = "mail.trust";

const CODE_WORDS: Record<SuspicionCode, string> = {
  dmarc: "a failed DMARC check",
  spf: "a failed SPF check",
  dkim: "a DKIM problem",
  "reply-to": "replies going to another domain",
  "display-name": "a sender name that does not match the address",
  link: "links that lead elsewhere than they show",
  classifier: "the classifier's phishing verdict",
};

const words = (codes: readonly SuspicionCode[]): string => {
  const list = codes.map((c) => CODE_WORDS[c]);
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1) ?? ""}`;
};

export interface TrustedOneMail {
  codes: SuspicionCode[];
  subject: string | null;
}

export interface TrustedView {
  sender: string;
  codes: SuspicionCode[];
  mails: TrustedOneMail[];
  at: number;
  sentence: string;
}

export type TrustResult = { ok: true; message: string; undo?: string; restored?: string; trusted?: TrustedView[] } | { ok: false; status: number; error: string };

const sentenceOf = (v: Omit<TrustedView, "sentence">): string => {
  const one = v.mails[0];
  const mails = v.mails.length > 1 ? `${v.mails.length} single mails are not flagged for their own reasons.` : one ? `One mail (“${one.subject ?? "no subject"}”) is not flagged for ${words(one.codes)}.` : "";
  return [...(v.codes.length > 0 ? [`Not flagged for ${words(v.codes)}.`] : []), ...(mails ? [mails] : [])].join(" ");
};

/**
 * "Not phishing" on a flagged mail. Reply-To, display-name and link reasons are remembered for that exact sender address;
 * authentication and classifier reasons only for this one mail, so mail from the same address that fails its checks
 * is still flagged. Logs `not-phishing` in the mail log and lists the dismissal in Done for you with Undo.
 */
export function dismissSuspicion(db: Database, mail: ListedMail, reasons: readonly SuspicionReason[], now: number, newId: () => string = () => crypto.randomUUID()): TrustResult {
  if (reasons.length === 0) return refuse(409, "This mail is not flagged as possible phishing.");
  const sender = senderKey(mail.from.address);
  const id = newId();
  const features = mailFeatures(db, mail);
  const codes = [...new Set(reasons.map((r) => r.code))];
  const wide = codes.filter((c) => SENDER_WIDE_CODES.has(c));
  const single = codes.filter((c) => !SENDER_WIDE_CODES.has(c));
  db.transaction(() => {
    const logId = logMailDecision(db, features, "not-phishing", "desk", now);
    const insert = db.query("INSERT OR IGNORE INTO desk_mail_trusted (dismissal, sender, code, message_id, subject, log_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const c of codes) insert.run(id, sender, c, SENDER_WIDE_CODES.has(c) ? "" : mail.id, mail.subject.slice(0, 300), logId, now);
    const parts = [...(wide.length > 0 ? [`Mail from ${sender} is no longer flagged for ${words(wide)}.`] : []), ...(single.length > 0 ? [`This mail is no longer flagged for ${words(single)}; other mail from ${sender} still is.`] : [])];
    db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?)")
      .run(`mail-trust:${id}`, TRUST_DONE, id, `Not phishing: “${mail.subject}”`, parts.join(" "), now, now);
  })();
  const message = wide.length > 0 ? `Not phishing: mail from ${sender} is no longer flagged for ${words(wide)}.` : "Not phishing: this mail is no longer flagged.";
  return { ok: true, message, undo: id };
}

/** Undo of one "Not phishing": the mail is flagged again, and its `not-phishing` log line is withdrawn. */
export function undoDismissal(db: Database, id: string, now: number): TrustResult {
  const done = db.query<{ action: string }, [string]>("SELECT action FROM desk_done WHERE attempt_key = ?").get(`mail-trust:${id}`);
  if (!done) return refuse(404, "The Desk has no record of that dismissal.");
  if (done.action !== TRUST_DONE) return refuse(409, "That dismissal is already undone.");
  const rows = db.query<{ message_id: string; log_id: number | null }, [string]>("SELECT message_id, log_id FROM desk_mail_trusted WHERE dismissal = ?").all(id);
  const logIds = [...new Set(rows.flatMap((r) => (r.log_id === null ? [] : [r.log_id])))];
  db.transaction(() => {
    db.query("DELETE FROM desk_mail_trusted WHERE dismissal = ?").run(id);
    for (const logId of logIds) db.query("DELETE FROM desk_mail_log WHERE id = ? AND action = 'not-phishing'").run(logId);
    db.query("UPDATE desk_done SET action = ?, message = ?, updated_at = ? WHERE attempt_key = ?").run(`${TRUST_DONE}.undone`, "Flagged as possible phishing again.", now, `mail-trust:${id}`);
  })();
  if (rows.length === 0) return { ok: true, message: "Nothing to undo: the sender was already removed in Settings." };
  const messageId = rows.find((r) => r.message_id !== "")?.message_id;
  return { ok: true, message: "Undone. The mail shows as possible phishing again.", ...(messageId ? { restored: `mail:${messageId}` } : {}) };
}

/** Every remembered "Not phishing", one entry per sender address, for Settings. */
export function trustedViews(db: Database): TrustedView[] {
  const rows = db.query<{ sender: string; code: SuspicionCode; message_id: string; subject: string | null; created_at: number }, []>("SELECT sender, code, message_id, subject, created_at FROM desk_mail_trusted ORDER BY sender, created_at, id").all();
  const bySender = new Map<string, Omit<TrustedView, "sentence"> & { byMail: Map<string, TrustedOneMail> }>();
  for (const r of rows) {
    const v = bySender.get(r.sender) ?? { sender: r.sender, codes: [], mails: [], at: r.created_at, byMail: new Map<string, TrustedOneMail>() };
    v.at = Math.max(v.at, r.created_at);
    if (r.message_id === "") v.codes.push(r.code);
    else {
      const one = v.byMail.get(r.message_id) ?? { codes: [], subject: r.subject };
      one.codes.push(r.code);
      v.byMail.set(r.message_id, one);
    }
    bySender.set(r.sender, v);
  }
  return [...bySender.values()].map(({ byMail, ...v }) => {
    const view = { ...v, mails: [...byMail.values()] };
    return { ...view, sentence: sentenceOf(view) };
  });
}

/** Settings' Remove: forgets every "Not phishing" for one sender address, so its mail is checked in full again. */
export function removeTrustedSender(db: Database, address: string): TrustResult {
  const sender = senderKey(address);
  if (db.query("DELETE FROM desk_mail_trusted WHERE sender = ?").run(sender).changes === 0) return refuse(404, `${sender} has no "Not phishing" remembered.`);
  return { ok: true, message: `Mail from ${sender} is checked for phishing in full again.`, trusted: trustedViews(db) };
}
