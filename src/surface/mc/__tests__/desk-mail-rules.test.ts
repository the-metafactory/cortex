import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMailRules } from "../api/desk-mail-rules";
import { HandledLedger } from "../desk/actions";
import { listGrants, setGrant } from "../desk/autonomy";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { logMailDecision, queryMailLog, type MailFeatures, type MailLogAction, type MailLogWhere } from "../desk/mail-log";
import {
  answerProposal, createRule, listRules, MailRuleLoop, matchesRule, pendingRuleMail, proposeRules, releaseRule, ruleRuns, runMailRules, setRuleOn, undoRuleRun,
  type MailRulesConfig, type RulePassDeps,
} from "../desk/mail-rules";
import { SourceCache, type SourceMail, type SourceReading } from "../desk/sources/command";
import { DAY_MS } from "../desk/time";
import { addVip } from "../desk/vips";
import { initDatabase } from "../db/init";
import { activeMailLink, attachMail, linkStudioMail, undoAttach } from "../desk/links";
import { ruleAttach } from "../desk/rule-attach";
import { saveBalanceState } from "../desk/balance-store";
import { snoozeMail } from "../desk/mail-snooze";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { mailDesk, queue } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const MOVE = ["/opt/adapters/bin/desk-mail-move.ts"];
const DESK: DeskOptions = mailDesk({ move: MOVE, timeoutSeconds: 20 });
const CONFIG: MailRulesConfig = { proposeAfter: 8, maxPerPass: 20, windowDays: 90 };

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const features = (id: string, sender: string, listId: string | null = null): MailFeatures => ({
  messageId: id, account: "work", sourceId: "work-mail", sender, senderDomain: sender.slice(sender.indexOf("@") + 1), listId, category: null, subject: `Report ${id}`, summary: null,
});

function decide(n: number, sender: string, action: MailLogAction = "archive", where: MailLogWhere = "desk", prefix = sender, listId: string | null = null): void {
  for (let i = 0; i < n; i++) logMailDecision(db, features(`${prefix}-${i}`, sender, listId), action, where, NOW - (i + 1) * 60_000, null);
}

const mail = (id: string, address: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Sender", address }, subject: `Report ${id}`, receivedAt: "2026-11-01T08:00:00.000Z", unread: true, account: "work", ...over,
});

const reading = (mails: SourceMail[]): SourceReading => ({ id: "work-mail", area: null, events: [], mail: mails, readAt: NOW, error: null, dropped: 0, problems: [] });

const moved = (id: string): WriterResult => ({ code: 0, stdout: JSON.stringify({ id, folder: "Archive", message: "Moved to Archive." }), stderr: "" });

let ids = 0;
function passDeps(results: (WriterResult | Error)[] = [], over: Partial<RulePassDeps> = {}) {
  const q = queue(results);
  const deps: RulePassDeps = { db, mailActions: DESK.mailActions, ledger: new HandledLedger(), run: q.run, now: () => NOW, config: CONFIG, newId: () => `run-${++ids}`, ...over };
  return { q, deps };
}

const approve = (sender: string, action: "archive" | "junk" | "trash" | "digest" = "archive", match: "sender" | "domain" | "list" | "subject" = "sender"): string => {
  const r = createRule(db, { match, value: sender, action }, NOW, () => `rule-${sender}`);
  if (!r.ok) throw new Error(r.error);
  return `rule-${sender}`;
};

describe("rule proposals from the decision log", () => {
  it("proposes after 8 agreeing decisions and not after 7", () => {
    decide(7, "reports@dmarc.example");
    expect(proposeRules(db, NOW, CONFIG)).toEqual([]);
    decide(1, "reports@dmarc.example", "archive", "client", "late");
    const [p, ...rest] = proposeRules(db, NOW, CONFIG);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ match: "sender", value: "reports@dmarc.example", action: "archive", agreeing: 8 });
    expect(p?.examples).toHaveLength(5);
  });

  it("proposes nothing when one decision disagrees: another action, an Undo or a mail kept", () => {
    for (const counter of ["trash", "restore", "kept"] as const) {
      db.exec("DELETE FROM desk_mail_log");
      decide(10, "news@shop.example");
      decide(1, "news@shop.example", counter, counter === "kept" ? "client" : "desk", `counter-${counter}`);
      expect(proposeRules(db, NOW, CONFIG)).toEqual([]);
    }
  });

  it("counts a to-do made in an Ivy conversation as a counter-example, like one made on the Desk", () => {
    for (const where of ["desk", "conversation"] as const) {
      db.exec("DELETE FROM desk_mail_log");
      decide(10, "news@shop.example");
      expect(proposeRules(db, NOW, CONFIG)).toHaveLength(1);
      decide(1, "news@shop.example", "todo", where, `todo-${where}`);
      expect(proposeRules(db, NOW, CONFIG)).toEqual([]);
    }
  });

  it("ignores what rules did, decisions outside the window and a VIP's mail", () => {
    decide(10, "bot@ci.example", "archive", "rule");
    logMailDecision(db, features("old", "bot@ci.example"), "archive", "desk", NOW - 100 * DAY_MS);
    decide(7, "bot@ci.example");
    expect(proposeRules(db, NOW, CONFIG)).toEqual([]);
    decide(9, "boss@corp.example");
    addVip(db, "boss@corp.example", null, NOW);
    expect(proposeRules(db, NOW, CONFIG).map((p) => p.value)).toEqual([]);
  });

  it("prefers a List-Id, and proposes a domain only for two or more senders", () => {
    decide(8, "a@lists.example", "archive", "desk", "a", "<weekly.lists.example>");
    expect(proposeRules(db, NOW, CONFIG).map((p) => `${p.match}:${p.value}`)).toEqual(["list:<weekly.lists.example>"]);
    db.exec("DELETE FROM desk_mail_log");
    decide(4, "a@shop.example", "junk");
    decide(4, "b@shop.example", "junk");
    expect(proposeRules(db, NOW, CONFIG).map((p) => `${p.match}:${p.value}:${p.action}`)).toEqual(["domain:shop.example:junk"]);
  });

  it("creates no rule without Approve; Not now hides it for a week, Never for good", () => {
    decide(8, "reports@dmarc.example");
    const key = proposeRules(db, NOW, CONFIG)[0]?.key ?? "";
    expect(listRules(db)).toEqual([]);
    expect(answerProposal(db, key, "later", NOW, CONFIG).ok).toBe(true);
    expect(proposeRules(db, NOW + DAY_MS, CONFIG)).toEqual([]);
    expect(proposeRules(db, NOW + 8 * DAY_MS, CONFIG).map((p) => p.key)).toEqual([key]);
    expect(answerProposal(db, key, "never", NOW + 8 * DAY_MS, CONFIG).ok).toBe(true);
    expect(proposeRules(db, NOW + 30 * DAY_MS, CONFIG)).toEqual([]);
    expect(listRules(db)).toEqual([]);
    expect(answerProposal(db, key, "approve", NOW, CONFIG)).toEqual({ ok: false, status: 409, error: "That proposal is gone: the log no longer supports it, or you already answered it." });
  });

  it("Approve creates the rule and turns on the mail.rules grant", () => {
    decide(8, "reports@dmarc.example");
    const key = proposeRules(db, NOW, CONFIG)[0]?.key ?? "";
    const r = answerProposal(db, key, "approve", NOW, CONFIG, () => "r1");
    expect(r).toMatchObject({ ok: true, rule: { id: "r1", sentence: "Archive mail from reports@dmarc.example", on: true, count: 0 } });
    expect(listGrants(db).has("mail.rules")).toBe(true);
    expect(proposeRules(db, NOW, CONFIG)).toEqual([]);
  });
});

describe("matching", () => {
  it("matches sender, the exact domain its evidence came from, List-Id and subject text", () => {
    const m = mail("x", "Alerts@Mx.Shop.Example", { subject: "Your DMARC Aggregate Report", headers: { listId: "<Alerts.Shop.Example>" } });
    expect(matchesRule({ match: "sender", value: "alerts@mx.shop.example" }, m)).toBe(true);
    expect(matchesRule({ match: "domain", value: "mx.shop.example" }, m)).toBe(true);
    expect(matchesRule({ match: "domain", value: "shop.example" }, m)).toBe(false);
    expect(matchesRule({ match: "domain", value: "hop.example" }, m)).toBe(false);
    expect(matchesRule({ match: "list", value: "<alerts.shop.example>" }, m)).toBe(true);
    expect(matchesRule({ match: "subject", value: "dmarc aggregate" }, m)).toBe(true);
  });
});

describe("rule passes", () => {
  it("moves matching mail through the move contract and writes Done for you", async () => {
    approve("reports@dmarc.example");
    const { q, deps } = passDeps([moved("m1")]);
    const pass = await runMailRules([reading([mail("m1", "reports@dmarc.example"), mail("m2", "ada@other.example")])], deps);
    expect(pass).toEqual({ handled: 1, failed: 0, paused: [] });
    expect(q.calls.map((c) => c.stdin)).toEqual([{ action: "move", account: "work", messageId: "m1", target: "archive" }]);
    expect(db.query("SELECT action, title, status FROM desk_done").all()).toEqual([{ action: "mail.rule", title: "Archived by your rule: “Report m1”", status: "done" }]);
    expect(queryMailLog(db).map((e) => [e.messageId, e.action, e.where])).toEqual([["m1", "archive", "rule"]]);
    expect(listRules(db)[0]).toMatchObject({ count: 1, lastRunAt: NOW });
  });

  it("skips a mail attached to a task", async () => {
    approve("reports@dmarc.example");
    attachMail(db, { ...mail("m1", "reports@dmarc.example"), sourceId: "work-mail" }, { kind: "task", key: "kickoff", title: "Kickoff prep" }, { id: "link-1", requestId: "attach-1", origin: "desk", now: NOW });
    const { q, deps } = passDeps([moved("m2")]);
    expect(await runMailRules([reading([mail("m1", "reports@dmarc.example"), mail("m2", "reports@dmarc.example")])], deps)).toEqual({ handled: 1, failed: 0, paused: [] });
    expect(q.calls.map((c) => (c.stdin as { messageId: string }).messageId)).toEqual(["m2"]);
  });

  it("never touches a VIP's mail", async () => {
    approve("corp.example", "archive", "domain");
    addVip(db, "boss@corp.example", null, NOW);
    const { q, deps } = passDeps([moved("n1")]);
    await runMailRules([reading([mail("b1", "boss@corp.example"), mail("n1", "news@corp.example")])], deps);
    expect(q.calls.map((c) => (c.stdin as { messageId: string }).messageId)).toEqual(["n1"]);
    expect(pendingRuleMail(db, [mail("b1", "boss@corp.example")])).toEqual(new Set());
  });

  it("pauses and asks when one pass would move more than the cap, and Handle all runs it once", async () => {
    approve("bulk@shop.example");
    const many = Array.from({ length: 21 }, (_, i) => mail(`b${i}`, "bulk@shop.example"));
    const { q, deps } = passDeps();
    expect(await runMailRules([reading(many)], deps)).toEqual({ handled: 0, failed: 0, paused: ["rule-bulk@shop.example"] });
    expect(q.calls).toEqual([]);
    expect(listRules(db)[0]?.held).toBe(21);
    expect((await runMailRules([reading(many.slice(0, 3))], deps)).handled).toBe(0);
    expect(releaseRule(db, "rule-bulk@shop.example", NOW).ok).toBe(true);
    expect((await runMailRules([reading(many)], deps)).handled).toBe(21);
    expect(listRules(db)[0]).toMatchObject({ held: null, released: false, count: 21 });
  });

  it("a rule turned off, or the grant taken back, does nothing", async () => {
    approve("reports@dmarc.example");
    setRuleOn(db, "rule-reports@dmarc.example", false, NOW);
    const { q, deps } = passDeps();
    expect((await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps)).handled).toBe(0);
    setRuleOn(db, "rule-reports@dmarc.example", true, NOW);
    setGrant(db, "mail.rules", false, NOW);
    expect((await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps)).handled).toBe(0);
    expect(pendingRuleMail(db, [mail("m1", "reports@dmarc.example")])).toEqual(new Set());
    expect(q.calls).toEqual([]);
  });

  it("records a refused move as failed in Done for you and does not retry it", async () => {
    approve("reports@dmarc.example");
    const { q, deps } = passDeps([{ code: 1, stdout: "", stderr: "The work account has no Archive mailbox.\n" }]);
    expect(await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps)).toEqual({ handled: 0, failed: 1, paused: [] });
    expect(db.query("SELECT action, status, message FROM desk_done").all()).toEqual([{ action: "mail.rule.failed", status: "failed", message: "The work account has no Archive mailbox." }]);
    await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps);
    expect(q.calls).toHaveLength(1);
    expect(queryMailLog(db)).toEqual([]);
  });

  it("Undo moves the mail back, logs the principal's restore, and the rule leaves that mail alone", async () => {
    approve("reports@dmarc.example");
    const { q, deps } = passDeps([moved("m1"), { code: 0, stdout: JSON.stringify({ message: "Moved back to INBOX." }), stderr: "" }]);
    await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps);
    const [run] = ruleRuns(db);
    const undone = await undoRuleRun(run?.id ?? "", { db, config: DESK.mailActions, ledger: deps.ledger, run: q.run, now: NOW + 1 });
    expect(undone).toEqual({ ok: true, message: "Moved back to INBOX.", restored: "mail:m1" });
    expect(q.calls[1]?.stdin).toEqual({ action: "restore", account: "work", messageId: "m1", from: "archive" });
    expect(db.query("SELECT action FROM desk_done").get()).toEqual({ action: "mail.rule.undone" });
    expect(queryMailLog(db).map((e) => [e.action, e.where])).toEqual([["restore", "desk"], ["archive", "rule"]]);
    expect(ruleRuns(db)[0]?.undoneAt).toBe(NOW + 1);
    expect((await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps)).handled).toBe(0);
    expect(await undoRuleRun(run?.id ?? "", { db, config: DESK.mailActions, ledger: deps.ledger, run: q.run, now: NOW + 2 })).toEqual({ ok: false, status: 409, error: "That is already undone." });
  });

  it("a digest rule keeps the mail in the inbox and off the Desk until Undo", async () => {
    approve("letters@news.example", "digest");
    const { q, deps } = passDeps();
    expect((await runMailRules([reading([mail("d1", "letters@news.example")])], deps)).handled).toBe(1);
    expect(q.calls).toEqual([]);
    const rt: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [mail("d1", "letters@news.example")] })) };
    const keys = async () => (await composeDesk(db, DESK, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) })).items.map((i) => i.key);
    expect(await keys()).toEqual([]);
    expect(await keys()).toEqual([]);
    const [run] = ruleRuns(db);
    expect(await undoRuleRun(run?.id ?? "", { db, config: DESK.mailActions, ledger: deps.ledger, run: q.run, now: NOW })).toMatchObject({ ok: true, restored: "mail:d1" });
    expect(await keys()).toEqual(["mail:d1"]);
  });
});

describe("the Desk view and the rules API", () => {
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const runtime = (mails: SourceMail[]): DeskRuntime => ({ options: DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: mails })) });
  const view = (rt: DeskRuntime) => composeDesk(db, DESK, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });

  it("shows a quiet proposal card, approves it, and offers Stop doing this on each run", async () => {
    decide(8, "reports@dmarc.example");
    const rt = runtime([]);
    const card = (await view(rt)).items.find((i) => i.kind === "mail-rule");
    expect(card).toMatchObject({ title: "Archive mail from reports@dmarc.example on its own?", urgency: "this-week" });
    expect(card?.actions.map((a) => a.label)).toEqual(["Approve", "Not now", "Never"]);
    expect(card?.detail.history[0]).toStartWith("“Report reports@dmarc.example-0”: archived on the Desk ");

    const res = await handleDeskMailRules(post({ op: "approve", proposal: card?.key }), db, rt, { now: () => NOW, newId: () => "r1" });
    expect(res.status).toBe(200);
    const after = await view(rt);
    expect(after.items.some((i) => i.kind === "mail-rule")).toBe(false);
    expect(after.mailRules).toEqual([{ id: "r1", match: "sender", value: "reports@dmarc.example", action: "archive", on: true, sentence: "Archive mail from reports@dmarc.example", lastRunAt: null, count: 0, held: null, target: null }]);
    expect(after.autonomy.types.find((t) => t.action === "mail.rules")?.on).toBe(true);

    const { deps } = passDeps([moved("m1")]);
    await runMailRules([reading([mail("m1", "reports@dmarc.example")])], deps);
    expect((await view(rt)).autonomy.done[0]).toMatchObject({ action: "mail.rule", undo: ruleRuns(db)[0]?.id, stop: "r1" });

    const stop = await handleDeskMailRules(post({ op: "stop", rule: "r1" }), db, rt, { now: () => NOW });
    expect(await stop.json()).toMatchObject({ ok: true, rule: { on: false } });
    expect((await view(rt)).autonomy.done[0]?.stop).toBeUndefined();
  });

  it("refuses an edit to a bad match, and a moving rule without the move command", async () => {
    approve("reports@dmarc.example");
    const rt = runtime([]);
    const bad = await handleDeskMailRules(post({ op: "edit", rule: "rule-reports@dmarc.example", match: "sender", value: "not-an-address", action: "archive" }), db, rt, { now: () => NOW });
    expect(bad.status).toBe(400);
    const good = await handleDeskMailRules(post({ op: "edit", rule: "rule-reports@dmarc.example", match: "domain", value: "@DMARC.example", action: "junk" }), db, rt, { now: () => NOW });
    expect(await good.json()).toMatchObject({ ok: true, rule: { match: "domain", value: "dmarc.example", action: "junk" } });
    const off = await handleDeskMailRules(post({ op: "create", match: "sender", value: "news@shop.example", action: "archive" }), db, { ...rt, options: mailDesk({ timeoutSeconds: 20 }) }, { now: () => NOW });
    expect(await off.json()).toEqual({ ok: false, error: "Mail rules that move mail need the move command (mc.desk.mail.actions.move), and it is not set up on this stack." });
    expect((await handleDeskMailRules(post({ op: "delete", rule: "rule-reports@dmarc.example" }), db, rt, { now: () => NOW })).status).toBe(200);
    expect(listRules(db)).toEqual([]);
  });

  it("keeps mail a rule will handle away from the model, but not a paused rule's mail", async () => {
    approve("reports@dmarc.example");
    expect(pendingRuleMail(db, [mail("m1", "reports@dmarc.example"), mail("m2", "ada@other.example")])).toEqual(new Set(["m1"]));
    db.query("UPDATE desk_mail_rules SET held = 30").run();
    expect(pendingRuleMail(db, [mail("m1", "reports@dmarc.example")])).toEqual(new Set());
  });

  it("logs a failed pass instead of dropping it", async () => {
    const lines: string[] = [];
    const loop = new MailRuleLoop(passDeps().deps, () => { throw new Error("disk full"); }, (line) => lines.push(line));
    await loop.kick();
    expect(lines).toEqual(["[desk] mail rule pass failed: disk full"]);
  });
});

describe("rules that attach", () => {
  const ATTACH_DESK: DeskOptions = { ...mailDesk({ timeoutSeconds: 20 }), areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }] };
  const task = (id: string, title: string, done = false) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, ...(done ? { done: true } : {}) });
  const seed = (done = false): AppState => ({
    outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [task("kickoff", "Kickoff prep", done)] }] },
    settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
  });
  const ada = (id: string, over: Partial<SourceMail> = {}): SourceMail => mail(id, "ada@example.org", over);
  const rt = (mails: SourceMail[]): DeskRuntime => ({ options: ATTACH_DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: mails })) });
  const rules = (body: unknown) => handleDeskMailRules(new Request("http://localhost/api/desk/mail/rules", { method: "POST", body: JSON.stringify(body) }), db, rt([]), { now: () => NOW, newId: () => "r1" });
  const pass = (mails: SourceMail[]) => {
    const { q, deps } = passDeps([], { mailActions: undefined, attach: ruleAttach(db, ATTACH_DESK, () => [reading(mails)], () => NOW) });
    return { q, run: runMailRules([reading(mails)], deps) };
  };
  const attachRule = async () => (await rules({ op: "create", match: "sender", value: "ada@example.org", action: "attach", target: { kind: "task", id: "kickoff" } })).json();

  beforeEach(() => { saveBalanceState(db, seed()); });

  it("accepts an attach rule without a move command and names its target", async () => {
    expect(await attachRule()).toMatchObject({ ok: true, rule: { action: "attach", sentence: "Attach mail from ada@example.org to “Kickoff prep”", target: { kind: "task", key: "kickoff", title: "Kickoff prep" } } });
    expect(await (await rules({ op: "create", match: "sender", value: "bo@example.org", action: "attach" })).json()).toEqual({ ok: false, error: "An attach rule needs a task or a thread to attach to." });
    expect((await rules({ op: "create", match: "sender", value: "cy@example.org", action: "attach", target: { kind: "task", id: "nope" } })).status).toBe(409);
  });

  it("attaches a matching unread mail to its task without touching the mailbox, and Undo brings it back", async () => {
    await attachRule();
    const { q, run } = pass([ada("m1"), mail("m2", "bo@example.org")]);
    expect(await run).toEqual({ handled: 1, failed: 0, paused: [] });
    expect(q.calls).toEqual([]);
    const [r] = ruleRuns(db);
    expect(activeMailLink(db, "m1")).toMatchObject({ toKind: "task", toKey: "kickoff", origin: "rule", ruleRun: r?.id });
    expect(db.query("SELECT action, title FROM desk_done").all()).toEqual([{ action: "mail.rule", title: "Attached by your rule: “Report m1” → “Kickoff prep”" }]);
    expect(queryMailLog(db).map((e) => [e.messageId, e.action, e.where])).toEqual([["m1", "attach", "rule"]]);
    const desk = rt([ada("m1")]);
    const shown = await composeDesk(db, ATTACH_DESK, undefined, { now: NOW, handled: desk.ledger, ...(desk.sourceCache ? { sourceCache: desk.sourceCache } : {}) });
    expect(shown.items.some((i) => i.key === "mail:m1")).toBe(false);
    expect(shown.autonomy.done[0]).toMatchObject({ action: "mail.rule", undo: r?.id, stop: "r1" });
    expect(await (await rules({ op: "undo", run: r?.id })).json()).toEqual({ ok: true, message: "The mail is back on the Desk.", restored: "mail:m1" });
    expect(activeMailLink(db, "m1")).toBeNull();
    expect(queryMailLog(db).map((e) => e.action).sort()).toEqual(["attach", "restore"]);
  });

  it("fails the run and turns the rule off when its task is done", async () => {
    await attachRule();
    saveBalanceState(db, seed(true));
    expect(await pass([ada("m1")]).run).toEqual({ handled: 0, failed: 1, paused: [] });
    expect(listRules(db)[0]?.on).toBe(false);
    expect(activeMailLink(db, "m1")).toBeNull();
    expect(db.query("SELECT action, title, message FROM desk_done").all()).toEqual([{ action: "mail.rule.failed", title: "Your rule could not attach “Report m1”: “Kickoff prep” is done", message: "The rule is turned off, and the mail stays on the Desk." }]);
  });

  it("never attaches a VIP's mail or a snoozed mail", async () => {
    await attachRule();
    addVip(db, "ada@example.org", null, NOW);
    expect(await pass([ada("m1")]).run).toEqual({ handled: 0, failed: 0, paused: [] });
    db.exec("DELETE FROM desk_vips");
    snoozeMail(db, { ...ada("m2"), sourceId: "work-mail" }, { kind: "tomorrow" }, { now: NOW, readings: [reading([ada("m2")])] });
    expect(await pass([ada("m2")]).run).toEqual({ handled: 0, failed: 0, paused: [] });
  });

  it("proposes an attach rule after three attaches to one task, and an Undo blocks it", async () => {
    const config = { ...CONFIG, proposeAfter: 3 };
    for (const id of ["a1", "a2", "a3"]) attachMail(db, { ...ada(id), sourceId: "work-mail" }, { kind: "task", key: "kickoff", title: "Kickoff prep" }, { id: `l-${id}`, requestId: `q-${id}`, origin: "desk", now: NOW - 60_000 });
    const [p] = proposeRules(db, NOW, config);
    expect(p).toMatchObject({ key: "mailrule:sender:attach:task:kickoff:ada@example.org", action: "attach", target: { kind: "task", key: "kickoff", title: "Kickoff prep" }, agreeing: 3 });
    expect(answerProposal(db, p?.key ?? "", "approve", NOW, config, () => "r2")).toMatchObject({ ok: true, rule: { sentence: "Attach mail from ada@example.org to “Kickoff prep”" } });
    db.exec("DELETE FROM desk_mail_rules");
    await undoAttach(db, "l-a1", { now: NOW, listed: () => true });
    expect(proposeRules(db, NOW, config)).toEqual([]);
  });

  it("counts Add to thread as an attach, so mail filed in a thread breaks agreement with a task", () => {
    const config = { ...CONFIG, proposeAfter: 3 };
    for (const id of ["a1", "a2"]) attachMail(db, { ...ada(id), sourceId: "work-mail" }, { kind: "task", key: "kickoff", title: "Kickoff prep" }, { id: `l-${id}`, requestId: `q-${id}`, origin: "desk", now: NOW - 60_000 });
    linkStudioMail(db, { ...ada("a3"), sourceId: "work-mail" }, { kind: "thread", key: "engines", title: "What can engines make?" }, { id: "c-a3", requestId: "c-a3", origin: "desk", now: NOW - 60_000 });
    logMailDecision(db, { ...features("a3", "ada@example.org"), subject: "Report a3" }, "studio", "desk", NOW - 60_000, null);
    expect(proposeRules(db, NOW, config)).toEqual([]);
  });
});
