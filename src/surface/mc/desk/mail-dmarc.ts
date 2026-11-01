import type { Database } from "bun:sqlite";
import { z } from "zod";
import { oneLine } from "./actions";
import type { WriterRunner } from "./create";
import type { ListedMail, MailActionsConfig, TrashLedger } from "./mail-actions";
import { mailFeatures } from "./mail-log";
import { movedTarget, moveMail } from "./mail-move";
import { digestedIds } from "./mail-rules";
import { mirrorWeek } from "./mirror";
import { localDay } from "./my-day";
import type { SourceReading } from "./sources/command";
import { CommandTimeout } from "./spawn";
import { DAY_MS } from "./time";
import type { DeskItem } from "./types";
import { CARD_DAYS, REFUSED_EXIT, type DmarcConfig, type DmarcFailOn } from "./mail-dmarc-schema";

export { DMARC_SQL, type DmarcConfig, type DmarcFailOn } from "./mail-dmarc-schema";


const Count = z.number().int().min(0).max(1e12);
const SourceSchema = z.object({ ip: z.string().regex(/^(?:[0-9a-f:.]{2,45}|unknown)$/), count: Count, spfFail: Count, dkimFail: Count, dmarcFail: Count });
const DomainSchema = z.object({
  domain: z.string().regex(/^[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/),
  messages: Count,
  spf: z.object({ pass: Count, fail: Count }),
  dkim: z.object({ pass: Count, fail: Count }),
  dmarcFail: Count,
  disposition: z.object({ none: Count, quarantine: Count, reject: Count }),
  failing: z.array(SourceSchema).max(5),
});
export const DmarcReportSchema = z.object({
  id: z.string().min(1).max(512),
  org: z.string().max(120),
  reportId: z.string().max(200),
  begin: z.iso.datetime(),
  end: z.iso.datetime(),
  policyDomain: z.string().max(253),
  domains: z.array(DomainSchema).max(200),
});

export type DmarcDomain = z.infer<typeof DomainSchema>;
export type DmarcReport = z.infer<typeof DmarcReportSchema>;

/** RFC 7489 section 7.2.1.1: an aggregate report's subject starts with "Report Domain:". */
export const isDmarcReportMail = (mail: { subject: string }): boolean => /^\s*(?:(?:fwd?|aw|wg):\s*)*report\s+domain:/i.test(mail.subject);

const owns = (domains: readonly string[], domain: string): boolean => domains.some((d) => domain === d || domain.endsWith(`.${d}`));

/** Failing messages of one domain: both checks failed (DMARC), or either failed, as configured. */
export const failuresOf = (d: DmarcDomain, failOn: DmarcFailOn): number => (failOn === "dmarc" ? d.dmarcFail : d.spf.fail + d.dkim.fail - d.dmarcFail);
const sourceFailures = (s: DmarcDomain["failing"][number], failOn: DmarcFailOn): number => (failOn === "dmarc" ? s.dmarcFail : s.count);

interface Row {
  message_id: string;
  source_id: string | null;
  subject: string | null;
  url: string | null;
  status: "read" | "refused";
  reason: string | null;
  org: string | null;
  begin_at: number | null;
  end_at: number | null;
  domains: string | null;
  filed: string | null;
  acked_at: number | null;
  created_at: number;
}

const COLUMNS = "message_id, source_id, subject, url, status, reason, org, begin_at, end_at, domains, filed, acked_at, created_at";

const domainsOf = (row: Row): DmarcDomain[] => {
  const parsed = z.array(DomainSchema).safeParse(JSON.parse(row.domains ?? "[]"));
  return parsed.success ? parsed.data : [];
};

const rowsSince = (db: Database, since: number): Row[] => db.query<Row, [number]>(`SELECT ${COLUMNS} FROM desk_mail_dmarc WHERE created_at >= ? ORDER BY created_at DESC`).all(since);

const known = (db: Database, ids: string[]): Map<string, Row> => {
  if (ids.length === 0) return new Map();
  return new Map(db.query<Row, [string]>(`SELECT ${COLUMNS} FROM desk_mail_dmarc WHERE message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)).map((r) => [r.message_id, r]));
};

export interface DmarcDeps {
  db: Database;
  config: DmarcConfig;
  mailActions: MailActionsConfig | undefined;
  ledger: TrashLedger;
  run: WriterRunner;
  now: () => number;
  log?: (line: string) => void;
}

export interface DmarcPass {
  read: number;
  refused: number;
  filed: number;
  failed: number;
}

type Outcome = { kind: "read"; report: DmarcReport } | { kind: "refused"; reason: string } | { kind: "failed"; reason: string };

async function readOne(mail: ListedMail, account: string, deps: DmarcDeps): Promise<Outcome> {
  try {
    const result = await deps.run(deps.config.command, JSON.stringify({ action: "dmarc", account, messageId: mail.id }), deps.config.timeoutSeconds * 1000);
    if (result.code === REFUSED_EXIT) return { kind: "refused", reason: oneLine(result.stderr, "The DMARC reader refused the report.") };
    if (result.code !== 0) return { kind: "failed", reason: oneLine(result.stderr || result.stdout, `exit code ${result.code}`) };
    const parsed = DmarcReportSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) return { kind: "refused", reason: "The DMARC reader printed counts the Desk could not read." };
    if (parsed.data.id !== mail.id) return { kind: "refused", reason: "The DMARC reader answered for another mail." };
    return { kind: "read", report: parsed.data };
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "refused", reason: "The DMARC reader printed counts the Desk could not read." };
    return { kind: "failed", reason: err instanceof CommandTimeout ? `the DMARC reader ${err.message}` : err instanceof Error ? err.message : String(err) };
  }
}

function store(db: Database, mail: ListedMail, outcome: Exclude<Outcome, { kind: "failed" }>, now: number): void {
  const report = outcome.kind === "read" ? outcome.report : null;
  db.query(`INSERT INTO desk_mail_dmarc (message_id, account, source_id, subject, url, status, reason, org, begin_at, end_at, domains, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`).run(
    mail.id, mail.account ?? null, mail.sourceId, mail.subject.slice(0, 300), mail.url ?? null, outcome.kind, outcome.kind === "refused" ? outcome.reason : null,
    report?.org ?? null, report ? Date.parse(report.begin) : null, report ? Date.parse(report.end) : null, report ? JSON.stringify(report.domains) : null, now,
  );
}

async function file(mail: ListedMail, deps: DmarcDeps, now: number): Promise<boolean> {
  const { db, config } = deps;
  const result = await moveMail(mail, config.after, { db, config: deps.mailActions, ledger: deps.ledger, run: deps.run, now }, config.after, mailFeatures(db, mail), {
    where: "rule",
    doneAction: "mail.move",
    title: config.after === "trash" ? "Read and deleted the DMARC report" : "Read and archived the DMARC report",
    recorded: () => { db.query("UPDATE desk_mail_dmarc SET filed = ? WHERE message_id = ?").run(config.after, mail.id); },
  });
  if (!result.ok) deps.log?.(`[desk] could not file the DMARC report ${mail.id}: ${result.error}`);
  return result.ok;
}

/**
 * Reads the DMARC aggregate reports a rule kept for the digest: each listed unread mail held by a `digest` rule whose
 * subject is an RFC 7489 report subject goes to the reader command once. Its counts are stored and the mail is then
 * archived (or deleted, per `after`) through the move contract, with Undo in Done for you. A refused report (exit 3)
 * is stored with its reason and left in the inbox; any other failure is retried on a later pass.
 */
export async function runDmarcPass(readings: readonly SourceReading[], deps: DmarcDeps): Promise<DmarcPass> {
  const { db, config } = deps;
  const pass: DmarcPass = { read: 0, refused: 0, filed: 0, failed: 0 };
  const listed = readings.filter((r) => r.error === null).flatMap((r) => r.mail.filter((m) => m.unread && isDmarcReportMail(m)).map((m): ListedMail => ({ ...m, sourceId: r.id })));
  const held = digestedIds(db, listed.map((m) => m.id));
  const seen = known(db, listed.map((m) => m.id));
  const pending = (m: ListedMail): boolean => {
    const row = seen.get(m.id);
    const unfiled = row === undefined || (row.status === "read" && !row.filed);
    return held.has(m.id) && Boolean(m.account) && movedTarget(deps.ledger, m.id) === undefined && unfiled;
  };
  const todo = listed.filter(pending);
  for (const mail of todo.slice(0, config.maxPerPass)) {
    const account = mail.account ?? "";
    if (!seen.has(mail.id)) {
      const outcome = await readOne(mail, account, deps);
      if (outcome.kind === "failed") {
        pass.failed += 1;
        deps.log?.(`[desk] could not read the DMARC report ${mail.id}: ${outcome.reason}`);
        continue;
      }
      store(db, mail, outcome, deps.now());
      if (outcome.kind === "refused") {
        pass.refused += 1;
        continue;
      }
      pass.read += 1;
    }
    if (await file(mail, deps, deps.now())) pass.filed += 1;
  }
  return pass;
}

/** Runs DMARC passes one after another, after each rule pass. */
export class DmarcLoop {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DmarcDeps, private readonly readings: () => readonly SourceReading[]) {}

  kick(): Promise<unknown> {
    this.chain = this.chain.then(() => runDmarcPass(this.readings(), this.deps)).catch((err: unknown) => {
      (this.deps.log ?? console.error)(`[desk] DMARC pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain;
  }
}

export interface DmarcWeekDomain {
  domain: string;
  owned: boolean;
  reports: number;
  messages: number;
  failures: number;
}

export interface DmarcWeek {
  from: string;
  reports: number;
  messages: number;
  failures: number;
  foreign: number;
  refused: { subject: string; reason: string }[];
  domains: DmarcWeekDomain[];
  line: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The week so far (from Monday, local time) in one line, such as "DMARC: 14 reports this week, 0 failures." Failures
 * count only domains the principal owns; reports about other domains are counted apart and never fail the line.
 */
export function dmarcWeek(db: Database, now: number, config: Pick<DmarcConfig, "domains" | "failOn">): DmarcWeek {
  const week = mirrorWeek(now);
  const rows = rowsSince(db, week.start);
  const read = rows.filter((r) => r.status === "read");
  const byDomain = new Map<string, DmarcWeekDomain>();
  let foreign = 0;
  for (const row of read) {
    const domains = domainsOf(row);
    if (domains.length > 0 && !domains.some((d) => owns(config.domains, d.domain))) foreign += 1;
    for (const d of domains) {
      const entry = byDomain.get(d.domain) ?? { domain: d.domain, owned: owns(config.domains, d.domain), reports: 0, messages: 0, failures: 0 };
      entry.reports += 1;
      entry.messages += d.messages;
      entry.failures += failuresOf(d, config.failOn);
      byDomain.set(d.domain, entry);
    }
  }
  const domains = [...byDomain.values()].sort((a, b) => Number(b.owned) - Number(a.owned) || b.messages - a.messages || a.domain.localeCompare(b.domain));
  const owned = domains.filter((d) => d.owned);
  const failures = owned.reduce((n, d) => n + d.failures, 0);
  const refused = rows.filter((r) => r.status === "refused").map((r) => ({ subject: r.subject ?? "", reason: r.reason ?? "" }));
  const extras = [foreign > 0 ? `${foreign} about other domains` : "", refused.length > 0 ? `${refused.length} could not be read` : ""].filter(Boolean);
  const line = `DMARC: ${plural(read.length, "report")} this week, ${plural(failures, "failure")}${extras.length ? ` (${extras.join(", ")})` : ""}.`;
  return { from: week.from, reports: read.length, messages: owned.reduce((n, d) => n + d.messages, 0), failures, foreign, refused, domains, line };
}

const what = (failOn: DmarcFailOn): string => (failOn === "dmarc" ? "failed SPF and DKIM" : "failed SPF or DKIM");

type FailureConfig = Pick<DmarcConfig, "domains" | "failOn">;

function failureCard(row: Row, d: DmarcDomain, config: FailureConfig, area: string | null): DeskItem | null {
  const failures = failuresOf(d, config.failOn);
  if (!owns(config.domains, d.domain) || failures === 0) return null;
  const sources = d.failing.filter((s) => sourceFailures(s, config.failOn) > 0);
  const top = sources[0];
  const from = top ? ` from ${top.ip}${sources.length > 1 ? ` and ${plural(sources.length - 1, "other source")}` : ""}` : "";
  const span = row.begin_at !== null && row.end_at !== null ? `${localDay(row.begin_at)} to ${localDay(row.end_at)}` : "the report's period";
  const reported = top ? `${plural(sourceFailures(top, config.failOn), "failing mail")} from ${top.ip}` : "failing mail";
  return {
    key: `dmarc:${row.message_id}:${d.domain}`,
    kind: "dmarc",
    source: "dmarc",
    area,
    urgency: "today",
    title: `${plural(failures, "mail")} as ${d.domain}${from} ${what(config.failOn)}.`,
    why: `${row.org ?? "A receiver"} reported ${reported} for ${span}. Someone may be sending as your domain, or one of your senders is not set up.`,
    score: 40,
    actions: [
      ...(row.url ? [{ id: "dmarc.open", label: "Open the report", role: "primary" as const, wired: true, url: row.url }] : []),
      { id: "dmarc.ack", label: "Got it", role: row.url ? "secondary" as const : "primary" as const, wired: true, target: row.message_id },
    ],
    detail: {
      summary: `${d.domain}: ${plural(d.messages, "message")} in this report, SPF failed for ${d.spf.fail}, DKIM for ${d.dkim.fail}, both for ${d.dmarcFail}. Receivers quarantined ${d.disposition.quarantine} and rejected ${d.disposition.reject}.`,
      history: sources.map((s) => `${s.ip}: ${plural(s.count, "failing mail")} (SPF ${s.spfFail}, DKIM ${s.dkimFail}, both ${s.dmarcFail})`),
      refs: [row.message_id],
      links: row.url ? [{ label: "Raw report", url: row.url }] : [],
    },
    since: row.created_at,
  };
}

/**
 * A card per report and owned domain with failures, from the last seven days, until the principal answers "Got it".
 * It names the domain, the failing source and its count, and links the raw report mail.
 */
export function dmarcItems(db: Database, now: number, config: FailureConfig, areaOf: (sourceId: string | null) => string | null = () => null): DeskItem[] {
  const rows = rowsSince(db, now - CARD_DAYS * DAY_MS).filter((r) => r.status === "read" && r.acked_at === null);
  return rows.flatMap((row) => domainsOf(row).flatMap((d) => failureCard(row, d, config, areaOf(row.source_id)) ?? []));
}

/** "Got it" on a failure card: hides every card of that report. */
export function ackDmarc(db: Database, messageId: string, now: number): boolean {
  return db.query("UPDATE desk_mail_dmarc SET acked_at = ? WHERE message_id = ? AND acked_at IS NULL").run(now, messageId).changes > 0;
}
