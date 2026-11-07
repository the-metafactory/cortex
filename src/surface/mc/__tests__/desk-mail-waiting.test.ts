import { classifierLabel } from "../desk/classify";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { queryMailLog } from "../desk/mail-log";
import { addWorkingDays, asksForAnswer, DEFAULT_WAITING, dueWaiting, readWaiting, recordWaiting, threadReplies, WaitingClassifier, waitingItems, waitingTopic, workingDaysBetween, type WaitingRunner } from "../desk/mail-waiting";
import { parseSourceOutput, SourceCache, type SourceMail, type SourceReading, type SourceSent } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { composeWith, mailDesk, queue } from "./desk-mail-fixtures";

let db: Database;
beforeEach(() => {
  db = initDatabase(":memory:");
});
afterEach(() => db.close());

const at = (day: number, hour = 10): number => new Date(2026, 9, day, hour, 0).getTime();
const MONDAY = at(26);
const FRIDAY = at(30);

const sent = (id: string, over: Partial<SourceSent> = {}): SourceSent => ({
  kind: "sent", id, from: { name: "Ada", address: "ada@example.org" }, to: [{ name: "Priya Shah", address: "priya@example.org" }],
  subject: "Venue quote", sentAt: new Date(MONDAY).toISOString(), text: "Does the quote include catering?", account: "personal", url: `message://%3C${id}%3E`, ...over,
});
const inbox = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Priya Shah", address: "priya@example.org" }, subject: "Re: Venue quote", receivedAt: new Date(at(27)).toISOString(), unread: true, account: "personal", ...over,
});
const reading = (sentMail: SourceSent[], mail: SourceMail[] = [], id = "personal-mail"): SourceReading => ({ id, area: "personal", events: [], mail, sent: sentMail, readAt: MONDAY, error: null, dropped: 0, problems: [] });
const cards = (now: number, draft = true) => waitingItems(db, now, { draft, areaOf: () => "personal" });

describe("working days", () => {
  it("adds working days at the same local time, skipping weekends", () => {
    expect(addWorkingDays(MONDAY, 4)).toBe(FRIDAY);
    expect(addWorkingDays(FRIDAY, 1)).toBe(at(33));
    expect(addWorkingDays(at(31), 1)).toBe(at(33));
    expect(addWorkingDays(at(29, 15), 4)).toBe(at(35, 15));
    expect(addWorkingDays(MONDAY, 0)).toBe(MONDAY);
  });

  it("counts the working days after the sent day up to today", () => {
    expect(workingDaysBetween(MONDAY, FRIDAY)).toBe(4);
    expect(workingDaysBetween(FRIDAY, at(33, 8))).toBe(1);
    expect(workingDaysBetween(at(31), at(32, 23))).toBe(0);
    expect(workingDaysBetween(MONDAY, at(26, 23))).toBe(0);
  });
});

describe("question detection", () => {
  const fixture: [string, string, boolean][] = [
    ["Venue quote", "Does the quote include catering?", true],
    ["Slides for Thursday", "Could you send me the slides by Wednesday. Thanks!", true],
    ["Budget", "Please confirm the numbers below.", true],
    ["Termin", "Kannst du mir bis Freitag Bescheid geben.", true],
    ["Offerte", "Ich bitte um eine kurze Rückmeldung bis Ende Woche.", true],
    ["Devis", "Pourriez-vous me renvoyer le devis signé.", true],
    ["Meeting next week?", "", true],
    ["Thanks", "Thanks for the great session yesterday, see you next week.", false],
    ["Minutes", "Here are the minutes. No reply needed.", false],
    ["Link", "The report is at https://example.org/r?id=4 for your files.", false],
    ["Re: Your question", "Yes, Tuesday works for me.", false],
  ];
  for (const [subject, text, expected] of fixture) {
    it(`${expected ? "asks" : "does not ask"}: ${subject}`, () => {
      expect(asksForAnswer(subject, text)).toBe(expected);
    });
  }

  it("takes the topic from the subject without reply and forward prefixes", () => {
    expect(waitingTopic("Re: AW: Fwd: Venue quote")).toBe("Venue quote");
    expect(waitingTopic("(no subject)")).toBe("your mail");
  });
});

describe("waiting-for tracker", () => {
  it("shows the card only after the working days pass, with the nudge, Snooze and Done", () => {
    recordWaiting(db, [reading([sent("s1")])], MONDAY);
    expect(cards(at(29))).toEqual([]);
    const [card] = cards(FRIDAY);
    expect(card?.title).toBe("No answer from Priya Shah about Venue quote since Monday");
    expect(card?.why).toContain("4 working days without an answer.");
    expect(card?.actions.map((a) => `${a.id}:${a.label}`)).toEqual(["mail.draft:Draft a nudge", "waiting.snooze:Wait 2 more days", "waiting.done:Done"]);
    expect(card?.more?.map((a) => a.id)).toEqual(["waiting.no-answer", "waiting.expect", "open"]);
    expect(card?.reply).toEqual({ to: "Priya Shah <priya@example.org>", subject: "Re: Venue quote" });
    expect(cards(FRIDAY, false)[0]?.actions.map((a) => a.id)).toEqual(["waiting.snooze", "waiting.done"]);
  });

  it("closes the wait on a reply in the thread by In-Reply-To or References, from any recipient", () => {
    recordWaiting(db, [reading([sent("s1"), sent("s2", { to: [{ address: "lee@example.org" }, { address: "kim@example.org" }] })])], MONDAY);
    recordWaiting(db, [reading([], [inbox("r1", { headers: { inReplyTo: "<s1>" } }), inbox("r2", { from: { address: "kim@example.org" }, headers: { references: ["p0", "s2"] } })])], at(27));
    expect(readWaiting(db, "s1")).toMatchObject({ state: "answered", closedBy: "priya@example.org" });
    expect(readWaiting(db, "s2")).toMatchObject({ state: "answered", closedBy: "kim@example.org" });
    expect(cards(FRIDAY)).toEqual([]);
    expect(threadReplies(db, "s1").map((r) => r.id)).toEqual(["r1"]);
  });

  it("closes the wait on a reply the source found in the archive", () => {
    recordWaiting(db, [reading([sent("s1", { replies: [{ id: "r9", from: { address: "priya@example.org" }, at: new Date(at(27)).toISOString() }] })])], MONDAY);
    expect(readWaiting(db, "s1")?.state).toBe("answered");
  });

  it("keeps waiting when the only replies are the sender's own or belong to another thread", () => {
    recordWaiting(db, [reading([sent("s1")], [inbox("x1", { headers: { inReplyTo: "<other>" } }), inbox("own", { from: { address: "ada@example.org" }, headers: { inReplyTo: "<s1>" } })])], MONDAY);
    expect(readWaiting(db, "s1")?.state).toBe("open");
    expect(cards(FRIDAY)).toHaveLength(1);
  });

  it("lets the sender's own follow-up supersede the wait, so the nudge waits again", () => {
    recordWaiting(db, [reading([sent("s1"), sent("s2", { subject: "Re: Venue quote", sentAt: new Date(FRIDAY).toISOString(), inReplyTo: "s1", text: "Any news on the catering?" })])], FRIDAY);
    expect(readWaiting(db, "s1")?.state).toBe("superseded");
    expect(dueWaiting(db, FRIDAY).map((w) => w.messageId)).toEqual([]);
    expect(dueWaiting(db, at(36)).map((w) => w.messageId)).toEqual(["s2"]);
  });

  it("keeps a plain follow-up waiting when it supersedes an open question", () => {
    recordWaiting(db, [reading([sent("s1"), sent("s2", { subject: "Re: Venue quote", sentAt: new Date(FRIDAY).toISOString(), references: ["s1"], text: "Just following up on this." })])], FRIDAY);
    expect(readWaiting(db, "s1")?.state).toBe("superseded");
    expect(readWaiting(db, "s2")).toMatchObject({ asks: true, detectedBy: "follow-up", state: "open" });
    expect(cards(at(36))[0]?.detail.history).toContain("It follows up on your earlier question in this conversation.");
  });

  it("ignores sent mail that asks nothing, mail to yourself or to no-reply addresses, and mail older than the window", () => {
    recordWaiting(db, [reading([
      sent("thanks", { text: "Thanks, that is all." }),
      sent("self", { to: [{ address: "ada@example.org" }] }),
      sent("robot", { to: [{ address: "noreply@service.example" }] }),
      sent("old", { sentAt: new Date(at(1)).toISOString() }),
    ])], FRIDAY);
    expect(readWaiting(db, "thanks")?.asks).toBe(false);
    expect(readWaiting(db, "self")).toBeNull();
    expect(readWaiting(db, "robot")).toBeNull();
    expect(readWaiting(db, "old")).toBeNull();
    expect(cards(at(40))).toEqual([]);
  });
});

describe("waiting-for actions", () => {
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const runtime = (options: DeskOptions): DeskRuntime => ({ options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [] })) });
  const ask = async (rt: DeskRuntime, body: unknown, now = FRIDAY, run?: ReturnType<typeof queue>["run"]) => (await handleDeskMail(post(body), db, rt, { now: () => now, ...(run ? { run } : {}) })).json();

  it("snoozes, then marks no answer needed and expects an answer again, logging each decision", async () => {
    recordWaiting(db, [reading([sent("s1")])], MONDAY);
    const rt = runtime(mailDesk({ timeoutSeconds: 20 }));
    expect(await ask(rt, { action: "waiting.snooze", key: "waiting:s1" })).toMatchObject({ ok: true, message: "The Desk waits until Tuesday for an answer about “Venue quote”." });
    expect(cards(at(34, 9))).toEqual([]);
    expect(cards(at(34, 11))).toHaveLength(1);
    expect(await ask(rt, { action: "waiting.no-answer", key: "waiting:s1" })).toMatchObject({ ok: true });
    expect(cards(at(40))).toEqual([]);
    expect(await ask(rt, { action: "waiting.expect", key: "waiting:s1" })).toMatchObject({ ok: true });
    expect(cards(at(34, 11))[0]?.more?.map((a) => a.id)).toEqual(["waiting.no-answer", "open"]);
    expect(await ask(rt, { action: "waiting.done", key: "waiting:s1" })).toMatchObject({ ok: true });
    expect(cards(at(40))).toEqual([]);
    const log = queryMailLog(db, {}).reverse();
    expect(log.map((e) => e.action)).toEqual(["snooze", "no-answer", "expect-answer", "waiting-done"]);
    expect(log[0]).toMatchObject({ messageId: "s1", sender: "priya@example.org", category: "sent", where: "desk" });
  });

  it("refuses an action on a sent mail the Desk does not track, and Snooze on a closed wait", async () => {
    const rt = runtime(mailDesk({ timeoutSeconds: 20 }));
    expect(await ask(rt, { action: "waiting.done", key: "waiting:nope" })).toMatchObject({ ok: false, error: "The Desk no longer tracks this sent mail." });
    recordWaiting(db, [reading([sent("s1")], [inbox("r1", { headers: { inReplyTo: "<s1>" } })])], MONDAY);
    expect(await ask(rt, { action: "waiting.snooze", key: "waiting:s1" })).toMatchObject({ ok: false });
    expect(queryMailLog(db, {})).toEqual([]);
  });

  it("drafts the nudge through the reply-draft contract, to the recipient and threaded to the sent mail", async () => {
    recordWaiting(db, [reading([sent("s1")])], MONDAY);
    const { calls, run } = queue([{ code: 0, stdout: "{}", stderr: "" }]);
    const rt = runtime(mailDesk({ draft: ["/opt/desk-mail-draft.ts"], timeoutSeconds: 20 }));
    expect(await ask(rt, { action: "draft", key: "waiting:s1", body: "Any news on the catering?" }, FRIDAY, run)).toMatchObject({ ok: true });
    expect(calls[0]?.stdin).toEqual({ action: "draft", account: "personal", messageId: "s1", to: "priya@example.org", subject: "Re: Venue quote", body: "Any news on the catering?" });
    expect(queryMailLog(db, {}).map((e) => `${e.action}:${e.folder}`)).toEqual(["draft:Drafts"]);
    expect(readWaiting(db, "s1")?.state).toBe("open");
  });
});

describe("waiting model", () => {
  const model = { baseUrl: "https://model.example/v1", model: "remote", timeoutSeconds: 10 };

  it("stores the model's verdict, topic and ask; a local-policy source without a local model stays with the heuristic", async () => {
    const seen: string[] = [];
    const run: WaitingRunner = async (access, request) => {
      seen.push(`${classifierLabel(access)}:${request.subject}`);
      return request.subject === "Venue quote" ? { asks: true, topic: "catering in the quote", ask: "You asked whether the quote includes catering." } : { asks: false };
    };
    const readings = [reading([sent("s1"), sent("s2", { subject: "Party", text: "Can you believe it?" })]), reading([sent("w1", { subject: "Budget", text: "Please confirm." })], [], "work-mail")];
    recordWaiting(db, readings, MONDAY);
    await new WaitingClassifier(model, run, () => undefined).kick(db, readings, new Set(["work-mail"]), MONDAY);
    expect(seen.sort()).toEqual(["remote:Party", "remote:Venue quote"]);
    expect(readWaiting(db, "s1")).toMatchObject({ asks: true, topic: "catering in the quote", detectedBy: "model:remote" });
    expect(readWaiting(db, "s2")).toMatchObject({ asks: false, detectedBy: "model:remote" });
    expect(readWaiting(db, "w1")).toMatchObject({ asks: true, detectedBy: "heuristic" });
    expect(cards(FRIDAY).map((c) => c.title)).toContain("No answer from Priya Shah about catering in the quote since Monday");
    expect(cards(FRIDAY).find((c) => c.key === "waiting:s1")?.why).toBe("You asked whether the quote includes catering. 4 working days without an answer.");
  });

  it("keeps the heuristic when the model fails or answers out of shape", async () => {
    const logged: string[] = [];
    const answers: unknown[] = [new Error("HTTP 500"), { asks: "maybe" }];
    const run: WaitingRunner = async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const readings = [reading([sent("s1"), sent("s2", { sentAt: new Date(at(27)).toISOString() })])];
    recordWaiting(db, readings, MONDAY);
    await new WaitingClassifier(model, run, (m) => logged.push(m)).kick(db, readings, new Set(), MONDAY);
    expect(readWaiting(db, "s1")?.detectedBy).toBe("heuristic");
    expect(readWaiting(db, "s2")?.detectedBy).toBe("heuristic");
    expect(logged).toHaveLength(2);
  });
});

describe("source contract and the Desk view", () => {
  it("reads sent items next to mail and drops a sent item without recipients", () => {
    const parsed = parseSourceOutput(JSON.stringify({ items: [inbox("m1", { headers: { references: ["<a@x>", "b@x"] } }), sent("s1"), { ...sent("bad"), to: [] }] }));
    expect(parsed.mail.map((m) => m.id)).toEqual(["m1"]);
    expect(parsed.mail[0]?.headers?.references).toEqual(["a@x", "b@x"]);
    expect(parsed.sent.map((s) => s.id)).toEqual(["s1"]);
    expect(parsed.dropped).toBe(1);
  });

  it("composes the card from a source that lists sent mail", async () => {
    const options: DeskOptions = { ...mailDesk({ draft: ["/opt/desk-mail-draft.ts"], timeoutSeconds: 20 }), mailWaiting: { ...DEFAULT_WAITING, afterDays: 0 } };
    const rt: DeskRuntime = { options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [sent("s1")] })) };
    const view = await composeWith(db, options, rt, at(26, 12));
    const card = view.items.find((i) => i.key === "waiting:s1");
    expect(card).toMatchObject({ kind: "mail-waiting", title: "No answer from Priya Shah about Venue quote since today" });
  });
});
