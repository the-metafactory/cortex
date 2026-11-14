import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { interrupts, NO_SWITCHES, pushInterrupts, type DeskTransport, type InterruptContext } from "../desk/interrupt";
import { readSwitches, setSwitch, switchKey } from "../desk/interrupt-switches";
import { commandTransport } from "../desk/transports";
import { addVip } from "../desk/vips";
import { handleDeskVips } from "../api/desk-vips";
import { SourceCache, type CommandRunner } from "../desk/sources/command";
import type { DeskEvent, DeskItem } from "../desk/types";
import { FakeTransport, MIN, NOW, RULES, vipMail } from "./desk-interrupt-fixture";

const mailItem = (over: Partial<DeskItem> = {}): DeskItem => ({
  key: "mail:m1",
  kind: "mail",
  source: "mail",
  area: null,
  urgency: "today",
  title: "Boss wrote: \"Budget\"",
  why: "",
  score: 50,
  actions: [],
  detail: { summary: "", history: [], refs: ["boss@example.com", "m1"], links: [] },
  since: NOW - 5 * MIN,
  ...over,
});

const review: DeskEvent = { key: "cal:cal:review", at: NOW + 3 * 60 * MIN, end: NOW + 4 * 60 * MIN, title: "Review", area: null, kind: "meeting" };

const context = (over: Partial<InterruptContext> = {}): InterruptContext => ({ ...NO_SWITCHES, vips: new Set(["boss@example.com"]), today: [review], ...over });

const off = (...keys: [string, string?][]): InterruptContext["switches"] =>
  new Map(keys.map(([code, target]) => [switchKey(code as never, target), { on: false, setBy: "switch" as const, changedAt: NOW }]));

describe("interruption reasons", () => {
  const linked = mailItem({ eventKey: review.key });

  it("names each mail reason when it fires alone", () => {
    expect(interrupts(linked, RULES, NOW, context({ vips: new Set() }))).toEqual({ code: "mail.meeting-today", eventKey: review.key });
    expect(interrupts(mailItem({ urgency: "waiting" }), RULES, NOW, context())).toEqual({ code: "mail.vip", target: "boss@example.com" });
    expect(interrupts(mailItem(), RULES, NOW, context({ vips: new Set() }))).toEqual({ code: "mail.ranked" });
    expect(interrupts(mailItem({ urgency: "waiting" }), RULES, NOW, context({ vips: new Set() }))).toBeNull();
  });

  it("picks the first reason that is switched on, and none when every firing reason is off", () => {
    expect(interrupts(linked, RULES, NOW, context())?.code).toBe("mail.meeting-today");
    expect(interrupts(linked, RULES, NOW, context({ switches: off(["mail.meeting-today"]) }))?.code).toBe("mail.vip");
    expect(interrupts(linked, RULES, NOW, context({ switches: off(["mail.meeting-today"], ["mail.vip", "boss@example.com"]) }))?.code).toBe("mail.ranked");
    expect(interrupts(linked, RULES, NOW, context({ switches: off(["mail.meeting-today"], ["mail.vip", "boss@example.com"], ["mail.ranked"]) }))).toBeNull();
  });

  it("lets interruptions.mail: false beat a stored on", () => {
    const on = new Map([[switchKey("mail.ranked"), { on: true, setBy: "switch" as const, changedAt: NOW }]]);
    expect(interrupts(linked, { ...RULES, mail: false }, NOW, context({ switches: on }))).toBeNull();
  });

  it("does not count a meeting that already started, nor stale mail", () => {
    expect(interrupts({ ...linked, since: review.at }, RULES, review.at + MIN, context({ vips: new Set() }))?.code).toBe("mail.ranked");
    expect(interrupts(mailItem({ since: NOW - 2 * 60 * MIN }), RULES, NOW, context())).toBeNull();
  });

  it("switches a VIP by the listed domain, and never treats suspicious mail as VIP mail", () => {
    expect(interrupts(mailItem({ urgency: "waiting" }), RULES, NOW, context({ vips: new Set(["@example.com"]) }))).toEqual({ code: "mail.vip", target: "@example.com" });
    expect(interrupts(mailItem({ suspicious: true }), RULES, NOW, context())).toEqual({ code: "mail.ranked" });
  });

  it("switches reminders and meetings off by default when the stack config does", () => {
    const reminder = mailItem({ key: "reminder:1", kind: "reminder" });
    expect(interrupts(reminder, { ...RULES, reminders: false }, NOW, context())).toBeNull();
    const on = new Map([[switchKey("reminder.due"), { on: true, setBy: "switch" as const, changedAt: NOW }]]);
    expect(interrupts(reminder, { ...RULES, reminders: false }, NOW, context({ switches: on }))).toEqual({ code: "reminder.due" });
  });
});

describe("interruption switches on the Desk", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const desk: DeskOptions = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [], sources: [{ id: "mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 5 }], interruptions: RULES };
  const runner: CommandRunner = async () => JSON.stringify({ items: [vipMail("vip", NOW - 5 * MIN)] });

  async function tick(transport: DeskTransport, at = NOW) {
    const view = await composeDesk(db, desk, undefined, { now: at, sourceCache: new SourceCache(runner) });
    return { view, pushed: await pushInterrupts(db, view.items, "discord", transport, at) };
  }

  it("pushes VIP mail with its reason, and nothing once that VIP's switch is off", async () => {
    addVip(db, "boss@example.com", "Boss", NOW);
    const before = await tick(new FakeTransport());
    expect(before.view.items.find((i) => i.key === "mail:vip")?.interrupt?.reason).toEqual({ code: "mail.vip", target: "boss@example.com" });
    expect(before.view.interruptions.filter((r) => r.code === "mail.vip")).toEqual([{ code: "mail.vip", target: "boss@example.com", label: "Mail from Boss", on: true, available: true, setBy: "default" }]);
    db.query("DELETE FROM desk_deliveries").run();
    setSwitch(db, RULES, { code: "mail.vip", target: "boss@example.com", on: false, setBy: "switch" }, NOW);
    setSwitch(db, RULES, { code: "mail.ranked", target: "", on: false, setBy: "switch" }, NOW);
    const transport = new FakeTransport();
    const after = await tick(transport);
    expect(after.view.items.find((i) => i.key === "mail:vip")?.interrupt).toBeUndefined();
    expect(after.pushed).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("removes a VIP's switch when the VIP is removed", async () => {
    addVip(db, "boss@example.com", null, NOW);
    setSwitch(db, RULES, { code: "mail.vip", target: "boss@example.com", on: false, setBy: "switch" }, NOW);
    expect(readSwitches(db).has(switchKey("mail.vip", "boss@example.com"))).toBe(true);
    const url = new URL("http://127.0.0.1/api/desk/vips?address=boss@example.com");
    expect((await handleDeskVips(new Request(url, { method: "DELETE" }), url, db)).status).toBe(200);
    expect(readSwitches(db).size).toBe(0);
  });

  it("gives the command transport the reason on stdin", async () => {
    const seen: string[] = [];
    const transport = commandTransport(["notify"], 1000, async (_argv, stdin) => { seen.push(stdin); return { code: 0, stdout: "", stderr: "" }; });
    await transport.send({ key: "mail:vip", title: "t", why: "w", reason: { code: "mail.vip", target: "boss@example.com" } });
    expect(JSON.parse(seen[0] ?? "{}")).toEqual({ key: "mail:vip", title: "t", why: "w", reason: { code: "mail.vip", target: "boss@example.com" } });
  });
});
