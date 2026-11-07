import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskCalendars } from "../api/desk-calendars";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { changeCalendar, discoverCalendars, listCalendars } from "../desk/calendars";
import { NO_INTERRUPTIONS } from "../desk/interrupt";
import { SourceCache } from "../desk/sources/command";
import { initDatabase } from "../db/init";

const NOW = new Date("2026-11-02T08:00:00").getTime();
const options: DeskOptions = {
  enabled: true, displayName: "Sam", topN: 5, rangerUrl: "", areas: [], interruptions: { ...NO_INTERRUPTIONS, meetingMinutes: 10 },
  sources: [{ id: "one", command: ["one"], everySeconds: 30, timeoutSeconds: 1 }],
};
const coverage = (ids: string[], status: "complete" | "partial" = "complete") => ({
  from: new Date(NOW).toISOString(), to: new Date(NOW + 86400000).toISOString(), status, provenance: "test",
  calendars: ids.map(id => ({ id, name: "Home" })),
});
const reading = (ids: string[], status: "complete" | "partial" = "complete") => JSON.stringify({ capabilities: ["calendar"], events: [], calendarCoverage: coverage(ids, status) });
const read = (db: Database, output: string | Error) => composeDesk(db, options, undefined, { now: NOW, sourceCache: new SourceCache(async () => { if (output instanceof Error) throw output; return output; }) });
const stored = (db: Database, source = "one") => db.query<{ calendar_id: string }, [string]>("SELECT calendar_id FROM desk_calendar_identities WHERE source = ? ORDER BY rowid").all(source).map(row => row.calendar_id);
const ids = (db: Database) => listCalendars(db).map(row => row.calendarId);

describe("Desk calendar retirement", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
    discoverCalendars(db, ["older", "old", "newest"].map(calendarId => ({ sourceId: "one", calendar: "Home", calendarId })));
    changeCalendar(db, { source: "one", name: "Home", calendarId: "older", enabled: false, color: "#111111" });
    changeCalendar(db, { source: "one", name: "Home", calendarId: "newest", color: "#123456" });
  });
  afterEach(() => { db.close(); });

  it("lists a name once in a source with the kept row's preferences, and keeps the retired rows", async () => {
    await read(db, reading(["newest"]));
    const expected = [{ source: "one", name: "Home", calendarId: "newest", enabled: true, color: "#123456" }];
    expect(listCalendars(db)).toEqual(expected);
    expect(stored(db)).toEqual(["older", "old", "newest"]);
    const settings = await handleDeskCalendars(new Request("http://localhost/api/desk/calendars"), db);
    expect(await settings.json()).toEqual({ calendars: expected });
    expect((await read(db, reading(["newest"]))).calendars).toEqual(expected);
  });

  it("keeps a row the reader still returns, even when it shares a name", async () => {
    await read(db, reading(["old", "newest"]));
    expect(ids(db)).toEqual(expect.arrayContaining(["old", "newest"]));
    expect(ids(db)).not.toContain("older");
    expect(listCalendars(db)).toHaveLength(2);
  });

  it("treats an event from a calendar as the reader returning it", async () => {
    const start = new Date(NOW + 300000).toISOString();
    await read(db, JSON.stringify({ capabilities: ["calendar"], events: [{ id: "a", title: "Meeting", start, calendar: "Home", calendarId: "old" }], calendarCoverage: coverage(["newest"]) }));
    expect(ids(db)).toContain("old");
  });

  it("keeps an event that names its calendar without an id visible, and its row", async () => {
    changeCalendar(db, { source: "one", name: "Home", calendarId: "older", enabled: true });
    const start = new Date(NOW + 300000).toISOString();
    const desk = await read(db, JSON.stringify({ capabilities: ["calendar"], events: [{ id: "a", title: "Meeting", start, calendar: "Home" }], calendarCoverage: { ...coverage(["other"]), calendars: [{ id: "other", name: "Other" }] } }));
    expect(desk.today.map(entry => entry.title)).toEqual(["Meeting"]);
    expect(ids(db)).toEqual(expect.arrayContaining(["older", "old", "newest"]));
  });

  it("restores the newest row when a name-only event arrives for a retired name", async () => {
    const otherOnly = { ...coverage(["other"]), calendars: [{ id: "other", name: "Other" }] };
    await read(db, JSON.stringify({ capabilities: ["calendar"], events: [], calendarCoverage: otherOnly }));
    expect(ids(db)).toEqual(["other"]);
    const start = new Date(NOW + 300000).toISOString();
    const desk = await read(db, JSON.stringify({ capabilities: ["calendar"], events: [{ id: "a", title: "Meeting", start, calendar: "Home" }], calendarCoverage: otherOnly }));
    expect(desk.today.map(entry => entry.title)).toEqual(["Meeting"]);
    expect(ids(db)).toEqual(expect.arrayContaining(["newest", "other"]));
    expect(ids(db)).not.toContain("older");
  });

  it("retires nothing on a partial, empty, failed or coverage-less reading", async () => {
    const before = listCalendars(db);
    for (const output of [reading(["newest"], "partial"), reading([]), new Error("reader is down"), JSON.stringify({ capabilities: ["calendar"], events: [] })]) {
      await read(db, output);
      expect(listCalendars(db)).toEqual(before);
    }
  });

  it("leaves another source's same-named rows alone", async () => {
    discoverCalendars(db, [{ sourceId: "two", calendar: "Home", calendarId: "elsewhere" }]);
    await read(db, reading(["newest"]));
    expect(listCalendars(db).map(row => row.source).sort()).toEqual(["one", "two"]);
  });

  it("restores a retired row with its preferences when the reader returns it again", async () => {
    await read(db, reading(["newest"]));
    await read(db, reading(["older", "newest"]));
    expect(listCalendars(db)).toContainEqual({ source: "one", name: "Home", calendarId: "older", enabled: false, color: "#111111" });
  });

  it("gives a new id for a retired name the newest row's preferences", async () => {
    await read(db, reading(["newest"]));
    await read(db, reading(["replacement"]));
    expect(listCalendars(db)).toEqual([{ source: "one", name: "Home", calendarId: "replacement", enabled: true, color: "#123456" }]);
  });

  it("refuses a change to a retired row, and a name-only change reaches the kept row alone", async () => {
    await read(db, reading(["newest"]));
    expect(changeCalendar(db, { source: "one", name: "Home", calendarId: "older", enabled: true })).toBe(false);
    expect(changeCalendar(db, { source: "one", name: "Home", enabled: false })).toBe(true);
    expect(listCalendars(db)).toEqual([{ source: "one", name: "Home", calendarId: "newest", enabled: false, color: "#123456" }]);
    await read(db, reading(["older", "newest"]));
    expect(listCalendars(db)).toContainEqual({ source: "one", name: "Home", calendarId: "older", enabled: false, color: "#111111" });
  });
});
