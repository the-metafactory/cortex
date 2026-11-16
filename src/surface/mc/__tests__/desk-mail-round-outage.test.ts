import { afterEach, describe, expect, it } from "bun:test";
import type { DeskView } from "../desk/types";
import { openMailRoundRig, roundAt, roundEvent, roundMail, type MailRoundRig, type RoundState } from "./fixtures/mail-round-rig";

let rig: MailRoundRig;
afterEach(async () => { await rig?.close(); });
const iso = (hour: number, minute = 0): string => new Date(roundAt(9, hour, minute)).toISOString();
const a = roundMail("outage-a", roundAt(9, 7));
const busy = [roundEvent("busy", roundAt(9, 8, 30), roundAt(9, 9, 30))];
const noGroups = { mailDigest: undefined, mailInvitations: undefined };

function queueCount(): number {
  return rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_round_queue").get()!.n;
}

function openCount(): number {
  return rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_rounds WHERE status='open'").get()!.n;
}

function expectQueued(view: DeskView): void {
  expect(view.mailRound).toMatchObject({ id: null, due: false, waiting: 1, mails: [] });
  expect(queueCount()).toBe(1);
  expect(openCount()).toBe(0);
}

async function startQueued(events = busy): Promise<void> {
  rig = await openMailRoundRig(roundAt(9, 8), noGroups);
  rig.setState({ mail: [a], events });
  const view = await rig.refresh();
  expect(view.calendarAvailability?.sources).toContainEqual(expect.objectContaining({ kind: "calendar" }));
  expectQueued(view);
}

async function restoredRound(): Promise<void> {
  rig.setState({ mail: [a], events: busy, calendarCoverage: { from: iso(8), to: iso(22) } });
  rig.setNow(roundAt(9, 9));
  const waiting = await rig.refresh();
  expectQueued(waiting);
  expect(waiting.mailRound?.nextScheduledAt).toBe(iso(9, 30));
  rig.setNow(roundAt(9, 9, 31));
  const opened = await rig.refresh();
  expect(opened.mailRound).toMatchObject({ due: true, waiting: 0, scheduledFor: iso(9, 30) });
  expect(opened.mailRound?.mails.map(mail => mail.key)).toEqual(["mail:outage-a"]);
  expect(queueCount()).toBe(0);
  expect(openCount()).toBe(1);
  expect((await rig.get()).mailRound?.id).toBe(opened.mailRound?.id);
}

describe("Mail round calendar qualification", () => {
  const cases: [string, RoundState["calendarCoverage"]][] = [
    ["missing", null],
    ["partial", { status: "partial" }],
    ["expired", { from: iso(8), to: iso(8, 15) }],
    ["not yet covered", { from: iso(8, 31), to: iso(22) }],
  ];
  it.each(cases)("preserves the persisted queue with %s coverage and recovers the shifted slot", async (_name, calendarCoverage) => {
    await startQueued();
    rig.setNow(roundAt(9, 8, 31));
    rig.setState({ mail: [a], events: [], calendarCoverage });
    const unavailable = await rig.refresh();
    expect(unavailable.sources.every(source => source.ok)).toBe(true);
    expect(unavailable.mailRound?.unavailable.calendar).toContain("round-source");
    expectQueued(unavailable);
    rig.reopen();
    expectQueued(await rig.refresh());
    await restoredRound();
  });

  it("requires coverage through the end of a shifted meeting chain", async () => {
    await startQueued();
    rig.setNow(roundAt(9, 9, 31));
    rig.setState({ mail: [a], events: busy, calendarCoverage: { from: iso(8), to: iso(9) } });
    const unavailable = await rig.refresh();
    expectQueued(unavailable);
    expect(unavailable.mailRound?.unavailable.calendar).toContain("round-source");
    rig.setState({ mail: [a], events: busy });
    rig.setNow(roundAt(9, 9, 32));
    const recovered = await rig.refresh();
    expect(recovered.mailRound).toMatchObject({ due: true, scheduledFor: iso(9, 30), waiting: 0 });
  });

  it("does not advance persisted membership using a stale reading", async () => {
    await startQueued([]);
    rig.setNow(roundAt(9, 8, 31));
    const stale = await rig.get();
    expect(stale.calendarAvailability?.sources).toContainEqual({ id: "round-source", kind: "unknown", reason: "The source reading is stale; a refresh is pending." });
    expectQueued(stale);
    expect((await rig.refresh()).mailRound?.due).toBe(true);
  });

  it.each([64, 65])("does not mistake an exhausted shift bound for the end of a %s-meeting chain", async length => {
    const start = roundAt(9, 8, 30);
    const events = Array.from({ length }, (_, index) => roundEvent(`chain-${index}`, start + index * 60_000, start + (index + 1) * 60_000, index % 2 ? "unknown" : "busy"));
    await startQueued(events);
    rig.setNow(start + 64 * 60_000 + 30_000);
    const view = await rig.refresh();
    if (length === 64) {
      expect(view.mailRound).toMatchObject({ due: true, waiting: 0, scheduledFor: new Date(start + 64 * 60_000).toISOString() });
    } else {
      expectQueued(view);
      expect(view.mailRound?.unavailable.calendar).toContain("round-source");
    }
  });

  it("keeps queued evidence when both sources fail", async () => {
    await startQueued([]);
    rig.setNow(roundAt(9, 8, 31));
    rig.setState({ mail: [], fail: true });
    const unavailable = await rig.refresh();
    expectQueued(unavailable);
    expect(unavailable.mailRound?.unavailable.mail).toEqual(["round-source"]);
    rig.reopen();
    expectQueued(await rig.refresh());
  });

  it("supports a source that explicitly declares attention without a calendar provider", async () => {
    rig = await openMailRoundRig(roundAt(9, 8), noGroups);
    rig.setState({ mail: [a], capabilities: ["attention"], calendarCoverage: null });
    expectQueued(await rig.refresh());
    rig.setNow(roundAt(9, 8, 31));
    const due = await rig.refresh();
    expect(due.calendarAvailability?.sources).toEqual([{ id: "round-source", kind: "attention" }]);
    expect(due.mailRound).toMatchObject({ due: true, waiting: 0, unavailable: { calendar: [] } });
  });

  it.each([false, true])("preserves a successor across handling, outage and reopen; restored meeting=%s", async shifted => {
    await startQueued([]);
    rig.setNow(roundAt(9, 8, 31));
    const opened = await rig.refresh();
    expect(opened.calendarAvailability?.sources).toContainEqual(expect.objectContaining({ kind: "calendar" }));
    expect(opened.mailRound?.due).toBe(true);
    const b = roundMail("successor-b", roundAt(9, 13, 30) + 30_000);
    rig.setNow(roundAt(9, 13, 31));
    rig.setState({ mail: [a, b], calendarCoverage: null });
    const outage = await rig.refresh();
    expect(outage.mailRound).toMatchObject({ id: opened.mailRound?.id, due: true, waiting: 1 });
    expect(outage.mailRound?.mails.map(mail => mail.key)).toEqual(["mail:outage-a"]);
    expect((await rig.post({ action: "hide", key: "mail:outage-a" })).status).toBe(200);
    expectQueued(await rig.get());
    rig.reopen();
    expectQueued(await rig.refresh());
    const events = shifted ? [roundEvent("afternoon", roundAt(9, 13, 30), roundAt(9, 14))] : [];
    rig.setState({ mail: [a, b], events });
    rig.setNow(roundAt(9, 13, 32));
    const restored = await rig.refresh();
    if (shifted) {
      expectQueued(restored);
      expect(restored.mailRound?.nextScheduledAt).toBe(iso(14));
      rig.setNow(roundAt(9, 14, 1));
    } else {
      expect(restored.mailRound?.due).toBe(true);
    }
    const due = await rig.refresh();
    expect(due.mailRound?.mails.map(mail => mail.key)).toEqual(["mail:successor-b"]);
    expect(due.mailRound?.id).not.toBe(opened.mailRound?.id);
    expect(openCount()).toBe(1);
    expect(queueCount()).toBe(0);
  });

  it("does not reuse a persisted completion to bring later arrivals forward", async () => {
    await startQueued([]);
    rig.setNow(roundAt(9, 8, 31));
    expect((await rig.refresh()).mailRound?.due).toBe(true);
    rig.setNow(roundAt(9, 13, 31));
    await rig.refresh();
    expect((await rig.post({ action: "hide", key: "mail:outage-a" })).status).toBe(200);
    expect((await rig.get()).mailRound).toMatchObject({ due: false, waiting: 0 });
    const later = roundMail("later-c", roundAt(9, 13, 45));
    rig.setState({ mail: [a, later] });
    rig.setNow(roundAt(9, 13, 46));
    expectQueued(await rig.refresh());
    rig.reopen();
    expectQueued(await rig.refresh());
    rig.setNow(roundAt(9, 16, 31));
    const next = await rig.refresh();
    expect(next.mailRound?.mails.map(mail => mail.key)).toEqual(["mail:later-c"]);
    expect(openCount()).toBe(1);
  });
});
