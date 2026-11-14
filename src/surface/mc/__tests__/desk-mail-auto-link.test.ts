import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskMail } from "../api/desk-mail";
import { handleDeskLinks } from "../api/desk-links";
import { HandledLedger } from "../desk/actions";
import { setGrant } from "../desk/autonomy";
import { MailClassifier, type CommandConfig, type MailClassification } from "../desk/classify";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { DeskView } from "../desk/types";
import { activeMailLink } from "../desk/links";
import { autoLinkMeeting } from "../desk/mail-auto-link";
import { historySentence, queryMailLog } from "../desk/mail-log";
import { proposeRules } from "../desk/mail-rules";
import { SourceCache, type SourceEvent, type SourceMail } from "../desk/sources/command";
import { addVip } from "../desk/vips";

const NOW = new Date("2026-11-04T09:00:00").getTime();
const iso = (hour: number, day = 4): string => new Date(2026, 10, day, hour).toISOString();
const MEETING: SourceEvent = { id: "k1", title: "Venue walkthrough", start: iso(14, 5), end: iso(15, 5) };
const PAST: SourceEvent = { id: "p1", title: "Morning standup", start: iso(7), end: iso(8) };
const MEETING_KEY = "cal:work-calendar:k1";

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Ada Lovelace", address: "ada@example.org" }, subject: `Agenda ${id}`, receivedAt: iso(8), unread: true, account: "work", url: `message://${id}`, ...over,
});

const COMMAND: CommandConfig = { command: ["/opt/desk/bin/desk-classify-mail.ts"], timeoutSeconds: 30, maxPerPass: 10 };
const DESK: DeskOptions = {
  enabled: true, displayName: "Ada", topN: 10, rangerUrl: "", areas: [{ id: "work", label: "Work", color: "", policy: "cloud", repos: [], goals: [] }],
  sources: [
    { id: "work-calendar", area: "work", command: ["cal"], everySeconds: 300, timeoutSeconds: 5 },
    { id: "work-mail", area: "work", command: ["mail"], everySeconds: 300, timeoutSeconds: 5 },
  ],
  mailClassifier: COMMAND,
};

const LINK_MEETING: MailClassification = { category: "meeting", meetingKey: MEETING_KEY, suggestedAction: "link-meeting", reason: "The agenda for the venue walkthrough." };

let db: Database;
let ids = 0;
beforeEach(() => {
  db = initDatabase(":memory:");
  ids = 0;
});
afterEach(() => db.close());

interface Stack {
  rt: DeskRuntime;
  classifier: MailClassifier;
  answers: Map<string, MailClassification | Record<string, unknown>>;
  compose: (now?: number) => Promise<DeskView>;
}

function deskWithClassifier(items: SourceMail[], events: SourceEvent[] = [MEETING, PAST], passClock: () => number = () => NOW): Stack {
  const answers = new Map<string, MailClassification | Record<string, unknown>>();
  const classifier = new MailClassifier(COMMAND, async (req) => answers.get(req.mail.id) ?? { category: "fyi", reason: "Just news." }, () => undefined, passClock);
  const sourceCache = new SourceCache(async ([cmd]) => JSON.stringify(cmd === "cal" ? { events } : { items }));
  const rt: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache };
  const compose = async (now = NOW): Promise<DeskView> => {
    const view = await composeDesk(db, DESK, undefined, { now, sourceCache, handled: rt.ledger, mailClassifier: classifier });
    await classifier.kick(db, { now, mail: [], events: [], vips: [] });
    return view;
  };
  return { rt, classifier, answers, compose };
}

const mailKeys = (view: DeskView): string[] => view.items.map((i) => i.key).filter((k) => k.startsWith("mail:"));
const linksCount = (): number => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_links").get()?.n ?? 0;
const doneRows = () => db.query<{ action: string; item_key: string; title: string; message: string }, []>("SELECT action, item_key, title, message FROM desk_done ORDER BY created_at").all();
const post = (url: string, body: unknown): Request => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const undoByMail = async (rt: DeskRuntime, link: string) => {
  await rt.sourceCache?.read(DESK.sources, NOW);
  const res = await handleDeskMail(post("http://localhost/api/desk/mail", { action: "attach.undo", link }), db, rt, { now: () => NOW + 60_000 });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};

describe("the mail.link-meeting grant", () => {
  it("is offered, off by default, wherever a mail classifier is set up", async () => {
    const { compose } = deskWithClassifier([mail("m1")]);
    const view = await compose();
    expect(view.autonomy.types.find((t) => t.action === "mail.link-meeting")).toEqual({
      action: "mail.link-meeting", label: "Link mail to its meeting", on: false,
      note: "When the classifier finds that a mail belongs to an upcoming meeting, the Desk links it there. Each link shows here with Undo, which brings the mail back.",
    });
  });

  it("is not offered for an endpoint classifier, which never suggests an action", async () => {
    const endpoint: DeskOptions = { ...DESK, mailClassifier: { baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 30, maxPerPass: 10 } };
    const sourceCache = new SourceCache(async ([cmd]) => JSON.stringify(cmd === "cal" ? { events: [MEETING] } : { items: [mail("m1")] }));
    const view = await composeDesk(db, endpoint, undefined, { now: NOW, sourceCache });
    expect(view.autonomy.types.map((t) => t.action)).not.toContain("mail.link-meeting");
  });

  it("links nothing while it is off", async () => {
    const s = deskWithClassifier([mail("m1")]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
    expect(mailKeys(await s.compose())).toEqual(["mail:m1"]);
    expect(doneRows()).toEqual([]);
  });
});

describe("an auto-link in the classifier pass", () => {
  beforeEach(() => setGrant(db, "mail.link-meeting", true, NOW - 1000));

  it("links the mail to its meeting with origin auto, takes the card off the Desk and lists it under Done for you with Undo", async () => {
    const s = deskWithClassifier([mail("m1"), mail("m2")]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    const link = activeMailLink(db, "m1");
    expect(link).toMatchObject({ origin: "auto", toKind: "meeting", toKey: MEETING_KEY, toTitle: "Venue walkthrough", requestId: "auto:m1", ruleRun: null });
    const view = await s.compose();
    expect(mailKeys(view)).toEqual(["mail:m2"]);
    expect([...view.today, ...view.ahead].find((e) => e.key === MEETING_KEY)?.links).toEqual([{ id: link?.id ?? "", kind: "mail", key: "mail:m1", title: "Agenda m1", origin: "auto" }]);
    expect(view.autonomy.done).toEqual([{ key: `mail-link:${link?.id}`, action: "mail.link", undo: link?.id, title: "Linked “Agenda m1” to “Venue walkthrough”", message: "It stays in your mailbox and shows with the meeting.", at: NOW, ok: true }]);
    const [logged] = queryMailLog(db, {});
    expect(logged).toMatchObject({ messageId: "m1", action: "attach", where: "auto", folder: "Venue walkthrough" });
    if (logged) expect(historySentence(logged, NOW)).toStartWith("The Desk linked it to “Venue walkthrough” on its own (");
  });

  it("links nothing for a meeting key the Desk does not list, or a meeting that is over", async () => {
    const s = deskWithClassifier([mail("m1"), mail("m2")]);
    s.answers.set("m1", { ...LINK_MEETING, meetingKey: "cal:work-calendar:nope" });
    s.answers.set("m2", { ...LINK_MEETING, meetingKey: "cal:work-calendar:p1" });
    await s.compose();
    expect(linksCount()).toBe(0);
    expect(doneRows()).toEqual([]);
  });

  it("judges the meeting by the time the pass sorts the mail, not when compose started it", async () => {
    const s = deskWithClassifier([mail("m1")], [MEETING, PAST], () => Date.parse(MEETING.end ?? MEETING.start) + 1);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
  });

  it("links nothing without link-meeting, without a meeting key, for suspicious mail or for a VIP", async () => {
    addVip(db, "boss@example.org", null, NOW);
    const s = deskWithClassifier([mail("m1"), mail("m2"), mail("m3"), mail("m4", { from: { name: "Boss", address: "Boss@example.org" } })]);
    s.answers.set("m1", { ...LINK_MEETING, suggestedAction: "reply" });
    s.answers.set("m2", { category: "fyi", suggestedAction: "link-meeting", reason: "No key." });
    s.answers.set("m3", { ...LINK_MEETING, suspicious: true });
    s.answers.set("m4", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
  });

  it("is idempotent when the same mail is classified again", async () => {
    const s = deskWithClassifier([mail("m1")]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    const listed = { ...mail("m1"), sourceId: "work-mail" };
    const events = new Map([[MEETING_KEY, { title: MEETING.title, at: Date.parse(MEETING.start), end: Date.parse(MEETING.end ?? MEETING.start) }]]);
    expect(autoLinkMeeting({ db, events, vips: new Set(), now: NOW + 60_000 }, listed, LINK_MEETING)).toBeNull();
    db.query("DELETE FROM desk_mail_classes").run();
    await s.compose(NOW + 120_000);
    expect(linksCount()).toBe(1);
    expect(doneRows()).toHaveLength(1);
  });

  it("Undo ends exactly that link, brings the mail back, takes the Undo off its entry, and the next pass does not link it again", async () => {
    const s = deskWithClassifier([mail("m1"), mail("m2")]);
    s.answers.set("m1", LINK_MEETING);
    s.answers.set("m2", LINK_MEETING);
    await s.compose();
    const one = activeMailLink(db, "m1");
    const two = activeMailLink(db, "m2");
    if (!one || !two) throw new Error("both mails should be linked");
    expect(await undoByMail(s.rt, one.id)).toEqual({ status: 200, json: { ok: true, message: "“Agenda m1” is back on the Desk.", restored: "mail:m1" } });
    expect(activeMailLink(db, "m1")).toBeNull();
    expect(activeMailLink(db, "m2")?.id).toBe(two.id);
    expect(queryMailLog(db, { since: NOW + 1 }).map((e) => [e.messageId, e.action, e.where])).toEqual([["m1", "restore", "desk"]]);
    db.query("DELETE FROM desk_mail_classes").run();
    const view = await s.compose(NOW + 120_000);
    expect(mailKeys(view)).toEqual(["mail:m1"]);
    expect(linksCount()).toBe(2);
    const entry = view.autonomy.done.find((d) => d.key === `mail-link:${one.id}`);
    expect(entry).toMatchObject({ action: "mail.link.undone", message: "“Agenda m1” is back on the Desk." });
    expect(entry?.undo).toBeUndefined();
    expect(view.autonomy.done.find((d) => d.key === `mail-link:${two.id}`)?.undo).toBe(two.id);
  });

  it("does not link a mail whose link by hand was undone", async () => {
    const s = deskWithClassifier([mail("m1")]);
    await s.rt.sourceCache?.read(DESK.sources, NOW);
    const attach = await handleDeskMail(post("http://localhost/api/desk/mail", { action: "attach", key: "mail:m1", requestId: "0f3c1a52-6c1e-4b8f-9d2a-1f0e5b7c9a11", to: { kind: "meeting", event: MEETING_KEY } }), db, s.rt, { now: () => NOW, newId: () => "hand-1" });
    expect(attach.status).toBe(200);
    expect((await undoByMail(s.rt, "hand-1")).status).toBe(200);
    s.answers.set("m1", LINK_MEETING);
    await s.compose(NOW + 120_000);
    expect(activeMailLink(db, "m1")).toBeNull();
    expect(doneRows()).toEqual([]);
  });

  it("Undo through the links route marks the entry the same way", async () => {
    const s = deskWithClassifier([mail("m1")]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    const link = activeMailLink(db, "m1");
    if (!link) throw new Error("the mail should be linked");
    await s.rt.sourceCache?.read(DESK.sources, NOW);
    const res = await handleDeskLinks(post("http://localhost/api/desk/links", { op: "unlink", link: link.id }), db, s.rt, { now: () => NOW + 60_000, newId: () => `id-${++ids}` });
    expect(res.status).toBe(200);
    expect(doneRows()).toEqual([{ action: "mail.link.undone", item_key: link.id, title: "Linked “Agenda m1” to “Venue walkthrough”", message: "“Agenda m1” is back on the Desk." }]);
  });

  it("does not count toward a rule proposal", async () => {
    const s = deskWithClassifier([1, 2, 3, 4, 5, 6].map((n) => mail(`m${n}`)));
    for (let n = 1; n <= 6; n += 1) s.answers.set(`m${n}`, LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(6);
    expect(proposeRules(db, NOW + 60_000)).toEqual([]);
  });
});

describe("an auto-link to a meeting with an attendee list", () => {
  beforeEach(() => setGrant(db, "mail.link-meeting", true, NOW - 1000));
  const LISTED: SourceEvent = { ...MEETING, organizer: { address: "grace@example.org" }, attendees: [{ name: "Ada Lovelace", address: "ada@example.org" }, { address: "bob@example.org" }] };

  it("refuses a sender who is neither the organizer nor an attendee, and leaves the mail on the Desk without a Done for you entry", async () => {
    const s = deskWithClassifier([mail("m1", { from: { name: "Mallory", address: "mallory@example.net" } })], [LISTED, PAST]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
    expect(doneRows()).toEqual([]);
    expect(queryMailLog(db, {})).toEqual([]);
    expect(mailKeys(await s.compose())).toEqual(["mail:m1"]);
  });

  it("links a mail from an attendee or the organizer, comparing addresses without regard to case", async () => {
    const s = deskWithClassifier([
      mail("m1", { from: { address: "BOB@example.ORG" } }),
      mail("m2", { from: { name: "Grace Hopper", address: "Grace@Example.org" } }),
    ], [{ ...LISTED, organizer: { address: "GRACE@example.org" } }, PAST]);
    s.answers.set("m1", LINK_MEETING);
    s.answers.set("m2", LINK_MEETING);
    await s.compose();
    expect(activeMailLink(db, "m1")).toMatchObject({ origin: "auto", toKey: MEETING_KEY });
    expect(activeMailLink(db, "m2")).toMatchObject({ origin: "auto", toKey: MEETING_KEY });
  });

  it("counts a meeting whose only listed person is its organizer as having an attendee list", async () => {
    const s = deskWithClassifier([mail("m1")], [{ ...MEETING, organizer: { address: "grace@example.org" } }, PAST]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
  });

  it("refuses every sender when the source listed people the Desk cannot read", async () => {
    const unreadable = { ...MEETING, organizer: { address: "nobody" }, attendees: [{ address: "not an address" }] };
    const s = deskWithClassifier([mail("m1")], [unreadable, PAST]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(linksCount()).toBe(0);
  });

  it("links any sender when the meeting lists no attendees", async () => {
    const s = deskWithClassifier([mail("m1", { from: { address: "someone@example.net" } })], [{ ...MEETING, attendees: [] }, PAST]);
    s.answers.set("m1", LINK_MEETING);
    await s.compose();
    expect(activeMailLink(db, "m1")).toMatchObject({ origin: "auto" });
  });

  it("leaves linking by hand unchanged for a sender who is not an attendee", async () => {
    const s = deskWithClassifier([mail("m1", { from: { address: "mallory@example.net" } })], [LISTED, PAST]);
    await s.rt.sourceCache?.read(DESK.sources, NOW);
    const attach = await handleDeskMail(post("http://localhost/api/desk/mail", { action: "attach", key: "mail:m1", requestId: "4d2b7e10-8a3c-4f6e-b1d9-2c5a7e9f0b13", to: { kind: "meeting", event: MEETING_KEY } }), db, s.rt, { now: () => NOW, newId: () => "hand-1" });
    expect(attach.status).toBe(200);
    expect(activeMailLink(db, "m1")).toMatchObject({ origin: "desk", toKey: MEETING_KEY });
  });
});
