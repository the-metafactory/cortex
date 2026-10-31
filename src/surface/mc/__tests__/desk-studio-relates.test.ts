import { describe, expect, it } from "bun:test";
import { studioNote, studioThread } from "./__fixtures__/studio";
import type { IvyNote, MaterialLink } from "../desk/studio/format";
import { buildThreadPage } from "../desk/studio/page";
import { relatesTo, relationCount, type RelatesContext } from "../desk/studio/relates";
import type { StudioThreadView, StudioView } from "../desk/studio/view";
import type { DeskEvent } from "../desk/types";

const NOW = Date.parse("2026-10-31T09:00:00+01:00");
const HOUR = 3_600_000;

const note = studioNote;
const thread = studioThread;
const mat = (kind: string, label: string, href?: string): MaterialLink => ({ kind, label, href });

const event = (key: string, title: string, at: number, over: Partial<DeskEvent> = {}): DeskEvent => ({ key, at, title, area: null, kind: "meeting", ...over });

const NETOPS = thread("netops", {
  place: 1,
  areas: ["work"],
  question: "Where does the NetOps AI proposal go after the cover email?",
  material: [mat("mail", "Cover email, sent 14 Oct"), mat("event", "NetOps sync, Mon 3 Nov 10:00"), mat("person", "Daniel Bertolo", "mailto:daniel@example.org"), mat("note", "Daniel said yes")],
});
const POST = thread("post", {
  place: 2,
  areas: ["personal"],
  question: "This week's invisible.ch post",
  material: [mat("session", "Today's grilling session on the Desk Studio"), mat("goal", "G5: one post a week"), mat("goal", "G9: learn the cello")],
});
const DESK = thread("desk", {
  place: 3,
  areas: ["lab"],
  question: "How does the Desk become useful to someone else?",
  material: [mat("session", "today’s grilling-session on the Desk  studio!"), mat("file", "BRIEF.md")],
});
const SHELF = thread("shelf", { state: "parked", areas: ["home"], material: [mat("file", "brief.md")] });
const BALANCE = thread("balance", {
  state: "closed",
  areas: ["lab"],
  closed: "2026-10-31",
  outcome: "decided",
  expect: "The engine becomes a package.",
  question: "Balance: own product or part of the Desk?",
});
const OLD = thread("old", { state: "closed", areas: ["home"], closed: "2026-09-01", outcome: "dropped", material: [mat("mail", "Cover email, sent 14 Oct")] });

const STUDIO: StudioView = {
  maxActive: 5,
  areas: [
    { id: "work", label: "Work", color: "#2563eb", policy: "local" },
    { id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" },
    { id: "personal", label: "Personal", color: "#16a34a", policy: "cloud" },
    { id: "home", label: "Home", color: "#ea580c", policy: "cloud" },
  ],
  active: [NETOPS, POST, DESK],
  parked: [SHELF],
  closed: [BALANCE, OLD],
  inbox: [],
  proposals: [],
  problems: [],
};

const CTX: RelatesContext = {
  now: NOW,
  goals: [{ id: "G5", text: "Make my know-how visible", state: "off-track" }],
  events: [
    event("sync", "NetOps sync", NOW + 48 * HOUR, { url: "https://cal.example.org/sync" }),
    event("past-sync", "NetOps sync", NOW - 48 * HOUR),
    event("zoe", "Zoë", NOW + 2 * HOUR, { kind: "all-day" }),
    event("proposal-review", "Proposal review: NetOps AI", NOW + 72 * HOUR),
    event("agent", "NetOps sync", NOW + HOUR, { kind: "agent" }),
    event("cover", "Cover email", NOW + 5 * HOUR),
  ],
};

describe("relates-to derivation", () => {
  it("relates threads that share a material link, by href or normalised label, and opens them", () => {
    const r = relatesTo(DESK, STUDIO, CTX);
    expect(r.threads.map((x) => [x.open, x.why])).toEqual([
      ["post", "Shares a source: today’s grilling-session on the Desk  studio!."],
      ["shelf", "Shares a source: BRIEF.md."],
    ]);
  });

  it("names the goal from the Desk's goals when the material names its id, and keeps an unknown goal as written", () => {
    const r = relatesTo(POST, STUDIO, CTX);
    expect(r.goals.map((g) => [g.title, g.why])).toEqual([
      ["Make my know-how visible", "The goal this thread serves, off track."],
      ["Learn the cello", "The goal this thread serves, named in its material."],
    ]);
  });

  it("finds upcoming calendar events named in the material or matching the question, soonest first", () => {
    const r = relatesTo(NETOPS, STUDIO, CTX);
    expect(r.events.map((e) => [e.title, e.why, e.href ?? null])).toEqual([
      ["Cover email", "Named in the material: Cover email, sent 14 Oct.", null],
      ["NetOps sync", "Named in the material: NetOps sync, Mon 3 Nov 10:00.", "https://cal.example.org/sync"],
    ]);
  });

  it("matches an event title found in the thread's question", () => {
    const r = relatesTo(thread("q", { question: "What should the Proposal review: NetOps AI decide?" }), STUDIO, CTX);
    expect(r.events.map((e) => [e.title, e.why])).toEqual([["Proposal review: NetOps AI", "Matches the thread's question."]]);
  });

  it("takes people only from material kinds that name a person, never from free text", () => {
    const r = relatesTo(NETOPS, STUDIO, CTX);
    expect(r.people.map((p) => [p.title, p.href])).toEqual([["Daniel Bertolo", "mailto:daniel@example.org"]]);
    expect(relatesTo(POST, STUDIO, CTX).people).toEqual([]);
  });

  it("relates closed decisions that share a material link or an area", () => {
    expect(relatesTo(NETOPS, STUDIO, CTX).decisions.map((d) => [d.open, d.why])).toEqual([["old", "Dropped 2026-09-01. Shares a source: Cover email, sent 14 Oct."]]);
    expect(relatesTo(DESK, STUDIO, CTX).decisions.map((d) => [d.open, d.why])).toEqual([["balance", "Decided 2026-10-31. Expected: The engine becomes a package. Same area: Lab."]]);
  });

  it("finds nothing for a thread that shares nothing", () => {
    const lone = thread("lone", { areas: ["solo"], material: [mat("file", "Only mine")] });
    const r = relatesTo(lone, STUDIO, CTX);
    expect(relationCount(r)).toBe(0);
  });

  it("works without calendar context", () => {
    const r = relatesTo(NETOPS, STUDIO);
    expect(r.events).toEqual([]);
    expect(r.goals).toEqual([]);
  });
});

describe("the thread page view-model", () => {
  const withNotes = thread("desk", {
    ...DESK,
    notes: [
      note("2026-10-25T07:30:00+02:00", { status: "kept", text: "Older." }),
      note("2026-10-31T03:14:00+01:00", { kind: "stand", because: "Two personas lack mail.", text: "The Studio is the product." }),
      note("2026-10-31T03:12:00+01:00", { text: "Three angles." }),
      note("2026-10-31T04:05:00+01:00", { kind: "idea", text: "Draft it in your voice?" }),
      note("2026-10-30T01:00:00+01:00", { kind: "idea", status: "dismissed", text: "Old idea." }),
    ],
    log: [{ at: "2026-10-24", text: "Opened" }],
  });
  const studio: StudioView = { ...STUDIO, active: [NETOPS, POST, withNotes] };
  const page = buildThreadPage(studio, "desk", CTX);

  it("returns null for a slug that is not in the Studio", () => {
    expect(buildThreadPage(studio, "nope", CTX)).toBeNull();
  });

  it("puts open stand and idea notes up as ghosts and lists the rest newest first", () => {
    expect(page?.standProposal?.text).toBe("The Studio is the product.");
    expect(page?.ideas.map((n) => n.text)).toEqual(["Draft it in your voice?"]);
    expect(page?.notes.map((n) => n.text)).toEqual(["Three angles.", "Old idea.", "Older."]);
    expect(page?.waitsOnYou).toBe(true);
  });

  it("says where the thread sits and marks material another thread also uses", () => {
    expect(page?.typeLabel).toBe("Question");
    expect(page?.where).toBe("place 3 of 5 · opened 20 Oct");
    expect(page?.material.map((m) => [m.label, m.also.map((o) => o.slug)])).toEqual([
      ["today’s grilling-session on the Desk  studio!", ["post"]],
      ["BRIEF.md", ["shelf"]],
    ]);
    expect(page?.areas.map((a) => a.label)).toEqual(["Lab"]);
  });

  it("describes a closed thread's outcome and a parked thread's place", () => {
    const closed = buildThreadPage(studio, "balance", CTX);
    expect(closed?.where).toBe("closed 31 Oct · opened 20 Oct");
    expect(closed?.outcome).toEqual({ open: false, label: "Decided", closed: "2026-10-31", expect: "The engine becomes a package.", reviewOn: null, text: "" });
    expect(buildThreadPage(studio, "shelf", CTX)?.where).toBe("parked · opened 20 Oct");
    expect(page?.outcome.open).toBe(true);
  });

  it("carries the relations", () => {
    expect(page?.relations.threads.map((r) => r.open)).toEqual(["post", "shelf"]);
  });
});
