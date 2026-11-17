import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DESK_API_VERSION } from "../../../desk-api/version";
import type { DeskView } from "../desk/types";
import { openMailRoundRig, postDeskJson, roundAt, roundEvent, type MailRoundRig } from "./fixtures/mail-round-rig";

const NOW = roundAt(16, 16, 10);

const SOURCE = "round-source";
const START = {
  old: roundAt(16, 10, 0),
  boundary: roundAt(16, 14, 40),
  a: roundAt(16, 15, 50),
  b: roundAt(16, 16, 2),
  yesterday: roundAt(15, 20),
  later: roundAt(17, 17, 0),
  added: roundAt(17, 17, 2),
} as const;
const key = (id: keyof typeof START): string => `meeting-after:cal:${SOURCE}:${id}@${START[id]}`;

let rig: MailRoundRig;

const afterMeeting = (view: DeskView): DeskView["items"] => view.items.filter((item) => item.kind === "meeting-after");

const dismissalCount = (): number | undefined => rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_meeting_dismissals").get()?.n;

const dismiss = (body: unknown): Promise<Response> => postDeskJson(rig.baseUrl(), "/api/desk/action", body);

beforeEach(async () => {
  rig = await openMailRoundRig(NOW, { mailDigest: undefined, mailInvitations: undefined });
  rig.setState({
    mail: [],
    events: [
      roundEvent("old", START.old, roundAt(16, 11, 0)),
      roundEvent("boundary", START.boundary, roundAt(16, 15, 10)),
      roundEvent("a", START.a, roundAt(16, 16, 5)),
      roundEvent("b", START.b, roundAt(16, 16, 9)),
      roundEvent("yesterday", START.yesterday, roundAt(15, 21)),
      roundEvent("later", START.later, roundAt(17, 17, 5)),
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

  it("lists two occurrences of one recurring meeting as two cards, and dismissing one keeps the other", async () => {
    rig.setNow(NOW + 31_000);
    rig.setState({
      mail: [],
      events: [roundEvent("recurring", roundAt(16, 15, 10), roundAt(16, 15, 30)), roundEvent("recurring", roundAt(16, 15, 40), roundAt(16, 15, 50))],
    });
    const cards = afterMeeting(await rig.refresh());
    expect(cards.map((item) => item.key)).toEqual([
      `meeting-after:cal:${SOURCE}:recurring@${roundAt(16, 15, 40)}`,
      `meeting-after:cal:${SOURCE}:recurring@${roundAt(16, 15, 10)}`,
    ]);
    expect((await dismiss({ action: "meeting.dismiss", key: cards[0]!.key })).status).toBe(200);
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([`meeting-after:cal:${SOURCE}:recurring@${roundAt(16, 15, 10)}`]);
    expect(dismissalCount()).toBe(1);
  });

  it("keeps a dismissed card away for every client that reads the Desk", async () => {
    const response = await dismiss({ action: "meeting.dismiss", key: key("b") });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, messagePhrase: { code: "meeting.dismissed" } });
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([key("a")]);
    expect((await dismiss({ action: "meeting.dismiss", key: key("b") })).status).toBe(200);
    rig.reopen();
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([key("a")]);
    expect(dismissalCount()).toBe(1);
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
    expect(dismissalCount()).toBe(0);
    expect(afterMeeting(await rig.get())).toHaveLength(2);
  });

  it("stops showing a dismissed card once the meeting is older than a day, and drops the row on the next dismissal", async () => {
    expect((await dismiss({ action: "meeting.dismiss", key: key("a") })).status).toBe(200);
    rig.setNow(roundAt(17, 6, 10));
    expect(afterMeeting(await rig.get())).toEqual([]);
    expect(dismissalCount()).toBe(1);
    rig.setNow(roundAt(17, 17, 10));
    expect(afterMeeting(await rig.get()).map((item) => item.key)).toEqual([key("later")]);
    expect(dismissalCount()).toBe(1);
    expect((await dismiss({ action: "meeting.dismiss", key: key("later") })).status).toBe(200);
    expect(dismissalCount()).toBe(1);
    expect(afterMeeting(await rig.get())).toEqual([]);
  });

  it("surfaces a meeting added after the first read once the Desk refreshes", async () => {
    rig.setNow(roundAt(17, 17, 10));
    rig.setState({ mail: [], events: [roundEvent("added", START.added, roundAt(17, 17, 6))] });
    expect(afterMeeting(await rig.refresh()).map((item) => item.key)).toEqual([key("added")]);
  });
});
