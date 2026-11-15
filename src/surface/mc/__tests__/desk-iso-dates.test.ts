import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";
import { invitationView, whenLine } from "../desk/mail-invitation";
import { snoozeAt, snoozeMail } from "../desk/mail-snooze";
import type { ListedMail } from "../desk/mail-actions";
import type { MailInvitation } from "../desk/sources/command";
import type { DeskView } from "../desk/types";
import { deskFixtureOptions } from "./fixtures/desk-options-fixture";

const NOW = new Date(2026, 10, 4, 10).getTime();
const invitation: MailInvitation = {
  method: "REQUEST", uid: "iso-invite", sequence: 0, summary: "Planning",
  start: "2026-11-05T09:00:00+05:45", end: "2026-11-05T10:00:00+05:45",
  organizer: { address: "sender@example.test" }, attendees: 1,
};
const mail: ListedMail = {
  kind: "mail", id: "iso-mail", sourceId: "mail", account: "test", subject: "Planning",
  from: { address: "sender@example.test" }, receivedAt: new Date(NOW).toISOString(), unread: true, invitation,
};
const calendar = { sources: [], events: [] };

describe("Desk ISO dates", () => {
  it("preserves the invitation text and source bounds beside canonical instants", () => {
    const view = invitationView(mail, calendar, undefined);
    expect(view).toMatchObject({
      when: whenLine(invitation), start: invitation.start, end: invitation.end,
      startIso: "2026-11-05T03:15:00.000Z", endIso: "2026-11-05T04:15:00.000Z",
    });
    const withoutEnd = { ...invitation, start: "2026-11-05T09:00:00", end: undefined };
    const fallback = invitationView({ ...mail, invitation: withoutEnd }, calendar, undefined);
    expect(fallback?.when).toBe(whenLine(withoutEnd));
    expect(fallback?.startIso).toBe(new Date(withoutEnd.start).toISOString());
    expect(Date.parse(fallback?.endIso ?? "") - Date.parse(fallback?.startIso ?? "")).toBe(3_600_000);
    expect(fallback).not.toHaveProperty("end");
  });

  it("carries date-only bounds for all-day invitations, including the exclusive end", () => {
    const allDay = { ...invitation, allDay: true, start: "2026-11-05T00:00:00", end: "2026-11-07T00:00:00" };
    expect(invitationView({ ...mail, invitation: allDay }, calendar, undefined)).toMatchObject({
      when: "Thursday 5 November to Friday 6 November, all day", start: allDay.start, end: allDay.end,
      startIso: "2026-11-05", endIso: "2026-11-07",
    });
    const singleDay = { ...allDay, end: undefined };
    expect(invitationView({ ...mail, invitation: singleDay }, calendar, undefined)).toMatchObject({
      when: "Thursday 5 November, all day", startIso: "2026-11-05", endIso: "2026-11-06",
    });
  });

  it("keeps snooze wording beside its ISO instant and uses null for a person condition", () => {
    const db = initDatabase(":memory:");
    try {
      const tomorrow = snoozeAt({ kind: "tomorrow" }, NOW);
      expect(tomorrow).not.toBeNull();
      expect(snoozeMail(db, mail, { kind: "tomorrow" }, { now: NOW, readings: [] })).toMatchObject({
        ok: true, until: "until tomorrow at 08:00", untilIso: new Date(tomorrow!).toISOString(),
      });
      expect(snoozeMail(db, mail, { kind: "date", date: "2026-11-20" }, { now: NOW, readings: [] })).toMatchObject({
        ok: true, until: "until Fri 20 Nov at 08:00", untilIso: new Date(2026, 10, 20, 8).toISOString(),
      });
      expect(snoozeMail(db, mail, { kind: "person", address: "sender@example.test" }, { now: NOW, readings: [] })).toMatchObject({
        ok: true, until: "until sender@example.test writes", untilIso: null,
      });
    } finally {
      db.close();
    }
  });

  it("agrees with today and my-day in the runtime zone, across DST and with no zone configured", async () => {
    const modulePath = (path: string): string => JSON.stringify(join(import.meta.dir, path));
    const code = `
      import { handleGetDesk } from ${modulePath("../api/desk.ts")};
      import { initDatabase } from ${modulePath("../db/init.ts")};
      import { HandledLedger } from ${modulePath("../desk/actions.ts")};
      import { deskTimeZone, localDay, startOfDay } from ${modulePath("../desk/time.ts")};
      import { deskFixtureOptions } from ${modulePath("fixtures/desk-options-fixture.ts")};
      const db = initDatabase(":memory:");
      try {
        const view = await (await handleGetDesk(db, { options: deskFixtureOptions, ledger: new HandledLedger() }, undefined)).json();
        const samples = ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-11-05T23:30:00Z"].map(value => {
          const at = Date.parse(value);
          return { at, date: localDay(at), midnight: startOfDay(at) };
        });
        console.log(JSON.stringify({ zone: deskTimeZone(), viewZone: view.timeZone, mirrorZone: view.mirror.week.timeZone, day: view.myDay.date, generatedAt: view.generatedAt, samples }));
      } finally { db.close(); }
    `;
    for (const zone of ["Europe/Zurich", "America/New_York", "Asia/Kathmandu", "UTC", undefined]) {
      const env = { ...process.env };
      if (zone) env.TZ = zone;
      else delete env.TZ;
      const child = Bun.spawn([process.execPath, "--eval", code], { env, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      const result = JSON.parse(output);
      expect(result.zone).not.toBe("");
      expect(result.viewZone).toBe(result.zone);
      expect(result.mirrorZone).toBe(result.zone);
      const dateInZone = (at: number): string => {
        const parts = new Intl.DateTimeFormat("en", { timeZone: result.zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
        const part = (name: string): string => parts.find(p => p.type === name)?.value ?? "";
        return `${part("year")}-${part("month")}-${part("day")}`;
      };
      expect(result.day).toBe(dateInZone(result.generatedAt));
      for (const sample of result.samples) {
        expect(sample.date).toBe(dateInZone(sample.at));
        expect(dateInZone(sample.midnight)).toBe(sample.date);
      }
    }
  });

  it("serves the zone and formatted invitation with its ISO siblings through GET /api/desk and curl", async () => {
    const db = initDatabase(":memory:");
    const source = { items: [{ ...mail, receivedAt: new Date().toISOString() }] };
    const desk = { ...deskFixtureOptions, sources: [{ id: "mail", command: [process.execPath, "--eval", `console.log(${JSON.stringify(JSON.stringify(source))})`], everySeconds: 300, timeoutSeconds: 30 }] };
    const context = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk });
    try {
      const child = Bun.spawn(["curl", "--fail", "--silent", "--show-error", `http://127.0.0.1:${context.port}/api/desk`], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited, errors).toBe(0);
      const view = JSON.parse(output) as DeskView;
      expect(view.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(view.mirror?.week.timeZone).toBe(view.timeZone);
      const invite = view.items.find(item => item.key === "mail:iso-mail")?.invitation;
      expect(invite).toMatchObject({ when: whenLine(invitation), startIso: "2026-11-05T03:15:00.000Z", endIso: "2026-11-05T04:15:00.000Z" });
      expect(typeof view.generatedAt).toBe("number");
      expect(view).not.toHaveProperty("generatedAtIso");
      console.log(JSON.stringify({ timeZone: view.timeZone, when: invite?.when, startIso: invite?.startIso, endIso: invite?.endIso }));
    } finally {
      context.stop(true);
      db.close();
    }
  });
});
