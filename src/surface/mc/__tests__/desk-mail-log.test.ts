import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { saveClassification } from "../desk/classify";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { ClientMailLog, LOCATE_ATTEMPTS, recordClientDecisions, type ClientLogDeps } from "../desk/mail-client-log";
import { departures, historySentence, logMailDecision, mailFeatures, purgeMailLog, queryMailLog, type MailLogEntry } from "../desk/mail-log";
import { movedKey } from "../desk/mail-move";
import { parseSourceOutput, SourceCache, type SourceMail, type SourceReading } from "../desk/sources/command";
import { DAY_MS } from "../desk/time";
import { initDatabase } from "../db/init";
import { mailDesk, queue } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const MOVE = ["/opt/adapters/bin/desk-mail-move.ts"];
const DESK: DeskOptions = mailDesk({ move: MOVE, draft: ["/opt/adapters/bin/desk-mail-draft.ts"], timeoutSeconds: 20 });

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Stats", address: "Reports@Stats.Example.org" }, subject: `Weekly ${id}`, receivedAt: "2026-11-01T08:00:00.000Z", unread: true,
  account: "work", firstParagraph: "Your weekly numbers are in.", headers: { listId: "<weekly.stats.example.org>" }, ...over,
});

const reading = (mails: SourceMail[], over: Partial<SourceReading> = {}): SourceReading => ({ id: "work-mail", area: null, events: [], mail: mails, readAt: NOW, error: null, dropped: 0, problems: [], ...over });


const ok = (body: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const refused = (line: string): WriterResult => ({ code: 1, stdout: "", stderr: `${line}\n` });

const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

async function deskWith(mails: SourceMail[]): Promise<DeskRuntime> {
  const rt: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: mails })) };
  await composeDesk(db, DESK, undefined, { now: NOW, handled: rt.ledger, sourceCache: rt.sourceCache });
  return rt;
}

const rows = (): Pick<MailLogEntry, "messageId" | "action" | "where" | "folder">[] => queryMailLog(db).map(({ messageId, action, where, folder }) => ({ messageId, action, where, folder })).reverse();

describe("Desk decisions", () => {
  it("logs a move with the mail's features only after the move command succeeded", async () => {
    saveClassification(db, "m1@stats", { category: "bulk", reason: "A newsletter.", summary: "Weekly statistics for October." }, "test", NOW);
    const rt = await deskWith([mail("m1@stats")]);
    const failing = queue([refused("The work account has no Archive mailbox, so nothing was moved.")]);
    expect((await handleDeskMail(post({ action: "move", key: "mail:m1@stats", target: "archive" }), db, rt, { run: failing.run, now: () => NOW })).status).toBe(502);
    expect(rows()).toEqual([]);

    const moving = queue([ok({ id: "m1@stats", folder: "Archiv", message: "Moved to Archiv." })]);
    expect((await handleDeskMail(post({ action: "move", key: "mail:m1@stats", target: "archive" }), db, rt, { run: moving.run, now: () => NOW })).status).toBe(200);
    expect(queryMailLog(db)).toEqual([{
      id: expect.any(Number), messageId: "m1@stats", account: "work", sourceId: "work-mail", sender: "reports@stats.example.org", senderDomain: "stats.example.org",
      listId: "<weekly.stats.example.org>", category: "bulk", subject: "Weekly m1@stats", summary: "Weekly statistics for October.", action: "archive", where: "desk", folder: "Archiv", at: NOW,
    }]);
  });

  it("logs Undo as restore, Unimportant as one decision, and a draft only once it is saved", async () => {
    const rt = await deskWith([mail("m1@stats"), mail("m2@stats", { from: { address: "news@other.example" } }), mail("m3@stats")]);
    const r = queue([ok({ id: "m1@stats", folder: "Junk", message: "Moved to Junk." }), ok({ id: "m1@stats", folder: "INBOX", message: "Moved back." })]);
    const moved = await (await handleDeskMail(post({ action: "move", key: "mail:m1@stats", target: "junk" }), db, rt, { run: r.run, now: () => NOW, newId: () => "mv1" })).json();
    expect(moved.undo).toBe("mv1");
    expect((await handleDeskMail(post({ action: "undo", move: "mv1" }), db, rt, { run: r.run, now: () => NOW + 1000 })).status).toBe(200);

    const trash = queue([ok({ id: "m2@stats", folder: "Trash", message: "Moved to Trash." })]);
    expect((await handleDeskMail(post({ action: "unimportant", key: "mail:m2@stats" }), db, rt, { run: trash.run, now: () => NOW })).status).toBe(200);

    const draftFails = queue([refused("The draft was not saved.")]);
    expect((await handleDeskMail(post({ action: "draft", key: "mail:m3@stats", body: "Thanks!" }), db, rt, { run: draftFails.run, now: () => NOW })).status).toBe(502);
    const draft = queue([ok({ id: "d1" })]);
    expect((await handleDeskMail(post({ action: "draft", key: "mail:m3@stats", body: "Thanks!" }), db, rt, { run: draft.run, now: () => NOW })).status).toBe(200);

    expect(rows()).toEqual([
      { messageId: "m1@stats", action: "junk", where: "desk", folder: "Junk" },
      { messageId: "m2@stats", action: "unimportant", where: "desk", folder: "Trash" },
      { messageId: "m3@stats", action: "draft", where: "desk", folder: "Drafts" },
      { messageId: "m1@stats", action: "restore", where: "desk", folder: "INBOX" },
    ]);
    expect(queryMailLog(db, { actions: ["restore"] })[0]).toMatchObject({ sender: "reports@stats.example.org", listId: "<weekly.stats.example.org>" });
  });

  it("shows a listed mail's decisions in its detail history as plain sentences", async () => {
    const m = mail("m4@stats");
    logMailDecision(db, mailFeatures(db, m), "draft", "desk", NOW - 60_000, "Drafts");
    logMailDecision(db, mailFeatures(db, m), "kept", "client", NOW - 30_000);
    const view = await composeDesk(db, DESK, undefined, { now: NOW, handled: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [m] })) });
    const history = view.items.find((i) => i.key === "mail:m4@stats")?.detail.history ?? [];
    expect(history.slice(-2)).toEqual([
      expect.stringMatching(/^You saved a reply draft on the Desk \(today at \d\d:\d\d\)\.$/),
      expect.stringMatching(/^You read it in your mail client and kept it in the inbox \(today at \d\d:\d\d\)\.$/),
    ]);
  });
});

describe("Client decisions from two source readings", () => {
  const deps = (run: ClientLogDeps["run"], ledger = new HandledLedger(), config: DeskOptions["mailActions"] = DESK.mailActions): ClientLogDeps => ({ db, config, ledger, run, now: () => NOW, retentionDays: 180 });

  it("diffs only unread mail that left the list or became read, and nothing after a failed reading", () => {
    const prev = reading([mail("a"), mail("b"), mail("c", { unread: false }), mail("d")]);
    const next = reading([mail("a"), mail("b", { unread: false })]);
    expect(departures(prev, next).map((d) => [d.mail.id, d.read])).toEqual([["b", true], ["d", false]]);
    expect(departures(undefined, next)).toEqual([]);
    expect(departures(prev, reading(prev.mail, { error: "exited 1" }))).toEqual([]);
    expect(departures(reading(prev.mail, { error: "exited 1" }), next).map((d) => d.mail.id)).toEqual(["b", "d"]);
  });

  it("records where each mail went: archive, junk, trash, read-and-kept, gone when not found, and nothing when the lookup fails", async () => {
    const prev = reading(["arch", "junk", "trash", "kept", "inbox-unread", "gone", "broken", "read"].map((id) => mail(id)));
    const next = reading([mail("read", { unread: false })]);
    const r = queue([
      ok({ id: "arch", place: "archive", folder: "Archiv", unread: false }),
      ok({ id: "junk", place: "junk", folder: "Junk", unread: true }),
      ok({ id: "trash", place: "trash", folder: "Deleted Items", unread: false }),
      ok({ id: "kept", place: "inbox", folder: "INBOX", unread: false }),
      ok({ id: "inbox-unread", place: "inbox", folder: "INBOX", unread: true }),
      ok({ id: "gone", place: "gone" }),
      refused("The work mail server did not accept the connection."),
    ]);
    const pass = await recordClientDecisions(prev, next, deps(r.run));
    expect([pass.logged, pass.failed.map((d) => d.mail.id)]).toEqual([6, ["broken"]]);
    expect(r.calls.map((c) => c.stdin)).toEqual(["arch", "junk", "trash", "kept", "inbox-unread", "gone", "broken"].map((id) => ({ action: "locate", account: "work", messageId: id })));
    expect(rows()).toEqual([
      { messageId: "arch", action: "archive", where: "client", folder: "Archiv" },
      { messageId: "junk", action: "junk", where: "client", folder: "Junk" },
      { messageId: "trash", action: "trash", where: "client", folder: "Deleted Items" },
      { messageId: "kept", action: "kept", where: "client", folder: "INBOX" },
      { messageId: "gone", action: "gone", where: "client", folder: null },
      { messageId: "read", action: "kept", where: "client", folder: null },
    ]);
  });

  it("skips mail the Desk moved itself, and logs nothing for a mail it has no command to look for", async () => {
    const ledger = new HandledLedger();
    ledger.add(movedKey("archive", "desk-moved"), NOW);
    logMailDecision(db, mailFeatures(db, mail("desk-trashed")), "trash", "desk", NOW - 1000, "Trash");
    const r = queue([]);
    const prev = reading([mail("desk-moved"), mail("desk-trashed"), mail("no-command"), mail("read-no-command")]);
    const pass = await recordClientDecisions(prev, reading([mail("read-no-command", { unread: false })]), deps(r.run, ledger, { timeoutSeconds: 20 }));
    expect([pass.logged, pass.failed]).toEqual([1, []]);
    expect(r.calls).toEqual([]);
    expect(rows().filter((e) => e.where === "client")).toEqual([{ messageId: "read-no-command", action: "kept", where: "client", folder: null }]);
  });

  it("tries a failed lookup again with the next readings, then gives up without logging a guess", async () => {
    const r = queue([refused("connection refused"), ok({ id: "x", place: "junk", folder: "Junk" }), refused("down"), refused("down"), refused("down"), refused("down")]);
    const log = new ClientMailLog(deps(r.run));
    await log.observe(reading([mail("x")]), reading([]));
    expect(rows()).toEqual([]);
    await log.observe(reading([]), reading([]));
    expect(rows()).toEqual([{ messageId: "x", action: "junk", where: "client", folder: "Junk" }]);
    await log.observe(reading([mail("y")]), reading([]));
    for (let i = 0; i < LOCATE_ATTEMPTS + 1; i += 1) await log.observe(reading([]), reading([]));
    expect(r.calls.filter((c) => (c.stdin as { messageId: string }).messageId === "y")).toHaveLength(LOCATE_ATTEMPTS);
    expect(rows().map((e) => e.messageId)).toEqual(["x"]);
  });

  it("runs the pass from the source cache whenever a source is read again", async () => {
    let listed = [mail("x")];
    const r = queue([ok({ id: "x", place: "archive", folder: "Archive" })]);
    const passes: Promise<unknown>[] = [];
    const cache = new SourceCache(async () => JSON.stringify({ items: listed }), (prev, next) => passes.push(recordClientDecisions(prev, next, deps(r.run))));
    const source = { id: "work-mail", command: ["desk-mail"], everySeconds: 1, timeoutSeconds: 5 };
    await cache.read([source], NOW);
    listed = [];
    await cache.read([source], NOW + 5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(passes);
    expect(rows()).toEqual([{ messageId: "x", action: "archive", where: "client", folder: "Archive" }]);
  });
});

describe("Retention and headers", () => {
  it("purges decisions older than the retention and keeps the rest", () => {
    const f = mailFeatures(db, mail("old"));
    logMailDecision(db, f, "archive", "desk", NOW - 181 * DAY_MS);
    logMailDecision(db, { ...f, messageId: "edge" }, "archive", "desk", NOW - 179 * DAY_MS);
    logMailDecision(db, { ...f, messageId: "new" }, "kept", "client", NOW);
    expect(purgeMailLog(db, NOW, 180)).toBe(1);
    expect(rows().map((e) => e.messageId)).toEqual(["edge", "new"]);
    expect(purgeMailLog(db, NOW, 30)).toBe(1);
    expect(rows().map((e) => e.messageId)).toEqual(["new"]);
  });

  it("keeps a mail whose headers are malformed, dropping only the fields that do not fit", () => {
    const base = { kind: "mail", from: { address: "a@b.example" }, subject: "s", receivedAt: "2026-11-01T08:00:00Z", unread: true };
    const parsed = parseSourceOutput(JSON.stringify({ items: [
      { ...base, id: "1", headers: { listId: 7, listUnsubscribe: "x".repeat(2001), replyTo: "a\u0000b@c.example", authResults: { spf: "PASS", dkim: "maybe", dmarc: ["fail"] }, inReplyTo: "  " } },
      { ...base, id: "2", headers: "List-Id: nope" },
      { ...base, id: "3", headers: { authResults: "spf=pass", listUnsubscribePost: "List-Unsubscribe=One-Click" } },
    ] }));
    expect(parsed.dropped).toBe(0);
    expect(parsed.mail.map((m) => [m.id, m.headers])).toEqual([
      ["1", { replyTo: "a b@c.example", authResults: { spf: "pass" } }],
      ["2", undefined],
      ["3", { listUnsubscribePost: "List-Unsubscribe=One-Click" }],
    ]);
  });

  it("words every client destination and Desk action for the history", () => {
    const e = (action: MailLogEntry["action"], where: MailLogEntry["where"], folder: string | null = null) => historySentence({ ...mailFeatures(db, mail("h")), id: 1, action, where, folder, at: NOW - 3 * DAY_MS }, NOW);
    expect(e("archive", "client", "Archiv")).toBe("You moved it to Archiv in your mail client (3 days ago).");
    expect(e("gone", "client")).toBe("It left the inbox outside the Desk, and the Desk could not find where it went (3 days ago).");
    expect(e("junk", "desk")).toBe("You moved it to Junk on the Desk (3 days ago).");
    expect(e("unimportant", "desk", "Trash")).toBe("You marked its sender unimportant on the Desk (3 days ago).");
  });
});
