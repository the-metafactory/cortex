import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import type { CalendarGap, CalendarGapReason, MyDayResponse } from "../../../desk-api";
import { deskContract } from "../../../desk-api/version";
import { handleDeskMyDay } from "../api/desk-my-day";
import { HandledLedger } from "../desk/actions";
import { calendarAvailability, currentGap } from "../desk/calendar-availability";
import { changeCalendar, discoverCalendars, listCalendars } from "../desk/calendars";
import { type DeskRuntime } from "../desk/compose";
import { readMyDay } from "../desk/my-day";
import { SourceCache } from "../desk/sources/command";
import { nextTask } from "../desk/time-first";
import { DATE, NOW, dayDatabase, desk } from "./desk-day-fixture";

const source = { id: "calendar", command: ["fixture-calendar"], everySeconds: 300, timeoutSeconds: 30 };
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const event = (start: number, end: number, id = "block") => ({ id, title: "Planning", calendar: "Work", calendarId: "work", start: iso(start), end: iso(end), availability: { status: "busy", provenance: "fixture" } });
const coverage = { from: iso(-600), to: iso(600), calendars: [{ id: "work", name: "Work" }], status: "complete", provenance: "fixture" };
const tasks = ["long", "fits", "short"];

function seed(): AppState {
  const children = tasks.map((id, index) => ({ id, title: id, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, estimateMinutes: [90, 20, 15][index] }));
  return { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 100, ordering: "parallel", children }] }, settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null };
}

describe("GET My Day serves the time-first state", () => {
  const { db, change } = dayDatabase(seed);
  let runtime: DeskRuntime;
  let reads: number;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    reads = 0;
    runtime = { options: { ...desk, sources: [source] }, ledger: new HandledLedger(), now: () => NOW };
    change({ op: "start", ids: tasks });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => handleDeskMyDay(req, db(), runtime) });
  });
  afterEach(() => { server.stop(true); });

  const prime = async (events: unknown[], at = NOW, failed = false) => {
    const cache = new SourceCache(() => {
      reads++;
      return failed ? Promise.reject(new Error("fixture calendar read failed")) : Promise.resolve(JSON.stringify({ capabilities: ["calendar"], calendarCoverage: coverage, events }));
    });
    await cache.read([source], at);
    runtime.sourceCache = cache;
  };
  const get = async (): Promise<MyDayResponse> => {
    const response = await fetch(new URL("/api/desk/my-day", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.json() as Promise<MyDayResponse>;
  };
  const expectedGap = () => currentGap(calendarAvailability({ sources: runtime.options?.sources ?? [], readings: runtime.sourceCache?.cached() ?? [], calendars: listCalendars(db()), now: NOW }), NOW);

  it("uses the server clock and cached busy overlaps without another calendar read", async () => {
    await prime([event(-10, 20), event(-5, 35, "overlap")]);
    const first = await get();
    expect(first.now).toEqual({ at: NOW, gap: expectedGap(), next: { kind: "none", reason: { code: "day.calendar-busy" } } });
    expect(first.now.gap).toMatchObject({ kind: "busy", until: NOW + 35 * 60_000 });
    await get();
    expect(reads).toBe(1);
  });

  it("picks the first fitting estimate in the saved order and preserves manual choice", async () => {
    await prime([event(35, 60)]);
    change({ op: "select", id: "long", revision: readMyDay(db(), desk, NOW).revision });
    const view = await get();
    expect(view.now.gap).toEqual(expectedGap());
    expect(view.now.gap).toMatchObject({ kind: "bounded", minutes: 35 });
    expect(view.now.next).toMatchObject({ kind: "fit", item: { task: { id: "fits" } }, minutes: 35, reason: { code: "day.task-fits" } });
    expect(view.items.map(item => item.task.id)).toEqual(tasks);
    expect(view.work.selection).toEqual({ kind: "manual", id: "long" });
  });

  it("offers the first task for open coverage and none once the day is closed", async () => {
    await prime([]);
    const view = await get();
    expect(view.now.gap).toEqual(expectedGap());
    expect(view.now.next).toMatchObject({ kind: "normal", item: { task: { id: "long" } }, reason: { code: "day.first-task" } });
    change({ op: "close" });
    expect((await get()).now.next).toEqual({ kind: "none", reason: { code: "day.closed" } });
  });

  it("returns coded unknown reasons for absent, unread, failed and stale calendars", async () => {
    const assertUnknown = async (reason: CalendarGapReason) => {
      const { now } = await get();
      expect(now.gap.kind).toBe("unknown");
      if (now.gap.kind !== "unknown") throw new Error("Expected unknown calendar availability");
      expect(now.gap.reasons).toContainEqual(reason);
      expect(now.next).toMatchObject({ kind: "unverified", item: { task: { id: "long" } }, reason: { code: "day.fit-unverified" } });
      for (const reason of now.gap.reasons) expect(deskContract().phraseCodes).toContain(reason.code);
    };
    runtime.options = { ...desk, sources: [] };
    await assertUnknown({ code: "calendar.no-coverage" });
    runtime.options = { ...desk, sources: [source] };
    await assertUnknown({ code: "calendar.not-read", params: { source: source.id } });
    await prime([], NOW, true);
    await assertUnknown({ code: "calendar.read-failed", params: { source: source.id } });
    await prime([event(-10, 20)], NOW - 300_000);
    await assertUnknown({ code: "calendar.stale", params: { source: source.id } });
    expect(reads).toBe(2);
  });

  it("respects disabled calendars", async () => {
    await prime([event(-10, 20)]);
    discoverCalendars(db(), [{ sourceId: source.id, calendar: "Work", calendarId: "work" }]);
    expect(changeCalendar(db(), { source: source.id, name: "Work", calendarId: "work", enabled: false })).toBe(true);
    expect((await get()).now.gap.kind).toBe("open");
  });

  it("ignores cached events from removed sources", async () => {
    const removed = { ...source, id: "removed-calendar", command: ["removed"] };
    const cache = new SourceCache(command => Promise.resolve(JSON.stringify({ capabilities: ["calendar"], calendarCoverage: coverage, events: command[0] === "removed" ? [{ ...event(-10, 20), availability: { status: "unknown", provenance: "fixture" } }] : [] })));
    await cache.read([source, removed], NOW);
    runtime.sourceCache = cache;
    expect((await get()).now.gap.kind).toBe("open");
  });

  it("serves no pick when every task is completed", async () => {
    await prime([]);
    for (const id of tasks) change({ op: "done", id });
    expect((await get()).now.next).toEqual({ kind: "none", reason: { code: "day.no-task" } });
  });

  it("serves no fit when all remaining estimates exceed the gap", async () => {
    await prime([event(5, 30)]);
    expect((await get()).now.next).toEqual({ kind: "none", reason: { code: "day.no-task-fits" } });
  });

  it("keeps nextTask eligibility and all published reason codes in every variant", () => {
    const day = readMyDay(db(), desk, NOW);
    const first = day.items[0];
    const second = day.items[1];
    if (!first || !second) throw new Error("Missing fixture tasks");
    first.task.done = true;
    second.task.deferredUntil = "2099-01-01";
    const gap: CalendarGap = { kind: "open", through: NOW + 600_000, asOf: NOW };
    expect(nextTask(day, gap)).toMatchObject({ kind: "normal", item: { task: { id: "short" } } });
    second.task.deferredUntil = DATE;
    expect(nextTask(day, gap)).toMatchObject({ kind: "normal", item: { task: { id: "fits" } } });
    for (const candidate of [day, { ...day, items: [] }, { ...day, phase: "closed" as const }]) {
      expect(deskContract().phraseCodes).toContain(nextTask(candidate, gap).reason.code);
    }
  });
});
