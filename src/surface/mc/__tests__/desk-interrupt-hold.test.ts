import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { markInterrupts, NO_SWITCHES, pushInterrupts, runningMeeting, toPush, type InterruptRules } from "../desk/interrupt";
import { commandTransport } from "../desk/transports";
import { addVip } from "../desk/vips";
import { SourceCache } from "../desk/sources/command";
import { clock } from "../desk/time";
import type { DeskEvent, DeskItem, DeskView } from "../desk/types";
import { freshInterrupts } from "../dashboard-v2/lib/desk-seen";
import { FakeTransport, MIN, NOW, RULES, vipMail } from "./desk-interrupt-fixture";

const meeting = (key: string, from: number, to: number | undefined, over: Partial<DeskEvent> = {}): DeskEvent => ({
  key, at: from, ...(to !== undefined ? { end: to } : {}), title: key, area: null, kind: "meeting", ...over,
});

const item = (over: Partial<DeskItem> = {}): DeskItem => ({
  key: "mail:m1", kind: "mail", source: "mail", area: null, urgency: "today", title: "t", why: "w", score: 50, actions: [],
  detail: { summary: "", history: [], refs: ["someone@example.com", "m1"], links: [] }, since: NOW, ...over,
});

const review = meeting("review", NOW - 10 * MIN, NOW + 30 * MIN, { title: "Review" });

const mark = (items: DeskItem[], today: DeskEvent[], at: number, rules: InterruptRules = RULES): DeskItem[] =>
  markInterrupts(items, rules, new Map(), at, { ...NO_SWITCHES, today });

describe("runningMeeting", () => {
  it("stretches the hold over back-to-back meetings", () => {
    const next = meeting("next", NOW + 30 * MIN, NOW + 60 * MIN);
    const gap = meeting("gap", NOW + 70 * MIN, NOW + 90 * MIN);
    expect(runningMeeting([review, gap, next], NOW)).toMatchObject({ eventKey: "review", title: "Review", until: NOW + 60 * MIN });
  });

  it("counts a meeting nested inside the chain as part of it, so mail about it is not held", () => {
    const nested = meeting("nested", NOW + 5 * MIN, NOW + 15 * MIN);
    expect(runningMeeting([review, nested], NOW)?.keys.has("nested")).toBe(true);
    expect(mark([item({ eventKey: "nested", since: NOW + MIN })], [review, nested], NOW + 2 * MIN)[0]?.interrupt?.delivery).toBe("pending");
  });

  it("ignores free meetings, meetings without an end, all-day events and meetings not yet running", () => {
    expect(runningMeeting([meeting("free", NOW - MIN, NOW + MIN, { availability: { status: "free", provenance: "test" } })], NOW)).toBeNull();
    expect(runningMeeting([meeting("open", NOW - MIN, undefined)], NOW)).toBeNull();
    expect(runningMeeting([meeting("day", NOW - MIN, NOW + MIN, { kind: "all-day" })], NOW)).toBeNull();
    expect(runningMeeting([meeting("later", NOW + MIN, NOW + 2 * MIN)], NOW)).toBeNull();
    expect(runningMeeting([meeting("tentative", NOW - MIN, NOW + MIN, { availability: { status: "unknown", provenance: "test" } })], NOW)).not.toBeNull();
  });
});

describe("holding interruptions during a meeting", () => {
  it("holds mail and reminders that arrived during a busy meeting, with the reason and the hold on the item", () => {
    const [mail, reminder] = mark([item(), item({ key: "reminder:1", kind: "reminder" })], [review], NOW + MIN);
    expect(mail?.interrupt).toEqual({ delivery: "held", reason: { code: "mail.ranked" }, held: { eventKey: "review", title: "Review", until: NOW + 30 * MIN } });
    expect(reminder?.interrupt?.delivery).toBe("held");
  });

  it("does not hold a meeting about to start, mail about the running meeting, or a failed delivery", () => {
    const soon = item({ key: "meeting:x", kind: "meeting" });
    const about = item({ eventKey: "review" });
    const [m, a] = mark([soon, about], [review], NOW + MIN);
    expect(m?.interrupt?.delivery).toBe("pending");
    expect(a?.interrupt?.delivery).toBe("pending");
    const failed = markInterrupts([item()], RULES, new Map([["mail:m1", { key: "mail:m1", transport: "discord", status: "failed", error: "no", ref: null, createdAt: NOW }]]), NOW + MIN, { ...NO_SWITCHES, today: [review] });
    expect(failed[0]?.interrupt).toEqual({ delivery: "failed", error: "no" });
  });

  it("does not hold mail that arrived before the meeting started", () => {
    expect(mark([item({ since: NOW - 20 * MIN })], [review], NOW + MIN)[0]?.interrupt?.delivery).toBe("pending");
  });

  it("releases after a 90-minute meeting even with a 60-minute age limit, counting age from the end", () => {
    const long = meeting("long", NOW - 5 * MIN, NOW + 85 * MIN);
    const released = mark([item()], [long], NOW + 86 * MIN)[0];
    expect(released?.interrupt?.delivery).toBe("pending");
    expect(released?.interrupt?.held?.until).toBe(NOW + 85 * MIN);
    expect(mark([item()], [long], NOW + 85 * MIN + 61 * MIN)[0]?.interrupt).toBeUndefined();
  });

  it("releases on the next tick when the meeting is cancelled", () => {
    expect(mark([item()], [], NOW + 2 * MIN)[0]?.interrupt).toEqual({ delivery: "pending", reason: { code: "mail.ranked" } });
    expect(mark([item()], [], NOW + 61 * MIN)[0]?.interrupt).toBeUndefined();
  });

  it("holds nothing with holdDuringMeetings off", () => {
    expect(mark([item()], [review], NOW + MIN, { ...RULES, holdDuringMeetings: false })[0]?.interrupt?.delivery).toBe("pending");
  });

  it("holds even with transport none, so the tab does not chime until release", () => {
    const [held] = mark([item()], [review], NOW + MIN, { ...RULES, transport: "none" });
    expect(held?.interrupt?.delivery).toBe("held");
    const view = { items: [held] } as DeskView;
    expect(freshInterrupts(view, new Set())).toEqual([]);
    const [released] = mark([item()], [review], NOW + 31 * MIN, { ...RULES, transport: "none" });
    expect(freshInterrupts({ items: [released] } as DeskView, new Set())).toEqual(["mail:m1"]);
  });

  it("tells the transport that the item waited, and gives the command transport the hold", async () => {
    const [released] = mark([item()], [review], NOW + 31 * MIN);
    if (!released) throw new Error("missing item");
    const push = toPush(released);
    expect(push.why).toBe(`w It arrived at ${clock(NOW)} during "Review" and waited until the meeting ended.`);
    const seen: string[] = [];
    await commandTransport(["notify"], 1000, async (_argv, stdin) => { seen.push(stdin); return { code: 0, stdout: "", stderr: "" }; }).send(push);
    expect(JSON.parse(seen[0] ?? "{}").held).toEqual({ eventKey: "review", title: "Review", until: NOW + 30 * MIN });
  });
});

describe("the hold on the Desk", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); addVip(db, "boss@example.com", "Boss", NOW); });
  afterEach(() => { db.close(); });

  const options: DeskOptions = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [], sources: [{ id: "src", command: ["src"], everySeconds: 300, timeoutSeconds: 5 }], interruptions: RULES };
  const source = (meetingEnd: number) => new SourceCache(async () => JSON.stringify({
    events: [{ id: "review", start: new Date(NOW - 10 * MIN).toISOString(), end: new Date(meetingEnd).toISOString(), title: "Review" }],
    items: [vipMail("m1", NOW + 2 * MIN)],
  }));

  it("pushes nothing while the meeting runs, then once after it ends with the waited sentence", async () => {
    const end = NOW + 30 * MIN;
    const transport = new FakeTransport();
    const tick = async (at: number) => {
      const view = await composeDesk(db, options, undefined, { now: at, sourceCache: source(end) });
      return { view, pushed: await pushInterrupts(db, view.items, "discord", transport, at) };
    };
    const during = await tick(NOW + 5 * MIN);
    expect(during.view.items.find((i) => i.key === "mail:m1")?.interrupt?.delivery).toBe("held");
    expect(during.pushed).toEqual([]);
    expect((await tick(end + MIN)).pushed).toEqual([{ key: "mail:m1", status: "sent" }]);
    expect((await tick(end + 2 * MIN)).pushed).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.why).toEndWith(`It arrived at ${clock(NOW + 2 * MIN)} during "Review" and waited until the meeting ended.`);
  });
});
