import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskDmarc } from "../api/desk-dmarc";
import { HandledLedger } from "../desk/actions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { ackDmarc, dmarcItems, dmarcWeek, isDmarcReportMail, runDmarcPass, type DmarcConfig, type DmarcDeps, type DmarcDomain } from "../desk/mail-dmarc";
import { queryMailLog } from "../desk/mail-log";
import { createRule, runMailRules } from "../desk/mail-rules";
import { SourceCache, type SourceMail, type SourceReading } from "../desk/sources/command";
import { DAY_MS } from "../desk/time";
import { initDatabase } from "../db/init";
import { mailDesk, queue } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-04T09:00:00.000Z");
const MOVE = ["/opt/adapters/bin/desk-mail-move.ts"];
const READER = ["/opt/adapters/bin/desk-mail-dmarc.ts"];
const CONFIG: DmarcConfig = { command: READER, domains: ["example.org"], failOn: "dmarc", after: "archive", timeoutSeconds: 30, maxPerPass: 20 };
const DESK: DeskOptions = { ...mailDesk({ move: MOVE, timeoutSeconds: 20 }), mailDmarc: CONFIG };

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const report = (id: string, subject = `Report Domain: example.org Submitter: reporter.example.net Report-ID: ${id}`, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "DMARC", address: "dmarc@reporter.example.net" }, subject, receivedAt: "2026-11-04T04:30:00.000Z", unread: true, account: "personal", url: `message://%3C${id}%3E`, ...over,
});

const reading = (mails: SourceMail[]): SourceReading => ({ id: "personal-mail", area: "personal", events: [], mail: mails, readAt: NOW, error: null, dropped: 0, problems: [] });

const domain = (name: string, over: Partial<DmarcDomain> = {}): DmarcDomain => ({
  domain: name, messages: 10, spf: { pass: 10, fail: 0 }, dkim: { pass: 10, fail: 0 }, dmarcFail: 0, disposition: { none: 10, quarantine: 0, reject: 0 }, failing: [], ...over,
});

const FAILING = domain("example.org", {
  messages: 7, spf: { pass: 2, fail: 5 }, dkim: { pass: 3, fail: 4 }, dmarcFail: 4, disposition: { none: 3, quarantine: 4, reject: 0 },
  failing: [{ ip: "203.0.113.9", count: 4, spfFail: 4, dkimFail: 4, dmarcFail: 4 }, { ip: "198.51.100.7", count: 1, spfFail: 1, dkimFail: 0, dmarcFail: 0 }],
});

const printed = (id: string, domains: DmarcDomain[]): WriterResult => ({
  code: 0, stderr: "",
  stdout: JSON.stringify({ id, org: "Reporter", reportId: `r-${id}`, begin: "2026-11-03T00:00:00.000Z", end: "2026-11-03T23:59:59.000Z", policyDomain: domains[0]?.domain ?? "example.org", domains, message: "Read." }),
});
const archived: WriterResult = { code: 0, stdout: JSON.stringify({ id: "x", folder: "Archive", message: "Moved to Archive." }), stderr: "" };

function deps(results: (WriterResult | Error)[], over: Partial<DmarcDeps> = {}) {
  const q = queue(results);
  const ledger = new HandledLedger();
  const d: DmarcDeps = { db, config: CONFIG, mailActions: DESK.mailActions, ledger, run: q.run, now: () => NOW, ...over };
  return { q, d, ledger };
}

async function digest(mails: SourceMail[], ledger = new HandledLedger()): Promise<void> {
  const r = createRule(db, { match: "subject", value: "report domain:", action: "digest" }, NOW - DAY_MS, () => "rule-dmarc");
  if (!r.ok) throw new Error(r.error);
  await runMailRules([reading(mails)], { db, mailActions: DESK.mailActions, ledger, run: queue().run, now: () => NOW, config: { proposeAfter: 8, maxPerPass: 20, windowDays: 90 } });
}

describe("which mail is a DMARC report", () => {
  it("takes the RFC 7489 subject, also forwarded, and nothing else", () => {
    expect(isDmarcReportMail({ subject: "Report domain: example.org Submitter: google.com Report-ID: 1" })).toBe(true);
    expect(isDmarcReportMail({ subject: "Fwd: Report Domain: example.org" })).toBe(true);
    expect(isDmarcReportMail({ subject: "Your weekly report: domain example.org" })).toBe(false);
  });
});

describe("the DMARC pass", () => {
  it("reads each report a digest rule holds once, stores its counts and archives it through the move contract", async () => {
    const mails = [report("r1@reporter.example.net"), report("news1", "Weekly news")];
    const { q, d, ledger } = deps([printed("r1@reporter.example.net", [FAILING]), archived]);
    await digest(mails, ledger);
    const pass = await runDmarcPass([reading(mails)], d);
    expect(pass).toEqual({ read: 1, refused: 0, filed: 1, failed: 0 });
    expect(q.calls.map((c) => [c.argv, c.stdin])).toEqual([
      [READER, { action: "dmarc", account: "personal", messageId: "r1@reporter.example.net" }],
      [MOVE, { action: "move", account: "personal", messageId: "r1@reporter.example.net", target: "archive" }],
    ]);
    expect(queryMailLog(db, { actions: ["archive"] }).map((e) => [e.messageId, e.where])).toEqual([["r1@reporter.example.net", "rule"]]);
    expect(db.query<{ title: string; action: string }, []>("SELECT title, action FROM desk_done WHERE action = 'mail.move'").all()).toEqual([{ title: "Read and archived the DMARC report: “Report Domain: example.org Submitter: reporter.example.net Report-ID: r1@reporter.example.net”", action: "mail.move" }]);
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 0, refused: 0, filed: 0, failed: 0 });
    expect(q.calls).toHaveLength(2);
  });

  it("leaves a report alone that no digest rule holds", async () => {
    const { q, d } = deps([]);
    expect(await runDmarcPass([reading([report("r1")])], d)).toEqual({ read: 0, refused: 0, filed: 0, failed: 0 });
    expect(q.calls).toEqual([]);
  });

  it("stores a refused report (exit 3) with its reason, never moves it, and shows it in the line", async () => {
    const mails = [report("bad")];
    const { q, d, ledger } = deps([{ code: 3, stdout: "", stderr: "The gzip attachment unpacks to more than 8 MiB, so it was not read.\n" }]);
    await digest(mails, ledger);
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 0, refused: 1, filed: 0, failed: 0 });
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 0, refused: 0, filed: 0, failed: 0 });
    expect(q.calls).toHaveLength(1);
    const week = dmarcWeek(db, NOW, CONFIG);
    expect(week.line).toBe("DMARC: 0 reports this week, 0 failures (1 could not be read).");
    expect(week.refused[0]?.reason).toContain("8 MiB");
  });

  it("retries after a failure that is not a refusal, and refuses counts it cannot read", async () => {
    const mails = [report("r2"), report("r3")];
    const { q, d, ledger } = deps([{ code: 1, stdout: "", stderr: "The personal mail server did not accept the connection." }, { code: 0, stdout: "{\"id\":\"r3\",\"domains\":\"lots\"}", stderr: "" }, printed("r2", [domain("example.org")]), archived]);
    await digest(mails, ledger);
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 0, refused: 1, filed: 0, failed: 1 });
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 1, refused: 0, filed: 1, failed: 0 });
    expect(q.calls.map((c) => (c.stdin as { messageId: string }).messageId)).toEqual(["r2", "r3", "r2", "r2"]);
  });

  it("retries only the move when the report was read but could not be filed", async () => {
    const mails = [report("r4")];
    const { q, d, ledger } = deps([printed("r4", [domain("example.org")]), { code: 1, stdout: "", stderr: "The personal account has no Archive mailbox, so nothing was moved." }, archived]);
    await digest(mails, ledger);
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 1, refused: 0, filed: 0, failed: 0 });
    expect(await runDmarcPass([reading(mails)], d)).toEqual({ read: 0, refused: 0, filed: 1, failed: 0 });
    expect(q.calls.map((c) => c.argv)).toEqual([READER, MOVE, MOVE]);
  });
});

async function seed(rows: [string, DmarcDomain[]][]): Promise<void> {
  const mails = rows.map(([id]) => report(id));
  const { d, ledger } = deps(rows.flatMap(([id, domains]) => [printed(id, domains), archived]));
  await digest(mails, ledger);
  await runDmarcPass([reading(mails)], d);
}

describe("the weekly line", () => {
  it("counts every report, fails only on owned domains, and counts foreign reports apart", async () => {
    await seed([["a", [domain("example.org")]], ["b", [FAILING]], ["c", [domain("other.example", { dmarcFail: 9, failing: [{ ip: "192.0.2.1", count: 9, spfFail: 9, dkimFail: 9, dmarcFail: 9 }] })]]]);
    const week = dmarcWeek(db, NOW, CONFIG);
    expect(week.line).toBe("DMARC: 3 reports this week, 4 failures (1 about other domains).");
    expect(week.domains.map((d) => [d.domain, d.owned, d.reports, d.failures])).toEqual([["example.org", true, 2, 4], ["other.example", false, 1, 9]]);
    expect(dmarcWeek(db, NOW, { ...CONFIG, failOn: "spf-or-dkim" }).failures).toBe(5);
    expect(dmarcWeek(db, NOW + 7 * DAY_MS, CONFIG).line).toBe("DMARC: 0 reports this week, 0 failures.");
  });

  it("counts a subdomain of an owned domain as owned", async () => {
    await seed([["s", [domain("news.example.org", { dmarcFail: 2, failing: [{ ip: "192.0.2.5", count: 2, spfFail: 2, dkimFail: 2, dmarcFail: 2 }] })]]]);
    expect(dmarcWeek(db, NOW, CONFIG).failures).toBe(2);
  });
});

describe("failure cards", () => {
  it("raise a card only for an owned domain with failures: domain, failing source, count and the raw report", async () => {
    await seed([["ok", [domain("example.org")]], ["bad", [FAILING]], ["foreign", [domain("other.example", { dmarcFail: 3, failing: [{ ip: "192.0.2.1", count: 3, spfFail: 3, dkimFail: 3, dmarcFail: 3 }] })]]]);
    const items = dmarcItems(db, NOW, CONFIG, () => "personal");
    expect(items).toHaveLength(1);
    const [card] = items;
    expect(card?.key).toBe("dmarc:bad:example.org");
    expect(card?.title).toBe("4 mails as example.org from 203.0.113.9 failed SPF and DKIM.");
    expect(card?.area).toBe("personal");
    expect(card?.actions.map((a) => [a.id, a.url ?? a.target])).toEqual([["dmarc.open", "message://%3Cbad%3E"], ["dmarc.ack", "bad"]]);
    expect(card?.detail.links).toEqual([{ label: "Raw report", url: "message://%3Cbad%3E" }]);
    expect(card?.detail.history).toEqual(["203.0.113.9: 4 failing mails (SPF 4, DKIM 4, both 4)"]);
  });

  it("with failOn spf-or-dkim, an SPF-only failure raises a card too", async () => {
    await seed([["spf", [domain("example.org", { spf: { pass: 7, fail: 3 }, failing: [{ ip: "198.51.100.7", count: 3, spfFail: 3, dkimFail: 0, dmarcFail: 0 }] })]]]);
    expect(dmarcItems(db, NOW, CONFIG)).toEqual([]);
    expect(dmarcItems(db, NOW, { ...CONFIG, failOn: "spf-or-dkim" }).map((i) => i.title)).toEqual(["3 mails as example.org from 198.51.100.7 failed SPF or DKIM."]);
  });

  it("Got it hides the card; it also goes after seven days", async () => {
    await seed([["bad", [FAILING]]]);
    expect(dmarcItems(db, NOW + 8 * DAY_MS, CONFIG)).toEqual([]);
    expect(ackDmarc(db, "bad", NOW)).toBe(true);
    expect(ackDmarc(db, "bad", NOW)).toBe(false);
    expect(dmarcItems(db, NOW, CONFIG)).toEqual([]);
  });
});

describe("the Desk view and the API", () => {
  const runtime = (): DeskRuntime => ({ options: DESK, ledger: new HandledLedger() });

  it("puts the line in the health area and the weekly mirror, and the card on the Desk", async () => {
    await seed([["bad", [FAILING]]]);
    const cache = new SourceCache(async () => ({ code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }));
    const view = await composeDesk(db, DESK, undefined, { now: NOW, sourceCache: cache });
    expect(view.dmarc?.line).toBe("DMARC: 1 report this week, 4 failures.");
    expect(view.mirror?.dmarc?.line).toBe("DMARC: 1 report this week, 4 failures.");
    expect(view.items.filter((i) => i.kind === "dmarc").map((i) => i.key)).toEqual(["dmarc:bad:example.org"]);
    const plain = await composeDesk(db, { ...DESK, mailDmarc: undefined }, undefined, { now: NOW, sourceCache: cache });
    expect(plain.dmarc).toBeUndefined();
    expect(plain.items.some((i) => i.kind === "dmarc")).toBe(false);
  });

  it("POST ack answers Got it once; GET returns the week; a stack without DMARC refuses", async () => {
    await seed([["bad", [FAILING]]]);
    const post = (body: unknown): Request => new Request("http://x/api/desk/mail/dmarc", { method: "POST", body: JSON.stringify(body) });
    expect((await handleDeskDmarc(post({ op: "ack", report: "bad" }), db, runtime(), () => NOW)).status).toBe(200);
    expect((await handleDeskDmarc(post({ op: "ack", report: "bad" }), db, runtime(), () => NOW)).status).toBe(404);
    expect((await handleDeskDmarc(post({ op: "ack" }), db, runtime(), () => NOW)).status).toBe(400);
    const week = (await (await handleDeskDmarc(new Request("http://x/api/desk/mail/dmarc"), db, runtime(), () => NOW)).json()) as { week: { reports: number } };
    expect(week.week.reports).toBe(1);
    expect((await handleDeskDmarc(new Request("http://x/api/desk/mail/dmarc"), db, { options: { ...DESK, mailDmarc: undefined }, ledger: new HandledLedger() }, () => NOW)).status).toBe(409);
  });
});
