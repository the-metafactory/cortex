import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskAsk, handleDeskCreate, handleDeskNoteDone } from "../api/desk-ask";
import { findWhen, parseByRules, parseWithCommand, toProposal, type ParserRequest } from "../desk/ask";
import { HandledLedger } from "../desk/actions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { RecentCalendarWrites, spawnWithStdin, writableKinds, WriterTimeout, type WriterRunner } from "../desk/create";
import { SourceCache } from "../desk/sources/command";
import { listOpenNotes } from "../desk/notes";

const NOW = new Date("2026-10-30T12:16:00").getTime();
const local = (s: string): number => new Date(s).getTime();
const MAP = { ref: "example/app#10", label: "App" };
const ctx = { now: NOW, maps: [MAP] };

describe("the rules parser", () => {
  it("makes a reminder with its time", () => {
    expect(parseByRules("remind me to call Ada tomorrow at 9", ctx)).toEqual({ kind: "reminder", fields: { text: "Call Ada", due: new Date(local("2026-10-31T09:00:00")).toISOString() } });
  });

  it("makes a note, a task on the first map and a goal draft", () => {
    expect(parseByRules("note: the boiler code is 4711", ctx)).toEqual({ kind: "note", fields: { text: "The boiler code is 4711" } });
    expect(parseByRules("ask an agent to find out why the build is slow", ctx)).toEqual({ kind: "task", fields: { title: "Find out why the build is slow", map: "example/app#10" } });
    expect(parseByRules("new goal: run twice a week", ctx)).toEqual({ kind: "goal", fields: { wording: "Run twice a week" } });
  });

  it("makes a calendar entry with a range, or an hour by default", () => {
    expect(parseByRules("schedule dentist on Tuesday from 14:00 to 15:30", ctx)).toEqual({
      kind: "calendar",
      fields: { title: "Dentist", start: new Date(local("2026-11-03T14:00:00")).toISOString(), end: new Date(local("2026-11-03T15:30:00")).toISOString() },
    });
    expect(parseByRules("add a meeting with Ada at 15:00", ctx)).toMatchObject({ fields: { title: "With Ada", start: new Date(local("2026-10-30T15:00:00")).toISOString(), end: new Date(local("2026-10-30T16:00:00")).toISOString() } });
  });

  it("leaves the time out when the text has none, and says when it cannot tell", () => {
    expect(parseByRules("remind me to water the plants", ctx)).toEqual({ kind: "reminder", fields: { text: "Water the plants" } });
    expect(parseByRules("what is the weather", ctx)).toMatchObject({ kind: "none" });
  });
});

describe("time phrases", () => {
  it("keeps tomorrow on the next calendar day across the autumn clock change", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Zurich";
    try {
      const changeDay = Date.parse("2026-10-25T10:00:00Z");
      expect(new Date(findWhen("tomorrow at 9", changeDay)?.at ?? 0).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("reads relative times, a bare hour as the next one, weekdays and dates", () => {
    expect(findWhen("in 20 minutes", NOW)?.at).toBe(NOW + 20 * 60_000);
    expect(findWhen("at 9", NOW)?.at).toBe(local("2026-10-31T09:00:00"));
    expect(findWhen("at 3pm", NOW)?.at).toBe(local("2026-10-30T15:00:00"));
    expect(findWhen("friday", NOW)).toMatchObject({ at: local("2026-11-06T00:00:00"), allDay: true });
    expect(findWhen("on 2.11.", NOW)?.at).toBe(local("2026-11-02T00:00:00"));
    expect(findWhen("tonight", NOW)?.at).toBe(local("2026-10-30T19:00:00"));
    expect(findWhen("nothing here", NOW)).toBeNull();
  });
});

describe("the parser command", () => {
  const request: ParserRequest = { text: "x", now: new Date(NOW).toISOString(), timeZone: "Europe/Zurich", kinds: ["reminder", "note", "task", "goal", "calendar"], maps: [MAP] };
  const answering = (answer: unknown) => async () => JSON.stringify(answer);

  it("accepts a valid card and a reasoned none", async () => {
    expect(await parseWithCommand(["p"], request, answering({ kind: "note", fields: { text: "Hi" } }), 1000)).toEqual({ kind: "note", fields: { text: "Hi" } });
    expect(await parseWithCommand(["p"], request, answering({ kind: "none", reason: "That is a question." }), 1000)).toEqual({ kind: "none", reason: "That is a question." });
  });

  it("returns null for anything off-contract, so the rules answer instead", async () => {
    expect(await parseWithCommand(["p"], request, answering({ kind: "reminder", fields: { text: "x" } }), 1000)).toBeNull();
    expect(await parseWithCommand(["p"], request, answering({ kind: "task", fields: { title: "x", map: "other/repo#1" } }), 1000)).toBeNull();
    expect(await parseWithCommand(["p"], request, async () => "not json", 1000)).toBeNull();
    expect(await parseWithCommand(["p"], request, async () => "null", 1000)).toBeNull();
    expect(await parseWithCommand(["p"], request, async () => { throw new Error("down"); }, 1000)).toBeNull();
  });
});

describe("proposals", () => {
  const all = writableKinds({ calendar: ["c"], task: ["t"], goal: ["g"] });

  it("places reminders and calendar entries in time", () => {
    const p = toProposal("calendar", { title: "Dentist", start: "2026-11-03T13:00:00.000Z", end: "2026-11-03T14:00:00.000Z" }, all, "rules");
    expect(p).toMatchObject({ label: "Calendar entry", at: Date.parse("2026-11-03T13:00:00.000Z"), end: Date.parse("2026-11-03T14:00:00.000Z") });
    expect(p.problem).toBeUndefined();
  });

  it("says what stops a card: a missing time, or a kind with no writer", () => {
    expect(toProposal("reminder", { text: "Call" }, all, "rules").problem).toBe("When should I remind you?");
    expect(toProposal("goal", { wording: "Run" }, writableKinds({}), "rules")).toMatchObject({ problem: "Goal drafts are not set up on this stack.", unwritable: true });
    expect(toProposal("calendar", { title: "x", start: "2026-11-03T13:00:00.000Z" }, writableKinds({}), "rules").problem).toBe("Calendar entries are not set up on this stack.");
  });
});

const ASK = { parser: [], timeoutSeconds: 5, writers: { calendar: ["cal-writer"], task: ["task-writer"] }, taskMaps: [MAP] };
const DESK: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ask: ASK };
const post = (path: string, body: unknown): Request => new Request(`http://mc${path}`, { method: "POST", body: JSON.stringify(body) });

describe("POST /api/desk/ask", () => {
  const runtime: DeskRuntime = { options: DESK, ledger: new HandledLedger() };

  it("answers with a proposal card and creates nothing", async () => {
    const res = await handleDeskAsk(post("/api/desk/ask", { text: "schedule dentist at 15:00" }), runtime, { now: () => NOW });
    const body = (await res.json()) as { proposal: { kind: string; at: number } };
    expect(body.proposal).toMatchObject({ kind: "calendar", at: local("2026-10-30T15:00:00"), via: "rules" });
  });

  it("prefers the parser command and falls back to the rules when it fails", async () => {
    const withParser = { ...runtime, options: { ...DESK, ask: { ...ASK, parser: ["parse"] } } };
    const viaParser = await handleDeskAsk(post("/api/desk/ask", { text: "whatever" }), withParser, { now: () => NOW, runParser: async () => JSON.stringify({ kind: "goal", fields: { wording: "Sleep more" } }) });
    expect(((await viaParser.json()) as { proposal: unknown }).proposal).toMatchObject({ kind: "goal", via: "parser", problem: "Goal drafts are not set up on this stack." });
    const fallback = await handleDeskAsk(post("/api/desk/ask", { text: "note buy milk" }), withParser, { now: () => NOW, runParser: async () => { throw new Error("no model"); } });
    expect(((await fallback.json()) as { proposal: unknown }).proposal).toMatchObject({ kind: "note", via: "rules" });
  });

  it("says so when the text matches no kind", async () => {
    const res = await handleDeskAsk(post("/api/desk/ask", { text: "hello there" }), runtime, { now: () => NOW });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/desk/create", () => {
  let db: Database;
  let runtime: DeskRuntime;
  beforeEach(() => {
    db = initDatabase(":memory:");
    runtime = { options: DESK, ledger: new HandledLedger(), recentWrites: new RecentCalendarWrites() };
  });

  it("stores a reminder and a note in the MC db", async () => {
    const due = new Date(NOW + 3_600_000).toISOString();
    expect((await handleDeskCreate(post("/api/desk/create", { requestId: "req-00001", kind: "reminder", fields: { text: "Call Ada", due } }), db, runtime, { now: () => NOW })).status).toBe(200);
    expect((await handleDeskCreate(post("/api/desk/create", { requestId: "req-00002", kind: "note", fields: { text: "Code 4711" } }), db, runtime, { now: () => NOW })).status).toBe(200);
    expect(listOpenNotes(db).map((n) => [n.kind, n.text])).toEqual([["reminder", "Call Ada"], ["note", "Code 4711"]]);
  });

  it("hands a calendar entry to its writer on stdin and keeps it on the timeline until the source shows it", async () => {
    const calls: { argv: string[]; stdin: string }[] = [];
    const runWriter: WriterRunner = async (argv, stdin) => {
      calls.push({ argv, stdin });
      return { code: 0, stdout: JSON.stringify({ id: "E1", message: "Added \"Dentist\"." }), stderr: "" };
    };
    const fields = { title: "Dentist", start: new Date(local("2026-10-30T15:00:00")).toISOString() };
    const res = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00003", kind: "calendar", fields }), db, runtime, { now: () => NOW, runWriter });
    expect(await res.json()).toEqual({ ok: true, message: "Added \"Dentist\"." });
    expect(calls).toEqual([{ argv: ["cal-writer"], stdin: JSON.stringify({ kind: "calendar", fields, requestId: "req-00003" }) }]);
    const view = await composeDesk(db, DESK, undefined, { now: NOW, sourceCache: new SourceCache(), recentWrites: runtime.recentWrites });
    expect(view.today.map((e) => [e.title, e.kind])).toContainEqual(["Dentist", "meeting"]);
  });

  it("creates once per request id", async () => {
    let runs = 0;
    const runWriter: WriterRunner = async () => {
      runs += 1;
      return { code: 0, stdout: JSON.stringify({ id: "N1" }), stderr: "" };
    };
    const req = () => post("/api/desk/create", { requestId: "req-00004", kind: "task", fields: { title: "Look", map: MAP.ref } });
    expect((await handleDeskCreate(req(), db, runtime, { runWriter })).status).toBe(200);
    expect((await handleDeskCreate(req(), db, runtime, { runWriter })).status).toBe(409);
    expect(runs).toBe(1);
  });

  it("passes on a writer's refusal and creates nothing on the Desk", async () => {
    const runWriter: WriterRunner = async () => ({ code: 3, stdout: "", stderr: "debug\nCalendar access is not granted.\n" });
    const fields = { title: "Dentist", start: new Date(NOW).toISOString() };
    const res = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00005", kind: "calendar", fields }), db, runtime, { runWriter });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Calendar access is not granted." });
    expect(runtime.recentWrites?.pending(NOW, [])).toEqual([]);
  });

  it("refuses a task when no map is set up at all", async () => {
    const noMaps: DeskRuntime = { ...runtime, options: { ...DESK, ask: { ...ASK, taskMaps: [] } } };
    const res = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00020", kind: "task", fields: { title: "Look", map: "any/repo#1" } }), db, noMaps, { runWriter: async () => ({ code: 0, stdout: "{\"id\":\"x\"}", stderr: "" }) });
    expect(res.status).toBe(400);
  });

  it("spends the request id when a writer times out or answers unreadably, since it may have created the item", async () => {
    const fields = { title: "Look", map: MAP.ref };
    let runs = 0;
    const slow: WriterRunner = async () => {
      runs += 1;
      throw new WriterTimeout("timed out after 5 s");
    };
    const first = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00021", kind: "task", fields }), db, runtime, { runWriter: slow });
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ uncertain: true, error: "The agent task writer timed out after 5 s. It may have been created; check before asking again." });
    expect((await handleDeskCreate(post("/api/desk/create", { requestId: "req-00021", kind: "task", fields }), db, runtime, { runWriter: slow })).status).toBe(409);
    expect(runs).toBe(1);
    const garbled: WriterRunner = async () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(await (await handleDeskCreate(post("/api/desk/create", { requestId: "req-00022", kind: "task", fields }), db, runtime, { runWriter: garbled })).json()).toMatchObject({ uncertain: true });
  });

  it("refuses a kind with no writer, a map not set up, and fields that do not validate", async () => {
    const status = async (kind: string, fields: unknown, id: string) => (await handleDeskCreate(post("/api/desk/create", { requestId: id, kind, fields }), db, runtime)).status;
    expect(await status("goal", { wording: "Run" }, "req-00006")).toBe(409);
    expect(await status("task", { title: "Look", map: "other/repo#1" }, "req-00007")).toBe(400);
    expect(await status("reminder", { text: "No time" }, "req-00008")).toBe(400);
  });
});

describe("notes and reminders with a writer", () => {
  const WRITTEN = { ...ASK, writers: { ...ASK.writers, note: ["note-writer"], reminder: ["reminder-writer", "--list", "Desk"] } };
  const WITH_WRITERS: DeskOptions = { ...DESK, ask: WRITTEN };
  let db: Database;
  let runtime: DeskRuntime;
  beforeEach(() => {
    db = initDatabase(":memory:");
    runtime = { options: WITH_WRITERS, ledger: new HandledLedger() };
  });

  const recording = (calls: { argv: string[]; stdin: string }[], answer: unknown): WriterRunner => async (argv, stdin) => {
    calls.push({ argv, stdin });
    return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
  };

  it("hands a note to its writer, stores nothing in desk_notes and shows the writer's message", async () => {
    const calls: { argv: string[]; stdin: string }[] = [];
    const runWriter = recording(calls, { id: "T1", message: "Saved to Tana." });
    const res = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00030", kind: "note", fields: { text: "Code 4711" } }), db, runtime, { now: () => NOW, runWriter });
    expect(await res.json()).toEqual({ ok: true, message: "Saved to Tana." });
    expect(calls).toEqual([{ argv: ["note-writer"], stdin: JSON.stringify({ kind: "note", fields: { text: "Code 4711" }, requestId: "req-00030" }) }]);
    expect(listOpenNotes(db)).toEqual([]);
  });

  it("hands a reminder to its writer with text and due, and the Desk neither shows nor pushes it", async () => {
    const calls: { argv: string[]; stdin: string }[] = [];
    const due = new Date(NOW + 60_000).toISOString();
    const res = await handleDeskCreate(post("/api/desk/create", { requestId: "req-00031", kind: "reminder", fields: { text: "Stretch", due } }), db, runtime, { now: () => NOW, runWriter: recording(calls, { id: "R1" }) });
    expect(await res.json()).toEqual({ ok: true, message: "Created the reminder." });
    expect(calls).toEqual([{ argv: ["reminder-writer", "--list", "Desk"], stdin: JSON.stringify({ kind: "reminder", fields: { text: "Stretch", due }, requestId: "req-00031" }) }]);
    expect(listOpenNotes(db)).toEqual([]);
    const later = await composeDesk(db, WITH_WRITERS, undefined, { now: NOW + 120_000, sourceCache: new SourceCache() });
    expect(later.items.some((i) => i.kind === "reminder")).toBe(false);
    expect(later.today.some((e) => e.kind === "reminder")).toBe(false);
  });

  it("treats a note writer's refusal, timeout and unreadable answer like any other writer, and keeps nothing", async () => {
    const send = (id: string, runWriter: WriterRunner) => handleDeskCreate(post("/api/desk/create", { requestId: id, kind: "note", fields: { text: "Code 4711" } }), db, runtime, { now: () => NOW, runWriter });
    const refused = await send("req-00032", async () => ({ code: 2, stdout: "", stderr: "trace\nTana is not reachable.\n" }));
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ ok: false, error: "Tana is not reachable." });
    expect((await send("req-00032", recording([], { id: "T2" }))).status).toBe(200);

    const slow = await send("req-00033", async () => { throw new WriterTimeout("timed out after 5 s"); });
    expect(await slow.json()).toEqual({ ok: false, uncertain: true, error: "The note writer timed out after 5 s. It may have been created; check before asking again." });
    expect((await send("req-00033", recording([], { id: "T3" }))).status).toBe(409);

    expect(await (await send("req-00034", async () => ({ code: 0, stdout: "ok", stderr: "" }))).json()).toMatchObject({ uncertain: true });
    expect(listOpenNotes(db)).toEqual([]);
  });

  it("offers notes and reminders whether or not a writer is set", () => {
    expect([...writableKinds({})].sort()).toEqual(["note", "reminder"]);
    expect([...writableKinds({ note: ["n"], reminder: ["r"] })].sort()).toEqual(["note", "reminder"]);
  });
});

describe("reminders and notes on the Desk", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });

  it("puts a reminder on the timeline, brings it back as an item when due, and lets it be done", async () => {
    const runtime: DeskRuntime = { options: DESK, ledger: new HandledLedger() };
    await handleDeskCreate(post("/api/desk/create", { requestId: "req-00010", kind: "reminder", fields: { text: "Stretch", due: new Date(NOW + 60_000).toISOString() } }), db, runtime, { now: () => NOW });
    await handleDeskCreate(post("/api/desk/create", { requestId: "req-00011", kind: "note", fields: { text: "Code 4711" } }), db, runtime, { now: () => NOW });

    const before = await composeDesk(db, DESK, undefined, { now: NOW, sourceCache: new SourceCache() });
    expect(before.today.map((e) => [e.title, e.kind])).toContainEqual(["Stretch", "reminder"]);
    expect(before.items.some((i) => i.kind === "reminder")).toBe(false);
    expect(before.notes.map((n) => n.text)).toEqual(["Code 4711"]);
    expect(before.ask).toEqual({ kinds: ["reminder", "note", "calendar", "task"], maps: [MAP] });

    const due = await composeDesk(db, DESK, undefined, { now: NOW + 120_000, sourceCache: new SourceCache() });
    const item = due.items.find((i) => i.kind === "reminder");
    expect(item).toMatchObject({ title: "Stretch", urgency: "now" });
    const done = item?.actions.find((a) => a.id === "reminder.done");
    expect((await handleDeskNoteDone(post("/api/desk/notes/done", { id: Number(done?.target) }), db)).status).toBe(200);
    expect((await composeDesk(db, DESK, undefined, { now: NOW + 180_000, sourceCache: new SourceCache() })).items.some((i) => i.kind === "reminder")).toBe(false);
  });
});

describe("spawnWithStdin", () => {
  it("returns on time even when the writer's child keeps the output pipe open", async () => {
    const started = Date.now();
    await expect(spawnWithStdin(["bash", "-c", "sleep 5 & sleep 5"], "", 300)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes stdin to the command and returns its exit code and output", async () => {
    expect(await spawnWithStdin(["bash", "-c", "cat; echo oops >&2; exit 4"], "{\"a\":1}", 2000)).toEqual({ code: 4, stdout: "{\"a\":1}", stderr: "oops\n" });
  });
});
