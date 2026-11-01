import { describe, expect, it } from "bun:test";
import { calendarDayStart, calendarDays, calendarWindows, moveCalendar, readCalendar } from "../dashboard-v2/lib/routine-calendar";
import { defaultRoutinesLocation, readRoutinesLocation, routinesSearch } from "../dashboard-v2/hooks/use-routines-location";
import { RoutineOccurrencePageSchema } from "../desk/routine-occurrence-contract";

const page = (query: URLSearchParams) => ({ owner: "reflex", principal: "test", stack: "default", start: query.get("start"), end: query.get("end"), timezone: query.get("timezone"), meaning: "planned-trigger", occurrences: [], complete: true, nextCursor: null, counts: { scope: "page", total: 0, active: 0, disabled: 0 } });
const occurrence = (at: string, id = "example") => ({ routineId: id, schedule: "* * * * *", sourceTimezone: "UTC", lifecycle: "active", handlingPolicy: "approval", readOnly: true, scheduledFor: at, capabilities: { editParameters: false, editSchedule: false, pause: false, delete: false, setPolicy: false } });

describe("Routines page calendar and location", () => {
  it("restores a direct workspace URL and keeps unrelated settings out of the Routines route", () => {
    const state = { ...defaultRoutinesLocation(), tab: "workspace" as const, routine: "example", view: "month" as const, date: "2026-11-02", timezone: "Europe/Zurich", showPaused: true, policy: "approval" as const };
    const search = routinesSearch("?api=local&settings=vips", state);
    expect(search).toContain("api=local"); expect(search).not.toContain("settings"); expect(readRoutinesLocation(search)).toEqual(state);
    expect(readRoutinesLocation(routinesSearch(search, null))).toBeNull();
    expect(readRoutinesLocation("?routines=bad&routine-date=2026-02-30&routine-timezone=Invalid%2FZone")?.date).not.toBe("2026-02-30");
  });
  it("uses local day boundaries across both DST transitions and bounded adjacent six-week month windows", () => {
    expect(calendarDayStart("2026-03-30", "Europe/Zurich") - calendarDayStart("2026-03-29", "Europe/Zurich")).toBe(23 * 3600000);
    expect(calendarDayStart("2026-10-26", "Europe/Zurich") - calendarDayStart("2026-10-25", "Europe/Zurich")).toBe(25 * 3600000);
    const days = calendarDays("2026-11-02", "month"); expect(days).toHaveLength(42); expect(days[0]).toBe("2026-10-26");
    const windows = calendarWindows(days, "Europe/Zurich"); expect(windows).toHaveLength(2); expect(windows[0]?.end).toBe(windows[1]?.start);
    for (const window of windows) expect(Date.parse(window.end) - Date.parse(window.start)).toBeLessThan(32 * 86400000);
    expect(moveCalendar("2026-12-31", "month", 1)).toBe("2027-01-01"); expect(moveCalendar("2026-11-02", "week", -1)).toBe("2026-10-26");
  });
  it("collects cursor pages and both month windows without treating page counts as totals", async () => {
    const server = Bun.serve({ port: 0, fetch(req) { const q = new URL(req.url).searchParams; const value = page(q); return Response.json(q.has("cursor") ? value : { ...value, occurrences: [occurrence(q.get("start") ?? "")], complete: false, nextCursor: "second", counts: { scope: "page", total: 1, active: 1, disabled: 0 } }); } });
    try {
      const read: typeof import("../dashboard-v2/lib/api").getJson = async (path, init) => { const response = await fetch(`${server.url}${path.slice(1)}`, init); return response.json(); };
      const result = await readCalendar({ days: calendarDays("2026-11-02", "month"), timezone: "Europe/Zurich", signal: new AbortController().signal, read });
      expect(result.complete).toBe(true); expect(result.occurrences).toHaveLength(2);
    } finally { server.stop(true); }
  });
  it("rejects repeated cursors, overlapping pages, foreign scope and owner failures", async () => {
    for (const mode of ["cursor", "duplicate", "scope", "failure"] as const) {
      const server = Bun.serve({ port: 0, fetch(req) { const q = new URL(req.url).searchParams; if (mode === "failure") return new Response("down", { status: 502 }); const value = page(q); return Response.json({ ...value, principal: mode === "scope" && q.has("cursor") ? "foreign" : "test", occurrences: [occurrence(mode === "duplicate" ? q.get("start") ?? "" : new Date(Date.parse(q.get("start") ?? "") + (q.has("cursor") ? 60000 : 0)).toISOString())], complete: false, nextCursor: "same", counts: { scope: "page", total: 1, active: 1, disabled: 0 } }); } });
      try {
        const read: typeof import("../dashboard-v2/lib/api").getJson = async (path, init) => { const response = await fetch(`${server.url}${path.slice(1)}`, init); if (!response.ok) throw new Error("Owner failure"); return response.json(); };
        await expect(readCalendar({ days: ["2026-11-02"], timezone: "UTC", signal: new AbortController().signal, read })).rejects.toThrow();
      } finally { server.stop(true); }
    }
  });
  it("marks dense bounded reads incomplete rather than returning a false complete total", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, fetch(req) { const q = new URL(req.url).searchParams; const n = requests++; return Response.json({ ...page(q), occurrences: [occurrence(new Date(Date.parse(q.get("start") ?? "") + n * 1000).toISOString())], complete: false, nextCursor: String(n), counts: { scope: "page", total: 1, active: 1, disabled: 0 } }); } });
    try {
      const read: typeof import("../dashboard-v2/lib/api").getJson = async (path, init) => { const response = await fetch(`${server.url}${path.slice(1)}`, init); return response.json(); };
      const result = await readCalendar({ days: ["2026-11-02"], timezone: "UTC", signal: new AbortController().signal, read });
      expect(requests).toBe(20); expect(result.complete).toBe(false); expect(result.occurrences).toHaveLength(20);
      expect(RoutineOccurrencePageSchema.safeParse({ ...page(new URLSearchParams()), nextCursor: "", complete: false }).success).toBe(false);
    } finally { server.stop(true); }
  });
});
