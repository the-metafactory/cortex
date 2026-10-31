import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskCalendars } from "../api/desk-calendars";
import { changeCalendar, discoverCalendars, listCalendars } from "../desk/calendars";
import { NO_INTERRUPTIONS } from "../desk/interrupt";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { parseSourceOutput, SourceCache } from "../desk/sources/command";

const NOW = new Date("2026-11-02T08:00:00").getTime();
const start = (days: number): string => new Date(NOW + days * 86400000 + 300000).toISOString();
const options: DeskOptions = {
  enabled: true, displayName: "Sam", topN: 5, rangerUrl: "", areas: [], interruptions: { ...NO_INTERRUPTIONS, meetingMinutes: 10 },
  sources: ["one", "two"].map((id) => ({ id, command: [id], everySeconds: 30, timeoutSeconds: 1 })),
};

describe("Desk calendars", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("preserves and validates the source calendar field", () => {
    const valid = parseSourceOutput(JSON.stringify({ events: [{ id: "a", start: start(0), title: "Meeting", calendar: "Home" }] }));
    expect(valid.events[0]?.calendar).toBe("Home");
    const invalid = parseSourceOutput(JSON.stringify({ events: [{ id: "a", start: start(0), title: "Meeting", calendar: 3 }] }));
    expect(invalid.events).toEqual([]);
    expect(invalid.problems[0]).toContain("events[0].calendar");
  });

  it("keeps same-named calendars distinct by source and preserves preferences across discovery", () => {
    discoverCalendars(db, [{ sourceId: "one", calendar: "Home" }, { sourceId: "two", calendar: "Home" }, { sourceId: "legacy" }]);
    expect(changeCalendar(db, { source: "one", name: "Home", enabled: false, color: "#123456" })).toBe(true);
    discoverCalendars(db, [{ sourceId: "one", calendar: "Home" }]);
    expect(listCalendars(db)).toContainEqual({ source: "one", name: "Home", enabled: false, color: "#123456" });
    expect(listCalendars(db)).toContainEqual({ source: "two", name: "Home", enabled: true, color: "#2563eb" });
    expect(listCalendars(db).some((c) => c.name === "legacy")).toBe(true);
  });

  it("filters hidden calendar events from today, ahead and meeting actions while retaining their settings", async () => {
    const cache = new SourceCache(async ([id]) => JSON.stringify({ events: [0, 1].map((day) => ({ id: `${id}-${day}`, title: `${id} meeting`, start: start(day), calendar: "Home" })) }));
    const initial = await composeDesk(db, options, undefined, { now: NOW, sourceCache: cache });
    expect(initial.today).toHaveLength(2);
    expect(initial.items.filter((i) => i.kind === "meeting")).toHaveLength(2);
    changeCalendar(db, { source: "one", name: "Home", enabled: false });
    changeCalendar(db, { source: "two", name: "Home", color: "#123456" });
    const after = await composeDesk(db, options, undefined, { now: NOW + 31000, sourceCache: cache });
    expect(after.today.map((e) => e.title)).toEqual(["two meeting"]);
    expect(after.ahead.map((e) => e.title)).toEqual(["two meeting"]);
    expect(after.today[0]).toMatchObject({ calendar: "Home", color: "#123456" });
    expect(after.ahead[0]?.color).toBe("#123456");
    expect(after.calendars).toHaveLength(2);
    expect(after.items.some((i) => i.source === "one")).toBe(false);
  });

  it("rejects cross-origin and unauthorized calendar changes through the real server", async () => {
    discoverCalendars(db, [{ sourceId: "one", calendar: "Home" }]);
    const context = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["allowed@example.org"], localPrincipal: "other@example.org" } }, db);
    try {
      const url = `http://127.0.0.1:${context.port}/api/desk/calendars`;
      const request = { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "one", name: "Home", enabled: false }) };
      expect((await fetch(url, { ...request, headers: { ...request.headers, Origin: "https://untrusted.example.org" } })).status).toBe(403);
      expect((await fetch(url, request)).status).toBe(403);
      expect(listCalendars(db)[0]?.enabled).toBe(true);
    } finally { context.stop(true); }
  });

  it("refuses invalid settings, unknown calendars and unsupported methods without writes", async () => {
    discoverCalendars(db, [{ sourceId: "one", calendar: "Home" }]);
    const call = (body: unknown, method = "PATCH") => handleDeskCalendars(new Request("http://localhost/api/desk/calendars", { method, body: JSON.stringify(body) }), db);
    expect((await call({ source: "one", name: "Home", color: "red" })).status).toBe(400);
    expect((await call({ source: "one", name: "Home", enabled: "no" })).status).toBe(400);
    expect((await call({ source: "one", name: "Home" })).status).toBe(400);
    expect((await call({ source: "absent", name: "Home", enabled: false })).status).toBe(404);
    expect((await call({}, "POST")).status).toBe(405);
    expect(listCalendars(db)[0]?.enabled).toBe(true);
    expect((await call({ source: "one", name: "Home", enabled: false })).status).toBe(200);
    const listed = await handleDeskCalendars(new Request("http://localhost/api/desk/calendars"), db);
    expect(await listed.json()).toEqual({ calendars: [{ source: "one", name: "Home", enabled: false, color: "#2563eb" }] });
  });
});
