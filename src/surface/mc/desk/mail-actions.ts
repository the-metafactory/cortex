import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import { forgetClassification, PREDICTED_ACTIONS, saveUnimportant } from "./classify";
import { logMailDecision, mailFeatures, type MailLogAction } from "./mail-log";
import { loggedAction } from "./mail-similar";
import { movedKey, moveMail, refuse, type MoveDeps, type MoveResult } from "./mail-move";
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
export function findListedMail(readings: SourceReading[], itemKey: string): ListedMail | null {
  for (const r of readings) {
    const m = r.mail.find((x) => `mail:${x.id}` === itemKey);
    if (m) return { ...m, sourceId: r.id };
  }
  return null;
}

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

/**
 * Runs the configured draft command for one listed mail: stdin `{ action: "draft", account, messageId, to, subject, body }`.
 * The command saves a reply in the account's Drafts and never sends it. The item stays on the Desk either way.
 */
export async function draftReply(mail: ListedMail, body: string, deps: Omit<MoveDeps, "db">): Promise<MailActionResult> {
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
    return { ok: true, message: `Reply saved in your ${mail.account} Drafts.` };
  } catch (err) {
    if (err instanceof CommandTimeout) return refuse(504, `The draft command ${err.message}. The draft may be saved; check Drafts.`);
    return refuse(502, `The draft command did not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(key);
  }
}

export const MAIL_CORRECTIONS = ["not-bulk", "matters", ...PREDICTED_ACTIONS] as const;
export type MailCorrection = (typeof MAIL_CORRECTIONS)[number];

export const CORRECTED_CATEGORY: Partial<Record<MailCorrection, string>> = { "not-bulk": "not bulk", matters: "matters" };

const correctionAction = (said: MailCorrection): MailLogAction => (said === "not-bulk" || said === "matters" ? "kept" : loggedAction(said));

const CORRECTION_DONE: Record<MailCorrection, string> = {
  "not-bulk": "Noted: this mail is not bulk.",
  matters: "Noted: this mail matters.",
  archive: "Noted: you would archive this mail.",
  junk: "Noted: this mail is spam to you.",
  trash: "Noted: you would delete this mail.",
  reply: "Noted: you would reply to this mail.",
  plan: "Noted: you would plan this mail.",
  todo: "Noted: you would make this mail a to-do.",
  keep: "Noted: you would keep this mail in the inbox.",
};

/**
 * Logs the principal's correction of one mail's triage as a weighted decision, and forgets the mail's classification so
 * the next pass sorts it again with the correction as its closest example. Nothing moves.
 */
export function correctMail(db: Database, mail: ListedMail, said: MailCorrection, now: number): MailActionResult {
  const features = mailFeatures(db, mail);
  const category = CORRECTED_CATEGORY[said];
  logMailDecision(db, category ? { ...features, category } : features, correctionAction(said), "correction", now);
  forgetClassification(db, mail.id);
  return { ok: true, message: `${CORRECTION_DONE[said]} The Desk sorts it and mail like it again with that in mind.` };
}
