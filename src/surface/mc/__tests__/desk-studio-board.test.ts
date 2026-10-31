import { describe, expect, it } from "bun:test";
import { studioNote, studioThread } from "./__fixtures__/studio";
import { buildBoard, normaliseLabel, sharedPairs, type BoardCard, type BoardClock, type BoardFree } from "../desk/studio/board";
import type { IvyNote, MaterialLink, StudioCapture } from "../desk/studio/format";
import type { StudioProposalView, StudioThreadView, StudioView } from "../desk/studio/view";

const NOW = Date.parse("2026-10-31T09:00:00+01:00");
const TODAY = Date.parse("2026-10-31T00:00:00+01:00");
const CLOCK: BoardClock = { now: NOW, startOfToday: TODAY, lastLook: null };

const note = studioNote;
const thread = studioThread;

const capture = (id: string, target?: StudioCapture["target"]): StudioCapture => ({ id, path: `inbox/${id}.md`, at: "2026-10-30T18:20:00+01:00", via: "voice", text: `Capture ${id}`, target });

const proposal = (id: string, target: StudioProposalView["target"]): StudioProposalView => ({
  id,
  path: `proposals/${id}.md`,
  type: "question",
  areas: ["work"],
  proposed: "2026-10-31T04:30:00+01:00",
  question: "What should run locally?",
  why: "It came up in 3 mails.",
  target,
  policy: "local",
});

const material = (label: string, href?: string): MaterialLink => ({ kind: "file", label, href });

const FIXTURE: StudioView = {
  maxActive: 5,
  areas: [
    { id: "work", label: "Work", color: "#2563eb", policy: "local" },
    { id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" },
  ],
  active: [
    thread("netops", { place: 1, areas: ["work"], policy: "local", notes: [note("2026-10-29T02:40:00+01:00")], material: [material("Cover email, sent 14 Oct")] }),
    thread("field-notes", { place: 2, notes: [note("2026-10-25T07:30:00+02:00", { status: "kept" })], material: [material("Today's grilling session")] }),
    thread("desk-open", {
      place: 3,
      notes: [note("2026-10-31T03:14:00+01:00", { kind: "stand" }), note("2026-10-25T07:30:00+02:00", { status: "kept" })],
      material: [material("today’s  Grilling-session!")],
    }),
    thread("weekly-post", { place: 4, areas: ["lab", "gone"], policy: "local", notes: [note("2026-10-31T04:05:00+01:00", { kind: "idea" })], material: [material("Brief", "https://example.org/brief")] }),
  ],
  parked: [thread("workshops", { state: "parked", notes: [note("2026-10-31T05:00:00+01:00")] })],
  closed: [thread("old", { state: "closed", outcome: "decided", closed: "2026-10-01" })],
  inbox: [
    capture("tango", { place: "new", area: "lab", reason: "No active thread is about tango." }),
    capture("lecture", { thread: "desk-open", reason: "It is about newcomers." }),
    capture("loose"),
  ],
  proposals: [proposal("spark", { place: "new", area: "work", reason: "Place 5 is free." })],
  problems: [{ path: "threads/broken.md", reason: "has no ## Question" }],
};

const cards = (board: ReturnType<typeof buildBoard>): BoardCard[] => board.places.filter((p): p is BoardCard => p.kind === "thread");

describe("the Studio board view-model", () => {
  const board = buildBoard(FIXTURE, CLOCK);

  it("lays the active threads into their places and shows the empty place as free", () => {
    expect(board.places.map((p) => (p.kind === "thread" ? p.thread.slug : `free ${p.place}`))).toEqual(["netops", "field-notes", "desk-open", "weekly-post", "free 5"]);
  });

  it("marks a thread as waiting on you when its latest note is still open", () => {
    expect(cards(board).map((c) => [c.thread.slug, c.waitsOnYou])).toEqual([["netops", true], ["field-notes", false], ["desk-open", true], ["weekly-post", true]]);
    expect(cards(board).find((c) => c.thread.slug === "desk-open")?.latest?.kind).toBe("stand");
  });

  it("joins two threads that share a material label once the labels are normalised", () => {
    expect(board.shared).toEqual([{ a: "field-notes", b: "desk-open", label: "Today's grilling session" }]);
    expect(cards(board).find((c) => c.thread.slug === "desk-open")?.shared).toEqual([{ slug: "field-notes", question: "What about field-notes?", label: "Today's grilling session" }]);
  });

  it("matches material by href even when the labels differ, and never on empty labels", () => {
    const a = thread("a", { material: [material("Brief", "https://example.org/brief")] });
    const b = thread("b", { material: [material("The brief document", "https://example.org/brief")] });
    const c = thread("c", { material: [material("—")] });
    const d = thread("d", { material: [material("…")] });
    expect(sharedPairs([a, b, c, d])).toEqual([{ a: "a", b: "b", label: "Brief" }]);
    expect(normaliseLabel("Today’s grilling-session!")).toBe("today s grilling session");
  });

  it("points a new-place capture and the proposal at the first free place, with the reason", () => {
    const tango = board.inbox.find((c) => c.id === "tango");
    expect(tango?.target).toEqual({ kind: "free", place: 5 });
    expect(tango?.sentence).toBe("Ivy would make it a thread in place 5, under Lab.");
    expect(tango?.reason).toBe("No active thread is about tango.");
    expect(board.proposals[0]?.target).toEqual({ kind: "free", place: 5 });
    const free = board.places.find((p): p is BoardFree => p.kind === "free");
    expect(free?.incoming).toEqual(["the voice note", "Ivy's proposed thread"]);
  });

  it("points a capture at the thread it names, and draws no line for one without a target", () => {
    const lecture = board.inbox.find((c) => c.id === "lecture");
    expect(lecture?.target).toEqual({ kind: "thread", slug: "desk-open", place: 3 });
    expect(lecture?.sentence).toBe("Ivy would file it into “What about desk-open”, place 3.");
    const loose = board.inbox.find((c) => c.id === "loose");
    expect(loose?.target).toBeNull();
    expect(loose?.reason).toBeNull();
  });

  it("draws no line when every place is taken or the named thread is not on the board", () => {
    const full: StudioView = { ...FIXTURE, active: [...FIXTURE.active, thread("fifth", { place: 5 })], inbox: [capture("parked-target", { thread: "workshops", reason: "r" }), capture("new", { place: "new", reason: "r" })] };
    const b = buildBoard(full, CLOCK);
    expect(b.places.every((p) => p.kind === "thread")).toBe(true);
    expect(b.inbox.map((c) => c.target)).toEqual([null, null]);
    expect(b.inbox.map((c) => c.sentence)).toEqual(["Ivy would file it into a thread that is not on the board.", "Every place is taken, so opening it would park a thread."]);
  });

  it("summarises the threads Ivy wrote in since the last look, and the places in use", () => {
    expect(board.summary).toBe("In the last day, I thought about 3 threads: “What about desk-open”, “What about weekly-post” and “What about workshops”. 4 of 5 places are in use, and I wait on you in 3 of them.");
    const evening = buildBoard(FIXTURE, { ...CLOCK, lastLook: Date.parse("2026-10-30T22:00:00+01:00") });
    expect(evening.summary.startsWith("Overnight I thought about 3 threads:")).toBe(true);
    const morning = buildBoard(FIXTURE, { ...CLOCK, lastLook: Date.parse("2026-10-30T10:00:00+01:00") });
    expect(morning.summary.startsWith("Since you last looked, I thought about 3 threads:")).toBe(true);
    const later = buildBoard(FIXTURE, { ...CLOCK, lastLook: Date.parse("2026-10-31T04:30:00+01:00") });
    expect(later.summary).toBe("Since you last looked, I thought about 1 thread: “What about workshops”. 4 of 5 places are in use, and I wait on you in 3 of them.");
  });

  it("omits the thought sentence when Ivy wrote nothing new", () => {
    const quiet = buildBoard(FIXTURE, { ...CLOCK, lastLook: NOW });
    expect(quiet.summary).toBe("4 of 5 places are in use, and I wait on you in 3 of them.");
    expect(quiet.thoughtAbout).toEqual([]);
  });

  it("gives an area the config does not list a visible stand-in instead of dropping it", () => {
    const post = cards(board).find((c) => c.thread.slug === "weekly-post");
    expect(post?.areas.map((a) => [a.id, a.label, a.policy])).toEqual([["lab", "Lab", "cloud"], ["gone", "gone", "local"]]);
  });

  it("keeps over-cap threads, parked threads, the journal and problems reachable", () => {
    const over = buildBoard({ ...FIXTURE, active: [...FIXTURE.active, thread("extra", { overCap: true })] }, CLOCK);
    expect(over.overCap.map((t) => t.slug)).toEqual(["extra"]);
    expect(board.parked.map((t) => t.slug)).toEqual(["workshops"]);
    expect(board.closed.map((t) => t.slug)).toEqual(["old"]);
    expect(board.problems).toHaveLength(1);
  });
});
