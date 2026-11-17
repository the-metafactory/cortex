import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { DESK_API_VERSION } from "../../../desk-api";
import { handleGetDeskStudio } from "../api/desk-studio";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { waitsOnYou } from "../desk/studio/board";
import { needsResponse } from "../desk/studio/response";
import { buildThreadFacts } from "../desk/studio/thread-facts";
import { buildThreadPage } from "../desk/studio/page";
import { readStudioFiles } from "../desk/studio/read";
import { buildStudioView, type StudioView } from "../desk/studio/view";
import { NOTE_KINDS, NOTE_STATUSES, THREAD_OUTCOMES, type DeskStudioResponse } from "../../../desk-api/wire/studio";
import { studioNote, studioThread } from "./__fixtures__/studio";

const studio = (active = [studioThread("one")], parked: StudioView["parked"] = [], closed: StudioView["closed"] = []): StudioView => ({
  active, parked, closed, maxActive: 1, areas: [], inbox: [], proposals: [], problems: [], yesFilter: { questions: [], fromConfig: false },
});

const at = (day: number): string => `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`;
const note = (day: number, over: Parameters<typeof studioNote>[1] = {}) => studioNote(at(day), { sample: false, ...over });

describe("pure Studio thread facts", () => {
  it("waits for an uncovered newest open note and stops after a covering response", () => {
    const thread = studioThread("one", { notes: [note(10)] });
    const derive = () => buildThreadFacts(studio([thread]), thread).derived;
    expect(derive()).toMatchObject({ waitsOnYou: true, needsResponse: true });
    thread.responses = [{ at: at(9), text: "An older response." }];
    expect(derive()).toMatchObject({ waitsOnYou: true, needsResponse: true });
    thread.responses = [{ at: at(11), text: "Covered." }];
    expect(derive()).toMatchObject({ waitsOnYou: false, needsResponse: false });
    thread.responses = [{ at: at(9), re: at(10), text: "Covers the referenced note." }];
    expect(derive()).toMatchObject({ waitsOnYou: false, needsResponse: false });
  });

  it("keeps the existing distinct response rules for blank responses, samples, statuses and closed threads", () => {
    for (const state of ["active", "parked", "closed"] as const) {
      for (const status of NOTE_STATUSES) {
        for (const sample of [true, false]) {
          for (const text of ["", "Answered."]) {
            const thread = studioThread("one", { state, outcome: "decided", notes: [note(10, { status, sample })], responses: [{ at: at(11), text }] });
            const derived = buildThreadFacts(studio([thread]), thread).derived;
            expect(derived.waitsOnYou).toBe(waitsOnYou(thread));
            expect(derived.needsResponse).toBe(needsResponse(thread));
          }
        }
      }
    }
  });

  it("splits every note kind and status, sorts newest first and leaves raw notes untouched", () => {
    const notes = NOTE_KINDS.flatMap((kind, i) => NOTE_STATUSES.map((status, j) => note(i * 3 + j + 1, { kind, status })));
    const thread = studioThread("one", { notes });
    const before = structuredClone(thread);
    const derived = buildThreadFacts(studio([thread]), thread).derived;
    expect(derived.notes.open.map(n => [n.kind, n.status, n.at])).toEqual([["note", "open", at(1)]]);
    expect(derived.notes.kept.map(n => [n.kind, n.status, n.at])).toEqual([
      ["idea", "kept", at(8)], ["stand", "kept", at(5)], ["note", "kept", at(2)],
    ]);
    expect(derived.standProposal).toEqual(notes.find(n => n.kind === "stand" && n.status === "open")!);
    expect(derived.ideas).toEqual(notes.filter(n => n.kind === "idea" && n.status === "open"));
    expect(thread).toEqual(before);
  });

  it("picks the newest stand and lists ideas and visible notes newest first just like the page", () => {
    const thread = studioThread("one", { notes: [note(8), note(7, { kind: "idea" }), note(9, { kind: "stand" }), note(12), note(11, { kind: "stand" }), note(13, { kind: "idea" }), note(14, { status: "kept" })] });
    const view = studio([thread]);
    const { derived } = buildThreadFacts(view, thread);
    expect(derived.standProposal?.at).toBe(at(11));
    expect(derived.ideas.map(n => n.at)).toEqual([at(13), at(7)]);
    expect(derived.notes.open.map(n => n.at)).toEqual([at(12), at(8)]);
    expect(derived.notes.kept.map(n => n.at)).toEqual([at(14)]);
    const page = buildThreadPage(view, thread.slug)!;
    expect(page.standProposal).toEqual(derived.standProposal);
    expect(page.ideas).toEqual(derived.ideas);
    expect(page.notes.filter(n => n.status === "open")).toEqual(derived.notes.open);
    expect(page.notes.filter(n => n.status === "kept")).toEqual(derived.notes.kept);
    expect(buildThreadFacts(studio(), studioThread("empty")).derived).toMatchObject({ standProposal: null, ideas: [], notes: { open: [], kept: [] } });
  });

  it("lists shared sources across active, parked and closed threads once per link without self matches", () => {
    const link = { kind: "link", label: "Café brief!", href: "https://example.org/brief" };
    const a = studioThread("one", { material: [link, { kind: "file", label: "—" }] });
    const b = studioThread("two", { state: "parked", material: [{ ...link, label: "Different label" }, link] });
    const c = studioThread("three", { state: "closed", outcome: "shipped", material: [{ kind: "file", label: "CAFÉ   brief" }, { kind: "file", label: "…" }] });
    const view = studio([a], [b], [c]);
    expect(buildThreadFacts(view, a).material.map(m => m.also)).toEqual([[{ slug: b.slug, question: b.question }, { slug: c.slug, question: c.question }], []]);
    expect(buildThreadFacts(view, b).material.every(m => m.also.some(other => other.slug === a.slug))).toBe(true);
    expect(buildThreadFacts(view, c).material[0]?.also).toEqual([{ slug: a.slug, question: a.question }, { slug: b.slug, question: b.question }]);
    expect(a.material[0]?.also).toBeUndefined();
  });

  it("serves outcome codes and ISO dates with no generated label", () => {
    for (const outcome of THREAD_OUTCOMES) {
      const thread = studioThread("one", { state: "closed", outcome, closed: "2026-11-12", expect: "A result.", reviewOn: "2026-12-01", outcomeText: "The thread's own words." });
      expect(buildThreadFacts(studio([], [], [thread]), thread).derived.outcome).toEqual({ open: false, outcome, closed: "2026-11-12", expect: "A result.", reviewOn: "2026-12-01", text: "The thread's own words." });
    }
    const closed = studioThread("closed", { state: "closed", outcome: "dropped" });
    expect(buildThreadFacts(studio(), closed).derived.outcome).toEqual({ open: false, outcome: "dropped", closed: null, expect: null, reviewOn: null, text: "" });
    for (const state of ["active", "parked"] as const) {
      const thread = studioThread("open", { state, outcomeText: "Still open." });
      expect(buildThreadFacts(studio(), thread).derived.outcome).toEqual({ open: true, text: "Still open." });
    }
  });

  it("keeps over-cap threads active with a null place and preserves other places and states", () => {
    for (const over of [{ place: 1 }, { overCap: true }, { state: "parked" as const }, { state: "closed" as const, outcome: "decided" as const }]) {
      const thread = studioThread("one", over);
      expect(buildThreadFacts(studio(), thread).derived.where).toEqual({ state: thread.state, place: thread.place ?? null, maxActive: 1, opened: thread.opened });
    }
  });
});

const THREAD_FILE = `---
type: question
areas: [lab]
state: active
opened: 2026-11-01
---
## Question
What should happen next?
## Assistant's notes
### 2026-11-10T10:00:00Z
trigger: stale
model: local
kind: note
status: open
A note to answer.
## Material
- link: [Brief](https://example.org/brief)
`;

describe("GET /api/desk/studio thread facts", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const options = (): DeskOptions => ({ enabled: true, assistantName: "Assistant", displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "#2563eb", repos: [], goals: [] }], sources: [], studio: { dir, maxActive: 1 } });
  const runtime = (): DeskRuntime => ({ options: options(), ledger: new HandledLedger() });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-studio-thread-facts-"));
    mkdirSync(join(dir, "threads"));
    const fixtures = {
      one: THREAD_FILE,
      two: THREAD_FILE.replace("2026-11-01", "2026-11-02"),
      parked: THREAD_FILE.replace("state: active", "state: parked"),
      closed: THREAD_FILE.replace("state: active", "state: closed\nclosed: 2026-11-12\noutcome: decided"),
    };
    for (const [slug, text] of Object.entries(fixtures)) writeFileSync(join(dir, `threads/${slug}.md`), text);
  });

  it("serves derived and material also on every thread while preserving raw notes, outcome and thinking", async () => {
    const response = await handleGetDeskStudio(runtime());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: DeskStudioResponse = await response.json();
    if (!body.studio) throw new Error("Fixture Studio must be enabled.");
    expect(body.materialText).toBe("untrusted");
    expect(body.directory).toBe(dir);
    const { files, problems } = await readStudioFiles(dir);
    const view = buildStudioView(files, options().studio!, options().areas, problems, "Assistant");
    for (const group of ["active", "parked", "closed"] as const) {
      expect(body.studio[group]).toHaveLength(view[group].length);
      for (const thread of body.studio[group]) {
        const raw = view[group].find(t => t.slug === thread.slug)!;
        const expected = buildThreadFacts(view, raw);
        expect(thread.derived).toEqual(expected.derived);
        expect(thread.material).toEqual(expected.material);
        expect(thread.notes).toEqual(raw.notes);
        expect(thread.outcome).toBe(raw.outcome);
        expect(thread.thinking?.kind).toBe("unavailable");
        expect(thread.material[0]?.also).toHaveLength(3);
        expect(thread.derived.waitsOnYou).toBe(true);
        expect(thread.derived.notes.open).toHaveLength(1);
        expect(thread.derived.outcome).not.toHaveProperty("label");
        expect(thread.derived.where).not.toHaveProperty("text");
        expect(thread).not.toHaveProperty("relations");
      }
    }
    expect(body.studio.active.find(t => t.slug === "two")?.derived.where).toEqual({ state: "active", place: null, maxActive: 1, opened: "2026-11-02" });
    writeFileSync(join(dir, "threads/one.md"), `${THREAD_FILE}\n## Responses\n\n### 2026-11-11T10:00:00Z\nAnswered.\n`);
    const after: DeskStudioResponse = await (await handleGetDeskStudio(runtime())).json();
    expect(after.studio?.active.find(t => t.slug === "one")?.derived).toMatchObject({ waitsOnYou: false, needsResponse: false });
  });

  it("serves the versioned HTTP route to curl with derived facts and shared material", async () => {
    const db = initDatabase(":memory:");
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk: options() });
    try {
      const request = Bun.spawn(["curl", "--silent", "--show-error", "--max-time", "10", "--include", `http://127.0.0.1:${ctx.port}/api/desk/studio`], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(request.stdout).text();
      expect(await request.exited).toBe(0);
      const boundary = output.indexOf("\r\n\r\n");
      const headers = output.slice(0, boundary).toLowerCase();
      expect(headers).toContain("http/1.1 200");
      expect(headers).toContain(`x-desk-api-version: ${DESK_API_VERSION}`);
      const body: DeskStudioResponse = JSON.parse(output.slice(boundary + 4));
      expect(body.studio?.active[0]?.derived).toMatchObject({ waitsOnYou: true, needsResponse: true });
      expect(body.studio?.active[0]?.material[0]?.also).toHaveLength(3);
      expect(body.studio?.closed[0]?.derived.outcome).toMatchObject({ open: false, outcome: "decided" });
    } finally {
      ctx.stop(true);
      db.close();
    }
  });

  it("keeps the null response when runtime, Desk or Studio is disabled", async () => {
    for (const value of [undefined, { ...runtime(), options: { ...options(), enabled: false } }, { ...runtime(), options: { ...options(), studio: undefined } }]) {
      const response = await handleGetDeskStudio(value);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ studio: null });
    }
  });
});
