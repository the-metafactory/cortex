import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { handleGetDesk } from "../api/desk";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { MailClassifier, type ClassifierConfig } from "../desk/classify";
import { composeDesk, type DeskRuntime } from "../desk/compose";
import { CommandTimeout } from "../common/spawn";
import { parseSourceOutput, SourceCache, type SourceMail } from "../desk/sources/command";
import { DAY_MS } from "../desk/time";
import type { DeskView } from "../desk/types";
import { trustedViews } from "../desk/mail-trust";
import { suspicionContext, suspicionOf } from "../desk/mail-suspicion";
import { JunkReview } from "../dashboard-v2/components/desk-mail-junk";
import { composeWith, mailPost, MOVE_DESK, NOW, queue } from "./desk-mail-fixtures";

const mail = (id: string, at = NOW - 1000): SourceMail => ({ kind: "mail", id, from: { name: "Example Sender", address: `${id}@example.org` }, subject: `Subject ${id}`, receivedAt: new Date(at).toISOString(), unread: true, account: "work", firstParagraph: "PRIVATE JUNK BODY", headers: { replyTo: "other@example.net" } });
let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

async function runtime(junk: SourceMail[] | null = [mail("one"), mail("two")]): Promise<DeskRuntime> {
  const rt = { options: MOVE_DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(() => Promise.resolve(JSON.stringify({ items: [mail("inbox")], ...(junk ? { junk } : {}) }))) };
  await rt.sourceCache.read(MOVE_DESK.sources, NOW);
  return rt;
}
const view = (rt: DeskRuntime) => composeWith(db, rt.options ?? MOVE_DESK, rt, NOW);
const reviews = async (rt: DeskRuntime) => (await view(rt)).items.filter(i => i.kind === "mail-junk");
async function junkKey(rt: DeskRuntime): Promise<string> {
  const key = (await reviews(rt))[0]?.junkReview?.mails[0]?.key;
  if (!key) throw new Error("Fixture has no junk review mail");
  return key;
}

describe("junk source readings", () => {
  it("retains the twenty newest mails within seven days, deduplicates and removes body-bearing fields", () => {
    const junk = Array.from({ length: 25 }, (_, i) => mail(`m${i}`, NOW - i * 1000));
    const p = parseSourceOutput(JSON.stringify({ items: [mail("m0"), mail("inbox")], junk: [...junk.toReversed(), mail("old", NOW - 7 * DAY_MS - 1), mail("future", NOW + 1), mail("m0"), { kind: "mail" }] }), NOW);
    expect(p.junk?.map(m => m.id)).toEqual(junk.slice(0, 20).map(m => m.id));
    expect(p.mail.map(m => m.id)).toEqual(["inbox"]);
    expect(p.junk?.[0]).toEqual({ kind: "mail", id: "m0", from: mail("m0").from, subject: "Subject m0", receivedAt: new Date(NOW).toISOString(), unread: true, account: "work" });
    expect(p.dropped).toBe(1);
    expect(p.problems.join(" ")).toContain("junk[");
  });

  it("keeps the seventh-day boundary, omits absent junk and reports malformed lists", () => {
    expect(parseSourceOutput(JSON.stringify({ junk: [mail("edge", NOW - 7 * DAY_MS)] }), NOW).junk).toHaveLength(1);
    expect(parseSourceOutput("{}", NOW).junk).toBeUndefined();
    expect(parseSourceOutput('{"junk":42}', NOW).problems).toEqual(["junk: must be an array"]);
  });

  it.each([NOW - 1000, NOW - 8 * DAY_MS])("keeps inbox copies when another account reports the same Message-ID as junk at %p", at => {
    const inbox = { ...mail("shared"), account: "inbox-account" };
    const junk = { ...mail("shared", at), account: "junk-account" };
    const parsed = parseSourceOutput(JSON.stringify({ items: [inbox], junk: [junk] }), NOW);
    expect(parsed.mail).toEqual([inbox]);
    expect(parsed.junk).toHaveLength(at >= NOW - 7 * DAY_MS ? 1 : 0);
  });

  it("expires cached junk even when the next source read fails", async () => {
    let failed = false;
    const cache = new SourceCache(() => failed ? Promise.reject(new Error("Fixture source refused")) : Promise.resolve(JSON.stringify({ junk: [mail("one")] })));
    await cache.read(MOVE_DESK.sources, NOW);
    failed = true;
    await cache.read(MOVE_DESK.sources, NOW + 8 * DAY_MS);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cache.cached()[0]?.junk).toEqual([]);
    expect(cache.cached()[0]?.error).toBe("Fixture source refused");
  });

  it("serves one metadata-only review per source and none for sources without junk", async () => {
    const rt = await runtime();
    const source = MOVE_DESK.sources[0];
    if (!source) throw new Error("Fixture has no source");
    const options = { ...MOVE_DESK, sources: [...MOVE_DESK.sources, { ...source, id: "second" }, { ...source, id: "none" }].map(s => ({ ...s, command: [s.id] })) };
    const at = Date.now() - 1000;
    const cache = new SourceCache(argv => Promise.resolve(JSON.stringify(argv[0] === "none" ? {} : { junk: [mail("one", at), mail("two", at)] })));
    await cache.read(options.sources.slice(0, 2), Date.now());
    const response = await handleGetDesk(db, { ...rt, options, sourceCache: cache }, undefined);
    expect(response.status).toBe(200);
    const body = await response.json() as DeskView;
    const items = body.items.filter(i => i.kind === "mail-junk");
    expect(items.map((i: { source: string }) => i.source).sort()).toEqual(["second", "work-mail"]);
    expect(items[0]?.junkReview?.mails).toHaveLength(2);
    expect(items[0]?.junkReview?.mails[0]).toMatchObject({ from: mail("one").from, subject: "Subject one", receivedAt: new Date(at).toISOString(), action: { id: "mail.notspam", wired: true } });
    expect(JSON.stringify(items)).not.toContain("PRIVATE JUNK BODY");
    expect((await reviews(await runtime([])))).toEqual([]);
    expect((await reviews(await runtime(null)))).toEqual([]);
  });

  it("never sends junk into either classifier lane or normal mail ranking", async () => {
    const config: ClassifierConfig = { command: ["fixture-model"], timeoutSeconds: 1, maxPerPass: 10, sourcePolicy: "local" };
    const classifier = new MailClassifier(config);
    const local = new MailClassifier(config);
    const remoteKick = spyOn(classifier, "kick").mockResolvedValue({ classified: 0, failed: 0, ms: [] });
    const localKick = spyOn(local, "kick").mockResolvedValue({ classified: 0, failed: 0, ms: [] });
    try {
      const rt = await runtime();
      const result = await composeDesk(db, { ...MOVE_DESK, mailClassifier: { ...config, local: config } }, undefined, { now: NOW, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}), mailClassifier: classifier, localMailClassifier: local });
      expect(result.items.filter(i => i.kind === "mail").map(i => i.key)).toEqual(["mail:inbox"]);
      for (const calls of [remoteKick.mock.calls, localKick.mock.calls]) {
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[1].mail.some(m => m.id === "one" || m.id === "two")).toBe(false);
      }
    } finally { remoteKick.mockRestore(); localKick.mockRestore(); }
  });
});

describe("Not spam", () => {
  it("restores a listed junk mail through the mover, records trust, offers Undo and hides only that mail", async () => {
    const rt = await runtime();
    const key = await junkKey(rt);
    const mover = queue();
    const response = await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW, newId: () => "notspam-one" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, undo: "notspam-one", restored: "mail:one" });
    expect(mover.calls[0]?.argv).toEqual(MOVE_DESK.mailActions?.move);
    expect(mover.calls[0]?.stdin).toEqual({ action: "restore", account: "work", messageId: "one", from: "junk" });
    expect((await reviews(rt))[0]?.junkReview?.mails.map(m => m.subject)).toEqual(["Subject two"]);
    expect(trustedViews(db)).toMatchObject([{ sender: "one@example.org", notSpam: true }]);
    expect(suspicionOf(mail("one"), suspicionContext(db))).toEqual([]);
    expect(suspicionOf({ ...mail("later"), from: mail("one").from }, suspicionContext(db))).toEqual([]);
    expect(suspicionOf(mail("two"), suspicionContext(db)).length).toBeGreaterThan(0);
    expect(suspicionOf({ ...mail("one"), headers: { authResults: { dmarc: "fail" } } }, suspicionContext(db)).map(r => r.code)).toContain("dmarc");
    expect(suspicionOf(mail("one"), suspicionContext(db), true).map(r => r.code)).toContain("classifier");
    expect(db.query("SELECT origin, action FROM desk_mail_log WHERE origin = 'correction'").all()).toEqual([{ origin: "correction", action: "kept" }]);
    expect((await view(rt)).autonomy.done[0]).toMatchObject({ action: "mail.move", undo: "notspam-one" });
    const restarted = { ...rt, ledger: new HandledLedger() };
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, restarted, { run: mover.run, now: () => NOW })).status).toBe(409);
    expect(mover.calls).toHaveLength(1);
    const undone = await handleDeskMail(mailPost({ action: "undo", move: "notspam-one" }), db, restarted, { run: mover.run, now: () => NOW + 1 });
    expect(undone.status).toBe(200);
    expect(mover.calls[1]?.stdin).toEqual({ action: "move", account: "work", messageId: "one", target: "junk" });
    expect(trustedViews(db)).toEqual([]);
    expect(suspicionOf(mail("one"), suspicionContext(db)).map(r => r.code)).toContain("reply-to");
    expect(db.query("SELECT * FROM desk_mail_log WHERE origin = 'correction'").all()).toEqual([]);
    expect((await reviews(restarted))[0]?.junkReview?.mails).toHaveLength(2);
  });

  it("pins symmetric spam and notspam action names and inverse move requests", async () => {
    const rt = await runtime();
    const mover = queue();
    for (const action of ["spam", "notspam"]) expect((await handleDeskMail(mailPost({ action, key: "mail:inbox" }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(400);
    expect((await handleDeskMail(mailPost({ action: "mail.spam", key: "mail:inbox" }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(200);
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key: await junkKey(rt) }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(200);
    expect(mover.calls.map(c => c.stdin)).toEqual([{ action: "move", account: "work", messageId: "inbox", target: "junk" }, { action: "restore", account: "work", messageId: "one", from: "junk" }]);
  });

  it("withdraws sender trust when removed in Settings without undoing the mailbox move", async () => {
    const rt = await runtime();
    const mover = queue();
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key: await junkKey(rt) }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(200);
    expect(suspicionOf(mail("one"), suspicionContext(db))).toEqual([]);
    expect((await handleDeskMail(mailPost({ action: "not-phishing.remove", sender: "one@example.org" }), db, rt, { now: () => NOW + 1 })).status).toBe(200);
    expect(suspicionOf(mail("one"), suspicionContext(db)).map(r => r.code)).toContain("reply-to");
    expect(trustedViews(db)).toEqual([]);
    expect(mover.calls).toHaveLength(1);
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(1);
  });

  it("binds identical Message-IDs to their listed accounts and keeps independent trust corrections", async () => {
    const rt = await runtime([{ ...mail("shared"), account: "first" }, { ...mail("shared"), account: "second" }]);
    const keys = (await reviews(rt))[0]?.junkReview?.mails.map(m => m.key) ?? [];
    expect(keys).toHaveLength(2);
    const mover = queue();
    const moves: string[] = [];
    for (const key of keys) {
      const response = await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW });
      expect(response.status).toBe(200);
      moves.push((await response.json() as { undo: string }).undo);
    }
    expect(mover.calls.map(c => (c.stdin as { account: string }).account)).toEqual(["first", "second"]);
    expect(db.query("SELECT * FROM desk_mail_trusted WHERE code = 'notspam'").all()).toHaveLength(2);
    expect((await reviews(rt))).toEqual([]);
    expect((await handleDeskMail(mailPost({ action: "undo", move: moves[0] }), db, rt, { run: mover.run, now: () => NOW + 1 })).status).toBe(200);
    expect(trustedViews(db)[0]?.notSpam).toBe(true);
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(1);
  });

  it("allows another Not spam after the same mail is later moved to Junk again", async () => {
    const rt = await runtime([mail("one")]);
    const mover = queue();
    const act = (body: unknown) => handleDeskMail(mailPost(body), db, rt, { run: mover.run, now: () => NOW });
    expect((await act({ action: "mail.notspam", key: await junkKey(rt) })).status).toBe(200);
    rt.sourceCache = new SourceCache(() => Promise.resolve(JSON.stringify({ items: [mail("one")] })));
    await rt.sourceCache.read(MOVE_DESK.sources, NOW);
    expect((await act({ action: "mail.spam", key: "mail:one" })).status).toBe(200);
    expect(trustedViews(db)).toEqual([]);
    rt.sourceCache = new SourceCache(() => Promise.resolve(JSON.stringify({ junk: [mail("one")] })));
    await rt.sourceCache.read(MOVE_DESK.sources, NOW);
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(1);
    expect((await act({ action: "mail.notspam", key: await junkKey(rt) })).status).toBe(200);
    expect(trustedViews(db)[0]?.notSpam).toBe(true);
  });

  it("honors a fresh junk listing after restoration and replaces its correction only after another successful move", async () => {
    const rt = await runtime([mail("one")]);
    const mover = queue();
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key: await junkKey(rt) }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(200);
    rt.sourceCache = new SourceCache(() => Promise.resolve(JSON.stringify({ junk: [mail("one")] })));
    await rt.sourceCache.read(MOVE_DESK.sources, NOW + 1);
    const key = await junkKey(rt);
    const before = db.query("SELECT * FROM desk_mail_trusted").all();
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: queue([{ code: 3, stdout: "", stderr: "Fixture refusal" }]).run, now: () => NOW + 2 })).status).toBe(502);
    expect(db.query("SELECT * FROM desk_mail_trusted").all()).toEqual(before);
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(1);
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW + 3 })).status).toBe(200);
    expect(db.query("SELECT * FROM desk_mail_trusted").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM desk_mail_log WHERE origin = 'correction'").all()).toHaveLength(1);
    expect((await reviews(rt))).toEqual([]);
  });

  it("keeps a restored mail suppressed when a later source failure retains stale junk", async () => {
    const rt = await runtime();
    let failed = false;
    rt.sourceCache = new SourceCache(() => failed ? Promise.reject(new Error("Fixture source unavailable")) : Promise.resolve(JSON.stringify({ junk: [mail("one")] })));
    await rt.sourceCache.read(MOVE_DESK.sources, NOW);
    const key = await junkKey(rt);
    const mover = queue();
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(200);
    failed = true;
    await rt.sourceCache.read(MOVE_DESK.sources, NOW + 301_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rt.sourceCache.cached()[0]?.error).toBe("Fixture source unavailable");
    expect((await reviews(rt))).toEqual([]);
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW + 302_000 })).status).toBe(409);
    expect(mover.calls).toHaveLength(1);
  });

  it.each([{ code: 3, stdout: "", stderr: "Junk is unavailable" }, new CommandTimeout("timed out"), new Error("Fixture move failed")])("keeps refused or failed moves listed and records no trust: %p", async failure => {
    const rt = await runtime();
    const mover = queue([failure]);
    const response = await handleDeskMail(mailPost({ action: "mail.notspam", key: await junkKey(rt) }), db, rt, { run: mover.run, now: () => NOW });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await response.json() as { error: string }).error).toBeTruthy();
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(2);
    expect(trustedViews(db)).toEqual([]);
    expect(db.query("SELECT * FROM desk_mail_moves").all()).toEqual([]);
  });

  it("refuses an unlisted key, an inbox key and an unconfigured mover", async () => {
    const rt = await runtime();
    const mover = queue();
    for (const key of ["junk:forged", "mail:inbox"]) expect((await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run: mover.run, now: () => NOW })).status).toBe(409);
    expect((await handleDeskMail(mailPost({ action: "mail.notspam", key: await junkKey(rt) }), db, { ...rt, options: { ...MOVE_DESK, mailActions: undefined } }, { run: mover.run, now: () => NOW })).status).toBe(409);
    expect(mover.calls).toHaveLength(0);
    expect(trustedViews(db)).toEqual([]);
  });

  it("runs a concurrent restore once and preserves its correction when Undo is refused", async () => {
    const rt = await runtime();
    const key = await junkKey(rt);
    let finish: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined;
    const pending = new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { finish = resolve; });
    const run = () => pending;
    const first = handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run, now: () => NOW, newId: () => "pending" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await handleDeskMail(mailPost({ action: "mail.notspam", key }), db, rt, { run, now: () => NOW });
    expect(second.status).toBe(409);
    expect(trustedViews(db)).toEqual([]);
    if (!finish) throw new Error("Fixture mover did not start");
    finish({ code: 0, stdout: "", stderr: "" });
    expect((await first).status).toBe(200);
    const refused = await handleDeskMail(mailPost({ action: "undo", move: "pending" }), db, rt, { run: queue([{ code: 3, stdout: "", stderr: "INBOX unavailable" }]).run, now: () => NOW + 1 });
    expect(refused.status).toBe(502);
    expect(trustedViews(db)[0]?.notSpam).toBe(true);
    expect((await reviews(rt))[0]?.junkReview?.mails).toHaveLength(1);
    expect(db.query("SELECT undone_at FROM desk_mail_moves WHERE id = 'pending'").get()).toEqual({ undone_at: null });
  });

  it("renders sender, subject, date and a Not spam button for each mail", async () => {
    const rt = await runtime();
    const mails = (await reviews(rt))[0]?.junkReview?.mails ?? [];
    const html = renderToStaticMarkup(<JunkReview mails={mails} sending={false} onAction={() => undefined} />);
    expect(html).toContain("one@example.org");
    expect(html).toContain("Subject two");
    expect(html.toLowerCase()).toContain("datetime=");
    expect(html.match(/Not spam/g)).toHaveLength(2);
    expect(html).not.toContain("PRIVATE JUNK BODY");
  });
});
