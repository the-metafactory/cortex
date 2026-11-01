import { describe, expect, it } from "bun:test";
import { parseSourceOutput, type DeskSourceConfig, type SourceReading } from "../desk/sources/command";
import { calendarAvailability, currentGap } from "../desk/calendar-availability";
import type { DeskCalendar } from "../desk/calendars";

const NOW = Date.parse("2026-11-03T10:25:00Z");
const source: DeskSourceConfig = { id: "calendar", command: ["owned-reader"], everySeconds: 300, timeoutSeconds: 30 };
const coverage = { from: "2026-11-03T00:00:00Z", to: "2026-11-04T00:00:00Z", calendars: [{ id: "work", name: "Work" }], status: "complete", provenance: "owned-reader-query" };
const event = (status: "free" | "busy" | "unknown", over = {}) => ({ id: "owned", title: "Owned block", calendar: "Work", calendarId: "work", start: "2026-11-03T11:00:00Z", end: "2026-11-03T11:30:00Z", availability: { status, provenance: "owned-provider-property" }, ...over });
const reading = (body: unknown): SourceReading => ({ id: source.id, area: null, readAt: NOW, error: null, ...parseSourceOutput(JSON.stringify(body)) });
const calendar = (readings: SourceReading[], calendars: DeskCalendar[] = []) => calendarAvailability({ sources: [source], readings, calendars, now: NOW });
const qualified = (events: unknown[]) => reading({ capabilities: ["calendar"], calendarCoverage: coverage, events });

describe("source-authoritative calendar availability", () => {
  it("retains status, provenance, real ends and all-day blocking intervals", () => {
    const parsed = qualified([event("free"), event("busy", { id: "all", allDay: true, start: coverage.from, end: coverage.to })]);
    expect(parsed.events[0]?.availability).toEqual({ status: "free", provenance: "owned-provider-property" });
    expect(currentGap(calendar([parsed]), NOW).kind).toBe("busy");
  });
  it("distinguishes complete empty coverage from legacy empty or attention-only output", () => {
    expect(currentGap(calendar([qualified([])]), NOW)).toMatchObject({ kind: "open", through: Date.parse(coverage.to), asOf: NOW });
    expect(currentGap(calendar([reading({ events: [] })]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([reading({ items: [] })]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([reading({ capabilities: ["attention"], items: [] })]), NOW).kind).toBe("unknown");
  });
  it("ignores explicitly declared attention sources alongside qualified calendars", () => {
    const attention = { ...source, id: "mail" };
    const model = calendarAvailability({ sources: [source, attention], readings: [qualified([]), { ...reading({ capabilities: ["attention"], items: [] }), id: "mail" }], calendars: [], now: NOW });
    expect(currentGap(model, NOW).kind).toBe("open");
  });
  it("keeps missing, failed, stale, partial and malformed readers unknown", () => {
    const good = qualified([]);
    const cases = [[], [{ ...good, error: "unreachable" }], [{ ...good, readAt: NOW - 300_000 }], [reading({ capabilities: ["calendar"], calendarCoverage: { ...coverage, status: "partial" }, events: [] })], [qualified([event("busy", { start: "invalid" })])]];
    for (const values of cases) expect(currentGap(calendar(values), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([reading({ capabilities: ["calendar"], calendarCoverage: coverage })]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([reading({ capabilities: ["attention"], events: [], calendarCoverage: coverage })]), NOW).kind).toBe("unknown");
  });
  it("finds the next real busy interval without treating free or all-day display as busy", () => {
    const model = calendar([qualified([event("free", { allDay: true, start: coverage.from, end: coverage.to }), event("busy")])]);
    expect(currentGap(model, NOW)).toMatchObject({ kind: "bounded", minutes: 35, until: Date.parse("2026-11-03T11:00:00Z") });
  });
  it("returns no free gap during overlaps and respects calendar visibility", () => {
    const model = [qualified([event("busy", { start: "2026-11-03T10:00:00Z", end: "2026-11-03T10:40:00Z" }), event("busy", { id: "overlap", start: "2026-11-03T10:20:00Z", end: "2026-11-03T10:50:00Z" })])];
    expect(currentGap(calendar(model), NOW)).toMatchObject({ kind: "busy", until: Date.parse("2026-11-03T10:50:00Z") });
    expect(currentGap(calendar(model, [{ source: source.id, name: "Work", color: "#123456", enabled: false }]), NOW).kind).toBe("open");
  });
  it("reports the end of a continuous overlapping chain rather than the first event end", () => {
    const now = Date.parse("2026-11-03T09:15:00Z");
    const model = calendar([qualified([event("busy", { start: "2026-11-03T09:00:00Z", end: "2026-11-03T10:00:00Z" }), event("busy", { id: "chain", start: "2026-11-03T09:30:00Z", end: "2026-11-03T11:00:00Z" })])]);
    expect(currentGap(model, now)).toMatchObject({ kind: "busy", until: Date.parse("2026-11-03T11:00:00Z") });
  });
  it("requires coverage across a claimed gap and never promotes stale cached busy to current evidence", () => {
    expect(currentGap(calendar([reading({ capabilities: ["calendar"], calendarCoverage: { ...coverage, to: "2026-11-03T10:30:00Z" }, events: [event("busy")] })]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([{ ...qualified([event("busy", { start: coverage.from })]), readAt: NOW - 300_000 }]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([qualified([event("unknown")])]), NOW).kind).toBe("unknown");
    expect(currentGap(calendar([qualified([event("busy", { end: undefined })])]), NOW).kind).toBe("unknown");
  });
});
