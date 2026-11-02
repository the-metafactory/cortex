import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeskMailInvitationsSchema } from "../../../common/types/config";
import { initDatabase } from "../db/init";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import type { CalendarAvailability, CalendarInterval } from "../desk/calendar-availability";
import type { DeskOptions } from "../desk/compose";
import type { WriterRunner } from "../desk/create";
import type { ListedMail } from "../desk/mail-actions";
import { calendarsOnly, freeSlots, invitationConflicts, invitationDecisions, invitationView, invitePayload, proposalBody, replyToInvitation, type InvitationsConfig, type InviteReplyDeps } from "../desk/mail-invitation";
import { queryMailLog } from "../desk/mail-log";
import { mailItems } from "../desk/rank";
import { SourceCache, SourceMailSchema, type MailInvitation, type SourceReading } from "../desk/sources/command";
import { startOfDay } from "../desk/time";

const DAY = 86_400_000;
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime();
const NOW = at(2, 8);

const INVITATION: MailInvitation = {
  method: "REQUEST",
  uid: "uid-1",
  sequence: 0,
  summary: "Budget review",
  start: new Date(at(3, 14)).toISOString(),
  end: new Date(at(3, 15)).toISOString(),
  organizer: { address: "olga@example.org", name: "Olga" },
  attendee: { address: "pat@example.com", status: "NEEDS-ACTION" },
  attendees: 2,
};

const mail = (over: Partial<ListedMail> = {}): ListedMail => ({
  kind: "mail", id: "invite@example.org", sourceId: "work-mail", account: "work", from: { address: "olga@example.org", name: "Olga" },
  subject: "Invitation: Budget review", unread: true, receivedAt: new Date(NOW - 3_600_000).toISOString(), invitation: INVITATION, ...over,
});

const event = (title: string, from: number, to: number, status: "busy" | "free" | "unknown" = "busy"): CalendarInterval => ({
  key: `cal:${title}`, source: "work-calendar", calendar: "Work", calendarId: "c1", title, at: from, end: to, availability: { status, provenance: "test" },
});

const calendar = (events: CalendarInterval[], to = startOfDay(NOW) + 7 * DAY): CalendarAvailability => ({
  sources: [{ id: "work-calendar", kind: "calendar", from: startOfDay(NOW), to, readAt: NOW, calendars: ["c1"], provenance: "test" }, { id: "work-mail", kind: "attention" }],
  events,
});

const CONFIG: InvitationsConfig = { command: ["invite-reply"], timeoutSeconds: 30, addToCalendar: ["work"], slots: { days: 5, dayStart: "09:00", dayEnd: "18:00", max: 5 } };

describe("conflicts", () => {
  test("a busy or unknown event that overlaps the invitation is a conflict; a free one and the invitation itself are not", () => {
    const check = invitationConflicts(INVITATION, calendar([
      event("Team sync", at(3, 13, 30), at(3, 14, 30)),
      event("Maybe", at(3, 14, 45), at(3, 15, 30), "unknown"),
      event("Lunch walk", at(3, 14), at(3, 15), "free"),
      event("Budget review", at(3, 14), at(3, 15), "unknown"),
      event("Later", at(3, 15), at(3, 16)),
    ]));
    expect(check.kind).toBe("conflicts");
    if (check.kind === "conflicts") expect(check.events.map((e) => [e.title, e.maybe])).toEqual([["Team sync", false], ["Maybe", true]]);
  });

  test("with no overlap the calendars are clear, but a calendar that does not cover the time makes it unknown", () => {
    expect(invitationConflicts(INVITATION, calendar([event("Later", at(3, 15), at(3, 16))])).kind).toBe("clear");
    const short = invitationConflicts(INVITATION, calendar([], startOfDay(NOW) + DAY));
    expect(short.kind).toBe("unknown");
    expect(invitationConflicts(INVITATION, { sources: [{ id: "work-calendar", kind: "unknown", reason: "stale" }], events: [] })).toEqual({ kind: "unknown", reasons: ["work-calendar: stale"] });
  });
});

describe("mail sources", () => {
  test("a stale or failed mail source does not make the calendars unknown; a stale calendar source still does", () => {
    const stale: CalendarAvailability = { ...calendar([]), sources: [...calendar([]).sources.filter((s) => s.kind === "calendar"), { id: "work-mail", kind: "unknown", reason: "The source reading is stale; a refresh is pending." }, { id: "personal-mail", kind: "unknown", reason: "The source could not be read." }] };
    const reading = (id: string, over: Partial<SourceReading>): SourceReading => ({ id, area: null, events: [], mail: [], readAt: NOW, error: null, dropped: 0, problems: [], ...over });
    const readings = [reading("work-mail", { capabilities: ["attention"], mail: [mail()] }), reading("personal-mail", { error: "boom", capabilities: ["attention"] }), reading("work-calendar", { capabilities: ["calendar"] })];
    expect(invitationConflicts(INVITATION, stale).kind).toBe("unknown");
    expect(invitationConflicts(INVITATION, calendarsOnly(stale, readings)).kind).toBe("clear");
    const undeclared = calendarsOnly(stale, [reading("work-mail", { mail: [mail()] }), reading("personal-mail", { error: "boom" })]);
    expect(invitationConflicts(INVITATION, undeclared).kind).toBe("unknown");
    const calendarStale: CalendarAvailability = { sources: [{ id: "work-calendar", kind: "unknown", reason: "stale" }], events: [] };
    expect(invitationConflicts(INVITATION, calendarsOnly(calendarStale, readings)).kind).toBe("unknown");
  });
});

describe("free slots", () => {
  test("lists free times of the invitation's length on working days, two per day, skipping busy time and the invitation's own slot", () => {
    const found = freeSlots(INVITATION, calendar([event("Busy morning", at(3, 9), at(3, 13))]), NOW, { days: 3, dayStart: "09:00", dayEnd: "18:00", max: 5 });
    expect(found.slots.map((s) => [new Date(s.at).getDate(), new Date(s.at).getHours(), new Date(s.at).getMinutes()])).toEqual([[3, 13, 0], [3, 14, 30], [4, 9, 0], [4, 10, 0], [5, 9, 0]]);
    expect(found.slots.every((s) => s.end - s.at === 3_600_000)).toBe(true);
  });

  test("skips the weekend and stops at the calendars' coverage", () => {
    const friday = { ...INVITATION, start: new Date(at(6, 14)).toISOString(), end: new Date(at(6, 15)).toISOString() };
    const days = freeSlots(friday, calendar([], startOfDay(NOW) + 9 * DAY), NOW, { days: 2, dayStart: "09:00", dayEnd: "18:00", max: 10 }).slots.map((s) => new Date(s.at).getDay());
    expect(days).toEqual([5, 5, 1, 1]);
  });

  test("an unknown calendar gives no slots and a reason", () => {
    expect(freeSlots(INVITATION, { sources: [{ id: "x", kind: "unknown", reason: "stale" }], events: [] }, NOW)).toEqual({ slots: [], reason: "x: stale" });
  });

  test("the proposal draft lists the slots", () => {
    const body = proposalBody(INVITATION, [{ at: at(4, 9), end: at(4, 10) }]);
    expect(body).toContain('invitation to "Budget review"');
    expect(body).toContain("- ");
    expect(body).toContain("09:00–10:00");
  });
});

interface Call { argv: string[]; stdin: string }

describe("replies", () => {
  let db: ReturnType<typeof initDatabase>;
  let calls: Call[];
  let answer: (argv: string[]) => { code: number; stdout: string; stderr: string };
  const run: WriterRunner = async (argv, stdin) => { calls.push({ argv, stdin }); return answer(argv); };
  const deps = (over: Partial<InviteReplyDeps> = {}): InviteReplyDeps => ({ db, config: CONFIG, writers: { calendar: ["calendar-writer"] }, run, now: NOW, writerTimeoutMs: 30_000, ...over });
  const input = (over: Partial<Parameters<typeof replyToInvitation>[1]> = {}) => ({ reply: "decline" as const, requestId: crypto.randomUUID(), commitment: null, confirmed: true, suspicious: false, ...over });
  beforeEach(() => {
    db = initDatabase(":memory:");
    calls = [];
    answer = (argv) => (argv[0] === "calendar-writer" ? { code: 0, stdout: JSON.stringify({ id: "ev1" }), stderr: "" } : { code: 0, stdout: JSON.stringify({ id: "r1", message: "The decline went to Olga." }), stderr: "" });
  });
  afterEach(() => db.close());

  test("nothing is sent without confirmation, for suspicious mail, or when the principal is not an attendee", async () => {
    expect(await replyToInvitation(mail(), input({ confirmed: false }), deps())).toMatchObject({ ok: false, status: 409 });
    expect(await replyToInvitation(mail(), input({ suspicious: true }), deps())).toMatchObject({ ok: false, status: 409 });
    const { attendee: _a, ...uninvited } = INVITATION;
    expect(await replyToInvitation(mail({ invitation: uninvited }), input(), deps())).toMatchObject({ ok: false, status: 409 });
    expect(await replyToInvitation(mail(), input(), deps({ config: undefined }))).toMatchObject({ ok: false, status: 409 });
    expect(calls).toHaveLength(0);
  });

  test("decline sends the reply command payload once, logs the decision and adds nothing to the calendar", async () => {
    const req = input();
    const result = await replyToInvitation(mail(), req, deps());
    expect(result).toEqual({ ok: true, message: "Declined. The decline went to Olga." });
    expect(calls).toEqual([{ argv: ["invite-reply"], stdin: JSON.stringify({ action: "invite-reply", account: "work", messageId: "invite@example.org", uid: "uid-1", reply: "decline", requestId: req.requestId }) }]);
    expect(queryMailLog(db, {}).map((e) => [e.action, e.where])).toEqual([["decline", "desk"]]);
    expect(await replyToInvitation(mail(), req, deps())).toEqual({ ok: true, message: "Declined. The decline went to Olga." });
    expect(await replyToInvitation(mail(), input({ reply: "accept" }), deps())).toEqual({ ok: false, status: 409, error: "You already declined this invitation." });
    expect(calls).toHaveLength(1);
  });

  test("accept records what falls away and adds the event through the calendar writer for a listed account", async () => {
    const commitment = { kind: "thread" as const, id: "t1", label: "Field Notes format" };
    const req = input({ reply: "accept", commitment });
    const result = await replyToInvitation(mail(), req, deps());
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain("The event is in your calendar.");
    const writer = calls.find((c) => c.argv[0] === "calendar-writer");
    expect(JSON.parse(writer?.stdin ?? "{}")).toMatchObject({ kind: "calendar", requestId: req.requestId, fields: { title: "Budget review", start: INVITATION.start, end: INVITATION.end } });
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")).toMatchObject({ reply: "accept", status: "sent", fallsAway: "Field Notes format", calendar: "The event is in your calendar." });
    const other = await replyToInvitation(mail({ id: "other@example.org", account: "personal" }), input({ reply: "accept" }), deps());
    expect(other.ok && other.message).toBe("Declined. The decline went to Olga.".replace("Declined", "Accepted"));
    expect(calls.filter((c) => c.argv[0] === "calendar-writer")).toHaveLength(1);
  });

  test("an account that names a calendar gets --calendar on the invitation writer and the writer's own words; an account without one gets the default calendar", async () => {
    answer = (argv) => (argv[0] === "invite-reply" ? { code: 0, stdout: JSON.stringify({ id: "r1" }), stderr: "" } : { code: 0, stdout: JSON.stringify({ id: "ev1", message: argv.includes("Privat") ? 'Added "Budget review" to Privat on Tue 3 Nov at 14:00.' : "Added." }), stderr: "" });
    const config: InvitationsConfig = { ...CONFIG, calendarWriter: ["invitation-writer"], addToCalendar: ["work", { account: "personal", calendar: "Privat" }] };
    const priv = await replyToInvitation(mail({ id: "p@example.org", account: "personal" }), input({ reply: "accept" }), deps({ config }));
    expect(priv.ok && priv.message).toBe('Accepted. Added "Budget review" to Privat on Tue 3 Nov at 14:00.');
    const work = await replyToInvitation(mail(), input({ reply: "accept" }), deps({ config }));
    expect(work.ok && work.message).toBe("Accepted. The event is in your calendar.");
    const shared = await replyToInvitation(mail({ id: "s@example.org" }), input({ reply: "accept" }), deps({ config: { ...config, calendarWriter: undefined } }));
    expect(shared.ok).toBe(true);
    expect(calls.filter((c) => c.argv[0] !== "invite-reply").map((c) => c.argv)).toEqual([["invitation-writer", "--calendar", "Privat"], ["invitation-writer"], ["calendar-writer"]]);
    expect(invitationDecisions(db, ["p@example.org"]).get("p@example.org")?.calendar).toBe('Added "Budget review" to Privat on Tue 3 Nov at 14:00.');
  });

  test("a writer that refuses the named calendar leaves the answer sent and says the event was not added", async () => {
    answer = (argv) => (argv[0] === "invite-reply" ? { code: 0, stdout: JSON.stringify({ id: "r1" }), stderr: "" } : { code: 1, stdout: "", stderr: "2 calendars are named Calendar, so it is unclear which one is meant and nothing was added." });
    const config: InvitationsConfig = { ...CONFIG, addToCalendar: [{ account: "work", calendar: "Calendar" }] };
    const result = await replyToInvitation(mail(), input({ reply: "accept" }), deps({ config }));
    expect(result.ok && result.message).toBe("Accepted. The event was not added to your calendar: 2 calendars are named Calendar, so it is unclear which one is meant and nothing was added.");
    expect(calls.at(-1)?.argv).toEqual(["calendar-writer", "--calendar", "Calendar"]);
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")?.status).toBe("sent");
  });

  test("the invitations config takes account names and { account, calendar } entries, and refuses a calendar that reads as a flag", () => {
    const parse = (addToCalendar: unknown) => DeskMailInvitationsSchema.safeParse({ command: ["x"], addToCalendar });
    expect(parse(["personal", { account: "work", calendar: "Privat" }]).success).toBe(true);
    expect(parse([{ account: "work", calendar: "--all" }]).success).toBe(false);
    expect(parse([{ account: "work", calendar: "Privat", extra: 1 }]).success).toBe(false);
    expect(parse(["work", { account: "work", calendar: "Privat" }]).success).toBe(false);
  });

  test("a failed command is recorded and can be retried with a new request; a timeout makes it uncertain and blocks another answer", async () => {
    answer = () => ({ code: 1, stdout: "", stderr: "The work mail server did not take the reply: refused" });
    expect(await replyToInvitation(mail(), input(), deps())).toEqual({ ok: false, status: 502, error: "The answer was not sent: The work mail server did not take the reply: refused" });
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")?.status).toBe("failed");
    expect(queryMailLog(db, {})).toHaveLength(0);
    const { CommandTimeout } = await import("../desk/spawn");
    const slow: WriterRunner = async () => { throw new CommandTimeout("timed out after 30 s"); };
    expect(await replyToInvitation(mail(), input(), deps({ run: slow }))).toMatchObject({ ok: false, status: 504 });
    expect(await replyToInvitation(mail(), input(), deps())).toMatchObject({ ok: false, status: 409 });
  });

  test("a calendar writer that throws after a sent acceptance still records the answer as sent", async () => {
    const throwing: WriterRunner = async (argv, stdin) => {
      calls.push({ argv, stdin });
      if (argv[0] === "calendar-writer") throw new Error("spawn failed");
      return { code: 0, stdout: JSON.stringify({ id: "r1" }), stderr: "" };
    };
    const result = await replyToInvitation(mail(), input({ reply: "accept" }), deps({ run: throwing }));
    expect(result.ok && result.message).toContain("The event was not added to your calendar");
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")?.status).toBe("sent");
    expect(queryMailLog(db, {}).map((e) => e.action)).toEqual(["accept"]);
  });

  test("a decline on an account listed under removeOnDecline runs its remover with the invitation's UID and time, and the card line says what it did", async () => {
    answer = (argv) => (argv[0] === "exchange-remover" ? { code: 0, stdout: JSON.stringify({ id: "uid-1", message: "Exchange's tentative copy is removed from your calendar." }), stderr: "" } : { code: 0, stdout: JSON.stringify({ id: "r1", message: "The decline went to Olga." }), stderr: "" });
    const config: InvitationsConfig = { ...CONFIG, removeOnDecline: [{ account: "work", command: ["exchange-remover", "--ical-account", "me"] }] };
    const recurring = mail({ invitation: { ...INVITATION, recurring: true } });
    const result = await replyToInvitation(recurring, input(), deps({ config }));
    expect(result).toEqual({ ok: true, message: "Declined. The decline went to Olga. Exchange's tentative copy is removed from your calendar." });
    expect(calls.map((c) => c.argv[0])).toEqual(["invite-reply", "exchange-remover"]);
    expect(JSON.parse(calls[1]?.stdin ?? "{}")).toEqual({ action: "remove-declined", account: "work", uid: "uid-1", start: INVITATION.start, end: INVITATION.end, recurring: true });
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")).toMatchObject({ reply: "decline", status: "sent", calendar: "Exchange's tentative copy is removed from your calendar." });
  });

  test("accept, and a decline on an account not listed, never run the remover", async () => {
    const config: InvitationsConfig = { ...CONFIG, addToCalendar: [], removeOnDecline: [{ account: "work", command: ["exchange-remover"] }] };
    await replyToInvitation(mail(), input({ reply: "accept" }), deps({ config }));
    await replyToInvitation(mail({ id: "p@example.org", account: "personal" }), input(), deps({ config }));
    expect(calls.map((c) => c.argv[0])).toEqual(["invite-reply", "invite-reply"]);
  });

  test("a remover that fails, throws or times out leaves the decline sent and says the copy is still there", async () => {
    const config: InvitationsConfig = { ...CONFIG, removeOnDecline: [{ account: "work", command: ["exchange-remover"] }] };
    answer = (argv) => (argv[0] === "exchange-remover" ? { code: 1, stdout: "", stderr: "Exchange answered HTTP 401." } : { code: 0, stdout: JSON.stringify({ id: "r1", message: "The decline went to Olga." }), stderr: "" });
    const failed = await replyToInvitation(mail(), input(), deps({ config }));
    expect(failed).toEqual({ ok: true, message: "Declined. The decline went to Olga. The calendar still holds the tentative copy: Exchange answered HTTP 401." });
    expect(invitationDecisions(db, ["invite@example.org"]).get("invite@example.org")).toMatchObject({ status: "sent", calendar: "The calendar still holds the tentative copy: Exchange answered HTTP 401." });
    expect(queryMailLog(db, {}).map((e) => e.action)).toEqual(["decline"]);
    const { CommandTimeout } = await import("../desk/spawn");
    const slow: WriterRunner = async (argv) => {
      if (argv[0] === "exchange-remover") throw new CommandTimeout("timed out after 30 s");
      return { code: 0, stdout: JSON.stringify({ id: "r2" }), stderr: "" };
    };
    const timedOut = await replyToInvitation(mail({ id: "t@example.org" }), input(), deps({ config, run: slow }));
    expect(timedOut).toEqual({ ok: true, message: "Declined. The calendar still holds the tentative copy: the remove command timed out after 30 s." });
  });

  test("removeOnDecline takes { account, command } entries and refuses an account listed twice", () => {
    const parse = (removeOnDecline: unknown) => DeskMailInvitationsSchema.safeParse({ command: ["x"], removeOnDecline });
    expect(parse([{ account: "work", command: ["desk-exchange-decline", "--ical-account", "me"] }]).success).toBe(true);
    expect(parse([{ account: "work", command: [] }]).success).toBe(false);
    expect(parse([{ account: "work", command: ["a"] }, { account: "work", command: ["b"] }]).success).toBe(false);
    expect(DeskMailInvitationsSchema.parse({ command: ["x"] }).removeOnDecline).toEqual([]);
  });

  test("the payload names the source's account, Message-ID and invitation UID", () => {
    expect(invitePayload(mail(), "accept", "req-1")).toEqual({ action: "invite-reply", account: "work", messageId: "invite@example.org", uid: "uid-1", reply: "accept", requestId: "req-1" });
    expect(invitePayload(mail({ invitation: undefined }), "accept", "req-1")).toBeNull();
  });
});

describe("card", () => {
  const view = (over: Partial<ListedMail> = {}) => {
    const m = mail(over);
    const v = invitationView(m, calendar([event("Team sync", at(3, 14), at(3, 14, 30))]), CONFIG);
    if (!v) throw new Error("no view");
    return { m, v };
  };

  test("an invitation shows the event, its conflicts, the Yes-filter and Accept, Decline and Propose times", () => {
    const { m, v } = view();
    const item = mailItems({ now: NOW, mail: [{ ...m, area: null }], events: [], vips: new Set(), draft: true, invitations: new Map([[m.id, v]]) })[0];
    expect(item?.actions.map((a) => a.id)).toEqual(["invite.accept", "invite.decline", "invite.propose"]);
    expect(item?.actions.map((a) => a.role)).toEqual(["primary", "secondary", "secondary"]);
    expect(item?.why).toContain('invites you to "Budget review"');
    expect(item?.why).toContain('It overlaps "Team sync"');
    expect(item?.yesFilter).toBeDefined();
    expect(item?.invitation?.canReply).toBe(true);
    expect(item?.urgency).toBe("today");
  });

  test("an answered invitation offers no answer again and says what fell away", () => {
    const { m, v } = view();
    const answered = { ...v, decision: { reply: "accept" as const, status: "sent" as const, at: NOW - 60_000, fallsAway: "Field Notes format", result: "Accepted.", calendar: null } };
    const item = mailItems({ now: NOW, mail: [{ ...m, area: null }], events: [], vips: new Set(), draft: true, invitations: new Map([[m.id, answered]]) })[0];
    expect(item?.actions.some((a) => a.id.startsWith("invite."))).toBe(false);
    expect(item?.detail.history.join(" ")).toContain("Falls away: Field Notes format.");
  });

  test("an invitation without a calendar part offers Accept and Decline as drafts when drafting is set up", () => {
    const m = mail({ invitation: undefined });
    const classified = new Map([[m.id, { category: "reply" as const, reason: "Asks you to speak.", commitment: "invitation" as const }]]);
    const item = mailItems({ now: NOW, mail: [{ ...m, area: null }], events: [], vips: new Set(), draft: true, classified })[0];
    expect(item?.actions.map((a) => a.id).slice(0, 2)).toEqual(["invite.accept", "invite.decline"]);
    expect(item?.invitation).toBeUndefined();
    const noDraft = mailItems({ now: NOW, mail: [{ ...m, area: null }], events: [], vips: new Set(), draft: false, classified })[0];
    expect(noDraft?.actions.some((a) => a.id.startsWith("invite."))).toBe(false);
  });

  test("the source contract keeps a good invitation and drops a malformed one without dropping the mail", () => {
    const base = { kind: "mail", id: "m@x", from: { address: "a@b.c" }, subject: "s", receivedAt: new Date(NOW).toISOString(), unread: true };
    expect(SourceMailSchema.parse({ ...base, invitation: INVITATION }).invitation?.uid).toBe("uid-1");
    expect(SourceMailSchema.parse({ ...base, invitation: { ...INVITATION, organizer: { address: "not an address" } } }).invitation).toBeUndefined();
    expect(SourceMailSchema.parse({ ...base, invitation: { ...INVITATION, end: new Date(at(3, 13)).toISOString() } }).invitation).toBeUndefined();
  });
});

describe("api", () => {
  test("invite.reply without confirmation sends nothing; with it the command runs once", async () => {
    const db = initDatabase(":memory:");
    const calls: string[] = [];
    const run: WriterRunner = async (argv, stdin) => { calls.push(stdin); return { code: 0, stdout: JSON.stringify({ id: "r1", message: "Sent." }), stderr: "" }; };
    const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [{ id: "work-mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 30 }], mailInvitations: { ...CONFIG, addToCalendar: [] } };
    const cache = new SourceCache(async () => JSON.stringify({ items: [{ ...mail(), sourceId: undefined }] }));
    await cache.read(options.sources, NOW);
    const runtime = { options, sourceCache: cache, ledger: new HandledLedger() };
    const post = (body: object) => new Request("http://x/api/desk/mail", { method: "POST", body: JSON.stringify(body) });
    const body = { action: "invite.reply", key: "mail:invite@example.org", reply: "decline", requestId: crypto.randomUUID(), commitment: null };
    expect((await handleDeskMail(post({ ...body, confirmed: false }), db, runtime, { run, now: () => NOW })).status).toBe(409);
    expect((await handleDeskMail(post(body), db, runtime, { run, now: () => NOW })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const sent = await handleDeskMail(post({ ...body, confirmed: true }), db, runtime, { run, now: () => NOW });
    expect(sent.status).toBe(200);
    expect(calls).toHaveLength(1);
    const proposed = await handleDeskMail(post({ action: "invite.propose", key: "mail:invite@example.org" }), db, runtime, { run, now: () => NOW });
    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ ok: true, body: "", slots: 0 });
    db.close();
  });
});

test("a failed refresh keeps the capabilities of the last good reading", async () => {
  let fail = false;
  const cache = new SourceCache(async () => { if (fail) throw new Error("down"); return JSON.stringify({ capabilities: ["attention"], items: [] }); });
  const sources = [{ id: "work-mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 30 }];
  await cache.read(sources, NOW);
  fail = true;
  await cache.read(sources, NOW + 600_000);
  await new Promise((r) => setTimeout(r, 10));
  const [reading] = cache.cached();
  expect(reading?.error).toBe("down");
  expect(reading?.capabilities).toEqual(["attention"]);
});
