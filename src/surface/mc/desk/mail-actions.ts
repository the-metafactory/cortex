import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import { forgetClassification, PREDICTED_ACTIONS, saveUnimportant } from "./classify";
import { logMailDecision, mailFeatures, type MailLogAction } from "./mail-log";
import { loggedAction } from "./mail-similar";
import { CORRECTION_MOVES } from "./mail-correction-schema";
import { movedKey, moveMail, refuse, type MoveDeps, type MoveResult, type MoveTarget } from "./mail-move";
import { CommandTimeout } from "./spawn";
import { replySubject } from "./mail-triage";
import type { SourceMail, SourceReading } from "./sources/command";
import { addSender, isVip, listVips } from "./vips";

export const MAIL_ACTIONS = ["move", "trash", "unimportant", "draft", "undo", "block"] as const;
export type MailActionId = (typeof MAIL_ACTIONS)[number];
export const isMailAction = (v: unknown): v is MailActionId => MAIL_ACTIONS.includes(v as MailActionId);

export interface MailActionsConfig {
  move?: string[];
  trash?: string[];
  draft?: string[];
  timeoutSeconds: number;
}

export type ListedMail = SourceMail & { sourceId: string };

const draftKey = (messageId: string): string => `draft:${messageId}`;

export const MAX_REPLY_CHARS = 20_000;

export type MailActionResult = MoveResult;

/** The mail behind a Desk item key, from the sources' last reading, never from the page. */
export type ListedMailLookup = { ok: true; mail: ListedMail } | { ok: false; reason: "unlisted" | "ambiguous"; error: string };

export const AMBIGUOUS_ACCOUNT_REFUSAL = "This Message-ID is listed under more than one account, so the Desk cannot tell which mailbox to act on. Nothing was run.";

/** Resolves a Desk item key to one listed mail; a Message-ID listed under more than one account is ambiguous. */
export function resolveListedMail(readings: SourceReading[], itemKey: string): ListedMailLookup {
  const hits: ListedMail[] = [];
  for (const r of readings) {
    const m = r.mail.find((x) => `mail:${x.id}` === itemKey);
    if (m) hits.push({ ...m, sourceId: r.id });
  }
  const [first] = hits;
  if (!first) return { ok: false, reason: "unlisted", error: "The Desk no longer lists this mail." };
  if (new Set(hits.map((h) => h.account ?? null)).size > 1) return { ok: false, reason: "ambiguous", error: AMBIGUOUS_ACCOUNT_REFUSAL };
  return { ok: true, mail: first };
}

export const findListedMail = (readings: SourceReading[], itemKey: string): ListedMail | null => {
  const found = resolveListedMail(readings, itemKey);
  return found.ok ? found.mail : null;
};

export interface TrashLedger {
  has(key: string): boolean;
  add(key: string, now: number): void;
  forget(key: string): void;
  claim(key: string): boolean;
  release(key: string): void;
}

/**
 * Puts the sender on the unimportant list, sorts this mail as bulk and moves it to Trash like "Seen, delete".
 * A VIP is refused: VIP wins. A refused move keeps the sender marked and the item listed. Without a trash
 * command the mail is hidden like a trashed one.
 */
export async function markUnimportant(db: Database, mail: ListedMail, deps: MoveDeps): Promise<MoveResult> {
  const address = mail.from.address.toLowerCase();
  const who = mail.from.name ?? address;
  if (isVip(new Set(listVips(db).map((v) => v.address)), address)) {
    return refuse(409, `${who} is on your VIP list, and VIPs always show. Remove them there first.`);
  }
  const features = mailFeatures(db, mail);
  addSender(db, "unimportant", address, mail.from.name ?? null, deps.now);
  saveUnimportant(db, mail.id, deps.now);
  const marked = `Mail from ${who} will be treated as unimportant`;
  if (!deps.config?.trash?.length && !deps.config?.move?.length) {
    deps.ledger.add(movedKey("trash", mail.id), deps.now);
    logMailDecision(db, features, "unimportant", "desk", deps.now);
    return { ok: true, message: `${marked}.` };
  }
  const moved = await moveMail(mail, "trash", deps, "unimportant", features);
  if (!moved.ok) return refuse(moved.status, `${marked}, but moving it to Trash failed: ${moved.error}`);
  return { ...moved, message: `${moved.message} ${marked}.` };
}

export type DraftResult = { ok: true; message: string; id: string } | { ok: false; status: number; error: string };

function draftId(stdout: string): string {
  try {
    const printed: unknown = JSON.parse(stdout);
    const id = typeof printed === "object" && printed !== null && "id" in printed ? printed.id : undefined;
    return typeof id === "string" ? id.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Runs the configured draft command for one listed mail: stdin `{ action: "draft", account, messageId, to, subject, body }`.
 * The command saves a reply in the account's Drafts and never sends it. The item stays on the Desk either way.
 */
export async function draftReply(mail: ListedMail, body: string, deps: Omit<MoveDeps, "db">): Promise<DraftResult> {
  const config = deps.config;
  const argv = config?.draft;
  if (!config || !argv?.length) return refuse(409, "Drafting replies is not set up on this stack.");
  if (!mail.account) return refuse(409, "The mail source names no account for this mail, so the Desk cannot draft a reply.");
  if (body.trim() === "") return refuse(400, "Write the reply first.");
  if (body.length > MAX_REPLY_CHARS) return refuse(400, `The reply is longer than ${MAX_REPLY_CHARS} characters.`);
  const key = draftKey(mail.id);
  if (!deps.ledger.claim(key)) return refuse(409, "A draft for this mail is already being saved.");
  try {
    const stdin = JSON.stringify({ action: "draft", account: mail.account, messageId: mail.id, to: mail.from.address, subject: replySubject(mail.subject), body });
    const result = await deps.run(argv, stdin, config.timeoutSeconds * 1000);
    if (result.code !== 0) return refuse(502, `The draft was not saved: ${oneLine(result.stderr || result.stdout, `the draft command exited with code ${result.code}.`)}`);
    return { ok: true, message: `Reply saved in your ${mail.account} Drafts.`, id: draftId(result.stdout) };
  } catch (err) {
    if (err instanceof CommandTimeout) return refuse(504, `The draft command ${err.message}. The draft may be saved; check Drafts.`);
    return refuse(502, `The draft command did not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(key);
  }
}

export interface MailReportConfig {
  command: string[];
  to?: string;
  timeoutSeconds: number;
}

const reportKey = (messageId: string): string => `report:${messageId}`;

const reportMessage = (stdout: string, fallback: string): string => {
  try {
    const out: unknown = JSON.parse(stdout);
    const message = typeof out === "object" && out !== null && "message" in out && typeof out.message === "string" ? oneLine(out.message, fallback) : fallback;
    return message.length > 0 && message.length <= 300 ? message : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Runs the configured report command for one listed mail: stdin `{ action: "report", account, messageId, to? }`. With
 * `to`, the adapter saves a draft to that address with the original attached as message/rfc822, for the principal to
 * send; without it, the command reports the mail its own way. Nothing moves; Spam stays a separate action.
 */
export async function reportMail(mail: ListedMail, report: MailReportConfig | undefined, deps: Omit<MoveDeps, "db" | "config">): Promise<MailActionResult> {
  if (!report?.command.length) return refuse(409, "Reporting mail is not set up on this stack.");
  if (!mail.account) return refuse(409, "The mail source names no account for this mail, so the Desk cannot report it.");
  const key = reportKey(mail.id);
  if (!deps.ledger.claim(key)) return refuse(409, "This mail is already being reported.");
  try {
    const stdin = JSON.stringify({ action: "report", account: mail.account, messageId: mail.id, ...(report.to ? { to: report.to } : {}) });
    const result = await deps.run(report.command, stdin, report.timeoutSeconds * 1000);
    if (result.code !== 0) return refuse(502, `The mail was not reported: ${oneLine(result.stderr || result.stdout, `the report command exited with code ${result.code}.`)}`);
    return { ok: true, message: reportMessage(result.stdout, report.to ? `A report draft to ${report.to} is in your ${mail.account} Drafts. Send it from there.` : "The mail was reported.") };
  } catch (err) {
    if (err instanceof CommandTimeout) return refuse(504, `The report command ${err.message}. A draft may exist; check Drafts.`);
    return refuse(502, `The report command did not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(key);
  }
}

export const MAIL_CORRECTIONS = ["not-bulk", "matters", ...PREDICTED_ACTIONS] as const;
export type MailCorrection = (typeof MAIL_CORRECTIONS)[number];

export const CORRECTED_CATEGORY: Partial<Record<MailCorrection, string>> = { "not-bulk": "not bulk", matters: "matters" };

const correctionAction = (said: MailCorrection): MailLogAction => (said === "not-bulk" || said === "matters" ? "kept" : loggedAction(said));

const CORRECTION_DONE: Record<MailCorrection, string> = {
  "not-bulk": "Corrected: this mail is not bulk.",
  matters: "Corrected: this mail matters.",
  archive: "Corrected: you would archive this.",
  junk: "Corrected: this is spam to you.",
  trash: "Corrected: you would delete this.",
  reply: "Corrected: you would reply.",
  plan: "Corrected: you would plan this.",
  todo: "Corrected: you would make this a to-do.",
  keep: "Corrected: you keep this.",
};

const CORRECTED_TITLE: Record<MoveTarget, string> = { archive: "Archived after your correction", junk: "Moved to Junk after your correction", trash: "Deleted after your correction" };

export type CorrectionResult = MoveResult | { ok: false; status: number; error: string; recorded: true; correction: number };

const loggedCorrection = (db: Database, id: number, mail: ListedMail, said: MailCorrection): boolean =>
  db.query<{ n: number }, [number, string, string]>("SELECT COUNT(*) AS n FROM desk_mail_log WHERE id = ? AND message_id = ? AND action = ? AND origin = 'correction'").get(id, mail.id, correctionAction(said))?.n === 1;

const carriedOut = (db: Database, id: number): boolean =>
  db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM desk_mail_moves WHERE correction_id = ? AND undone_at IS NULL").get(id)?.n !== 0;

/**
 * Logs the principal's correction of one mail's triage as a weighted decision, and forgets the mail's classification so
 * the next pass sorts it again with the correction as its closest example. Archive, spam and delete then move the mail
 * with moveMail, which links the move to that one decision instead of logging its own. A failed move keeps the logged
 * correction and answers `recorded` with its id; sending that id back as `correction` retries only the move.
 */
export async function correctMail(mail: ListedMail, said: MailCorrection, deps: MoveDeps, retry?: number): Promise<CorrectionResult> {
  const { db, now } = deps;
  const features = mailFeatures(db, mail);
  const category = CORRECTED_CATEGORY[said];
  const target = CORRECTION_MOVES[said];
  if (retry !== undefined) {
    if (!target || !loggedCorrection(db, retry, mail, said)) return refuse(409, "The Desk has no record of that correction for this mail.");
    if (carriedOut(db, retry)) return refuse(409, "That correction was already carried out.");
  }
  const correction = retry ?? logMailDecision(db, category ? { ...features, category } : features, correctionAction(said), "correction", now);
  forgetClassification(db, mail.id);
  if (!target) return { ok: true, message: `${CORRECTION_DONE[said]} The Desk sorts it and mail like it again with that in mind.` };
  const moved = await moveMail(mail, target, deps, correctionAction(said), features, { where: "correction", doneAction: "mail.move", title: CORRECTED_TITLE[target], correction });
  if (moved.ok) return { ...moved, message: `${moved.message} ${CORRECTION_DONE[said]}` };
  return { ok: false, status: moved.status, error: `${CORRECTION_DONE[said]} The correction is recorded, but the mail was not moved: ${moved.error}`, recorded: true, correction };
}
