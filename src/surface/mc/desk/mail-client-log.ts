import type { Database } from "bun:sqlite";
import type { WriterRunner } from "./create";
import type { MailActionsConfig, TrashLedger } from "./mail-actions";
import { departures, lastMailDecision, logMailDecision, mailFeatures, purgeMailLog, type Departure, type MailLogAction } from "./mail-log";
import { movedTarget } from "./mail-move";
import type { SourceReading } from "./sources/command";

const DESK_MOVES = new Set<MailLogAction>(["archive", "junk", "trash", "unimportant"]);
const PLACES = ["inbox", "archive", "junk", "trash", "gone"] as const;
type Place = (typeof PLACES)[number];

export const LOCATE_ATTEMPTS = 3;

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

const NOT_LOOKED_UP = "not-looked-up";

function handledOnDesk(deps: ClientLogDeps, messageId: string): boolean {
  if (movedTarget(deps.ledger, messageId) !== undefined) return true;
  const last = lastMailDecision(deps.db, messageId);
  return (last?.where === "desk" || last?.where === "rule") && DESK_MOVES.has(last.action);
}

function readLocated(stdout: string): Located | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !("place" in parsed)) return null;
    const place = PLACES.find((p) => p === parsed.place);
    if (!place) return null;
    const folder = "folder" in parsed && typeof parsed.folder === "string" && parsed.folder.trim() ? parsed.folder.trim().slice(0, 200) : null;
    const unread = "unread" in parsed && parsed.unread === true;
    return { place, folder, unread };
  } catch {
    return null;
  }
}

async function locate(deps: ClientLogDeps, d: Departure): Promise<Located | null | typeof NOT_LOOKED_UP> {
  const argv = deps.config?.move;
  const account = d.mail.account;
  if (!argv?.length || !account) return NOT_LOOKED_UP;
  try {
    const result = await deps.run(argv, JSON.stringify({ action: "locate", account, messageId: d.mail.id }), (deps.config?.timeoutSeconds ?? 30) * 1000);
    return result.code === 0 ? readLocated(result.stdout) : null;
  } catch {
    return null;
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

export interface ClientPass {
  logged: number;
  failed: Departure[];
}

/**
 * Logs, as `client` decisions, what the person did outside the Desk with the mails one reading listed unread: read and
 * kept in the inbox, or moved to Archive, Junk or Trash (found with the move command's `locate`). A mail the command
 * reports in none of those folders is logged as `gone`. Without a move command or an account, a mail that left the list
 * is not looked for and not logged, since it may only have left the source's window. A lookup that fails logs
 * nothing and comes back in `failed`, so a broken connection is never recorded as the person's decision. A mail the
 * Desk moved itself is skipped. `retry` adds departures an earlier pass could not look up.
 */
export async function recordClientDecisions(prev: SourceReading | undefined, next: SourceReading, deps: ClientLogDeps, retry: Departure[] = []): Promise<ClientPass> {
  purgeMailLog(deps.db, deps.now(), deps.retentionDays);
  const listedUnread = new Set(next.error === null ? next.mail.filter((m) => m.unread).map((m) => m.id) : []);
  const fresh = departures(prev, next);
  const queued = [...fresh, ...retry.filter((r) => r.sourceId === next.id && !listedUnread.has(r.mail.id) && !fresh.some((f) => f.mail.id === r.mail.id))];
  const pass: ClientPass = { logged: 0, failed: [] };
  for (const d of queued) {
    if (handledOnDesk(deps, d.mail.id)) continue;
    const located = d.read ? null : await locate(deps, d);
    if (located === NOT_LOOKED_UP) continue;
    if (!d.read && located === null) {
      pass.failed.push(d);
      continue;
    }
    const outcome = located ? decided(located) : { action: "kept" as const, folder: null };
    if (!outcome || handledOnDesk(deps, d.mail.id)) continue;
    logMailDecision(deps.db, mailFeatures(deps.db, { ...d.mail, sourceId: d.sourceId }), outcome.action, "client", deps.now(), outcome.folder);
    pass.logged += 1;
  }
  return pass;
}

/**
 * Runs one pass per new reading, one after another, so two readings never locate the same mail at once. A mail whose
 * lookup failed is tried again with the next readings of its source, at most LOCATE_ATTEMPTS times, then dropped unlogged.
 */
export class ClientMailLog {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, { departure: Departure; attempts: number }>();

  constructor(private readonly deps: ClientLogDeps) {}

  observe(prev: SourceReading | undefined, next: SourceReading): Promise<unknown> {
    this.chain = this.chain.then(() => this.pass(prev, next)).catch(() => undefined);
    return this.chain;
  }

  private async pass(prev: SourceReading | undefined, next: SourceReading): Promise<void> {
    const retry = [...this.pending.values()].filter((p) => p.departure.sourceId === next.id);
    for (const p of retry) this.pending.delete(p.departure.mail.id);
    const { failed } = await recordClientDecisions(prev, next, this.deps, retry.map((p) => p.departure));
    for (const d of failed) {
      const attempts = (retry.find((p) => p.departure.mail.id === d.mail.id)?.attempts ?? 0) + 1;
      if (attempts < LOCATE_ATTEMPTS) this.pending.set(d.mail.id, { departure: d, attempts });
    }
  }
}
