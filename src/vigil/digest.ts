import type { Database } from "bun:sqlite";
import type { NotifyResult } from "../adapters/types";
import { budgetDay, budgetDayStartedToday, VIGIL_DAILY_TEXT_LIMIT } from "./budget";
import { channelValue, recordChannel } from "./channels";
import { getVigilSubject, getVigilTextsSpent, type VigilEventRow } from "./db";
import type { FlushTextsOptions } from "./flush";
import { openProposals, proposalDigestLines } from "./proposals";
import { pendingResults } from "./results";
import { renderResult, type ResultRenderOptions } from "./result-render";
import { createVigilRenderer } from "./render";

type BuildDigestOptions = Pick<FlushTextsOptions, "db" | "now" | "resolveGoalWording"> & ResultRenderOptions;
export type SendDigestOptions = BuildDigestOptions & Pick<FlushTextsOptions, "send" | "fallback">;

const DIGEST_LIMIT = 1950;
const activeDigests = new WeakMap<Database, Promise<void>>();
const sections = ["Held back", "Worse", "Stale", "proposals", "waiting for you", "Recovered"] as const;
type Section = typeof sections[number];

function digestSection(event: VigilEventRow): Section | null {
  if (event.delivery === "held") return "Held back";
  if (event.delivery !== "pending") return null;
  if (event.direction === "better") return "Recovered";
  if (event.route !== "digest") return null;
  return event.to_value === "stale" ? "Stale" : "Worse";
}

function digestAt(db: Database, day: string): number | null {
  return db.query<{ digest_at: number | null }, [string]>(
    "SELECT digest_at FROM vigil_budget WHERE budget_day = ?",
  ).get(day)?.digest_at ?? null;
}

function markDigestDone(db: Database, day: string, now: number): void {
  db.query(`INSERT INTO vigil_budget (budget_day, digest_at) VALUES (?, ?)
    ON CONFLICT(budget_day) DO UPDATE SET digest_at = excluded.digest_at`).run(day, now);
}

function renderLines(lines: readonly { section: Section; text: string }[], budget: string, omitted = 0): string {
  const output: string[] = [];
  let heading: Section | undefined;
  for (const line of lines) {
    if (line.section !== heading) output.push(line.section);
    output.push(line.text);
    heading = line.section;
  }
  if (omitted > 0) output.push(`… ${omitted} more in Mission Control`);
  output.push(budget);
  return output.join("\n");
}

async function prepareDigest(options: BuildDigestOptions) {
  const { db, now, resolveGoalWording } = options;
  const events = db.query<VigilEventRow, []>(`SELECT * FROM vigil_events
    WHERE delivery IN ('held', 'pending') ORDER BY occurred_at, rowid`).all();
  const included = events.filter((event) => digestSection(event) !== null);
  const results = pendingResults(db);
  const proposals = openProposals(db, now);
  const lastDigest = db.query<{ digest_at: number | null }, []>("SELECT MAX(digest_at) AS digest_at FROM vigil_budget").get()?.digest_at ?? null;
  const proposalLines = await proposalDigestLines(proposals, now, lastDigest, options);
  if (included.length === 0 && results.length === 0 && proposalLines.length === 0) return null;
  const render = createVigilRenderer({ resolveGoalWording });
  const lines: { section: Section; text: string }[] = [];
  for (const section of sections) {
    if (section === "proposals") {
      for (const text of proposalLines) lines.push({ section, text });
    }
    if (section === "waiting for you") {
      for (const result of results) lines.push({ section, text: await renderResult(result, options) });
    }
    for (const event of included.filter((row) => digestSection(row) === section)) {
      const subject = getVigilSubject(db, event.subject_key);
      if (!subject) throw new Error(`Vigil digest has no subject: ${event.subject_key}`);
      lines.push({ section, text: (await render(event, subject)).replace(/[\r\n]+/g, " ") });
    }
  }
  const yesterday = new Date(`${budgetDay(now)}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const spent = getVigilTextsSpent(db, yesterday.toISOString().slice(0, 10));
  const budget = `Budget: ${spent} of ${VIGIL_DAILY_TEXT_LIMIT} texts yesterday · DM ${channelValue(db, "dm-channel")} · email ${channelValue(db, "email-channel")}`;
  const totalLines = lines.length;
  let text = renderLines(lines, budget);
  while (text.length > DIGEST_LIMIT) {
    lines.pop();
    text = renderLines(lines, budget, totalLines - lines.length);
  }
  return { text, events: included, results, proposals };
}

export async function buildDigest(options: BuildDigestOptions): Promise<string | null> {
  return (await prepareDigest(options))?.text ?? null;
}

export function sendDigest(options: SendDigestOptions): Promise<void> {
  const active = activeDigests.get(options.db);
  if (active) return active;
  const sending = deliverDigest(options).finally(() => { activeDigests.delete(options.db); });
  activeDigests.set(options.db, sending);
  return sending;
}

async function deliverDigest(options: SendDigestOptions): Promise<void> {
  const { db, now, send, fallback } = options;
  const day = budgetDay(now);
  if (digestAt(db, day) !== null) return;
  const digest = await prepareDigest(options);
  if (digest === null) {
    markDigestDone(db, day, now);
    return;
  }
  let via: "dm" | "email" | null = null;
  let dmResult: NotifyResult = { delivered: false, kind: "permanent", code: "no-adapter" };
  try {
    if (send) dmResult = await send(digest.text);
  } catch {
    dmResult = { delivered: false, kind: "transient", code: "exception" };
  }
  if (dmResult.delivered) via = "dm";
  recordChannel(db, "dm-channel", via === "dm" ? "ok" : "regressed", now);
  if (via === null && fallback) {
    let result: Awaited<ReturnType<NonNullable<SendDigestOptions["fallback"]>>>;
    try {
      result = await fallback(`[Vigil] digest ${day}`, digest.text);
    } catch {
      result = { ok: false, error: "exception" };
    }
    recordChannel(db, "email-channel", result.ok ? "ok" : "regressed", now);
    if (result.ok) via = "email";
  }
  if (via === null) {
    console.warn(`Vigil: digest ${day} undelivered; retrying next tick`);
    return;
  }
  db.transaction(() => {
    for (const event of digest.events) {
      db.query(`UPDATE vigil_events SET delivery = 'digested', digested_at = ?, via = ?
        WHERE id = ? AND delivery IN ('held', 'pending')`).run(now, via, event.id);
    }
    for (const result of digest.results) {
      db.query("UPDATE vigil_results SET digested_version = MAX(digested_version, ?) WHERE result_ref = ?")
        .run(result.version, result.result_ref);
    }
    for (const proposal of digest.proposals) {
      db.query("UPDATE vigil_proposals SET digested_version = MAX(digested_version, ?) WHERE proposal_ref = ?")
        .run(proposal.version, proposal.proposal_ref);
    }
    markDigestDone(db, day, now);
  })();
}

export async function maybeSendDigest(options: SendDigestOptions): Promise<void> {
  if (!budgetDayStartedToday(options.now) || digestAt(options.db, budgetDay(options.now)) !== null) return;
  await sendDigest(options);
}
