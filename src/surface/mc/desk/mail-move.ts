import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import type { WriterRunner } from "./create";
import type { ListedMail, MailActionsConfig, TrashLedger } from "./mail-actions";
import { loggedFeatures, logMailDecision, mailFeatures, senderDomain, type MailFeatures, type MailLogAction } from "./mail-log";
import { CommandTimeout } from "./spawn";
import { DAY_MS } from "./time";
import { addSender, isVip, listVips, normalizeVip } from "./vips";

export const MOVE_TARGETS = ["archive", "junk", "trash"] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];

export const UNDO_WINDOW_MS = 7 * DAY_MS;

const FOLDER: Record<MoveTarget, string> = { archive: "Archive", junk: "Junk", trash: "Trash" };
const DONE: Record<MoveTarget, string> = { archive: "Archived", junk: "Moved to Junk", trash: "Deleted" };
const NOT_SET: Record<MoveTarget, string> = {
  archive: "Archiving mail is not set up on this stack.",
  junk: "Moving mail to Junk is not set up on this stack.",
  trash: "Deleting mail is not set up on this stack.",
};

/** The ledger key that hides a moved mail from the Desk until the source reads it again without it. */
export const movedKey = (target: MoveTarget, messageId: string): string => `moved:${target}:${messageId}`;
const claimKey = (messageId: string): string => `move:${messageId}`;

export const movedTarget = (ledger: Pick<TrashLedger, "has">, messageId: string): MoveTarget | undefined =>
  MOVE_TARGETS.find((t) => ledger.has(movedKey(t, messageId)));

export interface MoveDeps {
  db: Database;
  config: MailActionsConfig | undefined;
  ledger: TrashLedger;
  run: WriterRunner;
  now: number;
  newId?: () => string;
}

export type MoveResult = { ok: true; message: string; undo?: string; block?: string; restored?: string } | { ok: false; status: number; error: string };

export const refuse = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

interface Printed {
  message: string;
  folder: string | null;
}

function printed(stdout: string, fallback: string): Printed {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return { message: fallback, folder: null };
    const message = "message" in parsed && typeof parsed.message === "string" ? oneLine(parsed.message, fallback) : fallback;
    const folder = "folder" in parsed && typeof parsed.folder === "string" && parsed.folder.trim() ? parsed.folder.trim().slice(0, 200) : null;
    return { message, folder };
  } catch {
    return { message: fallback, folder: null };
  }
}


interface Claimed {
  key: string;
  argv: string[];
  request: Record<string, string>;
  command: "move" | "trash";
  failed: (line: string) => string;
  timedOut: string;
}

async function runClaimed(deps: MoveDeps, timeoutSeconds: number, c: Claimed, done: (stdout: string) => MoveResult): Promise<MoveResult> {
  if (!deps.ledger.claim(c.key)) return refuse(409, "This mail is already being moved.");
  let stdout: string;
  try {
    const result = await deps.run(c.argv, JSON.stringify(c.request), timeoutSeconds * 1000);
    if (result.code !== 0) return refuse(502, c.failed(oneLine(result.stderr || result.stdout, `The ${c.command} command exited with code ${result.code}.`)));
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof CommandTimeout) return refuse(504, `The ${c.command} command ${err.message}. ${c.timedOut}`);
    return refuse(502, `The ${c.command} command did not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(c.key);
  }
  try {
    return done(stdout);
  } catch (err) {
    return refuse(500, `The mail moved, but the Desk could not record it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Moves one listed mail to its account's folder for the target. With `mc.desk.mail.actions.move` the command reads
 * `{ action: "move", account, messageId, target }`, and the move is logged with an Undo in Done for you. Without it, a
 * move to Trash falls back to the legacy trash command (`{ action: "trash", account, messageId }`, no Undo). The
 * contract asks the command to move only, never to delete or expunge; its last stderr line is the refusal shown.
 */
export async function moveMail(mail: ListedMail, target: MoveTarget, deps: MoveDeps, logAs: MailLogAction = target, features: MailFeatures = mailFeatures(deps.db, mail)): Promise<MoveResult> {
  const config = deps.config;
  const move = config?.move;
  const argv = move?.length ? move : target === "trash" ? config?.trash : undefined;
  if (!config || !argv?.length) return refuse(409, NOT_SET[target]);
  const account = mail.account;
  if (!account) return refuse(409, "The mail source names no account for this mail, so the Desk cannot move it.");
  const already = movedTarget(deps.ledger, mail.id);
  if (already) return refuse(409, `This mail is already in ${FOLDER[already]}.`);
  const command = move?.length ? "move" : "trash";
  const request: Record<string, string> = command === "move" ? { action: "move", account, messageId: mail.id, target } : { action: "trash", account, messageId: mail.id };
  return runClaimed(deps, config.timeoutSeconds, { key: claimKey(mail.id), argv, request, command, failed: (line) => line, timedOut: `The mail may have moved; check ${FOLDER[target]}.` }, (stdout) => {
    deps.ledger.add(movedKey(target, mail.id), deps.now);
    const { message, folder } = printed(stdout, `Moved to ${FOLDER[target]}.`);
    if (command !== "move") {
      logMailDecision(deps.db, features, logAs, "desk", deps.now, folder ?? FOLDER[target]);
      return { ok: true, message };
    }
    const id = (deps.newId ?? (() => crypto.randomUUID()))();
    deps.db.transaction(() => {
      deps.db.query("INSERT INTO desk_mail_moves (id, account, message_id, target, sender, folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, account, mail.id, target, mail.from.address.toLowerCase(), folder, deps.now);
      deps.db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, 'mail.move', ?, ?, 'done', ?, ?, ?)")
        .run(`mail-move:${id}`, id, `${DONE[target]}: “${mail.subject}”`, message, deps.now, deps.now);
      logMailDecision(deps.db, features, logAs, "desk", deps.now, folder ?? FOLDER[target]);
    })();
    return { ok: true, message, undo: id, ...(target === "junk" ? { block: `@${senderDomain(mail.from.address)}` } : {}) };
  });
}

const movedFeatures = (row: MoveRow): MailFeatures => ({
  messageId: row.message_id,
  account: row.account,
  sourceId: null,
  sender: row.sender,
  senderDomain: senderDomain(row.sender),
  listId: null,
  category: null,
  subject: null,
  summary: null,
});

interface MoveRow {
  account: string;
  message_id: string;
  target: MoveTarget;
  sender: string;
  created_at: number;
  undone_at: number | null;
}

const readMove = (db: Database, id: string): MoveRow | null =>
  db.query<MoveRow, [string]>("SELECT account, message_id, target, sender, created_at, undone_at FROM desk_mail_moves WHERE id = ?").get(id);

/**
 * Undo of one logged move: the move command reads `{ action: "restore", account, messageId, from }` and moves the
 * message back to INBOX. The mail shows on the Desk again (`restored` is its item key); Done for you keeps the line, marked undone.
 */
export async function undoMove(id: string, deps: MoveDeps): Promise<MoveResult> {
  const config = deps.config;
  const argv = config?.move;
  if (!config || !argv?.length) return refuse(409, "Undo needs the move command, and it is not set up on this stack.");
  const row = readMove(deps.db, id);
  if (!row) return refuse(404, "The Desk has no record of that move.");
  if (row.undone_at !== null) return refuse(409, "That move is already undone.");
  if (deps.now - row.created_at > UNDO_WINDOW_MS) return refuse(409, "That move is too old to undo from the Desk. Move the mail back in your mail client.");
  const request = { action: "restore", account: row.account, messageId: row.message_id, from: row.target };
  const claimed: Claimed = { key: claimKey(row.message_id), argv, request, command: "move", failed: (line) => `The mail was not moved back: ${line}`, timedOut: "The mail may be back; check INBOX." };
  return runClaimed(deps, config.timeoutSeconds, claimed, (stdout) => {
    const { message } = printed(stdout, "Moved back to INBOX.");
    deps.ledger.forget(movedKey(row.target, row.message_id));
    deps.db.transaction(() => {
      deps.db.query("UPDATE desk_mail_moves SET undone_at = ? WHERE id = ?").run(deps.now, id);
      deps.db.query("UPDATE desk_done SET action = 'mail.move.undone', message = ?, updated_at = ? WHERE attempt_key = ?").run(message, deps.now, `mail-move:${id}`);
      logMailDecision(deps.db, loggedFeatures(deps.db, row.message_id) ?? movedFeatures(row), "restore", "desk", deps.now, "INBOX");
    })();
    return { ok: true, message, restored: `mail:${row.message_id}` };
  });
}

/**
 * The second step after Spam: puts the sender's whole domain on the unimportant list as `@domain`. Refused when the
 * sender or anyone else on that domain is a VIP, because VIP wins.
 */
export function blockSenderDomain(db: Database, id: string, now: number): MoveResult {
  const row = readMove(db, id);
  if (!row) return refuse(404, "The Desk has no record of that move.");
  if (row.target !== "junk") return refuse(409, "Only mail moved to Junk can block its sender's domain.");
  const domain = normalizeVip(`@${senderDomain(row.sender)}`);
  if (!domain?.startsWith("@")) return refuse(409, "The sender's address has no domain the Desk can block.");
  const vips = listVips(db).map((v) => v.address);
  if (isVip(new Set(vips), row.sender) || vips.some((v) => v.endsWith(domain))) {
    return refuse(409, `${domain} has a sender on your VIP list, and VIPs always show. Nothing was blocked.`);
  }
  addSender(db, "unimportant", domain, "Blocked after Spam", now);
  return { ok: true, message: `Blocked ${domain}: its mail now counts as unimportant. You can change this in Settings.` };
}
