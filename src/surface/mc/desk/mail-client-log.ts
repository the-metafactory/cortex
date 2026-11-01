import type { Database } from "bun:sqlite";
import type { WriterRunner } from "./create";
import type { MailActionsConfig, TrashLedger } from "./mail-actions";
import { departures, logMailDecision, mailFeatures, purgeMailLog, type Departure, type MailLogAction } from "./mail-log";
import { movedTarget } from "./mail-move";
import type { SourceReading } from "./sources/command";

const DESK_MOVES = new Set<MailLogAction>(["archive", "junk", "trash", "unimportant"]);
const PLACES = ["inbox", "archive", "junk", "trash", "gone"] as const;
type Place = (typeof PLACES)[number];

export interface ClientLogDeps {
  db: Database;
  config: MailActionsConfig | undefined;
  ledger: Pick<TrashLedger, "has">;
  run: WriterRunner;
  now: () => number;
  retentionDays: number;
}

interface Located {
  place: Place;
  folder: string | null;
  unread: boolean;
}

const GONE: Located = { place: "gone", folder: null, unread: false };

function handledOnDesk(deps: ClientLogDeps, messageId: string): boolean {
  if (movedTarget(deps.ledger, messageId) !== undefined) return true;
  const last = deps.db.query<{ action: MailLogAction; place: string }, [string]>("SELECT action, place FROM desk_mail_log WHERE message_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(messageId);
  return last?.place === "desk" && DESK_MOVES.has(last.action);
}

function readLocated(stdout: string): Located {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !("place" in parsed)) return GONE;
    const place = PLACES.find((p) => p === parsed.place);
    if (!place) return GONE;
    const folder = "folder" in parsed && typeof parsed.folder === "string" && parsed.folder.trim() ? parsed.folder.trim().slice(0, 200) : null;
    const unread = "unread" in parsed && parsed.unread === true;
    return { place, folder, unread };
  } catch {
    return GONE;
  }
}

async function locate(deps: ClientLogDeps, d: Departure): Promise<Located> {
  const argv = deps.config?.move;
  const account = d.mail.account;
  if (!argv?.length || !account) return GONE;
  try {
    const result = await deps.run(argv, JSON.stringify({ action: "locate", account, messageId: d.mail.id }), deps.config?.timeoutSeconds ? deps.config.timeoutSeconds * 1000 : 30_000);
    return result.code === 0 ? readLocated(result.stdout) : GONE;
  } catch {
    return GONE;
  }
}

function decided(located: Located): { action: MailLogAction; folder: string | null } | null {
  switch (located.place) {
    case "inbox":
      return located.unread ? null : { action: "kept", folder: located.folder };
    case "gone":
      return { action: "gone", folder: null };
    default:
      return { action: located.place, folder: located.folder };
  }
}

/**
 * Logs, as `client` decisions, what the person did outside the Desk with the mails one reading listed unread: read and
 * kept in the inbox, or moved to Archive, Junk or Trash (found with the move command's `locate`). A mail the command
 * cannot find, or that no command can look for, is logged as `gone`. A mail the Desk moved itself is skipped.
 */
export async function recordClientDecisions(prev: SourceReading | undefined, next: SourceReading, deps: ClientLogDeps): Promise<number> {
  purgeMailLog(deps.db, deps.now(), deps.retentionDays);
  let logged = 0;
  for (const d of departures(prev, next)) {
    if (handledOnDesk(deps, d.mail.id)) continue;
    const outcome = d.read ? { action: "kept" as const, folder: null } : decided(await locate(deps, d));
    if (!outcome || handledOnDesk(deps, d.mail.id)) continue;
    logMailDecision(deps.db, mailFeatures(deps.db, { ...d.mail, sourceId: d.sourceId }), outcome.action, "client", deps.now(), outcome.folder);
    logged += 1;
  }
  return logged;
}

/** Runs one pass per new reading, one after another, so two readings never locate the same mail at once. */
export class ClientMailLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ClientLogDeps) {}

  observe(prev: SourceReading | undefined, next: SourceReading): Promise<unknown> {
    this.chain = this.chain.then(() => recordClientDecisions(prev, next, this.deps)).catch(() => 0);
    return this.chain;
  }
}
