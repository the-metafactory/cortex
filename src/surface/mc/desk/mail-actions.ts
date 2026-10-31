import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import { saveUnimportant } from "./classify";
import { CommandTimeout } from "./spawn";
import type { WriterRunner } from "./create";
import type { SourceMail, SourceReading } from "./sources/command";
import { addSender, isVip, listVips } from "./vips";

export const MAIL_ACTIONS = ["trash", "unimportant"] as const;
export type MailActionId = (typeof MAIL_ACTIONS)[number];
export const isMailAction = (v: unknown): v is MailActionId => MAIL_ACTIONS.includes(v as MailActionId);

export interface MailActionsConfig {
  trash?: string[];
  timeoutSeconds: number;
}

export type ListedMail = SourceMail & { sourceId: string };

export const trashKey = (messageId: string): string => `trash:${messageId}`;

export type MailActionResult = { ok: true; message: string } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): MailActionResult => ({ ok: false, status, error });

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
  claim(key: string): boolean;
  release(key: string): void;
}

export interface TrashDeps {
  config: MailActionsConfig | undefined;
  ledger: TrashLedger;
  run: WriterRunner;
  now: number;
}

/**
 * Runs the configured trash command for one listed mail: stdin `{ action: "trash", account, messageId }`.
 * The command moves that one message to the account's Trash; its last stderr line is the refusal shown.
 */
export async function trashMail(mail: ListedMail, deps: TrashDeps): Promise<MailActionResult> {
  const config = deps.config;
  const argv = config?.trash;
  if (!config || !argv?.length) return refuse(409, "Deleting mail is not set up on this stack.");
  if (!mail.account) return refuse(409, "The mail source names no account for this mail, so the Desk cannot move it.");
  const key = trashKey(mail.id);
  if (deps.ledger.has(key)) return refuse(409, "This mail is already in Trash.");
  if (!deps.ledger.claim(key)) return refuse(409, "This mail is already on its way to Trash.");
  try {
    const stdin = JSON.stringify({ action: "trash", account: mail.account, messageId: mail.id });
    const result = await deps.run(argv, stdin, config.timeoutSeconds * 1000);
    if (result.code !== 0) return refuse(502, oneLine(result.stderr || result.stdout, `The trash command exited with code ${result.code}.`));
    deps.ledger.add(key, deps.now);
    return { ok: true, message: "Moved to Trash." };
  } catch (err) {
    if (err instanceof CommandTimeout) return refuse(504, `The trash command ${err.message}. The mail may have moved; check Trash.`);
    return refuse(502, `The trash command did not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(key);
  }
}

/** Puts the sender on the unimportant list and sorts this mail as bulk. A VIP is refused: VIP wins. */
export function markUnimportant(db: Database, mail: ListedMail, now: number): MailActionResult {
  const address = mail.from.address.toLowerCase();
  const who = mail.from.name ?? address;
  if (isVip(new Set(listVips(db).map((v) => v.address)), address)) {
    return refuse(409, `${who} is on your VIP list, and VIPs always show. Remove them there first.`);
  }
  addSender(db, "unimportant", address, mail.from.name ?? null, now);
  saveUnimportant(db, mail.id, now);
  return { ok: true, message: `Mail from ${who} counts as bulk from now on. You can change this in Settings.` };
}
