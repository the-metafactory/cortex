import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskMeetingBrief } from "../api/desk-meeting-brief";
import { handleDeskMeetingPrevious } from "../api/desk-meeting-previous";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { saveBalanceState } from "../desk/balance-store";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { endLink, linkToMeeting, type LinkSubject } from "../desk/links";
import type { MeetingBrief, PreviousMeetingRelationship } from "../desk/meeting-brief-contract";
import { addNote } from "../desk/notes";
import { SourceCache } from "../desk/sources/command";
import { startServer } from "../server";
import { meetingBriefPreviousHttpProbe } from "./fixtures/meeting-brief-previous-http";
import { briefOptions, EVENT, NOW, PRINCIPAL, seed } from "./fixtures/meeting-brief";

const DAY = 86_400_000;
const OLD = "cal:cal:old";
const SAME_TITLE = "cal:cal:lookalike";
const FUTURE = "cal:cal:later";
const OTHER_CONNECTION = "cal:cal2:old";
const BRIEF_URL = "http://localhost/api/desk/meeting-brief";
const PREVIOUS_URL = "http://localhost/api/desk/meeting-brief/previous";

const iso = (at: number): string => new Date(at).toISOString();
const event = (id: string, title: string, at: number) => ({ id, title, start: iso(at), end: iso(at + 3_600_000) });

const calendar = (extra: ReturnType<typeof event>[] = []) => ({
  events: [event("standup", "Weekly sync", NOW + 3_600_000), event("old", "Weekly sync", NOW - 2 * DAY), event("lookalike", "Weekly sync", NOW - 3 * DAY), event("later", "Follow-up", NOW + 2 * DAY), ...extra],
  items: [],
});

let db: Database;
let dir: string;
let options: DeskOptions;
let seq = 0;

const writeCal = (data: unknown, file = "source.json"): void => writeFileSync(join(dir, file), JSON.stringify(data));

const runtime = async (): Promise<DeskRuntime> => {
  const cache = new SourceCache();
  await cache.read(options.sources, NOW);
  return { options, ledger: new HandledLedger(), sourceCache: cache };
};

const deps = { now: () => NOW };
const json = async (res: Response) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> });
const previous = async (rt: DeskRuntime, body: unknown) =>
  json(await handleDeskMeetingPrevious(new Request(PREVIOUS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), db, rt, deps));
const prepare = async (rt: DeskRuntime, key = EVENT): Promise<MeetingBrief> =>
  (await json(await handleDeskMeetingBrief(new Request(BRIEF_URL, { method: "POST", body: JSON.stringify({ event: key, refresh: true }) }), db, rt, deps))).json as unknown as MeetingBrief;
const read = async (rt: DeskRuntime, key = EVENT) =>
  json(await handleDeskMeetingBrief(new Request(`${BRIEF_URL}?event=${encodeURIComponent(key)}`), db, rt, deps));

const linkTo = (key: string, from: LinkSubject, at: number): void => {
  seq += 1;
  const result = linkToMeeting(db, from, { kind: "meeting", key, title: "Untrusted saved title", at, end: at + 3_600_000 }, {
    id: `link-${seq}`, requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, origin: "desk", now: NOW,
  });
  expect(result.ok).toBe(true);
};
const noteSubject = (text: string): LinkSubject => ({ kind: "note", key: `note:${addNote(db, "note", text, null, NOW).id}`, title: "Untrusted saved title", mail: null });
const taskSubject: LinkSubject = { kind: "task", key: "task:kickoff", title: "Untrusted saved title", mail: null };

beforeEach(() => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  dir = mkdtempSync(join(tmpdir(), "desk-brief-history-"));
  seq = 0;
  options = briefOptions(dir);
  options.sources = [...options.sources, { id: "cal2", command: ["cat", join(dir, "other.json")], everySeconds: 300, timeoutSeconds: 5 }];
  writeCal(calendar());
  writeCal({ events: [event("old", "Weekly sync", NOW - 2 * DAY)], items: [] }, "other.json");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/desk/meeting-brief/previous", () => {
  it("sets, replays and clears an explicit predecessor and returns the relationship", async () => {
    const rt = await runtime();
    const first = await previous(rt, { event: EVENT, previousEvent: OLD });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ ok: true, event: EVENT, previousEvent: OLD, relation: "explicit", message: "The previous meeting is set.", messagePhrase: { code: "brief.previous-set" } } satisfies PreviousMeetingRelationship);
    expect(await previous(rt, { event: EVENT, previousEvent: OLD })).toEqual(first);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_previous").get()).toEqual({ n: 1 });
    const swapped = await previous(rt, { event: EVENT, previousEvent: SAME_TITLE });
    expect(swapped.json).toMatchObject({ previousEvent: SAME_TITLE });
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_previous").get()).toEqual({ n: 1 });
    const cleared = await previous(rt, { event: EVENT, previousEvent: null });
    expect(cleared.json).toEqual({ ok: true, event: EVENT, previousEvent: null, relation: null, message: "No previous meeting is set.", messagePhrase: { code: "brief.previous-cleared" } });
    expect(await previous(rt, { event: EVENT, previousEvent: null })).toEqual(cleared);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_previous").get()).toEqual({ n: 0 });
  });

  it("answers 400 for bad input, 404 for a missing current meeting and 409 for self, future and unavailable targets", async () => {
    const rt = await runtime();
    for (const body of [null, {}, { event: EVENT }, { event: EVENT, previousEvent: 3 }, { event: "", previousEvent: OLD }, { event: EVENT, previousEvent: OLD, description: "Weekly sync" }, { event: EVENT, previousEvent: "" }]) {
      const res = await previous(rt, body);
      expect(res.status).toBe(400);
      expect(res.json.messagePhrase).toEqual({ code: "brief.previous-invalid" });
    }
    expect((await previous(rt, { event: "cal:cal:gone", previousEvent: OLD })).status).toBe(404);
    expect((await previous(rt, { event: "cal:cal:gone", previousEvent: null })).json.messagePhrase).toEqual({ code: "brief.meeting-gone" });
    expect(await previous(rt, { event: EVENT, previousEvent: EVENT })).toMatchObject({ status: 409, json: { messagePhrase: { code: "brief.previous-self" } } });
    expect(await previous(rt, { event: EVENT, previousEvent: FUTURE })).toMatchObject({ status: 409, json: { messagePhrase: { code: "brief.previous-not-earlier" } } });
    expect(await previous(rt, { event: OLD, previousEvent: EVENT })).toMatchObject({ status: 409, json: { messagePhrase: { code: "brief.previous-not-earlier" } } });
    expect(await previous(rt, { event: EVENT, previousEvent: "cal:cal:never-existed" })).toMatchObject({ status: 409, json: { messagePhrase: { code: "brief.previous-target-unavailable" } } });
    expect(await previous(rt, { event: EVENT, previousEvent: "cal:elsewhere:old" })).toMatchObject({ status: 409 });
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_previous").get()).toEqual({ n: 0 });
    expect((await handleDeskMeetingPrevious(new Request(PREVIOUS_URL), db, rt)).status).toBe(405);
    expect((await previous({ ...rt, options: { ...options, enabled: false } }, { event: EVENT, previousEvent: OLD })).status).toBe(409);
  });

  it("clears without needing the old predecessor to be readable, but not without the current meeting", async () => {
    const rt = await runtime();
    expect((await previous(rt, { event: EVENT, previousEvent: OLD })).status).toBe(200);
    writeCal({ events: calendar().events.filter((e) => e.id !== "old"), items: [] });
    expect((await previous(await runtime(), { event: EVENT, previousEvent: null })).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_meeting_previous").get()).toEqual({ n: 0 });
    expect((await previous(await runtime(), { event: EVENT, previousEvent: OLD })).status).toBe(409);
    writeCal({ events: [], items: [] });
    expect((await previous(await runtime(), { event: EVENT, previousEvent: null })).status).toBe(404);
  });
});

describe("the brief's previousMeeting", () => {
  it("is unidentified without a relation, and never guessed from a same-title meeting", async () => {
    linkTo(SAME_TITLE, noteSubject("Lookalike agenda"), NOW - 3 * DAY);
    linkTo(OLD, noteSubject("Old agenda"), NOW - 2 * DAY);
    const brief = await prepare(await runtime());
    expect(brief.previousMeeting).toEqual({ state: "unidentified", phrase: { code: "brief.previous-unidentified" }, message: "No previous meeting identified." });
    expect(JSON.stringify(brief)).not.toContain("agenda");
  });

  it("serves material linked to a past meeting that is outside today's list, separate from the current meeting's", async () => {
    linkTo(OLD, noteSubject("Agreed: ship on Friday"), NOW - 2 * DAY);
    linkTo(OLD, taskSubject, NOW - 2 * DAY);
    linkTo(SAME_TITLE, noteSubject("Unrelated lookalike"), NOW - 3 * DAY);
    linkTo(EVENT, noteSubject("Today's agenda"), NOW + 3_600_000);
    const rt = await runtime();
    await previous(rt, { event: EVENT, previousEvent: OLD });
    const brief = await prepare(rt);
    expect(brief.facts.map((f) => f.text)).toEqual(["Note: Today's agenda"]);
    expect(brief.previousMeeting).toMatchObject({ state: "identified", event: OLD, relation: "explicit", phrase: { code: "brief.previous-identified" }, gaps: [] });
    expect(brief.previousMeeting.facts?.map((f) => [f.text, f.sources[0]?.kind, f.sources[0]?.owner])).toEqual([
      ["Note: Agreed: ship on Friday", "note", "desk-notes"],
      ["Task: Kickoff prep", "task", "balance"],
    ]);
    expect(JSON.stringify(brief)).not.toContain("lookalike");
    expect(JSON.stringify(brief)).not.toContain("Untrusted saved title");
    expect((await read(rt)).json).toEqual(brief as unknown as Record<string, unknown>);
  });

  it("excludes unlinked material, and names a gap when the predecessor has none or the material is gone", async () => {
    const rt = await runtime();
    await previous(rt, { event: EVENT, previousEvent: OLD });
    const empty = await prepare(rt);
    expect(empty.previousMeeting.facts).toEqual([]);
    expect(empty.previousMeeting.gaps?.map((g) => [g.source.kind, g.source.item, g.reason])).toEqual([["meeting", OLD, "no-linked-material"]]);
    linkTo(OLD, noteSubject("Decision record"), NOW - 2 * DAY);
    linkTo(OLD, { kind: "note", key: "note:404", title: "x", mail: null }, NOW - 2 * DAY);
    const gone = await prepare(rt);
    expect(gone.previousMeeting.facts?.map((f) => f.text)).toEqual(["Note: Decision record"]);
    expect(gone.previousMeeting.gaps?.map((g) => [g.source.item, g.reason])).toEqual([["note:404", "read-failed"]]);
    const row = db.query<{ id: string }, []>("SELECT id FROM desk_links WHERE from_key LIKE 'note:%' ORDER BY created_at LIMIT 1").get();
    expect(endLink(db, row?.id ?? "", "undone", null, NOW)).toBe(true);
    const unlinked = await prepare(rt);
    expect(unlinked.previousMeeting.facts).toEqual([]);
  });

  it("changes the revision when a relationship is set, replaced or cleared, and refuses a stale GET", async () => {
    linkTo(OLD, noteSubject("Old"), NOW - 2 * DAY);
    const rt = await runtime();
    const base = await prepare(rt);
    await previous(rt, { event: EVENT, previousEvent: OLD });
    const stale = await read(rt);
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.json)).not.toContain("Old");
    const set = await prepare(rt);
    expect(set.revision).not.toBe(base.revision);
    await previous(rt, { event: EVENT, previousEvent: SAME_TITLE });
    expect((await read(rt)).status).toBe(409);
    const replaced = await prepare(rt);
    expect(replaced.revision).not.toBe(set.revision);
    await previous(rt, { event: EVENT, previousEvent: null });
    expect((await read(rt)).status).toBe(409);
    const cleared = await prepare(rt);
    expect(cleared.revision).toBe(base.revision);
    expect(cleared.previousMeeting.state).toBe("unidentified");
  });

  it("reports unavailable with a redacted reason when the predecessor is no longer readable, never a guessed meeting", async () => {
    linkTo(OLD, noteSubject("Private minutes"), NOW - 2 * DAY);
    const rt = await runtime();
    await previous(rt, { event: EVENT, previousEvent: OLD });
    const before = await prepare(rt);
    expect(JSON.stringify(before)).toContain("Private minutes");
    writeCal({ events: calendar().events.filter((e) => e.id !== "old"), items: [] });
    const rt2 = await runtime();
    const stale = await read(rt2);
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.json)).not.toContain("Private minutes");
    const after = await prepare(rt2);
    expect(after.previousMeeting).toEqual({ state: "unavailable", phrase: { code: "brief.previous-unavailable" }, message: "The previous meeting that was set can no longer be read.", event: OLD, relation: "explicit" });
    expect(JSON.stringify(after)).not.toContain("Private minutes");
    expect(JSON.stringify(after)).not.toContain(SAME_TITLE);
  });

  it("becomes unavailable when the stored predecessor no longer starts before the meeting", async () => {
    const rt = await runtime();
    await previous(rt, { event: EVENT, previousEvent: OLD });
    writeCal({ ...calendar(), events: calendar().events.map((e) => (e.id === "old" ? event("old", "Weekly sync", NOW + 5 * DAY) : e)) });
    expect((await prepare(await runtime())).previousMeeting.state).toBe("unavailable");
  });

  it("scopes the predecessor by source connection: another connection's meeting is its own, set only by the explicit write", async () => {
    linkTo(OLD, noteSubject("Calendar one minutes"), NOW - 2 * DAY);
    linkTo(OTHER_CONNECTION, noteSubject("Calendar two minutes"), NOW - 2 * DAY);
    const rt = await runtime();
    expect((await previous(rt, { event: EVENT, previousEvent: OTHER_CONNECTION })).status).toBe(200);
    const brief = await prepare(rt);
    expect(brief.previousMeeting.event).toBe(OTHER_CONNECTION);
    expect(brief.previousMeeting.facts?.map((f) => f.text)).toEqual(["Note: Calendar two minutes"]);
    expect(JSON.stringify(brief)).not.toContain("Calendar one minutes");
    options.sources = options.sources.filter((source) => source.id !== "cal2");
    const revoked = await prepare(await runtime());
    expect(revoked.previousMeeting).toMatchObject({ state: "unavailable", event: OTHER_CONNECTION });
    expect(JSON.stringify(revoked)).not.toContain("Calendar two minutes");
  });

  it("reads the predecessor's material under current policy: a removed area is an access-denied gap, not a fact", async () => {
    linkTo(OLD, taskSubject, NOW - 2 * DAY);
    const rt = await runtime();
    await previous(rt, { event: EVENT, previousEvent: OLD });
    expect((await prepare(rt)).previousMeeting.facts?.map((f) => f.text)).toEqual(["Task: Kickoff prep"]);
    const areas = options.areas;
    options.areas = [];
    expect((await read(rt)).status).toBe(409);
    const denied = await prepare(rt);
    expect(denied.previousMeeting.facts).toEqual([]);
    expect(denied.previousMeeting.gaps?.map((g) => [g.source.kind, g.reason])).toEqual([["task", "access-denied"]]);
    expect(JSON.stringify(denied)).not.toContain("Kickoff prep");
    options.areas = areas;
  });

  it("never infers a predecessor from a recurring flag, attendees or a mail invitation", async () => {
    const recurring = { ...event("weekly-b", "Weekly sync", NOW - 7 * DAY), recurring: true, attendees: [{ address: "ada@example.org" }], organizer: { address: "ada@example.org" } };
    writeCal(calendar([recurring]));
    const brief = await prepare(await runtime());
    expect(brief.previousMeeting.state).toBe("unidentified");
  });
});

describe("over the real Mission Control routes", () => {
  it("serves the write and the historical brief through the identity and Origin gates, and clears back to unidentified", async () => {
    linkTo(OLD, noteSubject("Historical decision"), NOW - 2 * DAY);
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: [PRINCIPAL], localPrincipal: PRINCIPAL } }, db, { desk: options });
    const base = `http://localhost:${ctx.server.port}`;
    const send = async (path: string, init: { method: string; body?: unknown; email?: string; origin?: string }) => {
      const res = await fetch(base + path, {
        method: init.method,
        headers: { origin: init.origin ?? base, "content-type": "application/json", "Cf-Access-Authenticated-User-Email": init.email ?? PRINCIPAL },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
    };
    try {
      const body = { event: EVENT, previousEvent: OLD };
      expect((await send("/api/desk/meeting-brief/previous", { method: "POST", body, email: "stranger@example.com" })).status).toBe(403);
      expect((await send("/api/desk/meeting-brief/previous", { method: "POST", body, origin: "https://untrusted.example.org" })).status).toBe(403);
      const set = await send("/api/desk/meeting-brief/previous", { method: "POST", body });
      expect(set).toMatchObject({ status: 200, cache: "no-store", json: { relation: "explicit", previousEvent: OLD } });
      const brief = await send("/api/desk/meeting-brief", { method: "POST", body: { event: EVENT } });
      expect((brief.json.previousMeeting as MeetingBrief["previousMeeting"]).facts?.map((f) => f.text)).toEqual(["Note: Historical decision"]);
      const cleared = await send("/api/desk/meeting-brief/previous", { method: "POST", body: { event: EVENT, previousEvent: null } });
      expect(cleared.json.relation).toBeNull();
      const after = await send("/api/desk/meeting-brief", { method: "POST", body: { event: EVENT } });
      expect(after.json.previousMeeting).toMatchObject({ state: "unidentified", message: "No previous meeting identified." });
    } finally {
      ctx.stop(true);
    }
  });

  it("matches the pinned previous-meeting examples through the real authenticated routes", async () => {
    expect(await meetingBriefPreviousHttpProbe()).toMatchObject({ isolated: true, modelConfigured: false });
  });
});
