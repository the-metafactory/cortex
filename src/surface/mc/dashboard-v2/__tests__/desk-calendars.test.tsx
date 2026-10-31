import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarSettingsBody } from "../components/desk-calendar-settings";
import { AheadStrip, TimelineRow } from "../components/desk-view";
import { requestCalendars, type CalendarFetch } from "../lib/desk-calendars";
import type { DeskEvent } from "../../desk/types";

describe("calendar settings and event colours", () => {
  it("renders a visibility switch and colour control for each source calendar", () => {
    const html = renderToStaticMarkup(<CalendarSettingsBody rows={[{ source: "one", name: "Home", enabled: true, color: "#123456" }, { source: "two", name: "Home", enabled: false, color: "#654321" }]} error={null} busy={false} onChange={() => {}} />);
    expect(html).toContain('aria-label="Show Home (one)"');
    expect(html).toContain('aria-label="Show Home (two)"');
    expect(html).toContain('aria-label="Colour for Home (one)"');
    expect(html).toContain('value="#123456"');
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("colours the timeline marker and the next-days entry", () => {
    const event: DeskEvent = { key: "e1", at: Date.now(), title: "Meeting", area: null, kind: "meeting", color: "#123456" };
    expect(renderToStaticMarkup(<TimelineRow event={event} className="meeting" />)).toContain('background:#123456;border-color:#123456');
    expect(renderToStaticMarkup(<AheadStrip events={[event, { ...event, key: "all-day", kind: "all-day" }]} />)).toContain('border-left:3px solid #123456');
  });

  it("keeps the server error visible when settings cannot be changed", async () => {
    const fetcher: CalendarFetch = async () => Response.json({ error: "Unknown calendar" }, { status: 404 });
    expect(await requestCalendars({ source: "one", name: "Home", enabled: false }, fetcher)).toEqual({ ok: false, error: "Unknown calendar" });
    const html = renderToStaticMarkup(<CalendarSettingsBody rows={[]} error="Unknown calendar" busy={false} onChange={() => {}} />);
    expect(html).toContain('role="alert">Unknown calendar');
  });
});
