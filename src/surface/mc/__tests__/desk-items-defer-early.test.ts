import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openMailRoundRig, roundAt, roundMail, type MailRoundRig } from "./fixtures/mail-round-rig";
import { backLine, wakeOf, URGENT_NOW_REASON, type SnoozeRow, type WakeFacts } from "../desk/mail-snooze";

const NOW = roundAt(16, 10);
const EMPTY_ROW: SnoozeRow = { messageId: "m1", sourceId: null, sender: "priya@example.org", subject: "Venue quote", kind: "time", untilAt: null, eventKey: null, eventTitle: null, eventStart: null, person: null, personName: null, label: "", state: "snoozed", backAt: null, reason: null, createdAt: 0 };
const NO_FACTS: WakeFacts = { events: new Map(), covered: () => false, wrote: () => null, threadReply: () => null, urgentNow: new Set() };
const KEY = "mail:early-fixture";

let rig: MailRoundRig;

const reply = (id: string, from: string, over = {}) => roundMail(id, NOW + 60_000, { from: { name: "Priya Shah", address: from }, subject: "Re: Venue quote", headers: { inReplyTo: "early-fixture" }, ...over });

beforeEach(async () => {
  rig = await openMailRoundRig(NOW, { mailDigest: undefined, mailInvitations: undefined });
  rig.setState({ mail: [roundMail("early-fixture", NOW - 1000, { subject: "Venue quote" })] });
  await rig.get();
  expect((await rig.defer({ action: "defer", key: KEY, until: { kind: "next-week" } })).status).toBe(200);
});

afterEach(async () => { await rig.close(); });

describe("an item put away returns early", () => {
  it("returns a mail when someone else writes in its thread, at urgency today or higher and without interrupt", async () => {
    rig.setState({ mail: [roundMail("early-fixture", NOW - 1000, { subject: "Venue quote" }), reply("reply-1", "priya@example.org")] });
    rig.setNow(NOW + 120_000);
    const view = await rig.refresh();
    const item = view.items.find((entry) => entry.key === KEY);
    expect(item?.back?.line).toBe("Back because Priya Shah wrote again: “Re: Venue quote”.");
    expect(["now", "today"]).toContain(item?.urgency ?? "");
    expect(item?.interrupt).toBeUndefined();
    expect(view.deferred.some((entry) => entry.key === KEY)).toBe(false);
  });

  it("returns a mail rated urgency now, with its reason and interrupt", async () => {
    rig.database().query("INSERT INTO desk_deliveries (item_key, transport, status, title, error, created_at, updated_at) VALUES (?, 'fixture', 'failed', 'Venue quote', 'fixture failure', ?, ?)").run(KEY, NOW, NOW);
    const item = (await rig.get()).items.find((entry) => entry.key === KEY);
    expect(item?.back?.line).toBe("Back because it is urgent now.");
    expect(item?.urgency).toBe("now");
    expect(item?.interrupt).toBeDefined();
  });

  it("keeps a mail away when its thread is quiet", async () => {
    rig.setNow(NOW + 120_000);
    const view = await rig.get();
    expect(view.items.some((entry) => entry.key === KEY)).toBe(false);
    expect(view.deferred.some((entry) => entry.key === KEY)).toBe(true);
  });

  it("ignores a message from the principal's own address", async () => {
    const own = reply("reply-own", "me@example.org");
    rig.setState({ mail: [roundMail("early-fixture", NOW - 1000, { subject: "Venue quote" }), own, { kind: "sent", id: "sent-1", from: { address: "me@example.org" }, to: [{ address: "priya@example.org" }], subject: "Re", sentAt: new Date(NOW).toISOString() } as never] });
    rig.setNow(NOW + 120_000);
    expect((await rig.refresh()).deferred.some((entry) => entry.key === KEY)).toBe(true);
  });
});

const waiting = (over: Partial<SnoozeRow> = {}): SnoozeRow => ({ ...EMPTY_ROW, createdAt: NOW, untilAt: NOW + 10 * 86_400_000, ...over });
const knowing = (over: Partial<WakeFacts> = {}): WakeFacts => ({ ...NO_FACTS, ...over });

describe("wakeOf early facts", () => {
  it("wakes on a thread reply and names the sender and subject", () => {
    expect(wakeOf(waiting(), knowing({ threadReply: () => ({ name: "Priya", subject: "Re: Venue" }) }), NOW)).toEqual({ kind: "back", reason: "Priya wrote again: “Re: Venue”" });
  });
  it("wakes any item rated urgency now and names why", () => {
    const decision = wakeOf(waiting({ messageId: "reminder:1" }), knowing({ urgentNow: new Set(["reminder:1"]) }), NOW, "reminder:1");
    expect(decision).toEqual({ kind: "back", reason: URGENT_NOW_REASON });
    expect(backLine(waiting({ reason: URGENT_NOW_REASON, kind: "time", untilAt: null }), NOW)).toBe("Back because it is urgent now.");
  });
  it("lets a non-mail item ignore thread facts", () => {
    expect(wakeOf(waiting(), knowing({ threadReply: () => ({}) }), NOW, "reminder:1")).toEqual({ kind: "wait" });
  });
});
