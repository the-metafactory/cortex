import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DESK_API_VERSION } from "../../../desk-api/version";
import type { DeskView } from "../desk/types";
import { openMailRoundRig, postDeskJson, roundAt, roundEvent, type MailRoundRig } from "./fixtures/mail-round-rig";

const NOW = roundAt(16, 16, 10);

const SOURCE = "round-source";
const key = (id: string): string => `meeting-after:cal:${SOURCE}:${id}`;

let rig: MailRoundRig;

const afterMeeting = (view: DeskView): DeskView["items"] => view.items.filter((item) => item.kind === "meeting-after");

const dismiss = (body: unknown): Promise<Response> => postDeskJson(rig.baseUrl(), "/api/desk/action", body);

beforeEach(async () => {
  rig = await openMailRoundRig(NOW, { mailDigest: undefined, mailInvitations: undefined });
  rig.setState({
    mail: [],
    events: [
      roundEvent("old", roundAt(16, 10, 0), roundAt(16, 11, 0)),
      roundEvent("boundary", roundAt(16, 14, 40), roundAt(16, 15, 10)),
      roundEvent("a", roundAt(16, 15, 50), roundAt(16, 16, 5)),
      roundEvent("b", roundAt(16, 16, 2), roundAt(16, 16, 9)),
      roundEvent("yesterday", roundAt(15, 20), roundAt(15, 21)),
    ],
  });
  await rig.get();
});

afterEach(async () => { await rig.close(); });

describe("Desk after-meeting card", () => {
  it("lists one card per meeting that ended within the last hour, newest ended first", async () => {
    const response = await fetch(`${rig.baseUrl()}/api/desk`);
    expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    const view = (await response.json()) as DeskView;
    const cards = afterMeeting(view);
    expect(cards.map((item) => item.key)).toEqual([key("b"), key("a")]);
    const first = cards[0];
    expect(first).toMatchObject({
      kind: "meeting-after",
      eventKey: `cal:${SOURCE}:b`,
      urgency: "today",
      actions: [{ id: "meeting.dismiss", label: "Dismiss", role: "primary", wired: true }],
    });
    expect(first?.title).toContain("Meeting b");
    expect(first?.whyPhrase).toEqual({ code: "meeting.ended", params: { endedAt: new Date(roundAt(16, 16, 9)).toISOString() } });
    expect(first?.detail.refs).toEqual([`cal:${SOURCE}:b`]);
    expect(cards[1]?.key).toBe(key("a"));
    expect(afterMeeting(view).some((item) => item.key === key("old"))).toBe(false);
    expect(afterMeeting(view).some((item) => item.key === key("boundary"))).toBe(false);
    expect(afterMeeting(view).some((item) => item.key === key("yesterday"))).toBe(false);
  });

  it("keeps a dismissed card away for every client that reads the Desk", async () => {
    const response = await dismiss({ action: "meeting.dismiss", key: key("b") });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, messagePhrase: { code: "meeting.dismissed" } });
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([key("a")]);
    expect((await dismiss({ action: "meeting.dismiss", key: key("b") })).status).toBe(200);
    rig.reopen();
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([key("a")]);
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_meeting_dismissals").get()?.n).toBe(1);
  });

  it("refuses a dismiss for a key that is not a current after-meeting card and stores nothing", async () => {
    for (const refused of [`meeting-after:cal:${SOURCE}:old`, `meeting-after:cal:${SOURCE}:missing`, "meeting-after:"]) {
      const response = await dismiss({ action: "meeting.dismiss", key: refused });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("The Desk has no after-meeting card with this key.");
    }
    for (const refused of ["mail:none", ""] ) {
      const response = await dismiss({ action: "meeting.dismiss", key: refused });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("A meeting-after item key is required.");
    }
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_meeting_dismissals").get()?.n).toBe(0);
    expect(afterMeeting(await rig.get())).toHaveLength(2);
  });

  it("drops a dismissal once the meeting is older than a day", async () => {
    expect((await dismiss({ action: "meeting.dismiss", key: key("a") })).status).toBe(200);
    rig.setNow(roundAt(17, 6, 10));
    expect(afterMeeting(await rig.get())).toEqual([]);
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_meeting_dismissals").get()?.n).toBe(1);
    rig.setNow(NOW + 25 * 60 * 60 * 1000);
    expect(afterMeeting(await rig.get())).toEqual([]);
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_meeting_dismissals").get()?.n).toBe(0);
  });
});
