import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskInterruptionFeedback, handleDeskInterruptions } from "../api/desk-interruptions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { InterruptRules } from "../desk/interrupt";
import { readSwitches, switchKey } from "../desk/interrupt-switches";
import { addVip } from "../desk/vips";
import { SourceCache, type CommandRunner } from "../desk/sources/command";
import type { InterruptReasonView } from "../desk/types";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

const RULES: InterruptRules = { transport: "none", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: true, notifications: true };

const options = (over: Partial<DeskOptions> = {}): DeskOptions => ({
  enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
  sources: [{ id: "mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 5 }],
  interruptions: RULES,
  ...over,
});

const runtime = (over: Partial<DeskOptions> = {}): DeskRuntime => ({ options: options(over) }) as DeskRuntime;

const URL_BASE = "http://127.0.0.1/api/desk/interruptions";
const post = (body: unknown, path = URL_BASE): Request => new Request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const feedback = (body: unknown): Request => post(body, `${URL_BASE}/feedback`);

const reasonOf = (reasons: InterruptReasonView[], code: string, target?: string): InterruptReasonView | undefined => reasons.find((r) => r.code === code && r.target === target);

let db: Database;
let clock = NOW;
const now = (): number => clock;
beforeEach(() => { db = initDatabase(":memory:"); clock = NOW; addVip(db, "boss@example.com", "Boss", NOW); });
afterEach(() => { db.close(); });

describe("/api/desk/interruptions", () => {
  it("lists every reason with one row per VIP", async () => {
    const res = await handleDeskInterruptions(new Request(URL_BASE), db, runtime(), now);
    expect(res.status).toBe(200);
    const { reasons } = (await res.json()) as { reasons: InterruptReasonView[] };
    expect(reasons.map((r) => [r.code, r.target ?? null, r.on, r.available, r.setBy])).toEqual([
      ["meeting.soon", null, true, true, "default"],
      ["reminder.due", null, true, true, "default"],
      ["mail.meeting-today", null, true, true, "default"],
      ["mail.deadline-today", null, true, true, "default"],
      ["mail.vip", "boss@example.com", true, true, "default"],
      ["mail.ranked", null, true, true, "default"],
    ]);
  });

  it("switches a reason off, and deletes the row when it is switched back to the default", async () => {
    const offRes = await handleDeskInterruptions(post({ code: "mail.ranked", on: false }), db, runtime(), now);
    expect(offRes.status).toBe(200);
    const off = (await offRes.json()) as { ok: boolean; message: string; reasons: InterruptReasonView[] };
    expect(off.ok).toBe(true);
    expect(off.message).toBe("\"Other mail ranked for today\" no longer interrupts you; it waits in the list.");
    expect(reasonOf(off.reasons, "mail.ranked")).toMatchObject({ on: false, setBy: "switch", changedAt: NOW });
    const back = (await (await handleDeskInterruptions(post({ code: "mail.ranked", on: true }), db, runtime(), now)).json()) as { reasons: InterruptReasonView[] };
    expect(reasonOf(back.reasons, "mail.ranked")).toEqual({ code: "mail.ranked", label: "Other mail ranked for today", on: true, available: true, setBy: "default" });
    expect(readSwitches(db).size).toBe(0);
  });

  it("switches a VIP by address", async () => {
    const res = await handleDeskInterruptions(post({ code: "mail.vip", target: "Boss@Example.com", on: false }), db, runtime(), now);
    expect(res.status).toBe(200);
    expect(readSwitches(db).get(switchKey("mail.vip", "boss@example.com"))?.on).toBe(false);
  });

  it("refuses bad requests with the documented status and wording", async () => {
    const cases: [Request, DeskRuntime, number, string][] = [
      [post({ code: "mail.nope", on: true }), runtime(), 400, "A reason code and on (true or false) are required."],
      [post({ code: "mail.ranked", on: "yes" }), runtime(), 400, "A reason code and on (true or false) are required."],
      [post({ code: "mail.vip", on: false }), runtime(), 400, "Mail from a VIP is switched per address: give the VIP's address as target."],
      [post({ code: "mail.ranked", target: "boss@example.com", on: false }), runtime(), 400, "Mail from a VIP is switched per address: give the VIP's address as target."],
      [post({ code: "mail.vip", target: "other@example.com", on: false }), runtime(), 404, "That address is not a VIP."],
      [post({ code: "mail.ranked", on: false }), runtime({ enabled: false }), 409, "The Desk is turned off on this stack."],
      [post({ code: "mail.ranked", on: false }), runtime({ interruptions: { ...RULES, mail: false } }), 409, "Mail interruptions are turned off for this stack (mc.desk.interruptions.mail)."],
    ];
    for (const [req, rt, status, error] of cases) {
      const res = await handleDeskInterruptions(req, db, rt, now);
      expect([res.status, await res.json()]).toEqual([status, { ok: false, error }]);
    }
    expect(readSwitches(db).size).toBe(0);
    const del = await handleDeskInterruptions(new Request(URL_BASE, { method: "DELETE" }), db, runtime(), now);
    expect([del.status, del.headers.get("Allow")]).toEqual([405, "GET, POST"]);
  });

  it("reads mail reasons as unavailable when mail interruptions are off", async () => {
    const { reasons } = (await (await handleDeskInterruptions(new Request(URL_BASE), db, runtime({ interruptions: { ...RULES, mail: false } }), now)).json()) as { reasons: InterruptReasonView[] };
    expect(reasons.filter((r) => !r.available).map((r) => r.code)).toEqual(["mail.meeting-today", "mail.deadline-today", "mail.vip", "mail.ranked"]);
  });
});

describe("/api/desk/interruptions/feedback", () => {
  const vipMail: CommandRunner = async () => JSON.stringify({ items: [{ kind: "mail", id: "m1", from: { name: "Boss", address: "boss@example.com" }, subject: "Budget", receivedAt: new Date(clock - 5 * MIN).toISOString(), unread: true }] });
  const compose = async () => composeDesk(db, options(), undefined, { now: clock, sourceCache: new SourceCache(vipMail) });
  const answer = (important: unknown, key: unknown = "mail:m1") => handleDeskInterruptionFeedback(feedback({ key, code: "mail.vip", target: "boss@example.com", important }), db, runtime(), now);

  it("keeps the reason on a yes and shows the answer on the item", async () => {
    const res = await answer(true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toBe("Kept. Mail like this still interrupts you.");
    expect(readSwitches(db).size).toBe(0);
    const item = (await compose()).items.find((i) => i.key === "mail:m1");
    expect(item?.interrupt).toEqual({ delivery: "off", reason: { code: "mail.vip", target: "boss@example.com" }, feedback: "yes" });
  });

  it("switches the reason off on a no, so the next compose does not mark a matching item", async () => {
    expect((await compose()).items.find((i) => i.key === "mail:m1")?.interrupt?.reason?.code).toBe("mail.vip");
    const res = await answer(false);
    const body = (await res.json()) as { message: string; reasons: InterruptReasonView[] };
    expect(body.message).toBe("Noted. Mail like this now waits in the list without interrupting you. You can switch it back on under Interruptions.");
    expect(reasonOf(body.reasons, "mail.vip", "boss@example.com")).toMatchObject({ on: false, setBy: "feedback" });
    expect((await compose()).items.find((i) => i.key === "mail:m1")?.interrupt?.reason?.code).toBe("mail.ranked");
  });

  it("follows a later answer for the same item, but never over a manual switch made since", async () => {
    await answer(false);
    clock = NOW + MIN;
    await answer(true);
    expect(readSwitches(db).size).toBe(0);
    clock = NOW + 2 * MIN;
    await answer(false);
    clock = NOW + 3 * MIN;
    await handleDeskInterruptions(post({ code: "mail.vip", target: "boss@example.com", on: false }), db, runtime(), now);
    clock = NOW + 4 * MIN;
    await answer(true);
    expect(readSwitches(db).get(switchKey("mail.vip", "boss@example.com"))).toEqual({ on: false, setBy: "switch", changedAt: NOW + 3 * MIN });
  });

  it("refuses an answer without a key or with a bad shape, and records nothing", async () => {
    const noKey = await answer(false, "");
    expect([noKey.status, await noKey.json()]).toEqual([400, { ok: false, error: "key is required." }]);
    const bad = await answer("no");
    expect([bad.status, await bad.json()]).toEqual([400, { ok: false, error: "A reason code and important (true or false) are required." }]);
    const notVip = await handleDeskInterruptionFeedback(feedback({ key: "mail:m1", code: "mail.vip", target: "x@example.com", important: false }), db, runtime(), now);
    expect(notVip.status).toBe(404);
    const get = await handleDeskInterruptionFeedback(new Request(`${URL_BASE}/feedback`), db, runtime(), now);
    expect([get.status, get.headers.get("Allow")]).toEqual([405, "POST"]);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_interrupt_feedback").get()).toEqual({ n: 0 });
  });

  it("forgets answers after 30 days", async () => {
    await answer(true);
    clock = NOW + 31 * DAY;
    await handleDeskInterruptionFeedback(feedback({ key: "mail:m2", code: "mail.ranked", important: true }), db, runtime(), now);
    expect(db.query<{ item_key: string }, []>("SELECT item_key FROM desk_interrupt_feedback").all().map((r) => r.item_key)).toEqual(["mail:m2"]);
  });
});
