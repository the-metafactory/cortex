import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { NO_INTERRUPTIONS } from "../desk/interrupt";
import { SourceCache } from "../desk/sources/command";
import { addNote } from "../desk/notes";
import { initDatabase } from "../db/init";

const NOW = new Date("2026-11-02T08:00:00").getTime();
const START_OF_DAY = new Date("2026-11-02T00:00:00").getTime();
const dayStart = (days: number): number => {
  const d = new Date(START_OF_DAY);
  d.setDate(d.getDate() + days);
  return d.getTime();
};
const options: DeskOptions = {
  enabled: true, displayName: "Sam", topN: 5, rangerUrl: "", areas: [], interruptions: NO_INTERRUPTIONS,
  sources: [{ id: "cal", command: ["cal"], everySeconds: 3600, timeoutSeconds: 1 }],
};
const event = (id: string, startMs: number) => ({ id, title: id, start: new Date(startMs).toISOString(), end: new Date(startMs + 1800000).toISOString(), calendar: "Work", calendarId: "work", availability: { status: "busy", provenance: "test" } });
const coverageEndingAt = (to: number) => ({ from: new Date(START_OF_DAY).toISOString(), to: new Date(to).toISOString(), calendars: [{ id: "work", name: "Work" }], status: "complete", provenance: "test" });

describe("Desk ahead[] rolling week", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const compose = (events: unknown[], calendarCoverage?: unknown) => {
    const cache = new SourceCache(async () => JSON.stringify({ capabilities: ["calendar"], ...(calendarCoverage ? { calendarCoverage } : {}), events }));
    return composeDesk(db, options, undefined, { now: NOW, sourceCache: cache });
  };

  it("lists an event that starts 6 days after the start of today", async () => {
    const desk = await compose([event("six", dayStart(6) + 3600000)]);
    expect(desk.ahead.map(entry => entry.title)).toEqual(["six"]);
  });

  it("leaves out an event that starts 7 days after the start of today", async () => {
    const desk = await compose([event("seven", dayStart(7))]);
    expect(desk.ahead).toEqual([]);
  });

  it("lists a reminder due 6 days after the start of today and leaves out one due on day 7", async () => {
    addNote(db, "reminder", "Day six", dayStart(6) + 3600000, NOW);
    addNote(db, "reminder", "Day seven", dayStart(7) + 3600000, NOW);
    const desk = await compose([]);
    expect(desk.ahead.filter(entry => entry.kind === "reminder").map(entry => entry.title)).toEqual(["Day six"]);
  });

  it("shows a short calendar read through the source's coverage end and invents nothing after it", async () => {
    const end = dayStart(3);
    const desk = await compose([event("early", dayStart(2) + 3600000)], coverageEndingAt(end));
    expect(desk.ahead.map(entry => entry.title)).toEqual(["early"]);
    const state = desk.calendarAvailability?.sources.find(source => source.id === "cal");
    expect(state).toMatchObject({ kind: "calendar", to: end });
  });
});
