import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as classify from "../desk/classify";
import { handleDeskMeetingBrief } from "../api/desk-meeting-brief";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { saveBalanceState } from "../desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { linkToMeeting, mailSubject, type LinkSubject } from "../desk/links";
import { BRIEF_GAP_REASONS, BRIEF_PREVIOUS_MEETING_STATES, BRIEF_SYNTHESIS_STATES, type MeetingBrief } from "../desk/meeting-brief-contract";
import { type BriefRead } from "../desk/meeting-brief";
import { addNote } from "../desk/notes";
import { startServer } from "../server";

import { NOW, EVENT, PRINCIPAL, SECRET_TITLE, seed, fixture, briefOptions, briefPost, briefRuntime, type Fixture } from "./fixtures/meeting-brief";
import { meetingBriefHttpProbe } from "./fixtures/meeting-brief-http";

const BASE_URL = "http://localhost/api/desk/meeting-brief";

const subject = (kind: LinkSubject["kind"], key: string, mail: LinkSubject["mail"] = null): LinkSubject => ({ kind, key, title: SECRET_TITLE, mail });
const MAIL_SNAPSHOT = { sourceId: "cal", sender: "ada@example.org", senderName: "Ada Lovelace", receivedAt: new Date(NOW).toISOString(), url: null, account: "work" };

let db: Database;
let dir: string;
let seq = 0;
let model: ReturnType<typeof spyOn<typeof classify, "modelJson">>;
let options: DeskOptions;

const link = (from: LinkSubject): void => {
  const result = linkToMeeting(db, from, { kind: "meeting", key: EVENT, title: SECRET_TITLE, at: NOW, end: NOW + 1 }, { id: `link-${++seq}`, requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, origin: "desk", now: NOW });
  expect(result.ok).toBe(true);
};

const writeFixture = (data: Fixture): void => writeFileSync(join(dir, "source.json"), JSON.stringify(data));

const runtime = async (data: Fixture = fixture()): Promise<DeskRuntime> => {
  writeFixture(data);
  return briefRuntime(options, data);
};

const post = (body: unknown): Request => briefPost(BASE_URL, body);
const get = (event = EVENT): Request => new Request(`${BASE_URL}?event=${encodeURIComponent(event)}`);
const call = async (req: Request, rt: DeskRuntime, readers?: Parameters<typeof handleDeskMeetingBrief>[3]) => {
  const res = await handleDeskMeetingBrief(req, db, rt, { now: () => NOW, ...readers });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};
const briefOf = (json: Record<string, unknown>): MeetingBrief => json as unknown as MeetingBrief;

beforeEach(() => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  dir = mkdtempSync(join(tmpdir(), "desk-brief-"));
  seq = 0;
  model = spyOn(classify, "modelJson");
  options = briefOptions(dir);
});
afterEach(() => {
  model.mockRestore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST and GET /api/desk/meeting-brief", () => {
  it("prepares attributed facts from the sources themselves, with the previous meeting and synthesis slots, and calls no model", async () => {
    link(subject("mail", "mail:m1", MAIL_SNAPSHOT));
    link(subject("task", "task:kickoff"));
    link(subject("note", `note:${addNote(db, "note", "Bring the budget sheet", null, NOW).id}`));
    const rt = await runtime();
    const prepared = await call(post({ event: EVENT }), rt);
    expect(prepared.status).toBe(200);
    const brief = briefOf(prepared.json);
    expect(brief).toMatchObject({ event: EVENT, preparedAt: new Date(NOW).toISOString(), gaps: [] });
    expect(brief.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.facts.map((f) => f.sources[0])).toEqual([
      { kind: "mail", adapter: null, owner: "desk-source-command", connection: "cal", item: "mail:m1", excerpt: "The venue costs 900.", link: "https://mail.example.test/m1" },
      { kind: "task", adapter: null, owner: "balance", item: "task:kickoff", excerpt: "Kickoff prep" },
      { kind: "note", adapter: null, owner: "desk-notes", item: "note:1", excerpt: "Bring the budget sheet" },
    ]);
    expect(brief.facts.map((f) => f.text)).toEqual(["Mail from Ada Lovelace: Venue quote", "Task: Kickoff prep", "Note: Bring the budget sheet"]);
    expect(new Set(brief.facts.map((f) => f.id)).size).toBe(3);
    expect(JSON.stringify(brief)).not.toContain(SECRET_TITLE);
    expect(brief.previousMeeting).toEqual({ state: "unidentified", phrase: { code: "brief.previous-unidentified" }, message: "No previous meeting identified." });
    expect(brief.synthesis).toMatchObject({ state: "unavailable", reason: "not-configured", phrase: { code: "brief.synthesis-not-configured" } });
    expect(BRIEF_SYNTHESIS_STATES).toEqual(["preparing", "ready", "unavailable", "failed"]);
    expect(BRIEF_PREVIOUS_MEETING_STATES).toEqual(["identified", "unidentified", "unavailable"]);
    expect(model).not.toHaveBeenCalled();

    const read = await call(get(), rt);
    expect(read).toEqual({ status: 200, json: prepared.json });
  });

  it("does not duplicate evidence on repeated preparation, and refresh rereads without changing the evidence", async () => {
    link(subject("note", `note:${addNote(db, "note", "Agenda", null, NOW).id}`));
    const rt = await runtime();
    const first = briefOf((await call(post({ event: EVENT }), rt)).json);
    const again = briefOf((await handleDeskMeetingBrief(post({ event: EVENT }), db, rt, { now: () => NOW + 60_000 }).then((r) => r.json())) as Record<string, unknown>);
    expect(again).toEqual(first);
    const refreshed = briefOf((await handleDeskMeetingBrief(post({ event: EVENT, refresh: true }), db, rt, { now: () => NOW + 60_000 }).then((r) => r.json())) as Record<string, unknown>);
    expect(refreshed.facts).toEqual(first.facts);
    expect(refreshed.revision).toBe(first.revision);
    expect(refreshed.preparedAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_briefs").get()).toEqual({ n: 1 });
  });

  it("answers 400 for malformed requests, 404 for unknown meetings and unprepared briefs, and 405 for other methods", async () => {
    const rt = await runtime();
    for (const body of [{}, { event: "" }, { event: 3 }, { event: EVENT, refresh: "yes" }, { event: EVENT, description: "Weekly sync" }, null]) {
      expect((await call(post(body), rt)).status).toBe(400);
    }
    expect((await call(new Request(BASE_URL), rt)).status).toBe(400);
    expect((await call(post({ event: "cal:cal:gone" }), rt)).status).toBe(404);
    expect((await call(get("cal:cal:gone"), rt)).status).toBe(404);
    expect((await call(get(), rt)).status).toBe(404);
    expect((await handleDeskMeetingBrief(new Request(BASE_URL, { method: "DELETE" }), db, rt)).status).toBe(405);
    expect((await call(post({ event: EVENT }), { ...rt, options: { ...options, enabled: false } })).status).toBe(409);
  });

  it("names a gap for every unreadable or empty source and never returns an empty successful brief for a removed source", async () => {
    link(subject("mail", "mail:m1", MAIL_SNAPSHOT));
    link(subject("note", "note:99"));
    link(subject("thread", "thread:planning"));
    link(subject("task", "task:gone"));
    const rt = await runtime(fixture({ items: [{ kind: "mail", id: "other", from: { address: "bo@example.org" }, subject: "Other", receivedAt: new Date(NOW).toISOString(), unread: true, account: "work" }] }));
    const brief = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(brief.facts).toEqual([]);
    expect(brief.gaps.map((g) => [g.source.kind, g.source.item, g.reason])).toEqual([
      ["mail", "mail:m1", "read-failed"],
      ["note", "note:99", "read-failed"],
      ["thread", "thread:planning", "no-adapter"],
      ["task", "task:gone", "read-failed"],
    ]);
    expect(brief.gaps.find((g) => g.reason === "no-adapter")).toMatchObject({ source: { adapter: null, owner: "studio" }, phrase: { code: "brief.gap-no-adapter", params: { kind: "thread" } } });
    for (const gap of brief.gaps) expect(BRIEF_GAP_REASONS).toContain(gap.reason);
    expect(JSON.stringify(brief)).not.toContain(SECRET_TITLE);
  });

  it("reports no linked material when the meeting has no links, and a mail source nothing is set up for", async () => {
    const rt = await runtime();
    const empty = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(empty.facts).toEqual([]);
    expect(empty.gaps).toEqual([expect.objectContaining({ reason: "no-linked-material", source: { kind: "meeting", adapter: null, owner: "desk-source-command", connection: "cal", item: EVENT } })]);
    link(subject("mail", "mail:m9", { ...MAIL_SNAPSHOT, account: "elsewhere" }));
    const other = briefOf((await call(post({ event: EVENT, refresh: true }), rt)).json);
    expect(other.gaps.map((g) => [g.source.item, g.reason])).toEqual([["mail:m9", "read-failed"]]);
  });

  it("keeps equal item keys in different accounts apart, by the account the link recorded", async () => {
    link(subject("mail", "mail:dup", { ...MAIL_SNAPSHOT, account: "work" }));
    const mail = (account: string, paragraph: string) => ({ kind: "mail", id: "dup", from: { address: "ada@example.org" }, subject: "Same id", firstParagraph: paragraph, receivedAt: new Date(NOW).toISOString(), unread: false, account });
    const rt = await runtime(fixture({ items: [mail("work", "from work"), mail("home", "from home")] }));
    const brief = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(brief.facts.map((f) => f.sources[0]?.excerpt)).toEqual(["from work"]);
  });

  it("keeps the linked Mail connection when another connection has the same account and item key", async () => {
    const data = fixture();
    const rt = await runtime(data);
    const listed = rt.sourceCache?.cached()[0]?.mail[0];
    if (!listed) throw new Error("Fixture mail missing");
    const linked = mailSubject({ ...listed, sourceId: "cal" });
    expect(linked.mail?.sourceId).toBe("cal");
    link(linked);
    rt.options = { ...options, sources: [...options.sources, { ...options.sources[0]!, id: "other" }] };
    const bound = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(bound.facts).toHaveLength(1);
    expect(bound.facts[0]?.sources[0]?.connection).toBe("cal");
    rt.options = { ...options, sources: [{ ...options.sources[0]!, id: "other" }] };
    const otherMeeting = "cal:other:standup";
    db.query("UPDATE desk_links SET to_key = ? WHERE id = ?").run(otherMeeting, "link-1");
    const removed = briefOf((await call(post({ event: otherMeeting }), rt)).json);
    expect(removed.facts).toEqual([]);
    expect(removed.gaps).toEqual([expect.objectContaining({ reason: "no-adapter", source: expect.objectContaining({ connection: "cal", item: "mail:m1" }) })]);
  });

  it("distinguishes a denied read and a successful empty read, and redacts both", async () => {
    link(subject("note", "note:1"));
    link(subject("task", "task:kickoff"));
    link(subject("thread", "thread:planning"));
    const rt = await runtime();
    const readers = {
      readers: {
        note: (): BriefRead => ({ ok: false, reason: "access-denied", identity: { kind: "note", adapter: "vault", connection: "private-vault", item: "note:1" } }),
        task: (): BriefRead => ({ ok: true, identity: { kind: "task", adapter: null, owner: "balance", item: "task:kickoff" }, text: "Task", excerpt: "  ", fingerprint: "empty" }),
        thread: (): BriefRead => { throw new Error("secret detail /fixture-private/evidence-canary.md"); },
      },
    };
    const res = await call(post({ event: EVENT }), rt, readers);
    const brief = briefOf(res.json);
    expect(brief.facts).toEqual([]);
    expect(brief.gaps.map((g) => [g.source.kind, g.reason])).toEqual([["note", "access-denied"], ["task", "no-linked-material"], ["thread", "read-failed"]]);
    expect(brief.gaps[0]?.source).toEqual({ kind: "note", adapter: "vault", connection: "private-vault", item: "note:1" });
    expect(JSON.stringify(brief)).not.toContain("secret detail");
    expect(JSON.stringify(brief)).not.toContain("/fixture-private");
  });

  it("changes the revision when linked content changes, and answers GET with refresh-required and no payload until it is refreshed", async () => {
    const note = addNote(db, "note", "Agenda v1", null, NOW);
    link(subject("note", `note:${note.id}`));
    const rt = await runtime();
    const first = briefOf((await call(post({ event: EVENT }), rt)).json);
    db.query("UPDATE desk_notes SET text = ? WHERE id = ?").run("Agenda v2 with private figures", note.id);

    const stale = await call(get(), rt);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, code: "refresh-required" });
    expect(JSON.stringify(stale.json)).not.toContain("Agenda");
    expect(stale.json).not.toHaveProperty("facts");

    const refreshed = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(refreshed.revision).not.toBe(first.revision);
    expect(refreshed.facts[0]?.sources[0]?.excerpt).toBe("Agenda v2 with private figures");
    expect((await call(get(), rt)).status).toBe(200);

    db.query("UPDATE desk_notes SET done_at = ? WHERE id = ?").run(NOW, note.id);
    expect((await call(get(), rt)).status).toBe(409);
    const rebuilt = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(rebuilt.facts).toEqual([]);
    expect(rebuilt.gaps.map((g) => g.reason)).toEqual(["read-failed"]);
  });

  it("invalidates task URL-only changes and reads actual Studio content", async () => {
    const state = seed();
    const task = state.outline.children[0]?.children[0];
    if (!task) throw new Error("Fixture task missing");
    task.external = { source: "jira", url: "https://tasks.example.test/old", syncedAt: new Date(NOW).toISOString() };
    saveBalanceState(db, state);
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    const first = briefOf((await call(post({ event: EVENT }), rt)).json);
    task.external.url = "https://tasks.example.test/new";
    saveBalanceState(db, state);
    expect((await call(get(), rt)).status).toBe(409);
    const next = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(next.revision).not.toBe(first.revision);
    expect(next.facts[0]?.sources[0]?.link).toBe(task.external.url);

    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "threads"));
    writeFileSync(join(dir, "threads/planning.md"), "---\ntype: question\nareas: [work]\nstate: active\nopened: 2026-11-01\n---\n## Question\nWhat is next?\n## Where I stand\nThe budget is approved.\n");
    rt.options = { ...options, studio: { dir, maxActive: 3 } };
    link(subject("thread", "thread:planning"));
    const studio = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(studio.facts.find(fact => fact.sources[0]?.kind === "thread")).toMatchObject({ text: "Studio thread: What is next?", sources: [{ kind: "thread", adapter: null, owner: "studio", item: "thread:planning", excerpt: "The budget is approved." }] });
    expect(model).not.toHaveBeenCalled();
  });

  it("refuses retained cache entries after their connection is removed, and fails closed on legacy unbound Mail identity", async () => {
    link(subject("mail", "mail:m1", { ...MAIL_SNAPSHOT, sourceId: undefined }));
    const rt = await runtime();
    const unbound = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(unbound.facts).toEqual([]);
    expect(unbound.gaps[0]).toMatchObject({ reason: "read-failed", phrase: { code: "brief.gap-relink-required" }, source: { kind: "mail", adapter: null, owner: "desk-source-command" } });
    const sources = [...options.sources, { ...options.sources[0]!, id: "other" }];
    rt.options = { ...options, sources };
    const ambiguous = briefOf((await call(post({ event: EVENT }), rt)).json);
    expect(ambiguous.facts).toEqual([]);
    expect(ambiguous.gaps[0]?.reason).toBe("read-failed");
    rt.options = { ...options, sources: [] };
    const removed = await call(get(), rt);
    expect(removed.status).toBe(404);
    expect(JSON.stringify(removed.json)).not.toContain("venue");
  });

  it("stops serving a prepared brief once the meeting is gone from the source", async () => {
    link(subject("note", `note:${addNote(db, "note", "Agenda", null, NOW).id}`));
    await call(post({ event: EVENT }), await runtime());
    const gone = await runtime(fixture({ events: [] }));
    expect((await call(get(), gone)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_briefs").get()).toEqual({ n: 0 });
  });
});

describe("the route behind the Host, Origin and identity gates", () => {
  it("revalidates live source contents without warming the Desk, and never returns a stale private snapshot", async () => {
    await meetingBriefHttpProbe();
    expect(model).not.toHaveBeenCalled();
  });

  it("refuses GET and POST for a stranger and a foreign origin, and serves the principal", async () => {
    link(subject("note", `note:${addNote(db, "note", "Agenda", null, NOW).id}`));
    writeFixture(fixture());
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: [PRINCIPAL], localPrincipal: PRINCIPAL } }, db, { desk: options });
    const base = `http://localhost:${ctx.server.port}`;
    const send = (method: string, email: string | null, origin: string | null = base) => fetch(`${base}/api/desk/meeting-brief${method === "GET" ? `?event=${EVENT}` : ""}`, {
      method,
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(email ? { "Cf-Access-Authenticated-User-Email": email } : {}) },
      ...(method === "POST" ? { body: JSON.stringify({ event: EVENT }) } : {}),
    });
    try {
      await fetch(`${base}/api/desk`, { headers: { "Cf-Access-Authenticated-User-Email": PRINCIPAL } });
      for (const method of ["GET", "POST"]) {
        expect((await send(method, "stranger@example.com")).status).toBe(403);
        expect((await send(method, PRINCIPAL, "https://untrusted.example.org")).status).toBe(403);
      }
      const prepared = await send("POST", PRINCIPAL);
      expect(prepared.status).toBe(200);
      const brief = await prepared.json() as MeetingBrief;
      expect(brief.facts).toHaveLength(1);
      expect(await (await send("GET", PRINCIPAL)).json()).toEqual(brief);
    } finally {
      ctx.stop(true);
    }
  });
});
