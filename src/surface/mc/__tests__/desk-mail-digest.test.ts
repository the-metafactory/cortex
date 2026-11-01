import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { saveClassification, type EndpointAccess, type MailClassification } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { buildDigests, DigestFlagger, digestTopics, digestView, flagPlan, readFlags, type DigestInput, type DigestTopic, type FlagRequest } from "../desk/mail-digest";
import { queryMailLog } from "../desk/mail-log";
import type { SweepMember } from "../desk/mail-sweep";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { addVip } from "../desk/vips";
import { initDatabase } from "../db/init";
import { composeWith, MOVE_DESK, queue } from "./desk-mail-fixtures";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(2, 9);
const letter = (id: string, address: string, received: number, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: address.split("@")[0] ?? address, address }, subject: `Issue ${id}`, receivedAt: new Date(received).toISOString(), unread: true, account: "personal",
  headers: { listId: `<${address.split("@")[1] ?? "x"}>` }, url: `message://%3C${id}%3E`, ...over,
});
const member = (m: SourceMail, sourceId = "personal-mail"): SweepMember => ({ ...m, sourceId, area: null });
const bulk = (over: Partial<MailClassification> = {}): MailClassification => ({ category: "bulk", reason: "A newsletter.", predictedAction: "archive", ...over });
const input = (mails: SweepMember[], classified: Record<string, MailClassification>, over: Partial<DigestInput> = {}): DigestInput => ({
  now: NOW, at: "07:00", mail: mails, classified: new Map(Object.entries(classified)), ruleHeld: new Set(), kept: new Set(), suspicion: { vips: new Set(), vipNames: new Map(), ownDomains: [] }, ...over,
});
const TOPICS: DigestTopic[] = [{ kind: "thread", name: "Desk routing", local: false }, { kind: "goal", name: "Publish one post a week", local: false }];

describe("digest builder", () => {
  it("groups newsletters by the day they arrived and shows a day only from its digest time", () => {
    const mails = [letter("a", "news@weekly.example", at(1, 8)), letter("b", "brief@sec.example", at(1, 22)), letter("c", "news@weekly.example", at(2, 6)), letter("d", "brief@sec.example", at(2, 8))].map((m) => member(m));
    const early = buildDigests(input(mails, { a: bulk(), b: bulk(), c: bulk(), d: bulk() }, { now: at(2, 6, 59) }));
    expect(early.groups.map((g) => [g.id, g.members.map((m) => m.id)])).toEqual([["digest:2026-11-01", ["a", "b"]]]);
    expect([...early.held].sort()).toEqual(["a", "b", "c", "d"]);
    const later = buildDigests(input(mails, { a: bulk(), b: bulk(), c: bulk(), d: bulk() }));
    expect(later.groups.map((g) => [g.id, g.kind, g.target, g.members.map((m) => m.id)])).toEqual([["digest:2026-11-02", "digest", "archive", ["c", "d"]], ["digest:2026-11-01", "digest", "archive", ["a", "b"]]]);
  });

  it("holds bulk mail with a List-Id and mail a digest rule keeps, never a VIP, suspicious, kept or DMARC mail", () => {
    const mails = [
      letter("list", "news@weekly.example", at(2, 6)),
      letter("nolist", "promo@shop.example", at(2, 6), { headers: {} }),
      letter("rule", "updates@vendor.example", at(2, 6), { headers: {} }),
      letter("vip", "boss@corp.example", at(2, 6)),
      letter("phish", "news@weekly.example", at(2, 6)),
      letter("kept", "news@weekly.example", at(2, 6)),
      letter("dmarc", "noreply@dmarc.example", at(2, 6), { subject: "Report Domain: invisible.example Submitter: x" }),
      letter("fyi", "team@corp.example", at(2, 6)),
    ].map((m) => member(m));
    const out = buildDigests(input(mails, { list: bulk(), nolist: bulk(), rule: { category: "fyi", reason: "x" }, vip: bulk(), phish: bulk({ suspicious: true }), kept: bulk(), dmarc: bulk(), fyi: { category: "fyi", reason: "x" } }, {
      ruleHeld: new Set(["rule", "dmarc"]), kept: new Set(["kept"]), suspicion: { vips: new Set(["boss@corp.example"]), vipNames: new Map(), ownDomains: [] },
    }));
    expect([...out.held].sort()).toEqual(["list", "rule"]);
  });
});

describe("flags", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("keeps a flag only when it names a listed item and topic and gives a reason, at most two", () => {
    const flags = readFlags({ flags: [
      { item: 1, topic: "desk routing", reason: "It covers the adapter contract." },
      { item: 2, topic: "Something else", reason: "Interesting." },
      { item: 3, topic: "Desk routing", reason: "  " },
      { item: 9, topic: "Desk routing", reason: "Out of range." },
      { item: 1, topic: "Publish one post a week", reason: "Same item twice." },
      { item: 3, topic: "Publish one post a week", reason: "A writing prompt for this week." },
      { item: 2, topic: "Desk routing", reason: "A third flag." },
    ] }, members, TOPICS);
    expect(flags).toEqual([
      { id: "a", kind: "thread", topic: "Desk routing", reason: "It covers the adapter contract." },
      { id: "c", kind: "goal", topic: "Publish one post a week", reason: "A writing prompt for this week." },
    ]);
  });

  it("flags nothing for an empty or malformed answer", () => {
    expect(readFlags({ flags: [] }, members, TOPICS)).toEqual([]);
    expect(readFlags("no", members, TOPICS)).toEqual([]);
  });

  it("shows the reason with the topic it names, and the no-flag line when nothing fits", () => {
    const group = buildDigests(input([member(letter("a", "news@weekly.example", at(2, 6))), member(letter("b", "x@y.example", at(2, 6)))], { a: bulk(), b: bulk() })).groups[0];
    if (!group) throw new Error("no digest");
    const flagged = digestView(group, [{ id: "a", kind: "thread", topic: "Desk routing", reason: "It covers the adapter contract." }, { id: "gone", kind: "goal", topic: "x", reason: "y" }]);
    expect(flagged.flags).toEqual([{ key: "mail:a", line: "It covers the adapter contract. (your Studio thread “Desk routing”)" }]);
    expect(flagged.mails.map((m) => [m.key, m.url])).toEqual([["mail:a", "message://%3Ca%3E"], ["mail:b", "message://%3Cb%3E"]]);
    expect(digestView(group, []).why).toBe("Nothing in them touches your Studio threads, focus projects or goals.");
    expect(digestView(group, undefined).why).toBe("Ivy has not read them yet.");
    expect(digestView(group, null).why).toBe("No model is set up to flag items worth reading.");
  });

  const MAIN: EndpointAccess = { baseUrl: "https://models.example/v1", model: "cloud", timeoutSeconds: 30 };
  const LOCAL: EndpointAccess = { baseUrl: "http://127.0.0.1:11434/v1", model: "local", timeoutSeconds: 30 };

  it("never sends a local-policy area's mail or thread to a model that is not its local one", () => {
    const g = buildDigests(input([member(letter("w", "list@work.example", at(2, 6)), "work-mail"), member(letter("p", "news@weekly.example", at(2, 6)))], { w: bulk(), p: bulk() })).groups[0];
    if (!g) throw new Error("no digest");
    const topics: DigestTopic[] = [...TOPICS, { kind: "thread", name: "Work secret", local: true }];
    const cloud = flagPlan({ ...MAIN }, g, topics, new Set(["work-mail"]));
    expect(cloud?.access.model).toBe("cloud");
    expect(cloud?.members.map((m) => m.id)).toEqual(["p"]);
    expect(cloud?.topics.map((t) => t.name)).toEqual(["Desk routing", "Publish one post a week"]);
    const local = flagPlan({ ...MAIN, local: LOCAL }, g, topics, new Set(["work-mail"]));
    expect([local?.access.model, local?.members.map((m) => m.id), local?.topics.length]).toEqual(["local", ["p", "w"], 3]);
  });

  it("asks the model once per set of items and topics and stores what it flagged", async () => {
    const g = buildDigests(input([member(letter("a", "news@weekly.example", at(2, 6)))], { a: bulk() })).groups[0];
    if (!g) throw new Error("no digest");
    const asked: FlagRequest[] = [];
    const flagger = new DigestFlagger(MAIN, async (_access, request) => {
      asked.push(request);
      return { flags: [{ item: 1, topic: "Desk routing", reason: "It covers the adapter contract." }] };
    }, () => {});
    await flagger.kick(db, [g], TOPICS, new Set(), NOW);
    await flagger.kick(db, [g], TOPICS, new Set(), NOW);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.items).toEqual([{ item: 1, from: "news", subject: "Issue a", text: "" }]);
    const row = db.query<{ flags: string }, []>("SELECT flags FROM desk_mail_digest_flags").get();
    expect(JSON.parse(row?.flags ?? "[]")).toEqual([{ id: "a", kind: "thread", topic: "Desk routing", reason: "It covers the adapter contract." }]);
  });

  it("collects this month's focus projects, active threads and goals as topics", () => {
    const outline = { title: "root", children: [{ title: "Desk", focusMonth: "2026-11", children: [] }, { title: "Old", focusMonth: "2026-10", children: [] }] };
    const topics = digestTopics({ active: [{ question: "How should Desk routing work?", policy: "local" }] }, () => ({ outline }), [{ text: "G5 weekly post" }], NOW);
    expect(topics).toEqual([
      { kind: "thread", name: "How should Desk routing work?", local: true },
      { kind: "focus", name: "Desk", local: false },
      { kind: "goal", name: "G5 weekly post", local: false },
    ]);
    expect(digestTopics(null, () => { throw new Error("unreadable"); }, [], NOW)).toEqual([]);
  });
});

describe("the digest on the Desk", () => {
  const DESK: DeskOptions = { ...MOVE_DESK, mailDigest: { at: "07:00" } };
  const LETTERS = ["n1", "n2", "n3"].map((id, i) => letter(id, `news${i}@list${i}.example`, at(2, 6, i)));
  const OTHER = letter("o1", "pal@friends.example", at(2, 6), { headers: {} });
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const moved = (id: string): WriterResult => ({ code: 0, stdout: JSON.stringify({ id, folder: "Archive", message: "Moved to Archive." }), stderr: "" });
  const restored = (id: string): WriterResult => ({ code: 0, stdout: JSON.stringify({ id, folder: "INBOX", message: "Moved back." }), stderr: "" });

  let ids = 0;
  beforeEach(() => { ids = 0; });

  function desk() {
    for (const m of LETTERS) saveClassification(db, m.id, bulk(), "test", NOW);
    saveClassification(db, OTHER.id, { category: "reply", reason: "A question." }, "test", NOW);
    addVip(db, "boss@corp.example", null, NOW);
    const rt: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [...LETTERS, OTHER] })) };
    return { rt, view: () => composeWith(db, DESK, rt, NOW) };
  }

  it("shows three newsletters as one digest card and not as single cards, bundles or sweeps", async () => {
    const v = await desk().view();
    expect(v.mailDigests?.map((d) => [d.id, d.mails.map((m) => m.key)])).toEqual([["digest:2026-11-02", ["mail:n1", "mail:n2", "mail:n3"]]]);
    expect(v.items.filter((i) => i.kind === "mail").map((i) => i.key)).toEqual(["mail:o1"]);
    expect(v.mailSweeps).toEqual([]);
  });

  it("leaves the stream as it was when no digest is configured", async () => {
    const { rt } = desk();
    const v = await composeWith(db, MOVE_DESK, rt, NOW);
    expect(v.mailDigests).toBeUndefined();
    expect(v.items.filter((i) => i.kind === "mail").map((i) => i.key).sort()).toEqual(["mail:n1", "mail:n2", "mail:n3", "mail:o1"]);
  });

  it("archives exactly the listed mails in one confirmed step, refuses mail outside the digest, and undoes all of them", async () => {
    const { rt, view } = desk();
    const id = (await view()).mailDigests?.[0]?.id ?? "";
    const q = queue([moved("n1"), moved("n2"), moved("n3"), restored("n1"), restored("n2"), restored("n3")]);
    const res = await handleDeskMail(post({ action: "sweep", sweep: id, keys: ["mail:n1", "mail:n2", "mail:n3", "mail:o1"] }), db, rt, { run: q.run, now: () => NOW, newId: () => `dg-${++ids}` });
    expect(await res.json()).toMatchObject({ ok: true, moved: 3, skipped: 1 });
    expect(q.calls.map((c) => c.stdin)).toEqual(["n1", "n2", "n3"].map((messageId) => expect.objectContaining({ action: "move", messageId, target: "archive" })));
    const after = await view();
    expect(after.mailDigests).toEqual([]);
    const line = after.autonomy.done.find((d) => d.action === "mail.sweep");
    expect(line?.title).toBe("Archived 3 mails: 3 newsletters from Monday 2 November");
    const undo = await handleDeskMail(post({ action: "sweep.undo", sweep: "dg-1" }), db, rt, { run: q.run, now: () => NOW });
    expect(await undo.json()).toMatchObject({ ok: true, message: "Moved 3 mails back to INBOX." });
  });

  it("keeps one mail: it leaves the digest, returns as its own card and is logged as kept", async () => {
    const { rt, view } = desk();
    await view();
    const res = await handleDeskMail(post({ action: "digest.keep", key: "mail:n2" }), db, rt, { now: () => NOW });
    expect(res.status).toBe(200);
    const v = await view();
    expect(v.mailDigests?.[0]?.mails.map((m) => m.key)).toEqual(["mail:n1", "mail:n3"]);
    expect(v.items.filter((i) => i.kind === "mail").map((i) => i.key).sort()).toEqual(["mail:n2", "mail:o1"]);
    expect(queryMailLog(db, {}).map((e) => [e.messageId, e.action, e.where])).toEqual([["n2", "kept", "desk"]]);
  });
});
