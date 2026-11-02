import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { handleDeskMailRules } from "../api/desk-mail-rules";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { logMailDecision, type MailFeatures, type MailLogAction, type MailLogWhere } from "../desk/mail-log";
import { mailMirror, mirrorListKey, readMailMirror } from "../desk/mail-mirror";
import { createRule, listRules } from "../desk/mail-rules";
import { mirrorWeek } from "../desk/mirror";
import { addVip } from "../desk/vips";
import { initDatabase } from "../db/init";
import { MirrorMail, timeLine } from "../dashboard-v2/components/desk-mirror-mail";
import { composeWith, MOVE_DESK } from "./desk-mail-fixtures";

const NOW = new Date(2026, 9, 29, 12).getTime();
const WEEK = mirrorWeek(NOW);
const HOUR = 3_600_000;

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const features = (id: string, sender: string, listId: string | null = null): MailFeatures => ({
  messageId: id, account: "work", sourceId: "work-mail", sender, senderDomain: sender.slice(sender.indexOf("@") + 1), listId, category: null, subject: `Subject ${id}`, summary: null,
});
const log = (id: string, sender: string, action: MailLogAction, where: MailLogWhere, at: number, listId: string | null = null): number =>
  logMailDecision(db, features(id, sender, listId), action, where, at);
const run = (id: string, rule: string, at: number, undoneAt: number | null = null, status = "done"): void => {
  db.query("INSERT INTO desk_mail_rule_runs (id, rule_id, message_id, action, status, created_at, undone_at) VALUES (?, ?, ?, 'archive', ?, ?, ?)").run(id, rule, `m-${id}`, status, at, undoneAt);
};
const rule = (match: string, value: string, id: string): void => {
  expect(createRule(db, { match, value, action: "archive" }, WEEK.start, () => id).ok).toBe(true);
};

function fixtureWeek(): void {
  log("n1", "letters@news.example", "archive", "desk", WEEK.start + HOUR, "<Weekly.News.Example>");
  log("n2", "letters@news.example", "archive", "client", WEEK.start + 2 * HOUR, "<weekly.news.example>");
  log("n3", "letters@news.example", "trash", "desk", WEEK.start + 3 * HOUR, "<weekly.news.example>");
  log("a1", "ada@people.example", "kept", "client", WEEK.start + 4 * HOUR);
  log("a2", "ada@people.example", "draft", "desk", WEEK.start + 5 * HOUR);
  log("r1", "bot@ci.example", "archive", "rule", WEEK.start + 6 * HOUR);
  log("old", "letters@news.example", "archive", "desk", WEEK.start - HOUR, "<weekly.news.example>");
}

describe("mail in the weekly mirror", () => {
  it("counts one week's decisions by action, where and sender from the log", () => {
    fixtureWeek();
    const m = readMailMirror(db, WEEK);
    expect(m.decisions).toBe(6);
    expect(m.mails).toBe(6);
    expect(m.byAction).toEqual([{ key: "archive", count: 3 }, { key: "draft", count: 1 }, { key: "kept", count: 1 }, { key: "trash", count: 1 }]);
    expect(m.byWhere).toEqual([{ key: "desk", count: 3 }, { key: "client", count: 2 }, { key: "rule", count: 1 }]);
    expect(m.senders).toEqual([{ kind: "list", value: "<weekly.news.example>", decisions: 3 }, { kind: "sender", value: "ada@people.example", decisions: 2 }]);
    expect(m.partial).toBe(false);
    const direct = (column: "action" | "origin") => db.query<{ key: string; count: number }, [number, number]>(`SELECT ${column} AS key, COUNT(*) AS count FROM desk_mail_log WHERE created_at >= ? AND created_at < ? GROUP BY ${column} ORDER BY count DESC, key`).all(WEEK.start, WEEK.end);
    expect(m.byAction).toEqual(direct("action") as typeof m.byAction);
    expect(m.byWhere).toEqual(direct("origin") as typeof m.byWhere);
  });

  it("counts a to-do made in an Ivy conversation as the principal's own decision (PRINCIPAL, ACTED)", () => {
    log("c1", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("c1", "ada@people.example", "todo", "conversation", WEEK.start + HOUR + 10 * 60_000);
    const m = readMailMirror(db, WEEK);
    expect(m.byWhere).toEqual([{ key: "conversation", count: 1 }]);
    expect(m.senders).toEqual([{ kind: "sender", value: "ada@people.example", decisions: 1 }]);
    expect(m.time).toEqual({ mails: 1, totalMs: 600_000, medianMs: 600_000, capped: 0, untimed: 0, capMs: 900_000 });
    expect(renderToStaticMarkup(createElement(MirrorMail, { mail: m, dmarc: null }))).toContain("In an Ivy conversation");
  });

  it("invents no time: time appears only for mails the log saw opened and then acted on", () => {
    fixtureWeek();
    expect(readMailMirror(db, WEEK).time).toBeNull();
    log("t1", "ada@people.example", "opened", "desk", WEEK.start + 10 * HOUR);
    log("t1", "ada@people.example", "archive", "desk", WEEK.start + 10 * HOUR + 120_000);
    log("t2", "ada@people.example", "opened", "desk", WEEK.start + 11 * HOUR);
    const m = readMailMirror(db, WEEK);
    expect(m.time).toEqual({ mails: 1, totalMs: 120_000, medianMs: 120_000, capped: 0, untimed: 1, capMs: 900_000 });
    expect(m.byAction.some((a) => a.key === "opened")).toBe(false);
    const html = renderToStaticMarkup(createElement(MirrorMail, { mail: readMailMirror(db, { start: WEEK.start, end: WEEK.start + 9 * HOUR }), dmarc: null }));
    expect(html).toContain("Time on mail is not measured: no mail was opened on the Desk this week.");
  });

  it("caps an idle gap, and lets neither a client decision nor a read-and-kept end a Desk open", () => {
    log("x1", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("x1", "ada@people.example", "archive", "desk", WEEK.start + 3 * HOUR);
    log("x2", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("x2", "ada@people.example", "opened", "desk", WEEK.start + HOUR + 60_000);
    log("x2", "ada@people.example", "draft", "desk", WEEK.start + HOUR + 240_000);
    log("x3", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("x3", "ada@people.example", "kept", "client", WEEK.start + HOUR + 60_000);
    log("x4", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("x4", "ada@people.example", "archive", "client", WEEK.start + HOUR + 60_000);
    const m = readMailMirror(db, WEEK);
    expect(m.time).toEqual({ mails: 2, totalMs: 900_000 + 240_000, medianMs: (900_000 + 240_000) / 2, capped: 1, untimed: 2, capMs: 900_000 });
    expect(timeLine(m.time)).toBe("Open to decision on the Desk: 19.0 min over 2 mails, median 9.5 min. Each mail counts from its first open on the Desk to your next decision there, at most 15 min. 1 mail took longer and counts as 15 min. 2 mails opened on the Desk had no decision there and are not timed. Mail read only in your mail program is not timed.");
    expect(readMailMirror(db, WEEK, { config: { checkAfterUndos: 2, archivedUnread: 3, top: 5, openCapMinutes: 1 } }).time).toMatchObject({ mails: 2, totalMs: 120_000, capped: 2, capMs: 60_000 });
  });

  it("says no time is shown when mails were opened on the Desk but none was decided there", () => {
    log("y1", "ada@people.example", "opened", "desk", WEEK.start + HOUR);
    log("y1", "ada@people.example", "kept", "client", WEEK.start + 2 * HOUR);
    const m = readMailMirror(db, WEEK);
    expect(m.time).toEqual({ mails: 0, totalMs: 0, medianMs: 0, capped: 0, untimed: 1, capMs: 900_000 });
    expect(renderToStaticMarkup(createElement(MirrorMail, { mail: m, dmarc: null }))).toContain("Time on mail is not measured yet: no mail opened on the Desk was decided there this week. 1 mail opened on the Desk had no decision there and is not timed.");
  });

  it("lists a rule undone more than the threshold as check this rule, counting undos made this week", () => {
    rule("sender", "bot@ci.example", "busy");
    rule("sender", "quiet@ci.example", "quiet");
    run("b1", "busy", WEEK.start - 2 * HOUR, WEEK.start + HOUR);
    run("b2", "busy", WEEK.start + HOUR, WEEK.start + 2 * HOUR);
    run("b3", "busy", WEEK.start + HOUR + 1, null, "failed");
    run("q1", "quiet", WEEK.start + HOUR, WEEK.start + 2 * HOUR);
    run("q2", "quiet", WEEK.start + HOUR + 1, WEEK.start + 2 * HOUR);
    run("q3", "quiet", WEEK.start + HOUR + 2);
    const at2 = readMailMirror(db, WEEK);
    expect(at2.rules.find((r) => r.id === "busy")).toMatchObject({ runs: 1, failed: 1, undone: 2, check: false });
    expect(at2.rules.find((r) => r.id === "quiet")).toMatchObject({ runs: 3, undone: 2, check: false });
    expect(at2.checkRules).toEqual([]);
    run("b4", "busy", WEEK.start + 3 * HOUR, WEEK.start + 4 * HOUR);
    const at3 = readMailMirror(db, WEEK);
    expect(at3.checkRules.map((r) => r.id)).toEqual(["busy"]);
    expect(readMailMirror(db, WEEK, { config: { checkAfterUndos: 1, archivedUnread: 3, top: 5, openCapMinutes: 15 } }).checkRules.map((r) => r.id)).toEqual(["busy", "quiet"]);
    const html = renderToStaticMarkup(createElement(MirrorMail, { mail: at3, dmarc: null }));
    expect(html).toContain("Check this rule");
    expect(html).toContain("Disable");
    expect(html).toContain("Edit");
  });

  it("lists senders archived unread repeatedly with Make a rule and, when a listed mail offers it, Unsubscribe", () => {
    fixtureWeek();
    log("p1", "promo@shop.example", "archive", "desk", WEEK.start + HOUR);
    log("p2", "promo@shop.example", "archive", "client", WEEK.start + 2 * HOUR);
    log("p3", "promo@shop.example", "archive", "desk", WEEK.start + 3 * HOUR);
    log("p3", "promo@shop.example", "restore", "desk", WEEK.start + 4 * HOUR);
    log("v1", "boss@work.example", "archive", "desk", WEEK.start + HOUR);
    log("v2", "boss@work.example", "archive", "desk", WEEK.start + 2 * HOUR);
    log("v3", "boss@work.example", "archive", "desk", WEEK.start + 3 * HOUR);
    addVip(db, "boss@work.example", null, NOW);
    const key = mirrorListKey({ listId: "<weekly.news.example>", sender: "letters@news.example" });
    const offers = new Map([[key, { key: "mail:n9", view: { kind: "one-click" as const, host: "news.example" } }]]);
    const m = readMailMirror(db, WEEK, { offers });
    expect(m.archivedUnread).toEqual([{ kind: "list", value: "<weekly.news.example>", count: 3, rule: { match: "list", value: "<weekly.news.example>", action: "archive", sentence: "Archive mail from the list <weekly.news.example>" }, unsubscribe: { key: "mail:n9", view: { kind: "one-click", host: "news.example" } } }]);
    log("p4", "promo@shop.example", "trash", "client", WEEK.start + 5 * HOUR);
    expect(readMailMirror(db, WEEK).archivedUnread.map((u) => u.value)).toEqual(["<weekly.news.example>", "promo@shop.example"]);
    rule("list", "<weekly.news.example>", "news");
    expect(readMailMirror(db, WEEK).archivedUnread.map((u) => u.value)).toEqual(["promo@shop.example"]);
    const html = renderToStaticMarkup(createElement(MirrorMail, { mail: m, dmarc: null }));
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("Make a rule: Archive mail from the list &lt;weekly.news.example&gt;");
  });

  it("is pure over the input: rows outside the week and unknown rules do not count", () => {
    const m = mailMirror({ start: WEEK.start, end: WEEK.end, entries: [], runs: [{ ruleId: "gone", status: "done", at: WEEK.start + 1, undoneAt: WEEK.start + 2 }], rules: [], vips: new Set() });
    expect(m).toMatchObject({ decisions: 0, mails: 0, rules: [], checkRules: [], archivedUnread: [], time: null });
    expect(renderToStaticMarkup(createElement(MirrorMail, { mail: m, dmarc: null }))).toBe("");
  });

  it("Make a rule creates the rule through the rules API and refuses a bad value", async () => {
    const rt: DeskRuntime = { options: MOVE_DESK, ledger: new HandledLedger() };
    const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const bad = await handleDeskMailRules(post({ op: "create", match: "sender", value: "not-an-address", action: "archive" }), db, rt, { now: () => NOW });
    expect(bad.status).toBe(400);
    const ok = await handleDeskMailRules(post({ op: "create", match: "sender", value: "Promo@Shop.example", action: "archive" }), db, rt, { now: () => NOW, newId: () => "made" });
    expect(ok.status).toBe(200);
    expect(listRules(db).map((r) => [r.id, r.match, r.value, r.action])).toEqual([["made", "sender", "promo@shop.example", "archive"]]);
    expect((await handleDeskMailRules(post({ op: "create", match: "sender", value: "promo@shop.example", action: "trash" }), db, rt, { now: () => NOW })).status).toBe(409);
  });

  it("the composed Desk carries the mail section in its mirror", async () => {
    fixtureWeek();
    const view = await composeWith(db, MOVE_DESK, { options: MOVE_DESK, ledger: new HandledLedger() }, NOW);
    expect(view.mirror?.mail?.decisions).toBe(6);
  });
});
