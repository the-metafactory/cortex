import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailSnoozeBox, newSnoozeAsk, snoozeMeetings } from "../components/desk-mail-snooze";
import type { DeskEvent, DeskItem } from "../../desk/types";

const NOW = new Date(2026, 10, 4, 10, 0).getTime();
const noop = (): void => undefined;
const item = { key: "mail:m1", detail: { summary: "", history: [], refs: ["priya@example.org", "m1"], links: [] } } as unknown as DeskItem;
const meeting = (key: string, hour: number, title: string, kind: DeskEvent["kind"] = "meeting"): DeskEvent => ({ key, at: new Date(2026, 10, 4, hour).getTime(), end: new Date(2026, 10, 4, hour + 1).getTime(), title, area: null, kind });

describe("Snooze picker", () => {
  it("offers the times, upcoming meetings and the sender", () => {
    const meetings = snoozeMeetings([meeting("cal:w:2", 15, "Review"), meeting("cal:w:1", 8, "Standup"), meeting("reminder:1", 12, "Pay rent", "reminder"), meeting("cal:w:3", 11, "Board call")], NOW);
    expect(meetings.map((m) => m.title)).toEqual(["Board call", "Review"]);
    const html = renderToStaticMarkup(<MailSnoozeBox ask={newSnoozeAsk(item)} now={NOW} meetings={meetings} sending={false} onChange={noop} onChoose={noop} onCancel={noop} />);
    expect(html).toContain("Later today (today at 13:00)");
    expect(html).toContain("Tomorrow morning (tomorrow at 08:00)");
    expect(html).toContain("Next week (Monday at 08:00)");
    expect(html).toContain("Board call, today at 11:00");
    expect(html).toContain('value="priya@example.org"');
    expect(html).toContain("stays unread in your mail");
  });

  it("hides the meeting choice when no meeting is ahead", () => {
    const html = renderToStaticMarkup(<MailSnoozeBox ask={newSnoozeAsk(item)} now={NOW} meetings={[]} sending={false} onChange={noop} onChoose={noop} onCancel={noop} />);
    expect(html).not.toContain("After this meeting");
  });
});
