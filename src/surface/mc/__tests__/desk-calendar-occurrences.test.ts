import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { NO_INTERRUPTIONS } from "../desk/interrupt";
import { SourceCache } from "../desk/sources/command";
import { initDatabase } from "../db/init";

const NOW = new Date("2026-11-02T08:00:00").getTime();
const at = (minutes: number): string => new Date(NOW + minutes * 60000).toISOString();
const options: DeskOptions = {
  enabled: true, displayName: "Sam", topN: 5, rangerUrl: "", areas: [], interruptions: { ...NO_INTERRUPTIONS, meetingMinutes: 10 },
  sources: ["work", "personal"].map(id => ({ id, command: [id], everySeconds: 30, timeoutSeconds: 1 })),
};
const event = (over: Record<string, unknown>) => ({ id: "a", title: "Meeting", start: at(60), end: at(90), calendar: "Home", calendarId: "cal", availability: { status: "busy", provenance: "test" }, ...over });

describe("Desk calendar occurrences", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const compose = (work: unknown[], personal: unknown[] = [], now = NOW, cache = new SourceCache(async ([id]) => JSON.stringify({ capabilities: ["calendar"], events: id === "work" ? work : personal }))) =>
    composeDesk(db, options, undefined, { now, sourceCache: cache });
  const shown = async (work: unknown[], personal: unknown[] = []) => {
    const desk = await compose(work, personal);
    return { today: desk.today.map(entry => entry.key), intervals: desk.calendarAvailability?.events.map(interval => interval.key) };
  };

  it("shows a repeated delivery of one occurrence once, in the entries and in availability", async () => {
    expect(await shown([event({}), event({})])).toEqual({ today: ["cal:work:a"], intervals: ["cal:work:a"] });
  });

  it("treats two spellings of one instant as the same occurrence", async () => {
    const spelled = new Date(NOW + 3600000).toISOString().replace(/\.\d+Z$/, "Z");
    expect((await shown([event({}), event({ start: spelled })])).today).toEqual(["cal:work:a"]);
  });

  it("stays at one entry through repeated refreshes", async () => {
    const cache = new SourceCache(async ([id]) => JSON.stringify({ capabilities: ["calendar"], events: id === "work" ? [event({}), event({})] : [] }));
    for (const now of [NOW, NOW + 31000, NOW + 62000]) {
      expect((await compose([], [], now, cache)).today).toHaveLength(1);
      await cache.read(options.sources, now);
    }
  });

  it("keeps two distinct coincident events with one title in one calendar", async () => {
    expect((await shown([event({ id: "a" }), event({ id: "b" })])).today).toEqual(["cal:work:a", "cal:work:b"]);
  });

  it("keeps two occurrences of one recurring id", async () => {
    const desk = await compose([event({}), event({ start: at(120), end: at(150) })]);
    expect(desk.today.map(entry => entry.at)).toEqual([Date.parse(at(60)), Date.parse(at(120))]);
  });

  it("keeps one provider id in two calendars", async () => {
    const desk = await compose([event({ calendarId: "first" }), event({ calendarId: "second" })]);
    expect(desk.today.map(entry => entry.calendarId)).toEqual(["first", "second"]);
  });

  it("retains a look-alike pair across two readers, which needs occurrence identity", async () => {
    expect((await shown([event({ id: "work-id" })], [event({ id: "personal-id", calendarId: "other" })])).today).toEqual(["cal:work:work-id", "cal:personal:personal-id"]);
  });
});

describe("Desk meetings across the day boundary", () => {
  const LATE = new Date("2026-11-02T23:50:00").getTime();
  const minute = (n: number): string => new Date(LATE + n * 60000).toISOString();
  const meeting = (over: Record<string, unknown>) => ({ id: "budget-call", title: "Budget call", start: minute(5), end: minute(40), calendar: "Work", calendarId: "cal", ...over });
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const compose = (events: unknown[]) => composeDesk(db, options, undefined, { now: LATE, sourceCache: new SourceCache(async ([id]) => JSON.stringify({ capabilities: ["calendar"], events: id === "work" ? events : [] })) });
  const meetingKeys = async (events: unknown[]) => (await compose(events)).items.filter(item => item.kind === "meeting").map(item => item.key);

  it("keeps one meeting item for an event that spans into the coming days", async () => {
    const desk = await compose([meeting({})]);
    expect(desk.today.map(entry => entry.key)).toEqual(["cal:work:budget-call"]);
    expect(desk.ahead.map(entry => entry.key)).toEqual(["cal:work:budget-call"]);
    expect(desk.items.filter(item => item.kind === "meeting").map(item => item.key)).toEqual([`meeting:cal:work:budget-call@${Date.parse(minute(5))}`]);
  });

  it("keeps an item for each of two distinct meetings in the window", async () => {
    expect(await meetingKeys([meeting({ id: "budget-call" }), meeting({ id: "handover", title: "Handover", start: minute(6), end: minute(41) })])).toEqual([
      `meeting:cal:work:budget-call@${Date.parse(minute(5))}`,
      `meeting:cal:work:handover@${Date.parse(minute(6))}`,
    ]);
  });

  it("composes no item key twice", async () => {
    const keys = (await compose([meeting({}), meeting({ id: "handover", title: "Handover", start: minute(6), end: minute(41) })])).items.map(item => item.key);
    expect(keys).toEqual([...new Set(keys)]);
  });
});
