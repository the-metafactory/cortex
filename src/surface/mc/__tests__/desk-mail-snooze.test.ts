import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { queryMailLog } from "../desk/mail-log";
import { createRule, pendingRuleMail } from "../desk/mail-rules";
import { backLine, backSnoozes, cancelSnooze, readSnooze, snoozeAt, snoozedIds, snoozeFacts, snoozeMail, wakeOf, wakeSnoozes, withoutSnoozed, type SnoozeRow, type WakeFacts } from "../desk/mail-snooze";
import { recordWaiting } from "../desk/mail-waiting";
import { SourceCache, type SourceEvent, type SourceMail, type SourceReading } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { composeWith, mailDesk } from "./desk-mail-fixtures";
import { offDeskIds } from "../desk/links";

const at = (day: number, hour = 10, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(4, 10);

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Priya Shah", address: "priya@example.org" }, subject: "Venue quote", receivedAt: new Date(at(4, 9)).toISOString(), unread: true, account: "work", ...over,
});
const event = (id: string, start: number, end: number, title = "Board call"): SourceEvent => ({ id, start: new Date(start).toISOString(), end: new Date(end).toISOString(), title });
const reading = (items: SourceMail[], events: SourceEvent[] = [], id = "work-mail"): SourceReading => ({ id, area: null, events, mail: items, readAt: NOW, error: null, dropped: 0, problems: [] });
const listed = (m: SourceMail, sourceId = "work-mail") => ({ ...m, sourceId });

describe("snooze times", () => {
  it("later today, tomorrow morning, next week and a date", () => {
    expect(snoozeAt({ kind: "later" }, at(4, 10, 7))).toBe(at(4, 13, 15));
    expect(snoozeAt({ kind: "tomorrow" }, NOW)).toBe(at(5, 8));
    expect(snoozeAt({ kind: "next-week" }, NOW)).toBe(at(9, 8));
    expect(snoozeAt({ kind: "next-week" }, at(9, 7))).toBe(at(16, 8));
    expect(snoozeAt({ kind: "date", date: "2026-11-20" }, NOW)).toBe(at(20, 8));
    expect(snoozeAt({ kind: "date", date: "2026-02-30" }, NOW)).toBeNull();
    expect(snoozeAt({ kind: "date", date: "soon" }, NOW)).toBeNull();
  });
});

const row = (over: Partial<SnoozeRow>): SnoozeRow => ({
  messageId: "m1", sourceId: "work-mail", sender: "priya@example.org", subject: "Venue quote", kind: "time", untilAt: null, eventKey: null, eventTitle: null, eventStart: null,
  person: null, personName: null, label: "", state: "snoozed", backAt: null, reason: null, createdAt: NOW, ...over,
});
const facts = (over: Partial<WakeFacts> = {}): WakeFacts => ({ events: new Map(), covered: () => false, wrote: () => null, ...over });

describe("wake evaluation over fixture readings", () => {
  it("wakes a time snooze when the time comes", () => {
    const r = row({ kind: "time", untilAt: at(5, 8) });
    expect(wakeOf(r, facts(), at(5, 7, 59))).toEqual({ kind: "wait" });
    expect(wakeOf(r, facts(), at(5, 8))).toMatchObject({ kind: "back" });
    expect(backLine(r, at(5, 8))).toBe("Back because you snoozed it until today at 08:00.");
  });

  it("wakes after the meeting ends, and follows a moved meeting", () => {
    const r = row({ kind: "meeting", eventKey: "cal:work-cal:e1", eventTitle: "Board call", eventStart: at(4, 14), untilAt: at(4, 15) });
    const seen = (start: number, end: number, title = "Board call") => facts({ events: new Map([["cal:work-cal:e1", { title, at: start, end }]]) });
    expect(wakeOf(r, seen(at(4, 14), at(4, 15)), at(4, 14, 30))).toEqual({ kind: "wait" });
    expect(wakeOf(r, seen(at(4, 14), at(4, 15)), at(4, 15))).toEqual({ kind: "back", reason: "“Board call” has ended" });
    expect(wakeOf(r, seen(at(4, 16), at(4, 17)), at(4, 15))).toEqual({ kind: "moved", event: { title: "Board call", at: at(4, 16), end: at(4, 17) } });
  });

  it("returns the mail when the meeting was cancelled, only when the calendar reading covers it", () => {
    const r = row({ kind: "meeting", eventKey: "cal:work-cal:e1", eventTitle: "Board call", eventStart: at(4, 14), untilAt: at(4, 15) });
    expect(wakeOf(r, facts({ covered: () => false }), at(4, 11))).toEqual({ kind: "wait" });
    expect(wakeOf(r, facts({ covered: (key, start) => key === "cal:work-cal:e1" && start === at(4, 14) }), at(4, 11))).toEqual({ kind: "back", reason: "“Board call” was cancelled" });
    expect(wakeOf(r, facts(), at(4, 15, 1))).toEqual({ kind: "back", reason: "“Board call” has ended" });
  });

  it("wakes a person snooze when the person writes after the snooze, not before", () => {
    const r = row({ kind: "person", person: "lena@example.org", personName: "Lena" });
    const db = initDatabase(":memory:");
    try {
      const before = reading([mail("m1"), mail("old", { from: { name: "Lena Roth", address: "Lena@Example.org" }, subject: "Earlier", receivedAt: new Date(at(4, 9)).toISOString() })]);
      expect(wakeOf(r, snoozeFacts(db, [before], undefined), NOW)).toEqual({ kind: "wait" });
      const after = reading([...before.mail, mail("new", { from: { name: "Lena Roth", address: "lena@example.org" }, subject: "The numbers", receivedAt: new Date(at(4, 11)).toISOString() })]);
      expect(wakeOf(r, snoozeFacts(db, [after], undefined), at(4, 11, 5))).toEqual({ kind: "back", reason: "Lena Roth wrote: “The numbers”" });
      recordWaiting(db, [reading([mail("reply", { from: { address: "lena@example.org" }, receivedAt: new Date(at(4, 12)).toISOString(), unread: false, headers: { inReplyTo: "<sent-1>" } })])], at(4, 12));
      expect(wakeOf(r, snoozeFacts(db, [before], undefined), at(4, 12))).toEqual({ kind: "back", reason: "Lena wrote" });
    } finally {
      db.close();
    }
  });
});

describe("the snooze store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-snooze-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("survives a restart, wakes after it, and logs the snooze", () => {
    const file = join(dir, "mc.db");
    let db = initDatabase(file);
    const r = reading([mail("m1")]);
    expect(snoozeMail(db, listed(mail("m1")), { kind: "person", address: "Lena@example.org" }, { now: NOW, readings: [r] })).toMatchObject({ ok: true, until: "until lena@example.org writes" });
    expect(queryMailLog(db, {}).map((e) => [e.messageId, e.action, e.where])).toEqual([["m1", "snooze", "desk"]]);
    db.close();

    db = initDatabase(file);
    expect([...snoozedIds(db)]).toEqual(["m1"]);
    const wrote = reading([mail("m1"), mail("n1", { from: { address: "lena@example.org" }, subject: "Figures", receivedAt: new Date(at(4, 11)).toISOString() })]);
    expect(wakeSnoozes(db, snoozeFacts(db, [wrote], undefined), at(4, 11))).toEqual(["m1"]);
    expect(snoozedIds(db).size).toBe(0);
    expect(readSnooze(db, "m1")).toMatchObject({ state: "back", reason: "lena@example.org wrote: “Figures”" });
    expect(backSnoozes(db, at(5, 10, 59)).get("m1")).toEqual({ line: "Back because lena@example.org wrote: “Figures”.", at: at(4, 11) });
    expect(backSnoozes(db, at(5, 11)).size).toBe(0);
    db.close();
  });

  it("snoozes read mail without changing its read status", () => {
    const db = initDatabase(":memory:");
    try {
      const m = mail("read", { unread: false });
      expect(snoozeMail(db, listed(m), { kind: "later" }, { now: NOW, readings: [reading([m])] })).toMatchObject({ ok: true });
      expect(snoozedIds(db).has("read")).toBe(true);
      expect(m.unread).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses past times, unknown or finished meetings and bad addresses", () => {
    const db = initDatabase(":memory:");
    try {
      const r = reading([mail("m1")], [event("e1", at(4, 8), at(4, 9))], "work-mail");
      const snooze = (choice: Parameters<typeof snoozeMail>[2], m = mail("m1")) => snoozeMail(db, listed(m), choice, { now: NOW, readings: [r] });
      expect(snooze({ kind: "date", date: "2026-11-01" })).toMatchObject({ ok: false, error: "That time has already passed." });
      expect(snooze({ kind: "meeting", event: "cal:work-mail:nope" })).toMatchObject({ ok: false });
      expect(snooze({ kind: "meeting", event: "cal:work-mail:e1" })).toMatchObject({ ok: false, error: "That meeting is already over." });
      expect(snooze({ kind: "person", address: "not an address" })).toMatchObject({ ok: false, error: "That is not a mail address." });
      expect(snoozedIds(db).size).toBe(0);
      expect(cancelSnooze(db, "m1")).toMatchObject({ ok: false });
    } finally {
      db.close();
    }
  });
});

describe("snoozed mail on the Desk", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => db.close());

  const options: DeskOptions = { ...mailDesk({ move: ["/opt/desk-mail-move.ts"], timeoutSeconds: 20 }), sources: [{ id: "work-mail", command: ["desk-mail"], everySeconds: 300, timeoutSeconds: 30 }] };
  const runtime = (items: SourceMail[], events: SourceEvent[] = []): DeskRuntime => ({ options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items, events })) });
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ask = async (rt: DeskRuntime, body: unknown, now = NOW) => {
    await rt.sourceCache?.read(options.sources, now);
    return (await handleDeskMail(post(body), db, rt, { now: () => now })).json();
  };

  it("leaves the Desk, offers Snooze on the card, and returns with the reason when the person writes", async () => {
    const first = runtime([mail("m1")]);
    const before = await composeWith(db, options, first, NOW);
    const card = before.items.find((i) => i.key === "mail:m1");
    expect([...(card?.actions ?? []), ...(card?.more ?? [])].map((a) => a.id)).toContain("mail.snooze");
    expect(await ask(first, { action: "snooze", key: "mail:m1", until: { kind: "person", address: "lena@example.org" } })).toMatchObject({ ok: true, message: "Snoozed “Venue quote” until lena@example.org writes. Its read status in your mail stays unchanged." });
    expect((await composeWith(db, options, runtime([mail("m1")]), at(4, 10, 5))).items.some((i) => i.key === "mail:m1")).toBe(false);
    const later = await composeWith(db, options, runtime([mail("m1"), mail("n1", { from: { name: "Lena Roth", address: "lena@example.org" }, subject: "Figures", receivedAt: new Date(at(4, 11)).toISOString() })]), at(4, 11, 5));
    const back = later.items.find((i) => i.key === "mail:m1");
    expect(back?.why.startsWith("Back because Lena Roth wrote: “Figures”.")).toBe(true);
    expect(back).toMatchObject({ urgency: "today", back: { line: "Back because Lena Roth wrote: “Figures”." } });
  });

  it("returns a mail snoozed until a meeting that was cancelled", async () => {
    const coverage = { from: new Date(at(4, 0)).toISOString(), to: new Date(at(11, 0)).toISOString(), calendars: [{ id: "c1", name: "Work" }], status: "complete", provenance: "test" };
    const meeting = { ...event("e1", at(4, 14), at(4, 15)), calendar: "Work", calendarId: "c1" };
    const source = (events: SourceEvent[]) => new SourceCache(async () => JSON.stringify({ capabilities: ["calendar"], calendarCoverage: coverage, items: [mail("m1")], events }));
    const rt: DeskRuntime = { options, ledger: new HandledLedger(), sourceCache: source([meeting]) };
    expect(await ask(rt, { action: "snooze", key: "mail:m1", until: { kind: "meeting", event: "cal:work-mail:e1" } })).toMatchObject({ ok: true, until: "until “Board call” ends" });
    expect((await composeWith(db, options, { ...rt, sourceCache: source([meeting]) }, at(4, 11))).items.some((i) => i.key === "mail:m1")).toBe(false);
    const back = (await composeWith(db, options, { ...rt, sourceCache: source([]) }, at(4, 12))).items.find((i) => i.key === "mail:m1");
    expect(back?.why.startsWith("Back because “Board call” was cancelled.")).toBe(true);
  });

  it("keeps snoozed mail out of rules, sweeps and bundles, and Cancel brings it back", async () => {
    createRule(db, { match: "sender", value: "priya@example.org", action: "archive" }, NOW, () => "rule-1");
    const rt = runtime([mail("m1")]);
    expect(await ask(rt, { action: "snooze", key: "mail:m1", until: { kind: "tomorrow" } })).toMatchObject({ ok: true });
    expect(pendingRuleMail(db, [mail("m1")]).size).toBe(0);
    expect(withoutSnoozed([reading([mail("m1"), mail("m2")])], snoozedIds(db))[0]?.mail.map((m) => m.id)).toEqual(["m2"]);
    expect(await ask(rt, { action: "snooze.cancel", key: "mail:m1" })).toMatchObject({ ok: true });
    expect(pendingRuleMail(db, [mail("m1")]).size).toBe(1);
    expect(await ask(rt, { action: "snooze", key: "mail:gone", until: { kind: "later" } })).toMatchObject({ ok: false, error: "The Desk no longer lists this mail." });
  });

  it("hides a mail without a mail command, never wakes it, lists it, and Show again brings it back without a reason", async () => {
    const calls: string[][] = [];
    const rt: DeskRuntime = { ...runtime([mail("m1"), mail("m2")]), options };
    const hide = async (body: unknown) => {
      await rt.sourceCache?.read(options.sources, NOW);
      return (await handleDeskMail(new Request("http://localhost/api/desk/mail", { method: "POST", body: JSON.stringify(body) }), db, rt, { now: () => NOW, run: async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; } })).json();
    };
    expect(await hide({ action: "hide", key: "mail:m1" })).toEqual({ ok: true, message: "Hid “Venue quote” from the Desk. It stays in your mailbox as it is." });
    expect(await hide({ action: "hide", key: "mail:m1" })).toEqual({ ok: true, message: "Hid “Venue quote” from the Desk. It stays in your mailbox as it is." });
    expect(calls).toEqual([]);
    expect(queryMailLog(db, {}).map((e) => [e.messageId, e.action, e.where])).toEqual([["m1", "ignored", "desk"]]);
    expect(wakeSnoozes(db, facts(), at(400, 10))).toEqual([]);
    const view = await composeWith(db, options, rt, NOW);
    expect(view.items.some((i) => i.key === "mail:m1")).toBe(false);
    expect(view.mailHidden).toEqual([{ key: "mail:m1", subject: "Venue quote", sender: "priya@example.org", at: NOW }]);
    createRule(db, { match: "sender", value: "priya@example.org", action: "archive" }, NOW, () => "rule-1");
    expect([...pendingRuleMail(db, [mail("m1"), mail("m2")])]).toEqual(["m2"]);
    expect(withoutSnoozed([reading([mail("m1"), mail("m2")])], offDeskIds(db))[0]?.mail.map((m) => m.id)).toEqual(["m2"]);
    expect(await hide({ action: "snooze", key: "mail:m2", until: { kind: "tomorrow" } })).toMatchObject({ ok: true });
    expect(await hide({ action: "hide.undo", key: "mail:m2" })).toEqual({ ok: false, error: "This mail is not hidden." });
    expect(await hide({ action: "hide.undo", key: "m1" })).toEqual({ ok: false, error: "A hide key starts with mail:." });
    expect(await hide({ action: "hide.undo", key: "mail:m1" })).toEqual({ ok: true, message: "“Venue quote” is back on the Desk." });
    const back = (await composeWith(db, options, rt, NOW)).items.find((i) => i.key === "mail:m1");
    expect(back?.back).toBeUndefined();
  });
});
