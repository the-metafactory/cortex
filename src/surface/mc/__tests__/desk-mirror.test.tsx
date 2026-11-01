import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { buildWeeklyMirror, mirrorOffered, mirrorWeek, type MirrorCalendarEvent } from "../desk/mirror";
import { type DeskOptions, composeDesk } from "../desk/compose";
import { buildStudioView } from "../desk/studio/view";
import { planAct } from "../desk/studio/acts";
import type { SourceReading } from "../desk/sources/command";
import { SourceCache, parseSourceOutput } from "../desk/sources/command";
import { DeskMirror } from "../dashboard-v2/components/desk-mirror";
import { deskSearch, readDeskLocation } from "../dashboard-v2/hooks/use-desk-studio";
import { StudioForegroundClock, foregroundForWeek } from "../dashboard-v2/lib/studio-foreground";
import { initDatabase } from "../db/init";
import { saveBalanceState, loadBalanceState } from "../desk/balance-store";
import { briefing, selectItems } from "../desk/present";

const at = (day: number, hour = 12, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(30, 17);
const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }, { id: "home", label: "Home", color: "", repos: [], goals: [] }], sources: [{ id: "calendar", command: ["unused"], everySeconds: 300, timeoutSeconds: 5 }], mirror: { day: "friday", time: "16:00" } };
function state(): AppState {
  return { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:work", title: "Work", weight: 60, ordering: "parallel", children: [] },
    { id: "area:home", title: "Home", weight: 40, ordering: "parallel", children: [] },
  ] }, settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} }, log: [
    { taskId: "task-a", areaId: "area:work", effort: 2, title: "Publish a draft", date: "2026-10-26" },
    { taskId: "studio-response:fixture", areaId: "area:home", effort: 1, title: "Respond to a thought", date: "2026-10-30" },
    { taskId: "old", areaId: "area:home", effort: 4, title: "Previous week", date: "2026-10-25" },
    { taskId: "future", areaId: "area:home", effort: 4, title: "Not yet", date: "2026-10-31" },
  ] };
}
const event = (id: string, start: number, end: number, area: string | null = "work"): MirrorCalendarEvent => ({ id, start: new Date(start).toISOString(), end: new Date(end).toISOString(), title: "Fixture meeting", area, sourceId: "calendar" });
const reading = (events: MirrorCalendarEvent[] = []): SourceReading => ({ id: "calendar", area: "work", events, mail: [], readAt: NOW, error: null, dropped: 0, problems: [] });
function mirror(extra: Partial<Parameters<typeof buildWeeklyMirror>[0]> = {}) {
  return buildWeeklyMirror({ now: NOW, desk, state: state(), studio: null, readings: [reading()], events: [], calendarSources: ["calendar"], ...extra });
}
describe("weekly mirror over authoritative evidence", () => {
  test("wins and source-owned Studio effort share span the week without interpreting credits as hours", () => {
    const model = mirror();
    expect(model.week).toMatchObject({ from: "2026-10-26", through: "2026-11-01" });
    expect(model.balance?.wins.map(w => w.title)).toEqual(["Respond to a thought", "Publish a draft"]);
    expect(model.balance?.areas[0]).toMatchObject({ targetShare: 0.6, actualShare: 2 / 3 });
    expect(model.studioEffortShare).toBe(1 / 3);
    const misleading = state();
    misleading.log[0] = { taskId: "manual", areaId: "area:work", effort: 2, title: "studio-response: a title is not attribution", date: "2026-10-26" };
    expect(mirror({ state: misleading }).studioEffortShare).toBe(1 / 3);
  });
  test("cross-month weeks keep earlier-month wins and no-evidence shares stay unknown", () => {
    const model = mirror({ now: new Date(2026, 10, 1, 12).getTime() });
    expect(model.balance?.totalCompletions).toBe(3);
    const empty = state(); empty.log = [];
    expect(mirror({ state: empty }).studioEffortShare).toBeNull();
    expect(mirror({ state: null }).balance).toBeNull();
  });
  test("paused or removed areas remain visible as unallocated recorded effort", () => {
    const input = state();
    input.log.push({ taskId: "removed", areaId: "area:removed", effort: 3, title: "An archived win", date: "2026-10-29" });
    expect(mirror({ state: input }).unallocatedEffortShare).toBe(0.5);
    expect(mirror({ state: input }).balance?.wins.some(w => w.title === "An archived win")).toBe(true);
  });
  test("calendar hours clip elapsed week intervals and merge overlap per area", () => {
    const events = [event("a", at(30, 9), at(30, 11)), event("b", at(30, 10), at(30, 12)), event("c", at(30, 16), at(30, 19)), event("other", at(30, 10), at(30, 11), "home"), event("future", at(31, 9), at(31, 12))];
    const model = mirror({ events, readings: [reading(events)] });
    expect(model.calendar.areas).toEqual([{ id: "work", hours: 4 }, { id: "home", hours: 1 }]);
    expect(model.calendar.sources[0]?.status).toBe("snapshot");
  });
  test("empty, missing, failed and stale calendar snapshots are distinct", () => {
    expect(mirror().calendar).toMatchObject({ available: true, areas: [], sources: [{ status: "snapshot" }] });
    expect(mirror({ readings: [] }).calendar.sources[0]?.status).toBe("missing");
    expect(mirror({ readings: [{ ...reading(), error: "offline" }] }).calendar).toMatchObject({ available: false, sources: [{ status: "failed" }] });
    expect(mirror({ readings: [{ ...reading(), readAt: NOW - 301_000 }] }).calendar).toMatchObject({ available: true, sources: [{ status: "stale" }] });
  });
  test("all-day and unknown-duration events are not guessed into meeting hours", () => {
    const events = [{ ...event("all", at(30, 0), at(31, 0)), allDay: true }, { id: "unknown", start: new Date(at(30, 9)).toISOString(), title: "No end", area: null, sourceId: "calendar" }];
    expect(mirror({ events }).calendar).toMatchObject({ areas: [], allDay: 1, withoutDuration: 1 });
    expect(parseSourceOutput(JSON.stringify({ events: [{ id: "bad", start: "invalid", title: "Malformed" }] }))).toMatchObject({ dropped: 1, events: [] });
  });
  test("Studio outcomes and dated parking logs are scoped to this week and reviews include overdue decisions", () => {
    const source = (slug: string, front: string, log = "") => ({ path: `threads/${slug}.md`, text: `---\ntype: question\nareas: [work]\nopened: 2026-10-26\n${front}\n---\n## Question\n${slug}\n## Where I stand\nThinking\n## Material\n## Ivy's notes\n## Log\n${log}\n## Outcome\nKeep the simpler option\n` });
    const studio = buildStudioView({ threads: [source("closed", "state: closed\nclosed: 2026-10-29\noutcome: decided\nreviewOn: 2026-10-30\nexpect: Less duplication", "- 2026-10-28: Parked"), source("old-park", "state: parked", "- 2026-10-20: Parked")], inbox: [], proposals: [] }, { dir: "/fixture", maxActive: 5 }, desk.areas);
    const model = mirror({ studio });
    expect(model.threads.opened).toHaveLength(2);
    expect(model.threads.parked.map(t => t.slug)).toEqual(["closed"]);
    expect(model.threads.closed[0]?.outcomeText).toBe("Keep the simpler option");
    expect(model.threads.reviews[0]?.expect).toBe("Less duplication");
  });
  test("the configured offer starts Friday16:00 and remains available through the weekend", () => {
    expect(mirrorOffered(at(30, 15, 59), desk.mirror)).toBe(false);
    expect(mirrorOffered(at(30, 16), desk.mirror)).toBe(true);
    expect(mirrorOffered(at(31, 12), desk.mirror)).toBe(true);
    expect(mirrorOffered(new Date(2026, 10, 2, 12).getTime(), desk.mirror)).toBe(false);
    expect(mirrorOffered(NOW, undefined)).toBe(false);
  });
  test("includes a thread parked by the real replacement act rather than only explicit Park", () => {
    const file = (slug: string, state: string) => ({ path: `threads/${slug}.md`, text: `---\ntype: question\nareas: [work]\nstate: ${state}\nopened: 2026-10-26\n---\n## Question\n${slug}\n## Where I stand\nThinking\n## Material\n## Ivy's notes\n## Log\n` });
    const files = { threads: [file("original", "active"), file("replacement", "parked")], inbox: [], proposals: [] };
    const options = { dir: "/fixture", maxActive: 1 };
    const view = buildStudioView(files, options, desk.areas);
    const plan = planAct({ files, view, now: new Date(NOW) }, { act: "unpark", thread: "replacement", park: "original" });
    if ("error" in plan) throw new Error(plan.error);
    const saved = { ...files, threads: files.threads.map(f => plan.writes.find(w => w.path === f.path) ?? f) };
    const studio = buildStudioView(saved, options, desk.areas);
    expect(studio.active.map(t => t.slug)).toEqual(["replacement"]);
    expect(mirror({ studio }).threads.parked.map(t => t.slug)).toEqual(["original"]);
  });
  test("real Desk composition includes the mirror and briefing without changing the confirmed day", async () => {
    const db = initDatabase(":memory:");
    try {
      saveBalanceState(db, state());
      const cache = new SourceCache(() => Promise.resolve(JSON.stringify({ events: [] })));
      const view = await composeDesk(db, desk, undefined, { now: NOW, sourceCache: cache });
      expect(view.mirror?.balance?.wins).toHaveLength(2);
      expect(briefing(view, selectItems(view, "all", new Set()), null).lines.join(" ")).toContain("weekly mirror is ready");
      expect(loadBalanceState(db)?.dayState).toBeNull();
    } finally { db.close(); }
  });
  test("URL routes survive reload/back and the React surface puts real wins first", () => {
    const search = deskSearch("?unrelated=kept&desk=studio&thread=one", { mode: "mirror", thread: null });
    expect(readDeskLocation(search)).toEqual({ mode: "mirror", thread: null });
    expect(search).toContain("unrelated=kept");
    expect(readDeskLocation(deskSearch(search, { mode: "day", thread: null })).mode).toBe("day");
    const html = renderToStaticMarkup(createElement(DeskMirror, { mirror: mirror(), areas: desk.areas, foreground: { kind: "unavailable", reason: "Not measured" }, onThread: () => undefined }));
    expect(html.indexOf("Wins first")).toBeLessThan(html.indexOf("Attention against intention"));
    expect(html).toContain("Recorded completion effort");
    expect(html).toContain("this browser");
    expect(html).toContain("partial source snapshot");
    expect(html).toContain("Respond to a thought");
  });
});

describe("local aggregate foreground Studio clock", () => {
  function store(initial: string | null = null) {
    let text = initial;
    return { getItem: () => text, setItem: (_key: string, value: string) => { text = value; } };
  }
  test("counts only active intervals, flushes blur/navigation and resumes without counting away time", () => {
    const storage = store();
    const clock = new StudioForegroundClock(storage);
    const sample = (seconds: number, active: boolean) => clock.sample({ at: NOW + seconds * 1000, monotonic: seconds * 1000, active });
    expect(clock.read().kind).toBe("unavailable");
    sample(0, true); sample(1, true); sample(2, false); sample(3, false); sample(4, true);
    expect(foregroundForWeek(sample(5, false), mirrorWeek(NOW))).toBe(3000);
    const reloaded = new StudioForegroundClock(storage);
    expect(foregroundForWeek(reloaded.sample({ at: NOW + 50_000, monotonic: 0, active: false }), mirrorWeek(NOW))).toBe(3000);
    expect(storage.getItem()).not.toContain("thread");
  });
  test("midnight and week boundaries split actual milliseconds into their local dates", () => {
    const clock = new StudioForegroundClock(store());
    const sunday = new Date(2026, 10, 1, 23, 59, 59, 500).getTime();
    clock.sample({ at: sunday, monotonic: 0, active: true });
    const result = clock.sample({ at: sunday + 1000, monotonic: 1000, active: false });
    expect(foregroundForWeek(result, mirrorWeek(sunday))).toBe(500);
    expect(foregroundForWeek(result, mirrorWeek(sunday + 1000))).toBe(500);
  });
  test("Desk timezone owns midnight buckets even when the browser zone differs and saved zones cannot be reinterpreted", () => {
    const storage = store();
    const clock = new StudioForegroundClock(storage, "Pacific/Auckland");
    const beforeMidnight = Date.parse("2026-11-01T10:59:59.500Z");
    clock.sample({ at: beforeMidnight, monotonic: 0, active: true });
    const result = clock.sample({ at: beforeMidnight + 1000, monotonic: 1000, active: false });
    expect(foregroundForWeek(result, { from: "2026-10-26", through: "2026-11-01", timeZone: "Pacific/Auckland" })).toBe(500);
    expect(foregroundForWeek(result, { from: "2026-11-02", through: "2026-11-08", timeZone: "Pacific/Auckland" })).toBe(500);
    expect(new StudioForegroundClock(storage, "America/Los_Angeles").read().kind).toBe("unavailable");
    expect(foregroundForWeek(result, { from: "2026-11-02", through: "2026-11-08", timeZone: "UTC" })).toBeNull();
    expect(new StudioForegroundClock(storage, "invalid-zone").read().kind).toBe("unavailable");
  });
  test("corrupt, missing, denied storage and long delayed ticks never fabricate earlier time", () => {
    const corrupt = new StudioForegroundClock(store("broken"));
    expect(corrupt.sample({ at: NOW, monotonic: 0, active: true }).kind).toBe("unavailable");
    expect(new StudioForegroundClock(null).read().kind).toBe("unavailable");
    const denied = new StudioForegroundClock({ getItem: () => null, setItem: () => { throw new Error("denied"); } });
    expect(denied.sample({ at: NOW, monotonic: 0, active: true }).kind).toBe("unavailable");
    const clock = new StudioForegroundClock(store());
    clock.sample({ at: NOW, monotonic: 0, active: true });
    const result = clock.sample({ at: NOW + 3_600_000, monotonic: 3_600_000, active: false });
    expect(foregroundForWeek(result, mirrorWeek(NOW))).toBe(0);
    expect(foregroundForWeek(result, mirrorWeek(NOW - 7 * 86_400_000))).toBeNull();
  });
});
